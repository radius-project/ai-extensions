import { describe, it, expect, afterEach, vi } from "vitest";
import {
  addGraphProgress,
  beginDeployAttempt,
  azureCredentialIdValidationError,
  azureLoginRequiredResponse,
  buildRoleAssignmentArgs,
  buildAzureCliAssistPrompt,
  azureCliAssistDisplayPrompt,
  azureCliAssistMessage,
  cleanupAzureSetupArtifacts,
  canReuseModeledGraph,
  deleteNewlyCreatedGitHubEnvironment,
  deployHandoffStatus,
  DEPLOY_HANDOFF_MAX_ATTEMPTS,
  DEPLOY_HANDOFF_RETRY_DELAY_MS,
  endChildInput,
  ensureServicePrincipal,
  finalizeSetupFailure,
  findFederatedCredentialNameCollision,
  graphDefinitionHash,
  isCrossSiteMutation,
  isCliCommandMissing,
  isCurrentSourceRefToken,
  isReplicationLagError,
  invokeSessionPrompt,
  pickAksResourceGroup,
  preflightGhcrPackageWriteAccess,
  resolveGitHubEnvironmentCreateState,
  resolveDeployStatus,
  resolveDeployRepairLoop,
  setDeployRepairHandoff,
  triggerDeployRepairHandoff,
  DEPLOY_MONITOR_LOST_KIND
} from "./server.js";
import { DEPLOY_REPAIR_ATTEMPT_CAP } from "./runtime/hooks.js";
import {
  createOperation,
  recordAzureApp,
  recordCommittedWorkflowFile,
  recordCreatedFederatedCredential,
  recordCreatedRoleAssignment,
  recordGitHubEnvironment,
  recordServicePrincipal
} from "./operations.js";
import {
  buildFederatedCredentialName,
  buildEnvironmentSuffix
} from "@radius-project/core";
import type { CanvasState } from "./shared.js";
import type { DeployRepairHandoffInput } from "./server.js";

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
  it("fails closed when the package credential username is blank", async () => {
    const result = await preflightGhcrPackageWriteAccess(
      async () => ({ token: "ghcr-token", username: "   " }),
      async () => ({
        actingLogin: "emuuser",
        displayLogin: "emuuser",
        mismatch: false,
        actingHasWorkflow: true,
        actingHasPackages: true,
        preferredLogin: null,
        reason: "user-selected-keyring-account",
        accounts: []
      })
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected GHCR preflight to fail");
    expect(result.code).toBe("ghcr-auth-failed");
    expect(result.error).toContain("Could not determine");
  });

  it("checks the specific GHCR credential login for write:packages", async () => {
    const result = await preflightGhcrPackageWriteAccess(
      async () => ({ token: "ghcr-token", username: "pubuser" }),
      async () => ({
        actingLogin: "emuuser",
        displayLogin: "emuuser",
        mismatch: false,
        actingHasWorkflow: true,
        actingHasPackages: true,
        preferredLogin: null,
        reason: "user-selected-keyring-account",
        accounts: [
          {
            login: "pubuser",
            hasWorkflow: true,
            hasPackages: false,
            switchable: true,
            acting: false
          },
          {
            login: "emuuser",
            hasWorkflow: true,
            hasPackages: true,
            switchable: true,
            acting: true
          }
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
        "--assignee-principal-type",
        "ServicePrincipal",
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
        "--assignee-principal-type",
        "ServicePrincipal",
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
        "--assignee-principal-type",
        "ServicePrincipal",
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
    const second = await cleanupAzureSetupArtifacts(op, {
      runAz: async () => ({
        code: 1,
        stdout: "",
        stderr:
          "Request_ResourceNotFound: Resource 'app-1' does not exist or one of its queried reference-property objects are not present."
      })
    });

    expect(second.state).toBe("succeeded");
    expect(op.setupArtifacts.cleanup).toMatchObject({
      state: "succeeded",
      attempts: 2
    });
    expect(
      op.setupArtifacts.cleanup.results.filter((r: any) => r.attempt === 2)
    ).toMatchObject([
      { artifactType: "service_principal", outcome: "not_found" },
      { artifactType: "azure_app", outcome: "not_found" }
    ]);
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
        "--assignee-principal-type",
        "ServicePrincipal",
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
        "--assignee-principal-type",
        "ServicePrincipal",
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

describe("isReplicationLagError", () => {
  it("treats Graph-replication 'principal not yet visible' errors as retryable", () => {
    for (const stderr of [
      "Principal <id> does not exist in the directory <tenant>.",
      "No matching principal found.",
      "PrincipalNotFound: Principal does not exist.",
      "Cannot find user or service principal in graph database for the given assignee.",
      "Cannot find principal in the directory.",
      "The assignee was not found in the directory."
    ]) {
      expect(isReplicationLagError(stderr), stderr).toBe(true);
    }
  });

  it("does NOT retry genuine authorization failures or empty errors", () => {
    expect(
      isReplicationLagError(
        "AuthorizationFailed: The client does not have authorization to perform action 'Microsoft.Authorization/roleAssignments/write'."
      )
    ).toBe(false);
    expect(isReplicationLagError("RoleAssignmentUpdateNotPermitted")).toBe(
      false
    );
    expect(isReplicationLagError("")).toBe(false);
    expect(isReplicationLagError(undefined)).toBe(false);
  });
});

describe("buildRoleAssignmentArgs", () => {
  it("assigns by SP object id with an explicit ServicePrincipal principal type (never by appId)", () => {
    const args = buildRoleAssignmentArgs({
      objectId: "00000000-obj-id",
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      subscriptionId: "sub"
    });
    expect(args).toContain("--assignee-object-id");
    expect(args[args.indexOf("--assignee-object-id") + 1]).toBe(
      "00000000-obj-id"
    );
    expect(args).toContain("--assignee-principal-type");
    expect(args[args.indexOf("--assignee-principal-type") + 1]).toBe(
      "ServicePrincipal"
    );
    // The appId-based form is what caused the replication race — never emit it.
    expect(args).not.toContain("--assignee");
    expect(
      args.slice(args.indexOf("--role"), args.indexOf("--role") + 2)
    ).toEqual(["--role", "Contributor"]);
    expect(
      args.slice(args.indexOf("--scope"), args.indexOf("--scope") + 2)
    ).toEqual(["--scope", "/subscriptions/sub/resourceGroups/rg"]);
  });
});

describe("findFederatedCredentialNameCollision", () => {
  // Prove the real name-collapse: two env names differing only by a char that
  // clean() normalizes ("prod:west" vs "prod-west") build the SAME FIC name but
  // DIFFERENT subjects (the subject keeps "%3A"). Emulates a reused app where
  // the colon env was set up first and the hyphen env is being added.
  const repoFullName = "octo/app";
  const colonName = buildFederatedCredentialName({
    repoFullName,
    envName: "prod:west"
  });
  const hyphenName = buildFederatedCredentialName({
    repoFullName,
    envName: "prod-west"
  });
  const colonSubject = `repo:${repoFullName}:${buildEnvironmentSuffix(
    "prod:west"
  )}`;
  const hyphenSubject = `repo:${repoFullName}:${buildEnvironmentSuffix(
    "prod-west"
  )}`;

  it("names collapse but subjects differ (guards the premise of the fix)", () => {
    expect(hyphenName).toBe(colonName);
    expect(hyphenSubject).not.toBe(colonSubject);
  });

  it("flags a name that already exists with a different subject", () => {
    const desired = [{ name: hyphenName, subject: hyphenSubject }];
    const existing = new Map([[colonName, colonSubject]]);
    const hit = findFederatedCredentialNameCollision(desired, existing);
    expect(hit).not.toBeNull();
    if (!hit) throw new Error("expected a credential collision");
    expect(hit.name).toBe(hyphenName);
    expect(hit.existingSubject).toBe(colonSubject);
    expect(hit.desiredSubject).toBe(hyphenSubject);
  });

  it("returns null when the same name maps to the same subject (true idempotent rerun)", () => {
    const desired = [{ name: colonName, subject: colonSubject }];
    const existing = new Map([[colonName, colonSubject]]);
    expect(findFederatedCredentialNameCollision(desired, existing)).toBeNull();
  });

  it("returns null when the name is not present at all", () => {
    const desired = [{ name: hyphenName, subject: hyphenSubject }];
    expect(findFederatedCredentialNameCollision(desired, new Map())).toBeNull();
  });

  it("accepts a plain object map as well as a Map", () => {
    const desired = [{ name: hyphenName, subject: hyphenSubject }];
    const hit = findFederatedCredentialNameCollision(desired, {
      [colonName]: colonSubject
    });
    expect(hit && hit.name).toBe(hyphenName);
  });

  it("is null-safe on empty or missing inputs", () => {
    expect(findFederatedCredentialNameCollision(null, new Map())).toBeNull();
    expect(findFederatedCredentialNameCollision([], null)).toBeNull();
    expect(
      findFederatedCredentialNameCollision(
        [{ subject: "s" }],
        new Map([["n", "x"]])
      )
    ).toBeNull();
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

describe("pickAksResourceGroup", () => {
  // The AKS Cluster Admin grant must be scoped to the resource group that
  // actually holds the cluster, which can differ from the deployment RG the
  // user selected. pickAksResourceGroup prefers the cluster's discovered RG.
  it("prefers the cluster's own resource group over the deployment RG", () => {
    expect(pickAksResourceGroup("rg-cluster", "rg-deploy")).toBe("rg-cluster");
  });

  it("falls back to the deployment RG when the cluster RG is absent", () => {
    expect(pickAksResourceGroup("", "rg-deploy")).toBe("rg-deploy");
    expect(pickAksResourceGroup(undefined, "rg-deploy")).toBe("rg-deploy");
    expect(pickAksResourceGroup(null, "rg-deploy")).toBe("rg-deploy");
  });

  it("trims whitespace and falls back on a blank cluster RG", () => {
    expect(pickAksResourceGroup("  rg-cluster  ", "rg-deploy")).toBe(
      "rg-cluster"
    );
    expect(pickAksResourceGroup("   ", "rg-deploy")).toBe("rg-deploy");
  });

  it("ignores non-string cluster RG values", () => {
    expect(pickAksResourceGroup(123, "rg-deploy")).toBe("rg-deploy");
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

    it("refuses a redeploy when monitoring was lost, since the run may still be live", () => {
      // The timeout path sets deployStatus to "failed" while saying the run may
      // still be going. Without this, an attempt-bound retry would sail through
      // the failed check and race a second workflow against the same target.
      const lost = resolveDeployRepairLoop(
        {
          deployAttempt: { id: "attempt-A" },
          deployStatus: "failed",
          deployErrorKind: DEPLOY_MONITOR_LOST_KIND,
          deployRunUrl: "https://github.com/acme/widgets/actions/runs/7"
        } as CanvasState,
        "attempt-A"
      );
      expect(lost.repairLoop).toBe(false);
      expect(lost.repairAttempt).toBe(0);
      expect(lost.error).toMatch(/may still be running/);
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
