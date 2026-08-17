import { describe, it, expect, afterEach, vi } from "vitest";
import {
  activeDeploymentMutation,
  addGraphProgress,
  beginPlannedGraphRequest,
  beginDeployAttempt,
  azureCredentialIdValidationError,
  azureLoginRequiredResponse,
  buildAzureCliAssistPrompt,
  azureCliAssistDisplayPrompt,
  azureCliAssistMessage,
  cleanupAzureSetupArtifacts,
  cleanupGitHubEnvironmentArtifact,
  guardStopBoundary,
  canReuseModeledGraph,
  DEPLOY_RAD_COMMANDS_STEP,
  deleteNewlyCreatedGitHubEnvironment,
  deploymentStatusBlocksMutation,
  DEPLOYMENT_MUTATION_LEASE_MS,
  deployHandoffStatus,
  DEPLOY_HANDOFF_MAX_ATTEMPTS,
  DEPLOY_HANDOFF_RETRY_DELAY_MS,
  endChildInput,
  ensureServicePrincipal,
  finalizeSetupFailure,
  graphDefinitionHash,
  isCrossSiteMutation,
  isCliCommandMissing,
  isCurrentSourceRefToken,
  isCurrentPlannedGraphRequest,
  invokeSessionPrompt,
  localDeploymentBlocksMutation,
  preflightGhcrPackageWriteAccess,
  resetDeploymentViewState,
  resolveGitHubEnvironmentCreateState,
  releaseDeploymentMutation,
  reserveDeploymentMutation,
  resolveDeploymentEnvironment,
  resolveDeployStatus,
  resolveDeployRepairLoop,
  setDeployRepairHandoff,
  triggerDeployRepairHandoff,
  setDeployFailureNotice,
  triggerDeployFailureNotice,
  classifyDeployDispatchFailure,
  DEPLOY_BRANCH_NOT_PUSHED_KIND,
  DEPLOY_RUN_UNCONFIRMED_KIND
} from "./server.js";
import { DEPLOY_REPAIR_ATTEMPT_CAP } from "./runtime/hooks.js";
import {
  createOperation,
  finish,
  recordAzureApp,
  recordCleanupState,
  recordCommittedWorkflowFile,
  recordCreatedFederatedCredential,
  recordCreatedRoleAssignment,
  recordGitHubEnvironment,
  recordServicePrincipal,
  requestStop,
  toClientView,
  unresolvedCleanupTargets
} from "./operations.js";
import type { CanvasState } from "./shared.js";
import type {
  DeployRepairHandoffInput,
  DeployFailureNoticeInput
} from "./server.js";
import type { GitHubIdentity, GitHubIdentityAccount } from "./gh.js";

describe("DEPLOY_RAD_COMMANDS_STEP", () => {
  it("matches the step name in the upstream run-rad-commands action", () => {
    // The deploy monitor gates all of its in-flight handling on finding a step
    // with this name. It previously read "Deploy Application", which exists
    // nowhere in radius-project/radius, so that entire code path never ran on
    // a real deploy. Pin the value so the same silent break cannot recur.
    expect(DEPLOY_RAD_COMMANDS_STEP).toBe("Run rad commands");
  });
});

describe("endChildInput", () => {
  it("keeps command execution authoritative when closing stdin fails", () => {
    expect(() =>
      endChildInput({
        stdin: {
          end() {
            throw new Error("stdin already closed");
          }
        }
      })
    ).not.toThrow();
  });
});

describe("preflightGhcrPackageWriteAccess", () => {
  const account = (
    login: string,
    overrides: Partial<GitHubIdentityAccount> = {}
  ): GitHubIdentityAccount => ({
    login,
    hasWorkflow: true,
    hasPackages: false,
    switchable: true,
    acting: false,
    ...overrides
  });

  const identity = (
    overrides: Partial<GitHubIdentity> = {}
  ): GitHubIdentity => ({
    actingLogin: "emuuser",
    displayLogin: "emuuser",
    mismatch: false,
    actingHasWorkflow: true,
    actingHasPackages: true,
    packagesLogin: "octocat",
    packagesHasWrite: true,
    packagesCredentialSource: "keyring",
    reason: "user-selected-keyring-account",
    accounts: [],
    ...overrides
  });

  it("fails closed when the package credential username is blank", async () => {
    const result = await preflightGhcrPackageWriteAccess(
      async () => ({ token: "ghcr-token", username: "   ", source: "keyring" }),
      async () => identity()
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected GHCR preflight to fail");
    expect(result.code).toBe("ghcr-auth-failed");
    expect(result.error).toContain("Could not determine");
  });

  it("checks the specific GHCR credential login for write:packages", async () => {
    const result = await preflightGhcrPackageWriteAccess(
      async () => ({
        token: "ghcr-token",
        username: "pubuser",
        source: "keyring"
      }),
      async () =>
        identity({
          accounts: [
            account("pubuser"),
            account("emuuser", { hasPackages: true, acting: true })
          ]
        })
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected GHCR preflight to fail");
    expect(result.code).toBe("ghcr-scope-required");
    expect(result.error).toContain("@pubuser");
    expect(result.error).toContain(
      "gh auth switch -h github.com -u pubuser && gh auth refresh -h github.com -s read:packages -s write:packages"
    );
    expect(result.error).not.toContain("previous-login");
  });

  it("reads the scope from the identity when it describes the very credential resolved", async () => {
    // The identity resolved the same login through the same source, so its
    // scope answer is the one for the credential GHCR will present — even when
    // the de-duplicated account list still carries the other credential's
    // prediction for that login.
    const result = await preflightGhcrPackageWriteAccess(
      async () => ({
        token: "ghcr-token",
        username: "dupuser",
        source: "keyring"
      }),
      async () =>
        identity({
          actingLogin: "dupuser",
          packagesLogin: "dupuser",
          packagesHasWrite: true,
          packagesCredentialSource: "keyring",
          accounts: [account("dupuser", { hasPackages: false, acting: true })]
        })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected GHCR preflight to pass");
    expect(result.login).toBe("dupuser");
    expect(result.credentials.source).toBe("keyring");
  });

  it("does not tell the user to refresh a session token that cannot be refreshed", async () => {
    // The resolved credential is the injected session token: gh auth refresh
    // cannot change it, and no stored account can publish packages either.
    const result = await preflightGhcrPackageWriteAccess(
      async () => ({
        token: "ghcr-token",
        username: "tokuser",
        source: "injected-token"
      }),
      async () =>
        identity({
          actingLogin: "tokuser",
          packagesLogin: "tokuser",
          packagesHasWrite: false,
          packagesCredentialSource: "injected-token",
          accounts: [account("tokuser", { switchable: false, acting: true })]
        })
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected GHCR preflight to fail");
    expect(result.code).toBe("ghcr-scope-required");
    expect(result.error).toContain(
      "gh auth login -h github.com -s read:packages -s write:packages"
    );
    expect(result.error).not.toContain("gh auth switch -h github.com");
    expect(result.error).not.toContain("gh auth refresh -h github.com");
  });

  it("names the stored account to select when the session token lacks the scope", async () => {
    const result = await preflightGhcrPackageWriteAccess(
      async () => ({
        token: "ghcr-token",
        username: "tokuser",
        source: "injected-token"
      }),
      async () =>
        identity({
          actingLogin: "tokuser",
          packagesLogin: "tokuser",
          packagesHasWrite: false,
          packagesCredentialSource: "injected-token",
          accounts: [
            account("tokuser", { switchable: false, acting: true }),
            account("storeduser", { hasPackages: true })
          ]
        })
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected GHCR preflight to fail");
    expect(result.error).toContain("Select the stored account @storeduser");
    expect(result.error).not.toContain("gh auth login");
  });

  it("falls back to the acting account when the credential login is absent from the account list", async () => {
    const result = await preflightGhcrPackageWriteAccess(
      async () => ({
        token: "ghcr-token",
        username: "loneuser",
        source: "injected-token"
      }),
      async () =>
        identity({
          actingLogin: "loneuser",
          actingHasPackages: true,
          packagesLogin: "someone-else",
          packagesCredentialSource: "keyring",
          accounts: []
        })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected GHCR preflight to pass");
    expect(result.login).toBe("loneuser");
  });

  it("fails closed when nothing describes the credential login", async () => {
    const result = await preflightGhcrPackageWriteAccess(
      async () => ({
        token: "ghcr-token",
        username: "stranger",
        source: "keyring"
      }),
      async () => identity({ accounts: [] })
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected GHCR preflight to fail");
    expect(result.code).toBe("ghcr-scope-required");
  });
});

describe("resolveGitHubEnvironmentCreateState", () => {
  it("treats a successful GET as a reused environment", () => {
    expect(
      resolveGitHubEnvironmentCreateState({
        code: 0,
        stdout: '{"name":"dev"}',
        stderr: ""
      })
    ).toBe("reused");
  });

  it("treats a 404 lookup as a created-candidate environment", () => {
    expect(
      resolveGitHubEnvironmentCreateState({
        code: 1,
        stdout: "",
        stderr: "gh: Not Found (HTTP 404)"
      })
    ).toBe("created_candidate");
  });

  it("fails closed when the lookup error is ambiguous", () => {
    expect(
      resolveGitHubEnvironmentCreateState({
        code: 1,
        stdout: "",
        stderr: "gh: Forbidden (HTTP 403)"
      })
    ).toBeNull();
  });
});

describe("deleteNewlyCreatedGitHubEnvironment", () => {
  it("does not delete a reused environment", async () => {
    let called = false;
    await expect(
      deleteNewlyCreatedGitHubEnvironment(
        { state: "reused", repo: "octo/app", name: "dev" },
        async () => {
          called = true;
        }
      )
    ).resolves.toBe(false);
    expect(called).toBe(false);
  });

  it("deletes only a newly created environment", async () => {
    const calls: string[][] = [];
    await expect(
      deleteNewlyCreatedGitHubEnvironment(
        { state: "created", repo: "octo/app", name: "dev env" },
        async (args) => {
          calls.push(args);
        }
      )
    ).resolves.toBe(true);
    expect(calls).toEqual([
      ["api", "--method", "DELETE", "/repos/octo/app/environments/dev%20env"]
    ]);
  });

  it("does not delete a created-candidate environment", async () => {
    let called = false;
    await expect(
      deleteNewlyCreatedGitHubEnvironment(
        { state: "created_candidate", repo: "octo/app", name: "dev" },
        async () => {
          called = true;
        }
      )
    ).resolves.toBe(false);
    expect(called).toBe(false);
  });
});

function newAzureOp() {
  return createOperation({
    provider: "azure",
    repo: "octo/app",
    environment: "dev"
  });
}

describe("ensureServicePrincipal", () => {
  it("reuses an existing Service Principal without creating a new one", async () => {
    const calls: string[][] = [];
    const result = await ensureServicePrincipal("app-1", async (args) => {
      calls.push(args);
      return { code: 0, stdout: "sp-object-1\n", stderr: "" };
    });

    expect(result).toEqual({
      ok: true,
      state: "reused",
      objectId: "sp-object-1"
    });
    expect(calls).toEqual([
      ["ad", "sp", "show", "--id", "app-1", "--query", "id", "-o", "tsv"]
    ]);
  });

  it("creates the Service Principal only after a not-found precheck", async () => {
    const calls: string[][] = [];
    const result = await ensureServicePrincipal("app-1", async (args) => {
      calls.push(args);
      return calls.length === 1 ?
          {
            code: 1,
            stdout: "",
            stderr:
              "Request_ResourceNotFound: Resource 'app-1' does not exist or one of its queried reference-property objects are not present."
          }
        : { code: 0, stdout: "", stderr: "" };
    });

    expect(result).toEqual({ ok: true, state: "created", objectId: null });
    expect(calls).toEqual([
      ["ad", "sp", "show", "--id", "app-1", "--query", "id", "-o", "tsv"],
      ["ad", "sp", "create", "--id", "app-1"]
    ]);
  });

  it("fails closed when the precheck returns an empty object id", async () => {
    const result = await ensureServicePrincipal("app-1", async () => ({
      code: 0,
      stdout: "",
      stderr: ""
    }));

    expect(result).toEqual({
      ok: false,
      stderr: "The Service Principal lookup returned an empty object id."
    });
  });
});

describe("cleanupAzureSetupArtifacts", () => {
  it("deletes only created Azure artifacts in reverse dependency order", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordCreatedFederatedCredential(op, {
      name: "radius-dev",
      subject: "repo:octo/app:environment:dev"
    });
    recordCreatedFederatedCredential(op, {
      name: "radius-dev-pr",
      subject: "repo:octo/app:pull_request"
    });
    recordCreatedRoleAssignment(op, {
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      principalObjectId: "sp-1"
    });
    recordCreatedRoleAssignment(op, {
      role: "Azure Kubernetes Service RBAC Cluster Admin",
      scope:
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/cluster",
      principalObjectId: "sp-1"
    });

    const calls: string[][] = [];
    const cleanup = await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    expect(calls).toEqual([
      [
        "role",
        "assignment",
        "delete",
        "--assignee-object-id",
        "sp-1",
        "--role",
        "Azure Kubernetes Service RBAC Cluster Admin",
        "--scope",
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/cluster",
        "--output",
        "none"
      ],
      [
        "role",
        "assignment",
        "delete",
        "--assignee-object-id",
        "sp-1",
        "--role",
        "Contributor",
        "--scope",
        "/subscriptions/sub/resourceGroups/rg",
        "--output",
        "none"
      ],
      [
        "ad",
        "app",
        "federated-credential",
        "delete",
        "--id",
        "app-1",
        "--federated-credential-id",
        "radius-dev-pr"
      ],
      [
        "ad",
        "app",
        "federated-credential",
        "delete",
        "--id",
        "app-1",
        "--federated-credential-id",
        "radius-dev"
      ],
      ["ad", "sp", "delete", "--id", "app-1"],
      ["ad", "app", "delete", "--id", "app-1"]
    ]);
    expect(cleanup.state).toBe("succeeded");
    expect(cleanup.warnings).toEqual([]);
    expect(op.setupArtifacts.cleanup).toMatchObject({
      state: "succeeded",
      attempts: 1
    });
    expect(op.setupArtifacts.cleanup.results).toHaveLength(6);
  });

  it("treats not-found as success and preserves reused resources", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "reused", appId: "app-1" });
    recordServicePrincipal(op, {
      state: "reused",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordCreatedFederatedCredential(op, {
      name: "radius-dev",
      subject: "repo:octo/app:environment:dev"
    });
    recordCreatedRoleAssignment(op, {
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      principalObjectId: "sp-1"
    });

    const calls: string[][] = [];
    const cleanup = await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) => {
        calls.push(args);
        return args[0] === "role" ?
            {
              code: 1,
              stdout: "",
              stderr: "No matched assignments were found to delete."
            }
          : {
              code: 1,
              stdout: "",
              stderr:
                "Request_ResourceNotFound: Resource 'radius-dev' does not exist or one of its queried reference-property objects are not present."
            };
      }
    });

    expect(calls).toEqual([
      [
        "role",
        "assignment",
        "delete",
        "--assignee-object-id",
        "sp-1",
        "--role",
        "Contributor",
        "--scope",
        "/subscriptions/sub/resourceGroups/rg",
        "--output",
        "none"
      ],
      [
        "ad",
        "app",
        "federated-credential",
        "delete",
        "--id",
        "app-1",
        "--federated-credential-id",
        "radius-dev"
      ]
    ]);
    expect(cleanup.state).toBe("succeeded");
    expect(cleanup.warnings).toEqual([]);
    expect(op.setupArtifacts.cleanup.results).toMatchObject([
      { outcome: "not_found", artifactType: "role_assignment" },
      { outcome: "not_found", artifactType: "federated_credential" }
    ]);
  });

  it("is idempotent across repeated cleanup attempts", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, { state: "created", appId: "app-1" });

    await cleanupAzureSetupArtifacts(op, {
      runAz: async () => ({ code: 0, stdout: "", stderr: "" })
    });
    // Proof of removal moves ownership: both artifacts are recorded as gone, so
    // a repeat attempt has nothing left it may act on and issues no `az` call.
    expect(op.setupArtifacts.servicePrincipal.state).toBe("deleted");
    expect(op.setupArtifacts.azureApp.state).toBe("deleted");
    const repeatedCalls: string[][] = [];
    const second = await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) => {
        repeatedCalls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    expect(repeatedCalls).toEqual([]);
    expect(second.state).toBe("not_needed");
    expect(second.results).toEqual([]);
    expect(op.setupArtifacts.cleanup).toMatchObject({
      state: "not_needed",
      attempts: 2
    });
    // The first attempt's proof survives the second attempt untouched.
    expect(
      op.setupArtifacts.cleanup.results.filter((r: any) => r.attempt === 1)
    ).toMatchObject([
      { artifactType: "service_principal", outcome: "deleted" },
      { artifactType: "azure_app", outcome: "deleted" }
    ]);
  });

  it("saves each deletion result before it starts the next one", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordCreatedRoleAssignment(op, {
      role: "Contributor",
      scope: "/subscriptions/sub",
      principalObjectId: "sp-1"
    });

    // An interrupted rollback must still report exactly what it removed, so the
    // ledger is asked what it holds at the moment each delete returns.
    const observed: Array<{ outcomes: string[]; state: string }> = [];
    await cleanupAzureSetupArtifacts(op, {
      runAz: async () => ({ code: 0, stdout: "", stderr: "" }),
      onResultRecorded: () => {
        observed.push({
          state: op.setupArtifacts.cleanup.state,
          outcomes: op.setupArtifacts.cleanup.results.map(
            (entry: any) => `${entry.artifactType}:${entry.outcome}`
          )
        });
      }
    });

    expect(observed).toEqual([
      {
        state: "running",
        outcomes: ["role_assignment:deleted"]
      },
      {
        state: "running",
        outcomes: ["role_assignment:deleted", "service_principal:deleted"]
      },
      {
        state: "running",
        outcomes: [
          "role_assignment:deleted",
          "service_principal:deleted",
          "azure_app:deleted"
        ]
      }
    ]);
    expect(op.setupArtifacts.cleanup.state).toBe("succeeded");
  });

  it("keeps a result an earlier pass recorded for the same attempt", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });

    // The rollback runner deletes the GitHub environment before the Azure pass
    // and records the outcome against the same attempt. Losing that row would
    // report a clean rollback while the environment was still present.
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev"
    });
    await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async () => {
        throw new Error("GitHub returned 502.");
      }
    });
    recordCleanupState(op, {
      state: "running",
      results: [
        {
          attempt: 1,
          artifactType: "github_environment",
          target: "octo/app:dev",
          identity: "octo/app:dev",
          outcome: "warning",
          detail: "GitHub returned 502."
        }
      ]
    });

    const seen: string[][] = [];
    await cleanupAzureSetupArtifacts(op, {
      runAz: async () => ({ code: 0, stdout: "", stderr: "" }),
      onResultRecorded: () => {
        seen.push(
          op.setupArtifacts.cleanup.results.map(
            (entry: any) => `${entry.artifactType}:${entry.outcome}`
          )
        );
      }
    });

    expect(seen).toEqual([["github_environment:warning", "azure_app:deleted"]]);
    expect(
      op.setupArtifacts.cleanup.results.map(
        (entry: any) => `${entry.artifactType}:${entry.outcome}`
      )
    ).toEqual(["github_environment:warning", "azure_app:deleted"]);
    // The unresolved environment is still what a rollback retry would target.
    expect(
      unresolvedCleanupTargets(op).map((entry: any) => entry.artifactType)
    ).toEqual(["github_environment"]);
  });

  it("retries only the named unresolved targets on a cleanup retry", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, { state: "created", appId: "app-1" });

    // First attempt: the Service Principal goes, the App Registration does not.
    await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) =>
        args.includes("app") && args.includes("delete") ?
          { code: 1, stdout: "", stderr: "Azure CLI returned 429." }
        : { code: 0, stdout: "", stderr: "" }
    });
    expect(op.setupArtifacts.servicePrincipal.state).toBe("deleted");
    expect(op.setupArtifacts.azureApp.state).toBe("created");

    const retriedCalls: string[][] = [];
    const retry = await cleanupAzureSetupArtifacts(op, {
      only: new Set(["azure_app#app-1"]),
      runAz: async (args) => {
        retriedCalls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    expect(retriedCalls).toEqual([["ad", "app", "delete", "--id", "app-1"]]);
    expect(retry.state).toBe("succeeded");
    expect([...retry.attemptedKeys]).toEqual(["azure_app#app-1"]);
    expect(op.setupArtifacts.azureApp.state).toBe("deleted");
    // The earlier attempt stays as history; only the latest attempt's results
    // describe what is unresolved now.
    expect(op.setupArtifacts.cleanup.results).toMatchObject([
      { attempt: 1, artifactType: "service_principal", outcome: "deleted" },
      { attempt: 1, artifactType: "azure_app", outcome: "warning" },
      { attempt: 2, artifactType: "azure_app", outcome: "deleted" }
    ]);
    expect(unresolvedCleanupTargets(op)).toEqual([]);
  });

  it("touches nothing when a retry names no target the ledger still owns", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });

    const calls: string[][] = [];
    const result = await cleanupAzureSetupArtifacts(op, {
      only: new Set(["azure_app#some-other-app"]),
      runAz: async (args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    expect(calls).toEqual([]);
    expect(result.state).toBe("not_needed");
    expect([...result.attemptedKeys]).toEqual([]);
    expect(op.setupArtifacts.azureApp.state).toBe("created");
  });

  it("records warnings and continues when a delete fails", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordCreatedFederatedCredential(op, {
      name: "radius-dev",
      subject: "repo:octo/app:environment:dev"
    });
    recordCreatedRoleAssignment(op, {
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      principalObjectId: "sp-1"
    });

    const calls: string[][] = [];
    const cleanup = await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) => {
        calls.push(args);
        return args[0] === "role" ?
            {
              code: 1,
              stdout: "",
              stderr:
                "AuthorizationFailed: caller cannot delete this role assignment."
            }
          : { code: 0, stdout: "", stderr: "" };
      }
    });

    expect(cleanup.state).toBe("succeeded_with_warnings");
    expect(cleanup.warnings[0]).toContain("AuthorizationFailed");
    expect(calls).toEqual([
      [
        "role",
        "assignment",
        "delete",
        "--assignee-object-id",
        "sp-1",
        "--role",
        "Contributor",
        "--scope",
        "/subscriptions/sub/resourceGroups/rg",
        "--output",
        "none"
      ],
      [
        "ad",
        "app",
        "federated-credential",
        "delete",
        "--id",
        "app-1",
        "--federated-credential-id",
        "radius-dev"
      ],
      ["ad", "sp", "delete", "--id", "app-1"],
      ["ad", "app", "delete", "--id", "app-1"]
    ]);
    expect(op.setupArtifacts.cleanup).toMatchObject({
      state: "succeeded_with_warnings",
      attempts: 1
    });
  });
});

describe("cleanupGitHubEnvironmentArtifact", () => {
  it("deletes an environment this attempt proved it created and records it as gone", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev"
    });
    const calls: string[][] = [];
    const steps: string[] = [];

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async (args) => {
        calls.push(args);
      },
      steps
    });

    expect(calls).toEqual([
      ["api", "--method", "DELETE", "/repos/octo/app/environments/dev"]
    ]);
    expect(result).toMatchObject({ attempted: true, warnings: [] });
    expect(result.results).toMatchObject([
      {
        attempt: 1,
        artifactType: "github_environment",
        target: "octo/app:dev",
        identity: "octo/app:dev",
        outcome: "deleted"
      }
    ]);
    expect(op.setupArtifacts.githubEnvironment.state).toBe("deleted");
    expect(steps).toEqual(['✅ Deleted GitHub environment "dev"']);
  });

  it("leaves an unprovable environment in place and says so", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created_candidate",
      repo: "octo/app",
      name: "dev"
    });

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 2,
      runDeleteEnvironment: async () => {
        throw new Error("must not delete an environment it cannot claim");
      }
    });

    expect(result.attempted).toBe(true);
    expect(result.results).toMatchObject([
      { attempt: 2, outcome: "skipped", artifactType: "github_environment" }
    ]);
    expect(result.warnings[0]).toContain(
      "cannot prove this request created it"
    );
    // Ownership never moves without proof of removal.
    expect(op.setupArtifacts.githubEnvironment.state).toBe("created_candidate");
  });

  it("keeps claiming the environment when the delete fails", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev"
    });

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async () => {
        throw new Error("GitHub API request failed.");
      }
    });

    expect(result.results).toMatchObject([
      { outcome: "warning", detail: "GitHub API request failed." }
    ]);
    expect(result.warnings).toEqual([
      'Failed to delete GitHub environment "dev": GitHub API request failed.'
    ]);
    expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
  });

  it("reports the missing delete helper rather than claiming a rollback", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev"
    });

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: null
    });

    expect(result.results).toMatchObject([{ outcome: "warning" }]);
    expect(result.warnings[0]).toContain("Missing the GitHub delete helper");
    expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
  });

  it("does nothing for an environment it never created", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "reused",
      repo: "octo/app",
      name: "dev"
    });

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async () => {
        throw new Error("must not delete a reused environment");
      }
    });

    expect(result).toEqual({ results: [], warnings: [], attempted: false });
    expect(op.setupArtifacts.githubEnvironment.state).toBe("reused");
  });

  it("does nothing for a record with no artifact ledger", async () => {
    const result = await cleanupGitHubEnvironmentArtifact(null, {
      attempt: 1,
      runDeleteEnvironment: async () => {
        throw new Error("must not run");
      }
    });

    expect(result).toEqual({ results: [], warnings: [], attempted: false });
  });
});

describe("guardStopBoundary", () => {
  function stopHarness() {
    const responses: Array<{ status: number; body: Record<string, unknown> }> =
      [];
    const diagnostics: Array<{ code: string; message: string }> = [];
    return {
      responses,
      diagnostics,
      respond: (status: number, body: Record<string, unknown>) => {
        responses.push({ status, body });
      },
      report: (diagnostic: { code: string; message: string }) => {
        diagnostics.push(diagnostic);
      }
    };
  }

  it("lets an operation with no recorded stop continue and writes nothing", async () => {
    const op = newAzureOp();
    const harness = stopHarness();
    let persisted = 0;

    const proceed = await guardStopBoundary({
      operation: op,
      boundary: "after-app-registration",
      persist: async () => {
        persisted += 1;
      },
      report: harness.report,
      respond: harness.respond
    });

    expect(proceed).toBe(true);
    expect(persisted).toBe(0);
    expect(harness.responses).toEqual([]);
    expect(op.state).toBe("running");
  });

  it("closes the operation at the named boundary and answers the caller once", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    requestStop(op);
    const harness = stopHarness();

    const proceed = await guardStopBoundary({
      operation: op,
      boundary: "after-app-registration",
      persist: async () => {},
      report: harness.report,
      respond: harness.respond
    });

    expect(proceed).toBe(false);
    expect(op.state).toBe("cancelled");
    expect(op.control.stop.boundary).toBe("after-app-registration");
    expect(harness.responses).toHaveLength(1);
    const [answer] = harness.responses;
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      cancelled: true,
      code: "operation-stopped",
      boundary: "after-app-registration",
      operationId: op.operationId
    });
    // The customer is told what the stopped attempt left behind.
    expect(toClientView(op).cleanup.created).toMatchObject([
      { kind: "azure_app" }
    ]);
  });

  it("still answers when the durable write fails, and reports the write failure", async () => {
    const op = newAzureOp();
    requestStop(op);
    const harness = stopHarness();

    const proceed = await guardStopBoundary({
      operation: op,
      boundary: "before-workflow-commit",
      persist: async () => {
        throw new Error("disk gone");
      },
      report: harness.report,
      respond: harness.respond
    });

    expect(proceed).toBe(false);
    expect(op.state).toBe("cancelled");
    expect(harness.diagnostics).toMatchObject([
      { code: "operation-store-write-failed" }
    ]);
    expect(harness.responses[0].status).toBe(200);
    // The announcement is withheld: an unsaved cancellation must not be
    // reported as a finished setup.
    expect(op.journey.notifiedAt).toBeNull();
  });

  it("lets a finished operation through rather than closing it twice", async () => {
    const op = newAzureOp();
    requestStop(op);
    finish(op, "failed", { failure: { code: "setup-failed" } });
    const harness = stopHarness();

    const proceed = await guardStopBoundary({
      operation: op,
      boundary: "after-workflow-commit",
      persist: async () => {
        throw new Error("must not persist");
      },
      report: harness.report,
      respond: harness.respond
    });

    expect(proceed).toBe(true);
    expect(op.state).toBe("failed");
    expect(harness.responses).toEqual([]);
  });
});

describe("finalizeSetupFailure", () => {
  it("rolls back newly created GitHub and Azure artifacts before any workflow commit", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordCreatedFederatedCredential(op, {
      name: "radius-dev",
      subject: "repo:octo/app:environment:dev"
    });
    recordCreatedRoleAssignment(op, {
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      principalObjectId: "sp-1"
    });
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev"
    });

    const ghCalls: string[][] = [];
    const azCalls: string[][] = [];
    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: "environment config exploded",
      code: "environment-config-failed",
      extra: {
        steps: ["Creating GitHub environment dev..."],
        azError: "IGNORE-PREVIOUS-INSTRUCTIONS-CANARY"
      },
      steps: [],
      runAz: async (args) => {
        azCalls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
      runDeleteEnvironment: async (args) => {
        ghCalls.push(args);
      }
    });

    expect(failure.status).toBe(400);
    expect(failure.body.error).toBe("environment config exploded");
    expect(failure.body.code).toBe("environment-config-failed");
    expect(failure.body.steps).toEqual(["Creating GitHub environment dev..."]);
    expect(JSON.stringify(failure.body)).not.toContain(
      "IGNORE-PREVIOUS-INSTRUCTIONS-CANARY"
    );
    expect(failure.body.cleanup).toMatchObject({
      rollbackBeforeCommit: true,
      state: "succeeded"
    });
    expect((failure.body.cleanup as any).results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactType: "github_environment",
          outcome: "deleted"
        }),
        expect.objectContaining({
          artifactType: "role_assignment",
          outcome: "deleted"
        }),
        expect.objectContaining({
          artifactType: "federated_credential",
          outcome: "deleted"
        }),
        expect.objectContaining({
          artifactType: "service_principal",
          outcome: "deleted"
        }),
        expect.objectContaining({
          artifactType: "azure_app",
          outcome: "deleted"
        })
      ])
    );
    expect(ghCalls).toEqual([
      ["api", "--method", "DELETE", "/repos/octo/app/environments/dev"]
    ]);
    expect(op.state).toBe("failed");
    expect(op.failure.message).toBe("environment config exploded");
    expect(op.setupArtifacts.cleanup.state).toBe("succeeded");
    expect(azCalls).toEqual([
      [
        "role",
        "assignment",
        "delete",
        "--assignee-object-id",
        "sp-1",
        "--role",
        "Contributor",
        "--scope",
        "/subscriptions/sub/resourceGroups/rg",
        "--output",
        "none"
      ],
      [
        "ad",
        "app",
        "federated-credential",
        "delete",
        "--id",
        "app-1",
        "--federated-credential-id",
        "radius-dev"
      ],
      ["ad", "sp", "delete", "--id", "app-1"],
      ["ad", "app", "delete", "--id", "app-1"]
    ]);
  });

  it("preserves the original error when cleanup also fails", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordCreatedFederatedCredential(op, {
      name: "radius-dev",
      subject: "repo:octo/app:environment:dev"
    });
    recordCreatedRoleAssignment(op, {
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      principalObjectId: "sp-1"
    });
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev"
    });

    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: "original failure",
      code: "original-failure",
      steps: [],
      runAz: async (args) =>
        args[0] === "role" ?
          {
            code: 1,
            stdout: "",
            stderr:
              "AuthorizationFailed: caller cannot delete this role assignment."
          }
        : { code: 0, stdout: "", stderr: "" },
      runDeleteEnvironment: async () => {
        throw new Error("GitHub delete exploded");
      }
    });

    expect(failure.body.error).toBe("original failure");
    expect(failure.body.code).toBe("original-failure");
    expect(op.failure.message).toBe("original failure");
    expect(op.failure.code).toBe("original-failure");
    expect(failure.body.cleanup).toMatchObject({
      rollbackBeforeCommit: true,
      state: "succeeded_with_warnings"
    });
    expect((failure.body.cleanup as any).warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("AuthorizationFailed"),
        expect.stringContaining("GitHub delete exploded")
      ])
    );
  });

  it("does not delete a reused GitHub environment", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "reused",
      repo: "octo/app",
      name: "dev"
    });

    let deleted = false;
    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: "reused env failed",
      code: "reused-env-failed",
      steps: [],
      runDeleteEnvironment: async () => {
        deleted = true;
      }
    });

    expect(deleted).toBe(false);
    expect(failure.body.cleanup).toMatchObject({
      rollbackAttempted: false,
      state: "not_needed",
      retained: [
        {
          kind: "github_environment",
          reason: "reused",
          target: "octo/app:dev"
        }
      ]
    });
  });

  it("retains a created-candidate GitHub environment with manual cleanup guidance", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created_candidate",
      repo: "octo/app",
      name: "dev"
    });

    let deleted = false;
    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: "candidate env failed",
      code: "candidate-env-failed",
      steps: [],
      runDeleteEnvironment: async () => {
        deleted = true;
      }
    });

    expect(deleted).toBe(false);
    expect(failure.body.cleanup).toMatchObject({
      rollbackAttempted: true,
      rollbackBeforeCommit: true,
      state: "succeeded_with_warnings",
      retained: [
        {
          kind: "github_environment",
          reason: "manual_cleanup_required",
          target: "octo/app:dev"
        }
      ]
    });
    expect((failure.body.cleanup as any).warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("cannot prove this request created it")
      ])
    );
  });

  it("retains resources after the first workflow commit and reports cleanup as not needed", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev"
    });
    recordCommittedWorkflowFile(op, {
      path: ".github/workflows/radius-verify-credentials.yml",
      branch: "main",
      mode: "default_branch"
    });
    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: "verify run failed later",
      code: "verify-run-failed",
      steps: [],
      runAz: async () => {
        throw new Error("should not roll back after commit");
      },
      runDeleteEnvironment: async () => {
        throw new Error("should not delete environment after commit");
      }
    });

    expect(failure.body.cleanup).toMatchObject({
      rollbackAttempted: false,
      rollbackBeforeCommit: false,
      state: "not_needed"
    });
    expect(op.state).toBe("failed_partial");
    expect(op.setupArtifacts.cleanup.state).toBe("not_needed");
  });

  it("retains committed resources when a later workflow step fails", async () => {
    const op = newAzureOp();
    recordAzureApp(op, {
      state: "created",
      appId: "app-1",
      displayName: "radius-deploy-octo-app"
    });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev"
    });
    recordCommittedWorkflowFile(op, {
      path: ".github/workflows/radius-verify-credentials.yml",
      branch: "main",
      mode: "default_branch"
    });
    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: "verify dispatch exploded",
      code: "verify-dispatch-failed",
      steps: [],
      runAz: async () => {
        throw new Error("should not clean up after commit");
      },
      runDeleteEnvironment: async () => {
        throw new Error("should not delete environment after commit");
      }
    });

    expect(failure.body.cleanup).toMatchObject({
      rollbackAttempted: false,
      rollbackBeforeCommit: false,
      state: "not_needed"
    });
    expect((failure.body.cleanup as any).retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "azure_app",
          reason: "retained",
          target: "radius-deploy-octo-app (app-1)"
        }),
        expect.objectContaining({
          kind: "service_principal",
          reason: "retained",
          target: "Service Principal for radius-deploy-octo-app (app-1)"
        }),
        expect.objectContaining({
          kind: "github_environment",
          reason: "retained",
          target: "octo/app:dev"
        }),
        expect.objectContaining({
          kind: "workflow_file",
          reason: "retained",
          target: ".github/workflows/radius-verify-credentials.yml on main"
        })
      ])
    );
    expect(op.state).toBe("failed_partial");
  });
});

describe("resolveDeployStatus", () => {
  it("returns success when the run concluded with success", () => {
    expect(
      resolveDeployStatus({
        runConclusion: "success",
        runStatus: "completed",
        state: "pending"
      })
    ).toBe("success");
  });

  describe("modeled graph refresh cache", () => {
    it("hashes the application definition deterministically", () => {
      expect(
        graphDefinitionHash(
          "resource app 'Radius.Core/applications@2023-10-01-preview' = {}"
        )
      ).toBe(
        graphDefinitionHash(
          "resource app 'Radius.Core/applications@2023-10-01-preview' = {}"
        )
      );
      expect(graphDefinitionHash("one")).not.toBe(graphDefinitionHash("two"));
      expect(graphDefinitionHash("app", "config-one")).not.toBe(
        graphDefinitionHash("app", "config-two")
      );
    });

    describe("graph diff request identity", () => {
      it("accepts results only for the current diff context", () => {
        const state = {
          sourceRefContexts: {
            diff: { token: "diff|octo/app|main...new" }
          }
        };
        expect(
          isCurrentSourceRefToken(state, "diff", "diff|octo/app|main...new")
        ).toBe(true);
        expect(
          isCurrentSourceRefToken(state, "diff", "diff|octo/app|main...old")
        ).toBe(false);
        expect(isCurrentSourceRefToken(state, "diff", null)).toBe(false);
      });
    });

    it("reuses resources only for the same repo, branch, and definition", () => {
      const hash = graphDefinitionHash("app");
      const state = {
        graphLoaded: true,
        graphTargetRepo: "octo/app",
        graphBranch: "main",
        graphDefinitionHash: hash,
        graphResources: []
      };
      expect(canReuseModeledGraph(state, "octo/app", "main", hash)).toBe(true);
      expect(canReuseModeledGraph(state, "octo/app", "feature", hash)).toBe(
        false
      );
      expect(
        canReuseModeledGraph(
          state,
          "octo/app",
          "main",
          graphDefinitionHash("changed")
        )
      ).toBe(false);
    });
  });

  it("returns pending when the run is still in progress (no conclusion yet)", () => {
    expect(
      resolveDeployStatus({
        runConclusion: "",
        runStatus: "in_progress",
        state: "pending"
      })
    ).toBe("pending");
    expect(
      resolveDeployStatus({
        runConclusion: "",
        runStatus: "queued",
        state: "pending"
      })
    ).toBe("pending");
  });

  it("returns failed for any non-success conclusion", () => {
    for (const conclusion of [
      "failure",
      "cancelled",
      "timed_out",
      "action_required",
      "skipped"
    ]) {
      expect(
        resolveDeployStatus({
          runConclusion: conclusion,
          runStatus: "completed",
          state: "pending"
        }),
        conclusion
      ).toBe("failed");
    }
  });

  it("falls back to the deployment-status state when no linked run is available", () => {
    expect(
      resolveDeployStatus({
        runConclusion: "",
        runStatus: "",
        state: "success"
      })
    ).toBe("success");
    expect(
      resolveDeployStatus({
        runConclusion: "",
        runStatus: "",
        state: "failure"
      })
    ).toBe("failed");
    expect(
      resolveDeployStatus({ runConclusion: "", runStatus: "", state: "error" })
    ).toBe("failed");
    expect(
      resolveDeployStatus({
        runConclusion: "",
        runStatus: "",
        state: "pending"
      })
    ).toBe("pending");
    expect(
      resolveDeployStatus({
        runConclusion: "",
        runStatus: "",
        state: "in_progress"
      })
    ).toBe("pending");
  });
});

describe("addGraphProgress", () => {
  it("accepts progress only from the current graph generation", () => {
    const state = { graphBuildGeneration: 2, progressMessages: ["current"] };

    expect(addGraphProgress(state, 1, "stale")).toBe(false);
    expect(addGraphProgress(state, 2, "latest")).toBe(true);
    expect(state.progressMessages).toEqual(["current", "latest"]);
  });
});

describe("isCrossSiteMutation", () => {
  // Read-only methods always pass, regardless of the header.
  it("allows GET/HEAD from any site", () => {
    for (const site of [
      "cross-site",
      "same-site",
      "same-origin",
      "none",
      "",
      undefined
    ]) {
      expect(isCrossSiteMutation("GET", site), "GET " + site).toBe(false);
      expect(isCrossSiteMutation("HEAD", site), "HEAD " + site).toBe(false);
    }
  });

  // The extension's own page (same-origin) and user navigations (none) pass.
  it("allows same-origin and none state-changing requests", () => {
    expect(isCrossSiteMutation("POST", "same-origin")).toBe(false);
    expect(isCrossSiteMutation("POST", "none")).toBe(false);
    expect(isCrossSiteMutation("DELETE", "same-origin")).toBe(false);
  });

  // The attack: a browser page on another site issuing a simple POST.
  it("rejects cross-site and same-site state-changing requests", () => {
    expect(isCrossSiteMutation("POST", "cross-site")).toBe(true);
    expect(isCrossSiteMutation("POST", "same-site")).toBe(true);
    expect(isCrossSiteMutation("PUT", "cross-site")).toBe(true);
    expect(isCrossSiteMutation("PATCH", "same-site")).toBe(true);
    expect(isCrossSiteMutation("DELETE", "cross-site")).toBe(true);
  });

  // Non-browser callers (extension host, curl) never send the header — allow.
  it("allows state-changing requests with no Sec-Fetch-Site header", () => {
    expect(isCrossSiteMutation("POST", undefined)).toBe(false);
    expect(isCrossSiteMutation("POST", null)).toBe(false);
    expect(isCrossSiteMutation("POST", "")).toBe(false);
  });

  // Header parsing is case-insensitive, trimmed, and array-tolerant.
  it("normalizes header value casing, whitespace, and array form", () => {
    expect(isCrossSiteMutation("post", "  Cross-Site  ")).toBe(true);
    expect(isCrossSiteMutation("POST", ["cross-site"])).toBe(true);
    expect(isCrossSiteMutation("POST", ["same-origin"])).toBe(false);
    expect(isCrossSiteMutation("POST", "SAME-ORIGIN")).toBe(false);
  });
});

describe("deploymentStatusBlocksMutation", () => {
  it.each(["pending", "in_progress", "deleting"])(
    "blocks the non-terminal status %s",
    (status) => {
      expect(deploymentStatusBlocksMutation(status)).toBe(true);
    }
  );

  it.each(["success", "failed", "unknown", "", undefined])(
    "allows the terminal status %s",
    (status) => {
      expect(deploymentStatusBlocksMutation(status)).toBe(false);
    }
  );
});

describe("deployment mutation reservations", () => {
  it("allows one mutation at a time and releases its owner", () => {
    const state: CanvasState = {};
    const deploy = reserveDeploymentMutation(state, {
      repo: "octo/app",
      environment: "prod",
      kind: "deploy"
    });

    expect(deploy).not.toBeNull();
    if (!deploy) throw new Error("expected deployment reservation");
    expect(
      reserveDeploymentMutation(state, {
        repo: "octo/app",
        environment: "prod",
        kind: "delete"
      })
    ).toBeNull();

    releaseDeploymentMutation(state, deploy);
    expect(state.deploymentMutation).toBeUndefined();
  });

  it("does not let a stale completion release a newer mutation", () => {
    const stale = {
      repo: "octo/app",
      environment: "prod",
      kind: "deploy" as const,
      expiresAt: 100
    };
    const current = {
      repo: "octo/app",
      environment: "prod",
      kind: "delete" as const,
      expiresAt: 200
    };
    const state: CanvasState = { deploymentMutation: current };

    releaseDeploymentMutation(state, stale);

    expect(state.deploymentMutation).toBe(current);
  });

  it("expires abandoned reservations and lets a later operation recover", () => {
    const state: CanvasState = {};
    const abandoned = reserveDeploymentMutation(
      state,
      {
        repo: "octo/app",
        environment: "prod",
        kind: "deploy"
      },
      100
    );
    expect(abandoned?.expiresAt).toBe(100 + DEPLOYMENT_MUTATION_LEASE_MS);
    expect(
      activeDeploymentMutation(state, 100 + DEPLOYMENT_MUTATION_LEASE_MS - 1)
    ).toBe(abandoned);

    const recovered = reserveDeploymentMutation(
      state,
      {
        repo: "octo/app",
        environment: "staging",
        kind: "deploy"
      },
      100 + DEPLOYMENT_MUTATION_LEASE_MS
    );

    expect(recovered).not.toBeNull();
    expect(state.deploymentMutation).toBe(recovered);
  });
});

describe("deployment mutation recovery", () => {
  it("bounds stale local in-progress state but preserves fresh and legacy state", () => {
    expect(
      localDeploymentBlocksMutation(
        { deployStatus: "in_progress", deployStartedAt: 100 },
        100 + DEPLOYMENT_MUTATION_LEASE_MS - 1
      )
    ).toBe(true);
    expect(
      localDeploymentBlocksMutation(
        { deployStatus: "in_progress", deployStartedAt: 100 },
        100 + DEPLOYMENT_MUTATION_LEASE_MS
      )
    ).toBe(false);
    expect(
      localDeploymentBlocksMutation({ deployStatus: "in_progress" }, 100)
    ).toBe(true);
    expect(
      localDeploymentBlocksMutation({ deployStatus: "success" }, 100)
    ).toBe(false);
  });

  it("restores the state-backed environment fallback for existing callers", () => {
    expect(resolveDeploymentEnvironment({ envName: "prod" }, undefined)).toBe(
      "prod"
    );
    expect(resolveDeploymentEnvironment({ envName: "prod" }, "staging")).toBe(
      "staging"
    );
    expect(resolveDeploymentEnvironment({}, undefined)).toBe("");
  });

  it("clears both the result and any abandoned reservation on reset", () => {
    const state: CanvasState = {
      deployResult: { message: "done" },
      deployAttempt: { id: "attempt-1" },
      deploymentMutation: {
        repo: "octo/app",
        environment: "prod",
        kind: "deploy",
        expiresAt: 1000,
        attemptId: "attempt-1"
      }
    };

    resetDeploymentViewState(state, "attempt-1", 100);

    expect(state.deployResult).toBeUndefined();
    expect(state.deploymentMutation).toBeUndefined();
  });

  it("does not let an old result page reset a newer reservation", () => {
    const current = {
      repo: "octo/app",
      environment: "staging",
      kind: "deploy" as const,
      expiresAt: 1000,
      attemptId: "attempt-2"
    };
    const state: CanvasState = {
      deployResult: { message: "new result" },
      deployAttempt: { id: "attempt-2" },
      deploymentMutation: current
    };

    resetDeploymentViewState(state, "attempt-1", 100);

    expect(state.deployResult).toEqual({ message: "new result" });
    expect(state.deploymentMutation).toBe(current);
  });

  it("clears an expired reservation even without an attempt match", () => {
    const state: CanvasState = {
      deploymentMutation: {
        repo: "octo/app",
        environment: "prod",
        kind: "deploy",
        expiresAt: 100
      }
    };

    resetDeploymentViewState(state, undefined, 100);

    expect(state.deploymentMutation).toBeUndefined();
  });
});

describe("planned graph request generations", () => {
  it("clears stale resources and lets only the latest request commit", () => {
    const state: CanvasState = { plannedResources: [{ name: "old" }] };

    const first = beginPlannedGraphRequest(state);
    const second = beginPlannedGraphRequest(state);

    expect(state.plannedResources).toBeNull();
    expect(isCurrentPlannedGraphRequest(state, first)).toBe(false);
    expect(isCurrentPlannedGraphRequest(state, second)).toBe(true);
  });
});

describe("triggerDeployRepairHandoff", () => {
  afterEach(() => {
    setDeployRepairHandoff(null);
  });

  function failedEntry(overrides: Partial<CanvasState> = {}) {
    return {
      state: {
        deployStatus: "failed",
        deployingRepo: "octo/app",
        deployingBranch: "feat",
        deployError: "BCP037: unknown property",
        deployRunUrl: "https://github.com/octo/app/actions/runs/42",
        deployAttempt: { id: "attempt-A" },
        ...overrides
      } satisfies CanvasState
    };
  }

  it("hands the failure to the agent with the repo, branch, error, run URL, and instance", () => {
    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
    });
    expect(triggerDeployRepairHandoff(failedEntry(), "radius-panel")).toBe(
      true
    );
    // attemptId is what binds the repair loop to this deploy attempt.
    expect(calls).toEqual([
      {
        repo: "octo/app",
        branch: "feat",
        error: "BCP037: unknown property",
        deployRunUrl: "https://github.com/octo/app/actions/runs/42",
        attemptId: "attempt-A",
        instanceId: "radius-panel"
      }
    ]);
  });

  it("fires only once so the agent's own redeploys can't double-drive the loop", () => {
    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
    });
    const entry = failedEntry();
    expect(triggerDeployRepairHandoff(entry)).toBe(true);
    expect(triggerDeployRepairHandoff(entry)).toBe(false);
    // A later attempt in the same loop fails differently; still no second handoff.
    entry.state.deployRunUrl = "https://github.com/octo/app/actions/runs/43";
    expect(triggerDeployRepairHandoff(entry)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("hands off again once a fresh user-initiated deploy fails", () => {
    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
    });
    const entry = failedEntry();
    triggerDeployRepairHandoff(entry);
    // A user deploy resets ownership AND the handoff delivery state; an agent
    // redeploy does not. Mirror exactly what /api/deploy assigns when
    // agentInitiated !== true, so this stays honest about the reset it models:
    // resetting deployRepairing alone leaves deployHandoffState "pending"
    // (delivery resolves in a microtask), which correctly suppresses a re-handoff.
    entry.state.deployRepairing = false;
    entry.state.deployHandoffState = "idle";
    entry.state.deployHandoffAttempts = 0;
    entry.state.deployAttempt = { id: "attempt-B" };
    expect(triggerDeployRepairHandoff(entry)).toBe(true);
    expect(calls).toHaveLength(2);
    // The handoff belongs to the new attempt, not a reopened attempt-A.
    expect(calls[1]).toMatchObject({ attemptId: "attempt-B" });
  });

  it("suppresses a re-handoff while delivery is still in flight", () => {
    // Ownership alone is not enough: an undelivered ("pending") handoff must not
    // be re-sent, otherwise a slow send would double-drive the repair loop.
    setDeployRepairHandoff(() => new Promise(() => {}));
    const entry = failedEntry();
    expect(triggerDeployRepairHandoff(entry)).toBe(true);
    entry.state.deployRepairing = false;
    expect(triggerDeployRepairHandoff(entry)).toBe(false);
    expect(entry.state.deployHandoffState).toBe("pending");
  });

  it("does not hand off a branch-not-pushed failure, which a model fix cannot solve", () => {
    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
    });
    expect(
      triggerDeployRepairHandoff(
        failedEntry({ deployErrorKind: "branch-not-pushed" })
      )
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does not hand off an oidc-subject-missing refusal, which lives in cloud configuration", () => {
    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
    });
    // The remedy is a federated credential in Azure, so a repair loop could only
    // burn its attempts redeploying an unchanged, still-doomed configuration.
    expect(
      triggerDeployRepairHandoff(
        failedEntry({ deployErrorKind: "oidc-subject-missing" })
      )
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does not hand off unless the deploy actually failed", () => {
    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
    });
    expect(
      triggerDeployRepairHandoff(failedEntry({ deployStatus: "in_progress" }))
    ).toBe(false);
    expect(triggerDeployRepairHandoff(undefined)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("never throws when the handoff itself fails", () => {
    setDeployRepairHandoff(() => {
      throw new Error("session gone");
    });
    expect(() => triggerDeployRepairHandoff(failedEntry())).not.toThrow();
  });

  it("retries delivery on the next status poll when the first send rejects", async () => {
    // The browser stops polling once a deploy is terminal, so a rejected send
    // has to leave the handoff retryable for the poll that is still running.
    const entry = failedEntry();
    setDeployRepairHandoff(() => Promise.reject(new Error("send failed")));
    expect(triggerDeployRepairHandoff(entry)).toBe(true);
    await Promise.resolve();
    expect(deployHandoffStatus(entry.state)).toMatchObject({
      state: "retryable",
      attempts: 1,
      pending: true
    });
    expect(entry.state.deployRepairing).toBe(false);

    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
      return Promise.resolve("message-id");
    });
    expect(triggerDeployRepairHandoff(entry)).toBe(true);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(deployHandoffStatus(entry.state)).toMatchObject({
      state: "delivered",
      pending: false
    });
    expect(entry.state.deployRepairing).toBe(true);
  });

  it("gives up after the attempt budget so the user gets recovery guidance", async () => {
    const entry = failedEntry();
    setDeployRepairHandoff(() => Promise.reject(new Error("send failed")));
    for (let i = 0; i < DEPLOY_HANDOFF_MAX_ATTEMPTS; i++) {
      triggerDeployRepairHandoff(entry);
      await Promise.resolve();
    }
    expect(deployHandoffStatus(entry.state)).toMatchObject({
      state: "failed",
      attempts: DEPLOY_HANDOFF_MAX_ATTEMPTS,
      pending: false
    });
    // Terminal: no further delivery is attempted.
    expect(triggerDeployRepairHandoff(entry)).toBe(false);
  });

  it("does not deliver twice while a send is still in flight", () => {
    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
      return new Promise(() => {});
    });
    const entry = failedEntry();
    expect(triggerDeployRepairHandoff(entry)).toBe(true);
    expect(triggerDeployRepairHandoff(entry)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(deployHandoffStatus(entry.state)).toMatchObject({
      state: "pending",
      pending: true
    });
  });

  // A canvas panel is reused across deploys, so these settle against whatever
  // deploy is current, not the one that opened the handoff.
  it("ignores a delivery that lands after a new deploy replaced the attempt", async () => {
    let resolveSend: (value: string) => void = () => {};
    setDeployRepairHandoff(
      () =>
        new Promise<string>((resolve) => {
          resolveSend = resolve;
        })
    );
    const entry = failedEntry();
    expect(triggerDeployRepairHandoff(entry)).toBe(true);

    // The user starts a new deploy before the send settles. Mirror exactly what
    // /api/deploy assigns when agentInitiated !== true.
    entry.state.deployStatus = "in_progress";
    entry.state.deployRepairing = false;
    entry.state.deployHandoffState = "idle";
    entry.state.deployHandoffAttempts = 0;
    entry.state.deployAttempt = { id: "attempt-B" };

    resolveSend("message-id");
    await Promise.resolve();

    // Marking the new attempt delivered/owned would permanently suppress its
    // own handoff via the deployRepairing guard.
    expect(entry.state.deployRepairing).toBe(false);
    expect(deployHandoffStatus(entry.state)).toMatchObject({
      state: "idle",
      attempts: 0
    });

    // The new attempt still gets its own handoff when it fails.
    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
      return Promise.resolve("message-id");
    });
    entry.state.deployStatus = "failed";
    expect(triggerDeployRepairHandoff(entry)).toBe(true);
    expect(calls).toEqual([
      expect.objectContaining({ attemptId: "attempt-B" })
    ]);
  });

  it("ignores a rejection that lands after a new deploy replaced the attempt", async () => {
    let rejectSend: (reason: Error) => void = () => {};
    setDeployRepairHandoff(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectSend = reject;
        })
    );
    const entry = failedEntry();
    expect(triggerDeployRepairHandoff(entry)).toBe(true);

    entry.state.deployStatus = "in_progress";
    entry.state.deployRepairing = false;
    entry.state.deployHandoffState = "idle";
    entry.state.deployHandoffAttempts = 0;
    entry.state.deployAttempt = { id: "attempt-B" };

    rejectSend(new Error("send failed"));
    await Promise.resolve();

    // "retryable" here would also keep the webview polling for a handoff that
    // belongs to a deploy that is already over.
    expect(deployHandoffStatus(entry.state)).toMatchObject({
      state: "idle",
      attempts: 0,
      pending: false
    });
  });

  // Every deploy mints an attempt id today, but a state without one must not
  // get stranded as pending - that would block every later handoff.
  it("still settles a handoff opened without an attempt id", async () => {
    setDeployRepairHandoff(() => Promise.resolve("message-id"));
    const entry = failedEntry({ deployAttempt: undefined });
    expect(triggerDeployRepairHandoff(entry)).toBe(true);
    await Promise.resolve();
    expect(entry.state.deployRepairing).toBe(true);
    expect(deployHandoffStatus(entry.state)).toMatchObject({
      state: "delivered",
      pending: false
    });
  });

  // The route resolves the deploy branch before calling beginDeployAttempt,
  // because an await between the reset and the new attempt id would leave the
  // previous attempt current for that window.
  it("revokes an in-flight handoff as soon as a new attempt begins", async () => {
    let resolveSend: (value: string) => void = () => {};
    setDeployRepairHandoff(
      () =>
        new Promise<string>((resolve) => {
          resolveSend = resolve;
        })
    );
    const entry = failedEntry();
    expect(triggerDeployRepairHandoff(entry)).toBe(true);

    beginDeployAttempt(entry.state, {
      repo: "octo/app",
      branch: "feat",
      provider: "azure",
      environment: "dev",
      appFile: ".radius/app.bicep",
      repairLoop: false
    });
    expect(entry.state.deployAttempt?.id).not.toBe("attempt-A");

    resolveSend("message-id");
    await Promise.resolve();

    expect(entry.state.deployRepairing).toBe(false);
    expect(deployHandoffStatus(entry.state)).toMatchObject({
      state: "idle",
      attempts: 0
    });
  });

  it("keeps an agent redeploy owned by the repair loop it came from", () => {
    const entry = failedEntry();
    beginDeployAttempt(entry.state, {
      repo: "octo/app",
      branch: "feat",
      provider: "azure",
      environment: "dev",
      appFile: ".radius/app.bicep",
      repairLoop: true,
      attemptId: "attempt-A"
    });
    expect(entry.state.deployRepairing).toBe(true);
    expect(deployHandoffStatus(entry.state)).toMatchObject({
      state: "delivered"
    });
    // The loop keeps one identity across its retries, so the agent's next
    // status call is not told its own attempt is inactive.
    expect(entry.state.deployAttempt?.id).toBe("attempt-A");
  });

  it("hands off a failed first agent deploy, which opens no repair loop", async () => {
    // Regression: radius_deploy sets agentInitiated on every call, so keying
    // ownership off that flag pre-marked a first agent deploy as repairing and
    // triggerDeployRepairHandoff bailed out — the agent never learned it failed.
    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
    });
    const entry = failedEntry();
    beginDeployAttempt(entry.state, {
      repo: "octo/app",
      branch: "feat",
      provider: "azure",
      environment: "dev",
      appFile: ".radius/app.bicep",
      repairLoop: false
    });
    entry.state.deployStatus = "failed";
    expect(entry.state.deployRepairing).toBe(false);
    expect(triggerDeployRepairHandoff(entry)).toBe(true);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it("carries the delivery budget across a repair loop but resets it otherwise", () => {
    // The budget belongs to the loop: resetting it on every redeploy let an
    // undeliverable handoff retry past DEPLOY_HANDOFF_MAX_ATTEMPTS forever.
    const entry = failedEntry();
    const input = {
      repo: "octo/app",
      branch: "feat",
      provider: "azure",
      environment: "dev",
      appFile: ".radius/app.bicep"
    };
    entry.state.deployHandoffAttempts = 2;
    beginDeployAttempt(entry.state, {
      ...input,
      repairLoop: true,
      attemptId: "attempt-A"
    });
    expect(entry.state.deployHandoffAttempts).toBe(2);
    beginDeployAttempt(entry.state, { ...input, repairLoop: false });
    expect(entry.state.deployHandoffAttempts).toBe(0);
  });

  it("advances the repair count on a loop redeploy and resets it on a new deploy", () => {
    // The count has to move exactly as resolveDeployRepairLoop projected it,
    // or the number reported to the agent would not be the one the next call
    // is checked against.
    const entry = failedEntry();
    const input = {
      repo: "octo/app",
      branch: "feat",
      provider: "azure",
      environment: "dev",
      appFile: ".radius/app.bicep"
    };
    entry.state.deployRepairAttempts = 1;
    beginDeployAttempt(entry.state, {
      ...input,
      repairLoop: true,
      attemptId: "attempt-A"
    });
    expect(entry.state.deployRepairAttempts).toBe(2);
    beginDeployAttempt(entry.state, { ...input, repairLoop: false });
    expect(entry.state.deployRepairAttempts).toBe(0);
  });

  it("resets the failure-notice state so a reused panel can relay a later failure", () => {
    // A canvas panel's CanvasState is reused across deploys. The notice has no
    // repair loop to inherit a budget from, so every new attempt — repair loop
    // or not — must clear a prior "delivered"/"failed" notice. Otherwise
    // triggerDeployFailureNotice would bail at its guard and a later
    // run-unconfirmed failure on the same panel would never reach chat.
    const entry = failedEntry();
    const input = {
      repo: "octo/app",
      branch: "feat",
      provider: "azure",
      environment: "dev",
      appFile: ".radius/app.bicep"
    };
    entry.state.deployNoticeState = "delivered";
    entry.state.deployNoticeAttempts = 3;
    beginDeployAttempt(entry.state, { ...input, repairLoop: false });
    expect(entry.state.deployNoticeState).toBe("idle");
    expect(entry.state.deployNoticeAttempts).toBe(0);
    entry.state.deployNoticeState = "failed";
    entry.state.deployNoticeAttempts = 3;
    beginDeployAttempt(entry.state, {
      ...input,
      repairLoop: true,
      attemptId: "attempt-A"
    });
    expect(entry.state.deployNoticeState).toBe("idle");
    expect(entry.state.deployNoticeAttempts).toBe(0);
  });

  describe("resolveDeployRepairLoop", () => {
    it("treats a deploy with no attempt as an ordinary deploy", () => {
      expect(
        resolveDeployRepairLoop(
          { deployAttempt: { id: "attempt-A" } } as CanvasState,
          ""
        )
      ).toEqual({ repairLoop: false, attemptId: "", repairAttempt: 0 });
      expect(resolveDeployRepairLoop({} as CanvasState, undefined)).toEqual({
        repairLoop: false,
        attemptId: "",
        repairAttempt: 0
      });
    });

    it("keeps a redeploy on the attempt it was handed so the loop stays addressable", () => {
      expect(
        resolveDeployRepairLoop(
          {
            deployAttempt: { id: "attempt-A" },
            deployStatus: "failed"
          } as CanvasState,
          "attempt-A"
        )
      ).toEqual({ repairLoop: true, attemptId: "attempt-A", repairAttempt: 1 });
    });

    it("rejects a stale repair rather than letting it clobber a newer deploy", () => {
      // The tool validated the attempt before POSTing, but a newer deploy can
      // start in between. Re-checking server-side keeps that race from marking
      // the newer deploy as already owned and swallowing its handoff.
      const stale = resolveDeployRepairLoop(
        { deployAttempt: { id: "attempt-B" } } as CanvasState,
        "attempt-A"
      );
      expect(stale.repairLoop).toBe(false);
      expect(stale.attemptId).toBe("");
      expect(stale.error).toMatch(/no longer the current attempt/);
    });

    it("rejects an attempt-bound deploy when the panel holds no attempt", () => {
      const orphan = resolveDeployRepairLoop({} as CanvasState, "attempt-A");
      expect(orphan.repairLoop).toBe(false);
      expect(orphan.error).toMatch(/no longer the current attempt/);
    });

    it("counts each redeploy in the loop so the agent is told its budget", () => {
      expect(
        resolveDeployRepairLoop(
          {
            deployAttempt: { id: "attempt-A" },
            deployStatus: "failed",
            deployRepairAttempts: 2
          } as CanvasState,
          "attempt-A"
        ).repairAttempt
      ).toBe(3);
    });

    it("refuses a redeploy past the repair cap instead of dispatching another run", () => {
      // The cap is stated in the handoff prompt, but prompt text is only an
      // instruction: enforcing it here is what actually stops a runaway loop,
      // and refusing before dispatch means it costs no workflow run.
      const spent = resolveDeployRepairLoop(
        {
          deployAttempt: { id: "attempt-A" },
          deployStatus: "failed",
          deployRepairAttempts: DEPLOY_REPAIR_ATTEMPT_CAP
        } as CanvasState,
        "attempt-A"
      );
      expect(spent.error).toMatch(/already used its/);
      // Every error branch reports not-a-loop, so a caller that reads
      // repairLoop before error cannot turn a refusal into a live loop.
      expect(spent.repairLoop).toBe(false);
      expect(spent.error).toContain(String(DEPLOY_REPAIR_ATTEMPT_CAP));
    });

    it("allows the final attempt within the cap", () => {
      expect(
        resolveDeployRepairLoop(
          {
            deployAttempt: { id: "attempt-A" },
            deployStatus: "failed",
            deployRepairAttempts: DEPLOY_REPAIR_ATTEMPT_CAP - 1
          } as CanvasState,
          "attempt-A"
        ).error
      ).toBeUndefined();
    });

    it("refuses a redeploy while the attempt is still running", () => {
      // Otherwise a duplicate call would dispatch a second workflow run and a
      // second monitor over the same state.
      const running = resolveDeployRepairLoop(
        {
          deployAttempt: { id: "attempt-A" },
          deployStatus: "in_progress"
        } as CanvasState,
        "attempt-A"
      );
      expect(running.repairLoop).toBe(false);
      expect(running.repairAttempt).toBe(0);
      expect(running.error).toMatch(/still running/);
    });

    it("refuses a redeploy when the run's outcome was never confirmed", () => {
      // The timeout path sets deployStatus to "failed" while saying the run may
      // still be going, and a dispatch of unknown outcome does the same. Without
      // this, an attempt-bound retry would sail through the failed check and
      // race a second workflow against the same target.
      const lost = resolveDeployRepairLoop(
        {
          deployAttempt: { id: "attempt-A" },
          deployStatus: "failed",
          deployErrorKind: DEPLOY_RUN_UNCONFIRMED_KIND,
          deployRunUrl: "https://github.com/acme/widgets/actions/runs/7"
        } as CanvasState,
        "attempt-A"
      );
      expect(lost.repairLoop).toBe(false);
      expect(lost.repairAttempt).toBe(0);
      expect(lost.error).toMatch(/may still be in flight/);
      // The handoff told the agent to keep passing this id; the way out has to
      // be spelled out or it will keep addressing an attempt that can never be
      // repaired, because its outcome will never be confirmed.
      expect(lost.error).toMatch(/without an attemptId/);
      expect(lost.error).toContain(
        "https://github.com/acme/widgets/actions/runs/7"
      );
    });

    it("still repairs a confirmed failure that carries an unrelated error kind", () => {
      expect(
        resolveDeployRepairLoop(
          {
            deployAttempt: { id: "attempt-A" },
            deployStatus: "failed",
            deployErrorKind: "branch-not-pushed"
          } as CanvasState,
          "attempt-A"
        )
      ).toEqual({ repairLoop: true, attemptId: "attempt-A", repairAttempt: 1 });
    });

    it("refuses a redeploy on an attempt that already succeeded", () => {
      // The attempt stays current after it settles and the agent keeps passing
      // its id, so reuse has to be sent down the new-deploy path: a loop
      // redeploy is marked agent-owned, which would suppress the handoff if
      // this one failed.
      const done = resolveDeployRepairLoop(
        {
          deployAttempt: { id: "attempt-A" },
          deployStatus: "complete",
          deployRepairAttempts: 2
        } as CanvasState,
        "attempt-A"
      );
      expect(done.repairLoop).toBe(false);
      expect(done.error).toMatch(/without an attemptId/);
    });
  });

  it("drops a scheduled retry when a new deploy starts during the backoff", async () => {
    vi.useFakeTimers();
    try {
      const calls: DeployRepairHandoffInput[] = [];
      setDeployRepairHandoff((payload) => {
        calls.push(payload);
        return Promise.reject(new Error("send failed"));
      });
      const entry = failedEntry();
      expect(triggerDeployRepairHandoff(entry)).toBe(true);
      await Promise.resolve();
      expect(calls).toHaveLength(1);
      expect(deployHandoffStatus(entry.state)).toMatchObject({
        state: "retryable",
        attempts: 1
      });

      // The backoff is its own window for the user to start a new deploy, and
      // that deploy can fail fast enough to land back in the handoff window.
      entry.state.deployRepairing = false;
      entry.state.deployHandoffState = "idle";
      entry.state.deployHandoffAttempts = 0;
      entry.state.deployAttempt = { id: "attempt-B" };

      await vi.advanceTimersByTimeAsync(DEPLOY_HANDOFF_RETRY_DELAY_MS * 2);

      // The retry belonged to attempt-A, so it must not re-send that attempt's
      // payload against attempt-B or consume attempt-B's budget.
      expect(calls).toHaveLength(1);
      expect(deployHandoffStatus(entry.state)).toMatchObject({
        state: "idle",
        attempts: 0
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries from the server when nothing polls the status route", async () => {
    vi.useFakeTimers();
    try {
      const calls: DeployRepairHandoffInput[] = [];
      setDeployRepairHandoff((payload) => {
        calls.push(payload);
        return Promise.reject(new Error("send failed"));
      });
      const entry = failedEntry();
      expect(triggerDeployRepairHandoff(entry)).toBe(true);
      await Promise.resolve();
      expect(calls).toHaveLength(1);

      // No status poll happens here; the retry has to come from the timer.
      await vi.advanceTimersByTimeAsync(DEPLOY_HANDOFF_RETRY_DELAY_MS);
      expect(calls).toHaveLength(2);
      expect(deployHandoffStatus(entry.state)).toMatchObject({
        state: "retryable",
        attempts: 2
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("triggerDeployFailureNotice", () => {
  afterEach(() => {
    setDeployFailureNotice(null);
  });

  function unconfirmedEntry(overrides: Partial<CanvasState> = {}) {
    return {
      state: {
        deployStatus: "failed",
        deployErrorKind: DEPLOY_RUN_UNCONFIRMED_KIND,
        deployingRepo: "octo/app",
        deployingBranch: "feat",
        deployError: "dispatch rejected: missing workflow scope",
        deployRunUrl: "https://github.com/octo/app/actions",
        deployAttempt: { id: "attempt-A" },
        ...overrides
      } satisfies CanvasState
    };
  }

  it("reports a run-unconfirmed failure to the agent with repo, branch, error, run URL, and instance", () => {
    const calls: DeployFailureNoticeInput[] = [];
    setDeployFailureNotice((payload) => {
      calls.push(payload);
    });
    expect(triggerDeployFailureNotice(unconfirmedEntry(), "radius-panel")).toBe(
      true
    );
    expect(calls).toEqual([
      {
        repo: "octo/app",
        branch: "feat",
        error: "dispatch rejected: missing workflow scope",
        deployRunUrl: "https://github.com/octo/app/actions",
        instanceId: "radius-panel"
      }
    ]);
  });

  it("never opens a repair loop, so the panel does not show a repairing note", async () => {
    setDeployFailureNotice(() => Promise.resolve("message-id"));
    const entry = unconfirmedEntry();
    expect(triggerDeployFailureNotice(entry)).toBe(true);
    await Promise.resolve();
    expect(entry.state.deployRepairing).toBeUndefined();
    expect(entry.state.deployHandoffState).toBeUndefined();
    expect(entry.state.deployNoticeState).toBe("delivered");
  });

  it("fires once per failure so a re-poll does not report it twice", () => {
    const calls: DeployFailureNoticeInput[] = [];
    setDeployFailureNotice((payload) => {
      calls.push(payload);
    });
    const entry = unconfirmedEntry();
    expect(triggerDeployFailureNotice(entry)).toBe(true);
    expect(triggerDeployFailureNotice(entry)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("relays a second failure on a reused panel after a new deploy begins", async () => {
    // The panel is reused across deploys. Once the first notice is delivered,
    // its guard would silence every later failure — beginDeployAttempt clears
    // the notice state, so a second run-unconfirmed failure still reaches chat.
    const calls: DeployFailureNoticeInput[] = [];
    setDeployFailureNotice((payload) => {
      calls.push(payload);
      return Promise.resolve("message-id");
    });
    const entry = unconfirmedEntry();
    expect(triggerDeployFailureNotice(entry)).toBe(true);
    await Promise.resolve();
    expect(entry.state.deployNoticeState).toBe("delivered");
    beginDeployAttempt(entry.state, {
      repo: "octo/app",
      branch: "feat",
      provider: "azure",
      environment: "dev",
      appFile: ".radius/app.bicep",
      repairLoop: false
    });
    entry.state.deployStatus = "failed";
    entry.state.deployErrorKind = DEPLOY_RUN_UNCONFIRMED_KIND;
    expect(triggerDeployFailureNotice(entry)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("does not report a repairable failure, which the repair handoff owns", () => {
    const calls: DeployFailureNoticeInput[] = [];
    setDeployFailureNotice((payload) => {
      calls.push(payload);
    });
    // A modeling failure has no run-unconfirmed kind; the repair handoff relays it.
    expect(
      triggerDeployFailureNotice(unconfirmedEntry({ deployErrorKind: null }))
    ).toBe(false);
    // Branch-not-pushed has its own actionable canvas panel, so no chat report.
    expect(
      triggerDeployFailureNotice(
        unconfirmedEntry({ deployErrorKind: DEPLOY_BRANCH_NOT_PUSHED_KIND })
      )
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does not report unless the deploy actually failed", () => {
    const calls: DeployFailureNoticeInput[] = [];
    setDeployFailureNotice((payload) => {
      calls.push(payload);
    });
    expect(
      triggerDeployFailureNotice(
        unconfirmedEntry({ deployStatus: "in_progress" })
      )
    ).toBe(false);
    expect(triggerDeployFailureNotice(undefined)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does nothing when no notice callback is registered", () => {
    setDeployFailureNotice(null);
    expect(triggerDeployFailureNotice(unconfirmedEntry())).toBe(false);
  });

  it("falls back through planned then context repo and omits absent details", () => {
    const calls: DeployFailureNoticeInput[] = [];
    setDeployFailureNotice((payload) => {
      calls.push(payload);
    });
    // No deployingRepo/branch/error/runUrl: the payload must fall back to the
    // planned/context repo and empty strings rather than carry undefined.
    expect(
      triggerDeployFailureNotice({
        state: {
          deployStatus: "failed",
          deployErrorKind: DEPLOY_RUN_UNCONFIRMED_KIND,
          plannedRepo: "octo/planned"
        }
      })
    ).toBe(true);
    expect(calls[0]).toMatchObject({
      repo: "octo/planned",
      branch: "",
      error: "",
      deployRunUrl: ""
    });

    calls.length = 0;
    triggerDeployFailureNotice({
      state: {
        deployStatus: "failed",
        deployErrorKind: DEPLOY_RUN_UNCONFIRMED_KIND,
        contextRepo: "octo/context"
      }
    });
    expect(calls[0]).toMatchObject({ repo: "octo/context" });

    // No repo anywhere: the payload carries an empty repo, never undefined.
    calls.length = 0;
    triggerDeployFailureNotice({
      state: {
        deployStatus: "failed",
        deployErrorKind: DEPLOY_RUN_UNCONFIRMED_KIND
      }
    });
    expect(calls[0]).toMatchObject({ repo: "" });
  });

  it("never throws when the notice callback itself fails", () => {
    setDeployFailureNotice(() => {
      throw new Error("session gone");
    });
    expect(() => triggerDeployFailureNotice(unconfirmedEntry())).not.toThrow();
  });

  it("never throws if recording the notice bookkeeping fails", () => {
    // A frozen state makes the deployNoticeState assignment throw before the
    // callback runs; the defensive outer guard must swallow it.
    setDeployFailureNotice(() => {
      throw new Error("must not be reached");
    });
    const entry = { state: Object.freeze(unconfirmedEntry().state) };
    expect(triggerDeployFailureNotice(entry)).toBe(false);
  });

  it("retries delivery on the next status poll when the first send rejects", async () => {
    const entry = unconfirmedEntry();
    setDeployFailureNotice(() => Promise.reject(new Error("send failed")));
    expect(triggerDeployFailureNotice(entry)).toBe(true);
    await Promise.resolve();
    expect(entry.state.deployNoticeState).toBe("retryable");
    expect(entry.state.deployNoticeAttempts).toBe(1);

    const calls: DeployFailureNoticeInput[] = [];
    setDeployFailureNotice((payload) => {
      calls.push(payload);
      return Promise.resolve("message-id");
    });
    expect(triggerDeployFailureNotice(entry)).toBe(true);
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(entry.state.deployNoticeState).toBe("delivered");
  });

  it("gives up after the attempt budget so the report is not retried forever", async () => {
    const entry = unconfirmedEntry();
    setDeployFailureNotice(() => Promise.reject(new Error("send failed")));
    for (let i = 0; i < DEPLOY_HANDOFF_MAX_ATTEMPTS; i++) {
      triggerDeployFailureNotice(entry);
      await Promise.resolve();
    }
    expect(entry.state.deployNoticeState).toBe("failed");
    expect(entry.state.deployNoticeAttempts).toBe(DEPLOY_HANDOFF_MAX_ATTEMPTS);
    // Terminal: no further delivery is attempted.
    expect(triggerDeployFailureNotice(entry)).toBe(false);
  });

  it("does not deliver twice while a send is still in flight", () => {
    const calls: DeployFailureNoticeInput[] = [];
    setDeployFailureNotice((payload) => {
      calls.push(payload);
      return new Promise(() => {});
    });
    const entry = unconfirmedEntry();
    expect(triggerDeployFailureNotice(entry)).toBe(true);
    expect(triggerDeployFailureNotice(entry)).toBe(false);
    expect(calls).toHaveLength(1);
    expect(entry.state.deployNoticeState).toBe("pending");
  });

  // A canvas panel is reused across deploys, so a late delivery must settle
  // against whatever deploy is current, not the one that opened the notice.
  it("ignores a delivery that lands after a new deploy replaced the attempt", async () => {
    let resolveSend: (value: string) => void = () => {};
    setDeployFailureNotice(
      () =>
        new Promise<string>((resolve) => {
          resolveSend = resolve;
        })
    );
    const entry = unconfirmedEntry();
    expect(triggerDeployFailureNotice(entry)).toBe(true);

    entry.state.deployStatus = "in_progress";
    entry.state.deployNoticeState = "idle";
    entry.state.deployNoticeAttempts = 0;
    entry.state.deployAttempt = { id: "attempt-B" };

    resolveSend("message-id");
    await Promise.resolve();

    expect(entry.state.deployNoticeState).toBe("idle");
    expect(entry.state.deployNoticeAttempts).toBe(0);
  });

  it("ignores a rejection that lands after a new deploy replaced the attempt", async () => {
    let rejectSend: (reason: Error) => void = () => {};
    setDeployFailureNotice(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectSend = reject;
        })
    );
    const entry = unconfirmedEntry();
    expect(triggerDeployFailureNotice(entry)).toBe(true);

    entry.state.deployStatus = "in_progress";
    entry.state.deployNoticeState = "idle";
    entry.state.deployNoticeAttempts = 0;
    entry.state.deployAttempt = { id: "attempt-B" };

    rejectSend(new Error("send failed"));
    await Promise.resolve();

    expect(entry.state.deployNoticeState).toBe("idle");
    expect(entry.state.deployNoticeAttempts).toBe(0);
  });

  // Falls back to the run-unconfirmed kind if the state somehow lost its kind
  // between the guard and the payload assembly.
  it("still settles a notice opened without an attempt id", async () => {
    setDeployFailureNotice(() => Promise.resolve("message-id"));
    const entry = unconfirmedEntry({ deployAttempt: undefined });
    expect(triggerDeployFailureNotice(entry)).toBe(true);
    await Promise.resolve();
    expect(entry.state.deployNoticeState).toBe("delivered");
  });

  it("retries from the server when nothing polls the status route", async () => {
    vi.useFakeTimers();
    try {
      const calls: DeployFailureNoticeInput[] = [];
      setDeployFailureNotice((payload) => {
        calls.push(payload);
        return Promise.reject(new Error("send failed"));
      });
      const entry = unconfirmedEntry();
      expect(triggerDeployFailureNotice(entry)).toBe(true);
      await Promise.resolve();
      expect(calls).toHaveLength(1);

      // No status poll happens here; the retry has to come from the timer.
      await vi.advanceTimersByTimeAsync(DEPLOY_HANDOFF_RETRY_DELAY_MS);
      expect(calls).toHaveLength(2);
      expect(entry.state.deployNoticeState).toBe("retryable");
      expect(entry.state.deployNoticeAttempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a scheduled retry when a new deploy starts during the backoff", async () => {
    vi.useFakeTimers();
    try {
      const calls: DeployFailureNoticeInput[] = [];
      setDeployFailureNotice((payload) => {
        calls.push(payload);
        return Promise.reject(new Error("send failed"));
      });
      const entry = unconfirmedEntry();
      expect(triggerDeployFailureNotice(entry)).toBe(true);
      await Promise.resolve();
      expect(calls).toHaveLength(1);

      // A new deploy during the backoff must revoke the scheduled retry.
      entry.state.deployNoticeState = "idle";
      entry.state.deployNoticeAttempts = 0;
      entry.state.deployAttempt = { id: "attempt-B" };

      await vi.advanceTimersByTimeAsync(DEPLOY_HANDOFF_RETRY_DELAY_MS * 2);

      expect(calls).toHaveLength(1);
      expect(entry.state.deployNoticeState).toBe("idle");
      expect(entry.state.deployNoticeAttempts).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isCliCommandMissing", () => {
  it("recognizes common missing-command errors", () => {
    expect(isCliCommandMissing("spawn az ENOENT")).toBe(true);
    expect(isCliCommandMissing("spawn az.exe ENOENT")).toBe(true);
    expect(isCliCommandMissing("/bin/sh: az: command not found")).toBe(true);
    expect(
      isCliCommandMissing(
        "'az' is not recognized as an internal or external command"
      )
    ).toBe(true);
  });

  it("does not treat ordinary auth or runtime failures as a missing CLI", () => {
    expect(isCliCommandMissing("Please run 'az login' to setup account.")).toBe(
      false
    );
    expect(isCliCommandMissing("ERROR: The subscription was not found.")).toBe(
      false
    );
    expect(
      isCliCommandMissing(
        "Failed to read token cache: No such file or directory"
      )
    ).toBe(false);
    expect(isCliCommandMissing("Token cache failed with ENOENT")).toBe(false);
    expect(isCliCommandMissing("helper: command not found")).toBe(false);
    expect(isCliCommandMissing("")).toBe(false);
  });
});

describe("azureCredentialIdValidationError", () => {
  const tenantId = "11111111-2222-3333-4444-555555555555";
  const subscriptionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("accepts valid or omitted credential identifiers", () => {
    expect(azureCredentialIdValidationError({ tenantId, subscriptionId })).toBe(
      ""
    );
    expect(azureCredentialIdValidationError()).toBe("");
  });

  it("rejects an invalid tenant before generating login guidance", () => {
    expect(
      azureCredentialIdValidationError({
        tenantId: "not-a-guid",
        subscriptionId
      })
    ).toBe('Invalid tenantId "not-a-guid" (expected a GUID).');
  });

  it("rejects an invalid subscription before invoking Azure CLI", () => {
    expect(
      azureCredentialIdValidationError({
        tenantId,
        subscriptionId: "not-a-guid"
      })
    ).toBe('Invalid subscriptionId "not-a-guid" (expected a GUID).');
  });
});

describe("azureLoginRequiredResponse", () => {
  const tenantId = "11111111-2222-3333-4444-555555555555";

  it("returns structured login guidance for an unauthenticated session", () => {
    expect(azureLoginRequiredResponse({ tenantId })).toEqual({
      error:
        'No active Azure session. Run "az login --use-device-code" in your terminal, then click Verify Credentials again.',
      code: "az-login-required",
      tenantId
    });
  });

  it("returns structured tenant-specific guidance for the wrong active tenant", () => {
    const response = azureLoginRequiredResponse({
      tenantId,
      activeTenantId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    });
    expect(response.code).toBe("az-login-required");
    expect(response.tenantId).toBe(tenantId);
    expect(response.error).toContain(`--tenant ${tenantId}`);
  });
});

describe("invokeSessionPrompt", () => {
  it("waits for the session prompt handler to finish", async () => {
    let completed = false;
    const result = await invokeSessionPrompt(async () => {
      await Promise.resolve();
      completed = true;
    }, "prompt");
    expect(completed).toBe(true);
    expect(result).toEqual({ status: 200 });
  });

  it("surfaces unavailable and rejected handlers as server errors", async () => {
    await expect(invokeSessionPrompt(null, "prompt")).resolves.toEqual({
      status: 503,
      error: "Could not reach the Copilot session to start Azure CLI help."
    });
    await expect(
      invokeSessionPrompt(async () => {
        throw new Error("send failed");
      }, "prompt")
    ).resolves.toEqual({
      status: 502,
      error: "The Copilot session could not start Azure CLI help."
    });
  });

  it("forwards a paired prompt/displayPrompt message to the handler untouched", async () => {
    const seen: unknown[] = [];
    const message = {
      prompt: "run az login …",
      displayPrompt: "Signing in to Azure CLI."
    };
    const result = await invokeSessionPrompt(async (value) => {
      seen.push(value);
    }, message);
    expect(seen).toEqual([message]);
    expect(result).toEqual({ status: 200 });
  });
});

describe("buildAzureCliAssistPrompt", () => {
  it("builds a login prompt with the requested tenant when it is a valid guid", () => {
    const prompt = buildAzureCliAssistPrompt({
      action: "login",
      tenantId: "11111111-2222-3333-4444-555555555555"
    });
    expect(prompt).toContain(
      "Run `az login --use-device-code --tenant 11111111-2222-3333-4444-555555555555`"
    );
    expect(prompt).toContain(
      "remove COPILOT_AGENT_SESSION_ID from the az process environment"
    );
    expect(prompt).toContain("show me the device code and sign-in URL");
    expect(prompt).toContain("click Verify Credentials again");
  });

  it("falls back to tenant-agnostic device-code login for invalid tenant ids", () => {
    const prompt = buildAzureCliAssistPrompt({
      action: "login",
      tenantId: "not-a-guid"
    });
    expect(prompt).toContain("Run `az login --use-device-code`");
    expect(prompt).not.toContain("--tenant not-a-guid");
  });

  it("builds install guidance when Azure CLI is missing", () => {
    const prompt = buildAzureCliAssistPrompt({ action: "install" });
    expect(prompt).toContain("Azure CLI is not installed");
    expect(prompt).toContain("install Azure CLI");
  });
});

describe("azureCliAssistDisplayPrompt", () => {
  it("summarizes the login case without the command or environment mechanics", () => {
    const display = azureCliAssistDisplayPrompt({
      action: "login",
      tenantId: "11111111-2222-3333-4444-555555555555"
    });
    expect(display).toBe(
      "Signing in to Azure CLI so the Radius canvas can verify these Azure credentials."
    );
    expect(display).not.toContain("az login");
    expect(display).not.toContain("COPILOT_AGENT_SESSION_ID");
    // A tenant guid is internal detail; it must not leak into the timeline.
    expect(display).not.toContain("11111111");
  });

  it("summarizes the install case", () => {
    expect(azureCliAssistDisplayPrompt({ action: "install" })).toContain(
      "Installing Azure CLI"
    );
  });
});

describe("azureCliAssistMessage", () => {
  // Issue #209: the canvas injects this turn on the user's behalf, so the
  // timeline must not show the multi-paragraph instructions as if the user
  // typed them, while the agent still receives them in full.
  it("pairs the full agent prompt with its short display stand-in", () => {
    const input = {
      action: "login",
      tenantId: "11111111-2222-3333-4444-555555555555"
    };
    const message = azureCliAssistMessage(input);
    expect(message.prompt).toBe(buildAzureCliAssistPrompt(input));
    expect(message.displayPrompt).toBe(azureCliAssistDisplayPrompt(input));
    expect(message.prompt).toContain("COPILOT_AGENT_SESSION_ID");
    expect(message.displayPrompt).not.toContain("COPILOT_AGENT_SESSION_ID");
    expect(message.displayPrompt.length).toBeLessThan(message.prompt.length);
  });
});

describe("deploy failures that may leave a run in flight", () => {
  it("treats an unresolved ref as proof that no run was created", () => {
    for (const stderr of [
      "No ref found for: feature-branch",
      "could not resolve to a Repository",
      "no commit found for the ref feature-branch"
    ])
      expect(classifyDeployDispatchFailure(stderr)).toBe(
        DEPLOY_BRANCH_NOT_PUSHED_KIND
      );
  });

  it("treats every other dispatch failure as a run that may exist", () => {
    // A non-zero exit is not proof GitHub created nothing: the request can be
    // accepted and the answer lost, and the token-scope retry can dispatch
    // twice. Guessing "no run" here is what starts a duplicate.
    for (const stderr of [
      "",
      "HTTP 504: Gateway Timeout",
      'missing required scope "workflow"',
      "context deadline exceeded"
    ])
      expect(classifyDeployDispatchFailure(stderr)).toBe(
        DEPLOY_RUN_UNCONFIRMED_KIND
      );
  });

  // The companion assertion — that every failure the monitor reports without a
  // confirmed outcome marks itself `run-unconfirmed` — used to be a
  // source-text probe over the `/api/deploy` legacy arm. It is now executed
  // against the extracted services instead, where each path is reachable:
  //   * no run found and the monitor's poll cap:
  //     `server/services/deploy-monitor.test.ts`
  //   * the monitor stopping unexpectedly:
  //     `server/services/deploy-request.test.ts` and
  //     `test/integration/http/deployments.test.ts`
  //   * the dispatch failure taking its kind from the classifier above:
  //     `server/services/deploy-dispatch.test.ts`
  // A confirmed workflow failure is deliberately excluded from that set — it is
  // the only kind a repair may act on.
});
