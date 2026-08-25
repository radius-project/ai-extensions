import { describe, it, expect, afterEach, vi } from "vitest";
import { remediationView } from "@radius-project/core";
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
  cleanupProviderRecoveryDisposition,
  cleanupGitHubEnvironmentArtifact,
  rollbackCommittedWorkflowFiles,
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
  environmentsApiPath,
  environmentNameFromApiPath,
  quarantineUnsettledCleanupDeletions,
  resetListingCaches,
  resetDeploymentViewState,
  resolveCleanupGitHubContext,
  releaseDeploymentMutation,
  reopenProviderReconciliation,
  resolveAcknowledgedVerificationRun,
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
  DEPLOY_OIDC_SUBJECT_CASE_MISMATCH_KIND,
  DEPLOY_RUN_UNCONFIRMED_KIND
} from "./server.js";
import { DEPLOY_REPAIR_ATTEMPT_CAP } from "./runtime/hooks.js";
import {
  createOperation,
  finish,
  prepareProviderMutation,
  settleProviderMutation,
  getSetupArtifactLedger,
  recordAzureApp,
  recordCleanupState,
  recordCommittedWorkflowFile,
  recordCreatedFederatedCredential,
  recordCreatedRoleAssignment,
  recordGitHubEnvironment,
  recordServicePrincipal,
  reconcileRestoredOperation,
  fromPersistedOperation,
  toPersistedOperation,
  unresolvedProviderMutations,
  providerRecoveryManualGuidance,
  hasUnfinishedCleanupAuthority,
  canStartRollback,
  canRetryCleanup,
  canExitSetup,
  requestStop,
  toClientView,
  cleanupTargetKey,
  unresolvedCleanupTargets
} from "./operations.js";
import type { CanvasState } from "./shared.js";
import type {
  DeployRepairHandoffInput,
  DeployFailureNoticeInput
} from "./server.js";
import type {
  GitHubIdentity,
  GitHubIdentityAccount,
  SelectedGhExecutor
} from "./gh.js";

describe("DEPLOY_RAD_COMMANDS_STEP", () => {
  it("matches the step name in the upstream run-rad-commands action", () => {
    // The deploy monitor gates all of its in-flight handling on finding a step
    // with this name. It previously read "Deploy Application", which exists
    // nowhere in radius-project/radius, so that entire code path never ran on
    // a real deploy. Pin the value so the same silent break cannot recur.
    expect(DEPLOY_RAD_COMMANDS_STEP).toBe("Run rad commands");
  });

  describe("resetListingCaches", () => {
    it("clears environment and deployment listing entries", () => {
      const environments = new Map([["octo/app", { environments: ["dev"] }]]);
      const deployments = new Map([["octo/app", { deployments: ["run-1"] }]]);

      resetListingCaches(environments, deployments);

      expect(environments.get("octo/app")).toBeUndefined();
      expect(deployments.get("octo/app")).toBeUndefined();
    });
  });
});

describe("verification dispatch recovery", () => {
  it("adopts an exact marked run after an acknowledged retry dispatch", async () => {
    const pauses: number[] = [];

    await expect(
      resolveAcknowledgedVerificationRun({
        operationMarker: "op_retry",
        pause: async (milliseconds) => {
          pauses.push(milliseconds);
        },
        discover: async () => ({ state: "applied", value: "4242" }),
        actionsUrl:
          "https://github.com/octo/app/actions/workflows/radius-verify.yml"
      })
    ).resolves.toEqual({ state: "applied", runId: "4242" });
    expect(pauses).toEqual([5000]);
  });

  it("fails closed when an acknowledged retry cannot expose an exact run", async () => {
    await expect(
      resolveAcknowledgedVerificationRun({
        operationMarker: "op_retry",
        pause: async () => {},
        discover: async () => {
          throw new Error("run list unavailable");
        },
        actionsUrl:
          "https://github.com/octo/app/actions/workflows/radius-verify.yml"
      })
    ).resolves.toMatchObject({
      state: "manual_required",
      guidance: expect.stringContaining(
        "could not confirm the exact marked run"
      )
    });
  });

  it("does not inspect or adopt runs for an acknowledged legacy retry", async () => {
    let inspected = false;
    await expect(
      resolveAcknowledgedVerificationRun({
        operationMarker: "",
        pause: async () => {
          throw new Error("legacy retries must not wait for adoption");
        },
        discover: async () => {
          inspected = true;
          return { state: "applied", value: "unrelated" };
        },
        actionsUrl:
          "https://github.com/octo/app/actions/workflows/radius-verify.yml"
      })
    ).resolves.toMatchObject({
      state: "manual_required",
      guidance: expect.stringContaining("does not expose")
    });
    expect(inspected).toBe(false);
  });

  describe("in-process provider reconciliation", () => {
    it("atomically reopens a terminalized unknown outcome for the scheduler", () => {
      const operation = createOperation({ operationId: "op_recovery" });
      prepareProviderMutation(operation, {
        kind: "azure_federated_credential.create",
        target: "app:dev"
      });

      finish(operation, "failed_partial", {
        failure: { code: "provider-mutation-outcome-unknown" }
      });

      expect(reopenProviderReconciliation(operation)).toBe(true);
      expect(operation).toMatchObject({
        state: "running",
        endedAt: null,
        executionActive: false,
        recoveryState: "provider_reconciliation_pending"
      });
    });
  });

  describe("cleanup provider recovery gate", () => {
    it.each([
      [
        "azure_federated_credential.create",
        "app:dev",
        false,
        "blocks destructive cleanup before reconciliation"
      ],
      [
        "github_branch.delete",
        "octo/app:refs/heads/radius/setup:abc",
        true,
        "allows only the exact delete recovery to resume"
      ]
    ])(
      "prevents successful cleanup for unresolved %s and %s",
      (kind, target, mayStartDestructiveCleanup) => {
        const operation = createOperation({ operationId: "op_cleanup" });
        prepareProviderMutation(operation, { kind, target });

        expect(cleanupProviderRecoveryDisposition(operation)).toEqual({
          blockers: [
            expect.objectContaining({ kind, target, status: "prepared" })
          ],
          mayStartDestructiveCleanup,
          mayCompleteCleanup: false
        });
      }
    );
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
    // The command travels as a remediation so the canvas can offer Copy / Run
    // with Copilot, and stays line-separated for shells that cannot parse `&&`.
    expect(result.remediation?.command).toBe(
      "gh auth switch -h github.com -u pubuser\ngh auth refresh -h github.com -s read:packages -s write:packages"
    );
    expect(result.remediation?.runnable).toBe(true);
    // The prose points at the callout rather than repeating the command.
    expect(result.error).not.toContain("gh auth switch -h github.com -u");
    expect(result.error).not.toContain("&&");
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
    expect(result.remediation?.command).toBe(
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
    // Switching accounts happens in the dialog, so there is no command to run
    // and the callout must not appear offering one.
    expect(result.remediation).toBeNull();
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

  it("falls back to prose when the login is one the registry will not run", async () => {
    const hostile = "pub user; rm -rf /";
    const result = await preflightGhcrPackageWriteAccess(
      async () => ({
        token: "ghcr-token",
        username: hostile,
        source: "keyring"
      }),
      async () =>
        identity({
          actingLogin: hostile,
          displayLogin: hostile,
          actingHasPackages: false,
          packagesLogin: hostile,
          packagesHasWrite: false,
          accounts: [
            {
              login: hostile,
              hasWorkflow: true,
              hasPackages: false,
              switchable: true,
              acting: true
            }
          ]
        })
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected GHCR preflight to fail");
    expect(result.code).toBe("ghcr-scope-required");
    // An unrunnable remediation must never be rendered as a command. The
    // trailing note mentions `gh auth switch` unconditionally, so assert on
    // the flags that only a built command carries.
    expect(result.error).not.toContain("-h github.com -u");
    expect(result.error).toContain("Grant @");
    // Nothing to offer the callout either, so the prose has to stand alone.
    expect(result.remediation).toBeNull();
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
      origin: "pre_existing",
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

    expect(result).toEqual({
      ok: true,
      state: "created",
      origin: "this_operation",
      objectId: null
    });
    expect(calls).toEqual([
      ["ad", "sp", "show", "--id", "app-1", "--query", "id", "-o", "tsv"],
      ["ad", "sp", "create", "--id", "app-1"]
    ]);
  });

  // A principal that answers now is not automatically one that was there
  // before: this operation may have made it and crashed before the ledger
  // caught up. Reading that as pre-existing leaves it behind at rollback.
  describe("a principal found again after a crash", () => {
    const NOT_FOUND = {
      code: 1,
      stdout: "",
      stderr: "Request_ResourceNotFound: Resource 'app-1' does not exist"
    };

    function journalled() {
      return createOperation({
        operationId: "op_sp",
        provider: "azure",
        repo: "octo/app",
        environment: "prod"
      });
    }

    async function crashAfterConfirm(createStdout: string) {
      const operation = journalled();
      // First run: absent, create acknowledged, then the process dies before
      // the ledger records anything.
      let call = 0;
      await ensureServicePrincipal(
        "app-1",
        async () => {
          call += 1;
          return call === 1 ? NOT_FOUND : (
              { code: 0, stdout: createStdout, stderr: "" }
            );
        },
        { operation, persist: async () => {} }
      );
      return operation;
    }

    async function restart(operation: object, objectId: string) {
      const calls: string[][] = [];
      const result = await ensureServicePrincipal(
        "app-1",
        async (args) => {
          calls.push(args);
          return { code: 0, stdout: `${objectId}\n`, stderr: "" };
        },
        {
          operation: operation as object & { operationId: string },
          persist: async () => {}
        }
      );
      return { result, calls };
    }

    it("settles the object id in the same write that confirms the create", async () => {
      const operation = await crashAfterConfirm(
        JSON.stringify({ id: "sp-object-1", appId: "app-1" })
      );

      expect(operation.providerRecovery.mutations).toEqual([
        expect.objectContaining({
          kind: "azure_service_principal.create",
          status: "confirmed",
          providerId: "sp-object-1"
        })
      ]);
    });

    it("claims the principal whose object id the confirmation recorded", async () => {
      const operation = await crashAfterConfirm(
        JSON.stringify({ id: "sp-object-1", appId: "app-1" })
      );

      const { result, calls } = await restart(operation, "sp-object-1");

      // Owned, so a rollback removes it. Reading it back is one lookup — the
      // create is never reissued.
      expect(result).toEqual({
        ok: true,
        state: "created",
        origin: "this_operation",
        objectId: "sp-object-1"
      });
      expect(calls).toEqual([
        ["ad", "sp", "show", "--id", "app-1", "--query", "id", "-o", "tsv"]
      ]);
    });

    it("claims nothing when a different object answers for the application", async () => {
      const operation = await crashAfterConfirm(
        JSON.stringify({ id: "sp-object-1", appId: "app-1" })
      );

      const { result, calls } = await restart(operation, "sp-object-2");

      expect(result).toMatchObject({
        ok: true,
        state: "created_candidate",
        origin: "unknown",
        objectId: "sp-object-2"
      });
      expect(calls).toHaveLength(1);
    });

    it("claims nothing when the confirmation recorded no object id", async () => {
      const operation = await crashAfterConfirm("");

      const { result } = await restart(operation, "sp-object-1");

      // Legacy confirmation, or a create Entra acknowledged without a body.
      // Either way there is nothing to match, so ownership is not assumed.
      expect(result).toMatchObject({
        state: "created_candidate",
        origin: "unknown"
      });
    });

    it.each([["prepared"], ["outcome_unknown"]])(
      "neither replays nor claims a create left %s",
      async (status) => {
        const operation = journalled();
        const mutation = prepareProviderMutation(operation, {
          kind: "azure_service_principal.create",
          target: "app-1"
        });
        settleProviderMutation(
          operation,
          mutation.mutationId,
          status as never,
          "the answer was lost"
        );

        const { result, calls } = await restart(operation, "sp-object-1");

        expect(result).toMatchObject({
          state: "created_candidate",
          origin: "unknown",
          objectId: "sp-object-1"
        });
        expect(calls).toEqual([
          ["ad", "sp", "show", "--id", "app-1", "--query", "id", "-o", "tsv"]
        ]);
      }
    );

    it("hands over a create Radius already gave up on", async () => {
      const operation = journalled();
      const mutation = prepareProviderMutation(operation, {
        kind: "azure_service_principal.create",
        target: "app-1"
      });
      settleProviderMutation(
        operation,
        mutation.mutationId,
        "manual_required",
        "Entra could not be read after the interrupted create."
      );

      const { result } = await restart(operation, "sp-object-1");

      expect(result).toEqual({
        ok: false,
        stderr: "Entra could not be read after the interrupted create."
      });
    });

    it("reuses a principal whose create this operation was refused", async () => {
      const operation = journalled();
      const mutation = prepareProviderMutation(operation, {
        kind: "azure_service_principal.create",
        target: "app-1"
      });
      settleProviderMutation(
        operation,
        mutation.mutationId,
        "not_applied",
        "Entra rejected the create."
      );

      const { result } = await restart(operation, "sp-object-1");

      // The create never landed, so whatever answers now predates it.
      expect(result).toEqual({
        ok: true,
        state: "reused",
        origin: "pre_existing",
        objectId: "sp-object-1"
      });
    });

    it("still reuses a principal no journal entry mentions", async () => {
      const operation = journalled();

      const { result } = await restart(operation, "sp-object-1");

      // Nothing was ever issued for it, so it is genuinely somebody else's.
      expect(result).toEqual({
        ok: true,
        state: "reused",
        origin: "pre_existing",
        objectId: "sp-object-1"
      });
    });

    it("carries the recorded object id through a save and reload", async () => {
      const operation = await crashAfterConfirm(
        JSON.stringify({ id: "sp-object-1", appId: "app-1" })
      );

      const restored = fromPersistedOperation(toPersistedOperation(operation));
      const { result } = await restart(restored, "sp-object-1");

      expect(result).toMatchObject({
        state: "created",
        origin: "this_operation"
      });
    });
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

  it("reconciles a failed create that produced a principal anyway", async () => {
    const calls: string[][] = [];
    const result = await ensureServicePrincipal("app-1", async (args) => {
      calls.push(args);
      if (calls.length === 1) {
        return {
          code: 1,
          stdout: "",
          stderr: "Request_ResourceNotFound: Resource 'app-1' does not exist"
        };
      }
      if (calls.length === 2) {
        return { code: 1, stdout: "", stderr: "the request timed out" };
      }
      return { code: 0, stdout: "sp-object-1\n", stderr: "" };
    });

    // Absent before, present after this attempt's own create: not a reuse, and
    // not something Radius may delete either.
    expect(result).toEqual({
      ok: true,
      state: "created_candidate",
      origin: "unknown",
      objectId: "sp-object-1"
    });
    expect(calls).toHaveLength(3);
  });

  it("fails closed when neither the create nor the reconciliation lookup found one", async () => {
    const result = await ensureServicePrincipal("app-1", async (args) =>
      args[2] === "create" ?
        { code: 1, stdout: "", stderr: "" }
      : {
          code: 1,
          stdout: "",
          stderr: "Request_ResourceNotFound: Resource 'app-1' does not exist"
        }
    );

    expect(result).toEqual({
      ok: false,
      stderr: "Request_ResourceNotFound: Resource 'app-1' does not exist"
    });
  });

  describe("journaling the create so a restart cannot repeat it", () => {
    function recovery() {
      const operation = createOperation({ operationId: "op_sp" });
      return {
        operation,
        port: { operation, persist: async () => {} }
      };
    }

    const absent = {
      code: 1,
      stdout: "",
      stderr: "Request_ResourceNotFound: Resource 'app-1' does not exist"
    };

    it("records the create before issuing it and confirms it afterwards", async () => {
      const { operation, port } = recovery();

      const result = await ensureServicePrincipal(
        "app-1",
        async (args) => (args[2] === "create" ? { code: 0 } : absent),
        port
      );

      expect(result).toMatchObject({
        ok: true,
        state: "created",
        origin: "this_operation"
      });
      expect(operation.providerRecovery.mutations).toEqual([
        expect.objectContaining({
          kind: "azure_service_principal.create",
          target: "app-1",
          providerIdempotencyKey: "app-1",
          status: "confirmed"
        })
      ]);
    });

    it("adopts the exact principal for this client id rather than creating a second one", async () => {
      const { operation, port } = recovery();
      const creates: string[][] = [];

      const result = await ensureServicePrincipal(
        "app-1",
        async (args) => {
          if (args[2] === "create") {
            creates.push(args);
            return { code: 1, stdout: "", stderr: "", timedOut: true };
          }
          return creates.length === 0 ?
              absent
            : { code: 0, stdout: "sp-object-1\n", stderr: "" };
        },
        port
      );

      // Present after this attempt's own create but never provably created by
      // it, so the object id is adopted and ownership is not.
      expect(result).toEqual({
        ok: true,
        state: "created_candidate",
        origin: "unknown",
        objectId: "sp-object-1"
      });
      expect(creates).toHaveLength(1);
      expect(operation.providerRecovery.mutations[0]).toMatchObject({
        status: "confirmed",
        evidence: expect.stringContaining("exact application client id")
      });
    });

    it("never reissues the create when a restart replays the same step", async () => {
      const { operation, port } = recovery();
      const creates: string[][] = [];
      const runAz = async (args: string[]) => {
        const identity = answersFederatedCredentialIdentity(args);
        if (identity) return identity;
        if (args[2] === "create") {
          creates.push(args);
          return { code: 1, stdout: "", stderr: "", timedOut: true };
        }
        return creates.length === 0 ?
            absent
          : { code: 0, stdout: "sp-object-1\n", stderr: "" };
      };

      await ensureServicePrincipal("app-1", runAz, port);
      const replay = await ensureServicePrincipal("app-1", runAz, port);

      // The second pass finds the principal in its precheck, so it reuses it
      // and never reaches the create at all.
      expect(creates).toHaveLength(1);
      expect(replay).toMatchObject({ ok: true, objectId: "sp-object-1" });
      expect(operation.providerRecovery.mutations).toHaveLength(1);
    });

    it("reports a definite Entra refusal without journaling a phantom principal", async () => {
      const { operation, port } = recovery();

      const result = await ensureServicePrincipal(
        "app-1",
        async (args) =>
          args[2] === "create" ?
            {
              code: 1,
              stdout: "",
              stderr:
                "ERROR: (Authorization_RequestDenied) Insufficient privileges to complete the operation."
            }
          : absent,
        port
      );

      expect(result).toMatchObject({
        ok: false,
        stderr: expect.stringContaining("Insufficient privileges")
      });
      expect(operation.providerRecovery.mutations[0].status).toBe(
        "not_applied"
      );
    });

    it("settles as not applied when Entra proves no principal exists", async () => {
      const { operation, port } = recovery();

      const result = await ensureServicePrincipal(
        "app-1",
        async (args) =>
          args[2] === "create" ?
            { code: 1, stdout: "", stderr: "", timedOut: true }
          : absent,
        port
      );

      expect(result.ok).toBe(false);
      expect(operation.providerRecovery.mutations[0].status).toBe(
        "not_applied"
      );
    });

    it("refuses to create a principal once reconciliation demanded a rollback", async () => {
      const { operation, port } = recovery();
      operation.providerRecovery.state = "rollback_pending";

      await expect(
        ensureServicePrincipal(
          "app-1",
          async (args) => {
            if (args[2] === "create") {
              throw new Error("no create may run while a rollback is pending");
            }
            return absent;
          },
          port
        )
      ).rejects.toMatchObject({ code: "provider-mutation-rollback-pending" });
    });

    it("leaves an unreadable directory unresolved instead of guessing", async () => {
      const { operation, port } = recovery();
      let created = false;

      await expect(
        ensureServicePrincipal(
          "app-1",
          async (args) => {
            if (args[2] === "create") {
              created = true;
              return { code: 1, stdout: "", stderr: "", timedOut: true };
            }
            return created ?
                { code: 1, stdout: "", stderr: "the directory did not answer" }
              : absent;
          },
          port
        )
      ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });

      expect(operation.providerRecovery.mutations[0].status).toBe(
        "outcome_unknown"
      );
    });

    it("treats an empty reconciliation object id as unreadable rather than absent", async () => {
      const { operation, port } = recovery();
      let created = false;

      await expect(
        ensureServicePrincipal(
          "app-1",
          async (args) => {
            if (args[2] === "create") {
              created = true;
              return { code: 1, stdout: "", stderr: "", timedOut: true };
            }
            return created ? { code: 0, stdout: "  \n", stderr: "" } : absent;
          },
          port
        )
      ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });

      expect(operation.providerRecovery.mutations[0].evidence).toContain(
        "empty object id"
      );
    });

    it("stops before the create when the precheck itself failed for another reason", async () => {
      const { operation, port } = recovery();

      const result = await ensureServicePrincipal(
        "app-1",
        async (args) => {
          if (args[2] === "create") {
            throw new Error("a failed precheck must not reach the create");
          }
          return {
            code: 1,
            stdout: "",
            stderr: "HTTP 503: Service Unavailable"
          };
        },
        port
      );

      expect(result).toEqual({
        ok: false,
        stderr: "HTTP 503: Service Unavailable"
      });
      expect(operation.providerRecovery.mutations).toEqual([]);
    });
  });
});

describe("deriving the environments listing a delete path belongs to", () => {
  it("names the listing and the environment the path targets", () => {
    expect(environmentsApiPath("/repos/octo/app/environments/dev")).toBe(
      "/repos/octo/app/environments"
    );
    expect(environmentNameFromApiPath("/repos/octo/app/environments/dev")).toBe(
      "dev"
    );
  });

  it("decodes the environment back to the name a listing reports", () => {
    expect(
      environmentNameFromApiPath("/repos/octo/app/environments/needs%20space")
    ).toBe("needs space");
  });

  it("refuses a name it cannot decode rather than comparing the escaped form", () => {
    expect(
      environmentNameFromApiPath("/repos/octo/app/environments/%E0%A4%A")
    ).toBeNull();
  });

  it.each([
    ["a repository path with no environment", "/repos/octo/app"],
    ["the listing path itself", "/repos/octo/app/environments"],
    ["a nested path below the environment", "/repos/octo/app/environments/a/b"],
    ["an unrelated path", "/user/repos"],
    ["an empty path", ""]
  ])("returns null for %s", (_label, path) => {
    expect(environmentsApiPath(path)).toBeNull();
    expect(environmentNameFromApiPath(path)).toBeNull();
  });
});

describe("resolveCleanupGitHubContext", () => {
  function selectedExecutor(overrides: Partial<SelectedGhExecutor> = {}) {
    return {
      login: "octocat",
      credentialSource: "keyring",
      requiresKeyringSwitch: false,
      scopes: ["repo", "workflow"],
      run: vi.fn(() => Promise.resolve({ code: 0, stdout: "{}", stderr: "" })),
      runOrThrow: vi.fn(() =>
        Promise.resolve({ code: 0, stdout: "", stderr: "" })
      ),
      verifyIdentity: vi.fn(() => Promise.resolve()),
      packageCredentials: () => ({
        token: "fixture-token",
        username: "octocat",
        source: "keyring" as const
      }),
      redact: (value: string) => value,
      errorMessage: (error: unknown) => String(error),
      ...overrides
    } satisfies SelectedGhExecutor;
  }

  it("pins rollback and environment deletion to the selected executor", async () => {
    const executor = selectedExecutor();
    const context = await resolveCleanupGitHubContext({
      targets: [
        { artifactType: "workflow_file" },
        { artifactType: "github_environment" }
      ],
      selectedLogin: "octocat",
      createExecutor: async () => executor
    });

    await expect(
      context.rollbackCommand({ args: ["api", "/repos/octo/app"] })
    ).resolves.toMatchObject({ ok: true });
    await context.deleteEnvironment([
      "api",
      "--method",
      "DELETE",
      "/repos/octo/app/environments/dev"
    ]);

    expect(executor.verifyIdentity).toHaveBeenCalledOnce();
    expect(executor.run).toHaveBeenCalledWith(
      ["api", "/repos/octo/app"],
      expect.objectContaining({ timeout: 20000 })
    );
    expect(executor.run).toHaveBeenCalledWith(
      ["api", "--method", "DELETE", "/repos/octo/app/environments/dev"],
      { timeout: 20000 }
    );
  });

  describe("a timed-out environment delete answered with 404", () => {
    const DELETE_ARGS = [
      "api",
      "--method",
      "DELETE",
      "/repos/octo/app/environments/dev"
    ];
    const TIMED_OUT = {
      code: 1,
      stdout: "",
      stderr: "terminated",
      timedOut: true
    };
    const listing = (names: string[], totalCount = names.length) => ({
      code: 0,
      stdout: JSON.stringify({
        total_count: totalCount,
        environments: names.map((name) => ({ name }))
      }),
      stderr: ""
    });

    // The delete, the 404 that starts the proof, then the listing pages the
    // caller supplies, then the confirming reread of the environment itself.
    const NOT_FOUND = { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };

    function timedOutDelete(
      ...responses: unknown[]
    ): ReturnType<typeof selectedExecutor> {
      const run = vi.fn();
      run.mockResolvedValueOnce(TIMED_OUT).mockResolvedValueOnce(NOT_FOUND);
      for (const response of responses) run.mockResolvedValueOnce(response);
      run.mockResolvedValue(NOT_FOUND);
      return selectedExecutor({ run });
    }

    async function context(executor: ReturnType<typeof selectedExecutor>) {
      return resolveCleanupGitHubContext({
        targets: [{ artifactType: "github_environment" }],
        selectedLogin: "octocat",
        createExecutor: async () => executor
      });
    }

    it("proves absence from the environments listing the same account can read", async () => {
      const executor = timedOutDelete(listing(["prod", "staging"]));

      await expect(
        (await context(executor)).deleteEnvironment(DELETE_ARGS)
      ).resolves.toBeUndefined();
      expect(executor.run).toHaveBeenCalledTimes(4);
      expect(executor.run).toHaveBeenNthCalledWith(
        3,
        ["api", "/repos/octo/app/environments?per_page=100&page=1"],
        expect.objectContaining({ timeout: 12000 })
      );
      // The listing is assembled request by request, so absence is confirmed
      // once more against the environment's own endpoint.
      expect(executor.run).toHaveBeenLastCalledWith(
        ["api", "/repos/octo/app/environments/dev"],
        expect.objectContaining({ timeout: 12000 })
      );
    });

    it.each([
      [
        "the Actions environments API is refused",
        { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" }
      ],
      [
        "the listing itself answers 404",
        { code: 1, stdout: "", stderr: "HTTP 404: Not Found" }
      ]
    ])("refuses absence when %s", async (_label, response) => {
      // Repository metadata being readable proves nothing about the Actions
      // environments permission: GitHub answers 404 per resource, so only a
      // listing the account can actually complete separates gone from hidden.
      const executor = timedOutDelete(response);

      await expect(
        (await context(executor)).deleteEnvironment(DELETE_ARGS)
      ).rejects.toThrow("masked access rather than a completed delete");
    });

    it("refuses absence when the listing still holds the environment", async () => {
      const executor = timedOutDelete(listing(["dev", "prod"]));

      await expect(
        (await context(executor)).deleteEnvironment(DELETE_ARGS)
      ).rejects.toThrow("is still present");
    });

    it("reads every page before calling the environment gone", async () => {
      const first = Array.from({ length: 100 }, (_u, index) => `env-${index}`);
      const second = Array.from({ length: 50 }, (_u, index) => `late-${index}`);
      const executor = timedOutDelete(
        listing(first, 150),
        listing(second, 150)
      );

      await expect(
        (await context(executor)).deleteEnvironment(DELETE_ARGS)
      ).resolves.toBeUndefined();
      expect(executor.run).toHaveBeenCalledTimes(5);
      expect(executor.run).toHaveBeenNthCalledWith(
        4,
        ["api", "/repos/octo/app/environments?per_page=100&page=2"],
        expect.anything()
      );
    });

    it("finds the environment on a later page rather than reporting it gone", async () => {
      const first = Array.from({ length: 100 }, (_u, index) => `env-${index}`);
      const executor = timedOutDelete(
        listing(first, 101),
        listing(["dev"], 101)
      );

      await expect(
        (await context(executor)).deleteEnvironment(DELETE_ARGS)
      ).rejects.toThrow("is still present");
    });

    it("refuses absence when the listing stops short of the count GitHub reports", async () => {
      // A short page that does not reach total_count was truncated somewhere,
      // so its silence about the environment is not evidence.
      const executor = timedOutDelete(listing(["prod"], 12));

      await expect(
        (await context(executor)).deleteEnvironment(DELETE_ARGS)
      ).rejects.toThrow("ended after 1 of 12 entries");
    });

    it.each([
      ["an unreadable body", { code: 0, stdout: "<html>", stderr: "" }],
      [
        "an array instead of an envelope",
        { code: 0, stdout: "[]", stderr: "" }
      ],
      [
        "an envelope with no environments",
        { code: 0, stdout: JSON.stringify({ total_count: 0 }), stderr: "" }
      ],
      [
        "an entry with no name",
        {
          code: 0,
          stdout: JSON.stringify({ total_count: 1, environments: [{}] }),
          stderr: ""
        }
      ]
    ])("refuses absence for %s", async (_label, response) => {
      const executor = timedOutDelete(response);

      await expect(
        (await context(executor)).deleteEnvironment(DELETE_ARGS)
      ).rejects.toThrow("could not read");
    });

    it("accepts an envelope that reports no total at all", async () => {
      const executor = timedOutDelete({
        code: 0,
        stdout: JSON.stringify({ environments: [{ name: "prod" }] }),
        stderr: ""
      });

      await expect(
        (await context(executor)).deleteEnvironment(DELETE_ARGS)
      ).resolves.toBeUndefined();
    });

    it("keeps a timed-out delete unknown when the path names no environment", async () => {
      const executor = timedOutDelete();

      await expect(
        (await context(executor)).deleteEnvironment([
          "api",
          "--method",
          "DELETE",
          "/user/repos"
        ])
      ).rejects.toThrow("could not derive the environments listing");
      expect(executor.run).toHaveBeenCalledTimes(2);
    });

    it("still refuses when the environment is readable after the timeout", async () => {
      const run = vi
        .fn()
        .mockResolvedValueOnce(TIMED_OUT)
        .mockResolvedValueOnce({
          code: 0,
          stdout: JSON.stringify({ name: "dev" }),
          stderr: ""
        });
      const executor = selectedExecutor({ run });

      await expect(
        (await context(executor)).deleteEnvironment(DELETE_ARGS)
      ).rejects.toThrow("identity is still present");
      expect(run).toHaveBeenCalledTimes(2);
    });
  });

  it("fails closed when a cleanup record has no selected GitHub account", async () => {
    const createExecutor = vi.fn();
    const context = await resolveCleanupGitHubContext({
      targets: [{ artifactType: "workflow_file" }],
      selectedLogin: "",
      createExecutor
    });

    await expect(
      context.rollbackCommand({ args: ["api", "/repos/octo/app"] })
    ).resolves.toMatchObject({
      ok: false,
      stderr: expect.stringContaining("does not name the GitHub account")
    });
    await expect(context.deleteEnvironment([])).rejects.toThrow(
      "does not name the GitHub account"
    );
    expect(createExecutor).not.toHaveBeenCalled();
  });

  it("surfaces selected-account resolution failure without using ambient credentials", async () => {
    const context = await resolveCleanupGitHubContext({
      targets: [{ artifactType: "github_environment" }],
      selectedLogin: "octocat",
      createExecutor: () => Promise.reject(new Error("keyring unavailable")),
      formatError: () => "selected account unavailable"
    });

    await expect(
      context.rollbackCommand({ args: ["api", "/repos/octo/app"] })
    ).resolves.toMatchObject({
      ok: false,
      stderr: "selected account unavailable"
    });
    await expect(context.deleteEnvironment([])).rejects.toThrow(
      "selected account unavailable"
    );
  });

  it("does not resolve a GitHub executor for Azure-only cleanup", async () => {
    const createExecutor = vi.fn();
    const context = await resolveCleanupGitHubContext({
      targets: [{ artifactType: "azure_app" }],
      selectedLogin: "",
      createExecutor
    });

    expect(createExecutor).not.toHaveBeenCalled();
    await expect(
      context.rollbackCommand({ args: ["api", "/repos/octo/app"] })
    ).resolves.toMatchObject({
      ok: false,
      stderr: "The selected GitHub account is unavailable."
    });
  });
});

describe("rollbackCommittedWorkflowFiles", () => {
  // The ledger half of a post-commit rollback: which files are selected, what
  // the ledger records afterwards, and whether the rest of the rollback is
  // allowed to run. GitHub is a scripted fake that throws on anything
  // unmodelled.
  const BLOB = "b".repeat(40);
  const DIGEST = "d".repeat(64);
  const VERIFY_PATH = ".github/workflows/radius-verify-credentials.yml";

  function committedOp() {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordCommittedWorkflowFile(op, {
      path: VERIFY_PATH,
      mode: "default_branch",
      branch: "main",
      commitSha: "c".repeat(40),
      blobSha: BLOB,
      contentSha256: DIGEST,
      previousBlobSha: null,
      previousBlobKnown: true
    });
    return op;
  }

  function rollbackPorts(script: {
    blobSha?: string;
    contentSha256?: string;
    deleteOk?: boolean;
    previousBlobContent?: string;
  }) {
    const deleted: string[] = [];
    const restored: string[] = [];
    const ports = {
      readRepository: async () => ({ status: "readable" as const }),
      readFile: async () => ({
        status: "present" as const,
        blobSha: script.blobSha ?? BLOB,
        contentSha256:
          script.contentSha256 ?? (script.blobSha ? "other" : DIGEST)
      }),
      readBranchHead: () => {
        throw new Error("unscripted readBranchHead");
      },
      readPullRequest: () => {
        throw new Error("unscripted readPullRequest");
      },
      readBlob: async () =>
        script.previousBlobContent === undefined ?
          { ok: false as const, detail: "unscripted readBlob" }
        : {
            ok: true as const,
            contentBase64: script.previousBlobContent
          },
      deleteFile: async ({ path }: { path: string }) => {
        if (script.deleteOk === false)
          return { ok: false as const, detail: "HTTP 409" };
        deleted.push(path);
        return { ok: true as const };
      },
      restoreFile: async ({ path }: { path: string }) => {
        restored.push(path);
        return { ok: true as const };
      },
      closePullRequest: () => {
        throw new Error("unscripted closePullRequest");
      },
      deleteBranch: () => {
        throw new Error("unscripted deleteBranch");
      }
    };
    return { ports, deleted, restored };
  }

  it("does nothing when the operation committed no workflow file", async () => {
    const op = newAzureOp();
    const { ports, deleted } = rollbackPorts({});

    await expect(
      rollbackCommittedWorkflowFiles(op, { attempt: 1, ports })
    ).resolves.toEqual({
      results: [],
      warnings: [],
      blocked: false,
      attempted: false
    });
    expect(deleted).toEqual([]);
  });

  it("reverts a verified file and marks it removed in the ledger", async () => {
    const op = committedOp();
    const { ports, deleted } = rollbackPorts({});
    const steps: string[] = [];

    const outcome = await rollbackCommittedWorkflowFiles(op, {
      attempt: 1,
      ports,
      steps
    });

    expect(outcome).toMatchObject({ blocked: false, attempted: true });
    expect(deleted).toEqual([VERIFY_PATH]);
    expect(op.setupArtifacts.commit.workflowFiles[0].state).toBe("removed");
    expect(steps[0]).toContain("Removed workflow");
  });

  it("restores the pre-Radius workflow after the same operation recommits it", async () => {
    const op = newAzureOp();
    recordCommittedWorkflowFile(op, {
      path: VERIFY_PATH,
      mode: "default_branch",
      branch: "main",
      commitSha: "c".repeat(40),
      blobSha: BLOB,
      contentSha256: DIGEST,
      previousBlobSha: "customer-blob",
      previousBlobKnown: true
    });
    recordCommittedWorkflowFile(op, {
      path: VERIFY_PATH,
      mode: "default_branch",
      branch: "main",
      commitSha: "e".repeat(40),
      blobSha: "f".repeat(40),
      contentSha256: "a".repeat(64),
      previousBlobSha: BLOB,
      previousBlobKnown: true
    });
    const { ports, restored } = rollbackPorts({
      blobSha: "f".repeat(40),
      contentSha256: "a".repeat(64),
      previousBlobContent: "Y3VzdG9tZXI="
    });

    const outcome = await rollbackCommittedWorkflowFiles(op, {
      attempt: 1,
      ports
    });

    expect(outcome).toMatchObject({ blocked: false, attempted: true });
    expect(outcome.results[0]?.outcome).toBe("restored");
    expect(restored).toEqual([VERIFY_PATH]);
    expect(op.setupArtifacts.commit.workflowFiles[0]).toMatchObject({
      state: "removed",
      previousBlobSha: "customer-blob"
    });
  });

  it("blocks and keeps the file when it is no longer what Radius wrote", async () => {
    const op = committedOp();
    const { ports, deleted } = rollbackPorts({ blobSha: "e".repeat(40) });

    const outcome = await rollbackCommittedWorkflowFiles(op, {
      attempt: 1,
      ports
    });

    // Blocked means the caller must not touch the GitHub environment or the
    // Azure identity the workflow still authenticates with.
    expect(outcome.blocked).toBe(true);
    expect(deleted).toEqual([]);
    expect(op.setupArtifacts.commit.workflowFiles[0].state).toBe("committed");
    expect(outcome.results[0]).toMatchObject({
      artifactType: "workflow_file",
      outcome: "skipped"
    });
  });

  it("blocks when GitHub refuses the removal", async () => {
    const op = committedOp();
    const { ports } = rollbackPorts({ deleteOk: false });

    const outcome = await rollbackCommittedWorkflowFiles(op, {
      attempt: 2,
      ports
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.warnings[0]).toContain("HTTP 409");
    expect(outcome.results[0]).toMatchObject({
      attempt: 2,
      outcome: "warning"
    });
  });

  it("acts only on the files a retry selected", async () => {
    const op = committedOp();
    recordCommittedWorkflowFile(op, {
      path: ".github/workflows/radius-deploy.yml",
      mode: "default_branch",
      branch: "main",
      commitSha: "c".repeat(40),
      blobSha: BLOB,
      contentSha256: DIGEST,
      previousBlobSha: null,
      previousBlobKnown: true
    });
    const { ports, deleted } = rollbackPorts({});

    await rollbackCommittedWorkflowFiles(op, {
      attempt: 2,
      ports,
      only: new Set([`workflow_file#main:${VERIFY_PATH}`])
    });

    expect(deleted).toEqual([VERIFY_PATH]);
  });
});

// The real call order for one delete: the pre-delete identity read, the
// listing pages when a 404 or a lost answer has to be proven, and the
// confirming reread. Scripting them by role keeps each test saying which
// answer it is exercising.
const ENV_NOT_FOUND = { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
const ENV_PRESENT = {
  code: 0,
  stdout: JSON.stringify({ id: "env-1", name: "dev" }),
  stderr: ""
};
function envListing(names: string[]) {
  return {
    code: 0,
    stdout: JSON.stringify({
      total_count: names.length,
      environments: names.map((name) => ({ name }))
    }),
    stderr: ""
  };
}
function environmentReader(
  script: {
    identity?: unknown;
    listing?: unknown;
    reread?: unknown;
  } = {}
) {
  let sawIdentity = false;
  const reads: string[] = [];
  const read = async (args: string[]) => {
    reads.push(args[1]);
    if (args[1].includes("/environments?")) {
      return (script.listing ?? envListing(["prod"])) as never;
    }
    if (!sawIdentity) {
      sawIdentity = true;
      return (script.identity ?? ENV_PRESENT) as never;
    }
    return (script.reread ?? ENV_NOT_FOUND) as never;
  };
  return Object.assign(read, { reads });
}

// The Service Principal delete reads Entra's own object id back first and
// requires it to match the ledger, so a principal recreated for the same
// application is never what gets removed.
function answersServicePrincipalIdentity(
  args: string[]
): { code: number; stdout: string; stderr: string } | null {
  if (
    args[0] !== "ad" ||
    args[1] !== "sp" ||
    args[2] !== "show" ||
    args[args.indexOf("--query") + 1] !== "id"
  ) {
    return null;
  }
  return {
    code: 0,
    stdout: `${args[args.indexOf("--id") + 1]}\n`,
    stderr: ""
  };
}

// Every name-addressed Azure delete first reads the resource's own id back and
// requires it to match the ledger. The fakes answer that read the way Azure
// would for a resource this attempt still owns.
function answersRecordedIdentity(
  args: string[]
): { code: number; stdout: string; stderr: string } | null {
  return (
    answersServicePrincipalIdentity(args) ??
    answersFederatedCredentialIdentity(args)
  );
}

function answersFederatedCredentialIdentity(
  args: string[]
): { code: number; stdout: string; stderr: string } | null {
  if (
    !args.includes("federated-credential") ||
    !args.includes("--federated-credential-id") ||
    args[args.indexOf("--query") + 1] !== "id"
  ) {
    return null;
  }
  const name = args[args.indexOf("--federated-credential-id") + 1];
  return { code: 0, stdout: `fic-${name}\n`, stderr: "" };
}

describe("cleanupAzureSetupArtifacts", () => {
  it("removes a Service Principal this operation added to somebody else's app", async () => {
    const op = newAzureOp();
    // The customer already had the App Registration; Radius only added the
    // principal. Leaving that behind because the app is theirs would leak the
    // one resource this setup actually created.
    recordAzureApp(op, {
      state: "reused",
      origin: "pre_existing",
      appId: "app-1"
    });
    recordServicePrincipal(op, {
      state: "created",
      origin: "this_operation",
      appId: "app-1",
      objectId: "sp-1"
    });

    const deletes: string[][] = [];
    const pass = await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
        if (args.includes("delete")) deletes.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    // Addressed by Entra's own object id, never by the application it belongs
    // to — that would reach a principal recreated for the same application.
    expect(deletes).toEqual([["ad", "sp", "delete", "--id", "sp-1"]]);
    expect(
      pass.results.map((entry: any) => `${entry.artifactType}:${entry.outcome}`)
    ).toEqual(["service_principal:deleted"]);
    // The application it belongs to is untouched.
    expect(op.setupArtifacts.azureApp.state).toBe("reused");
  });

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
      subject: "repo:octo/app:environment:dev",
      providerId: "fic-radius-dev"
    });
    recordCreatedFederatedCredential(op, {
      name: "radius-dev-pr",
      subject: "repo:octo/app:pull_request",
      providerId: "fic-radius-dev-pr"
    });
    recordCreatedRoleAssignment(op, {
      assignmentId: "assignment-1",
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
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    // The AKS assignment was recorded without an assignment id, so it can only
    // be addressed by assignee/role/scope. That triple matches a replacement
    // grant just as well as this attempt's, so it is refused rather than
    // deleted, and no `az` call is made for it at all.
    expect(calls).toEqual([
      [
        "role",
        "assignment",
        "delete",
        "--ids",
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Authorization/roleAssignments/assignment-1",
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
      ["ad", "sp", "delete", "--id", "sp-1"],
      ["ad", "app", "delete", "--id", "app-1"]
    ]);
    expect(cleanup.state).toBe("succeeded_with_warnings");
    expect(cleanup.warnings).toEqual([
      expect.stringContaining("no stable provider identity")
    ]);
    expect(op.setupArtifacts.cleanup).toMatchObject({
      state: "succeeded_with_warnings",
      attempts: 1
    });
    expect(op.setupArtifacts.cleanup.results).toHaveLength(6);
    expect(
      op.setupArtifacts.cleanup.results.filter(
        (entry: { outcome: string }) => entry.outcome === "skipped"
      )
    ).toHaveLength(1);
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
      subject: "repo:octo/app:environment:dev",
      providerId: "fic-radius-dev"
    });
    recordCreatedRoleAssignment(op, {
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      principalObjectId: "sp-1"
    });

    const calls: string[][] = [];
    const cleanup = await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
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

    // The role assignment carries no assignment id, so it can only be matched
    // by assignee/role/scope and is refused rather than deleted by attribute.
    expect(calls).toEqual([
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
    expect(cleanup.state).toBe("succeeded_with_warnings");
    expect(cleanup.warnings).toEqual([
      expect.stringContaining("no stable provider identity")
    ]);
    expect(op.setupArtifacts.cleanup.results).toMatchObject([
      { outcome: "skipped", artifactType: "role_assignment" },
      { outcome: "not_found", artifactType: "federated_credential" }
    ]);
  });

  describe("a cleanup delete whose answer was lost", () => {
    function azureOp() {
      const op = newAzureOp();
      recordAzureApp(op, { state: "created", appId: "app-1" });
      recordServicePrincipal(op, {
        state: "created",
        appId: "app-1",
        objectId: "sp-1"
      });
      recordCreatedFederatedCredential(op, {
        name: "radius-dev",
        subject: "repo:octo/app:environment:dev",
        providerId: "fic-radius-dev"
      });
      recordCreatedRoleAssignment(op, {
        assignmentId: "assignment-1",
        role: "Contributor",
        scope: "/subscriptions/sub/resourceGroups/rg",
        principalObjectId: "sp-1"
      });
      return op;
    }

    const lost = { code: 1, stdout: "", stderr: "terminated", timedOut: true };

    it("writes the delete down before issuing it", async () => {
      const op = azureOp();
      const journalled: string[][] = [];

      await cleanupAzureSetupArtifacts(op, {
        runAz: async (args: string[]) =>
          answersRecordedIdentity(args) ?? {
            code: 0,
            stdout: "",
            stderr: ""
          },
        persistJournal: async () => {
          journalled.push(
            op.providerRecovery.mutations.map(
              (entry: { kind: string; status: string }) =>
                `${entry.kind}:${entry.status}`
            )
          );
        }
      });

      // Every delete is `prepared` on disk before it goes out and settled after,
      // so a crash at any point reloads a record that knows the request existed.
      expect(journalled[0]).toEqual([
        "role_assignment.cleanup_delete:prepared"
      ]);
      expect(journalled.at(-1)).toEqual([
        "role_assignment.cleanup_delete:confirmed",
        "federated_credential.cleanup_delete:confirmed",
        "service_principal.cleanup_delete:confirmed",
        "azure_app.cleanup_delete:confirmed"
      ]);
    });

    it.each([
      ["a role assignment", "role", "role_assignment"],
      [
        "a federated credential",
        "federated-credential",
        "federated_credential"
      ],
      ["a Service Principal", "sp", "service_principal"],
      ["an App Registration", "app", "azure_app"]
    ])(
      "never reissues the delete for %s that is still present",
      async (_label, marker, artifactType) => {
        const op = azureOp();
        const deletes: string[][] = [];
        const runAz = async (args: string[]) => {
          const identity = answersRecordedIdentity(args);
          if (identity) return identity;
          const isTarget =
            marker === "role" ? args[0] === "role"
            : marker === "federated-credential" ?
              args.includes("federated-credential")
            : marker === "sp" ? args[1] === "sp"
            : args[1] === "app" && !args.includes("federated-credential");
          if (!isTarget) return { code: 0, stdout: "", stderr: "" };
          if (args.includes("delete")) {
            deletes.push(args);
            return lost;
          }
          // The reread finds the resource still there: a replacement, or a
          // delete that never landed. Either way Radius must not try again.
          return { code: 0, stdout: '["present"]', stderr: "" };
        };

        const first = await cleanupAzureSetupArtifacts(op, { runAz });
        const retry = await cleanupAzureSetupArtifacts(op, { runAz });

        expect(deletes).toHaveLength(1);
        const outcomeOf = (pass: { results: Array<Record<string, unknown>> }) =>
          pass.results.find((entry) => entry.artifactType === artifactType)
            ?.outcome;
        expect(outcomeOf(first)).toBe("skipped");
        expect(outcomeOf(retry)).toBe("skipped");
      }
    );

    it("settles a lost delete once the exact identity reads back absent", async () => {
      const op = azureOp();
      let appDeletes = 0;
      const runAz = async (args: string[]) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
        const isApp =
          args[1] === "app" && !args.includes("federated-credential");
        if (!isApp) return { code: 0, stdout: "", stderr: "" };
        if (args.includes("delete")) {
          appDeletes += 1;
          return lost;
        }
        return {
          code: 1,
          stdout: "",
          stderr: "Request_ResourceNotFound: Resource 'app-1' does not exist"
        };
      };

      const pass = await cleanupAzureSetupArtifacts(op, { runAz });

      expect(appDeletes).toBe(1);
      expect(
        pass.results.find((entry) => entry.artifactType === "azure_app")
      ).toMatchObject({ outcome: "not_found" });
      expect(op.setupArtifacts.azureApp.state).toBe("deleted");
      expect(unresolvedProviderMutations(op)).toEqual([]);
    });

    it("leaves the delete unresolved when the identity cannot be read at all", async () => {
      const op = azureOp();
      const pass = await cleanupAzureSetupArtifacts(op, {
        runAz: async (args) =>
          args.includes("delete") ? lost : (
            { code: 1, stdout: "", stderr: "HTTP 503: Service Unavailable" }
          )
      });

      expect(pass.state).toBe("succeeded_with_warnings");
      // Nothing may report this rollback complete while an issued delete has no
      // answer, and the ledger keeps claiming every resource.
      expect(
        unresolvedProviderMutations(op).map((entry) => entry.kind)
      ).toEqual([
        "role_assignment.cleanup_delete",
        // No entry for the principal: its identity could not be read, so no
        // delete was issued for it in the first place.
        "azure_app.cleanup_delete"
      ]);
      expect(op.setupArtifacts.azureApp.state).toBe("created");
      expect(op.setupArtifacts.servicePrincipal.state).toBe("created");
    });

    it("survives a restart and reconciles instead of replaying", async () => {
      const op = azureOp();
      const deletes: string[][] = [];
      const runAz = async (args: string[]) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
        if (args.includes("delete")) {
          deletes.push(args);
          return lost;
        }
        return {
          code: 1,
          stdout: "",
          stderr: "Request_ResourceNotFound: Resource does not exist"
        };
      };

      await cleanupAzureSetupArtifacts(op, { runAz });
      const restored = reconcileRestoredOperation(
        fromPersistedOperation(toPersistedOperation(op))
      );
      await cleanupAzureSetupArtifacts(restored, { runAz });

      // One delete per artifact across the crash: the reload found each entry
      // already settled from the reread rather than issuing it again.
      expect(deletes).toHaveLength(4);
    });

    it("hands an unsettleable delete to the customer instead of locking the repo", async () => {
      const op = azureOp();
      await cleanupAzureSetupArtifacts(op, {
        runAz: async (args) =>
          args.includes("delete") ? lost : (
            { code: 1, stdout: "", stderr: "HTTP 503: Service Unavailable" }
          )
      });
      expect(unresolvedProviderMutations(op)).not.toEqual([]);
      finish(op, "failed_partial", { failure: { code: "x" } });
      // A terminal record with an unresolved delete holds the repository, and
      // nothing left alive would ever reread it.
      expect(hasUnfinishedCleanupAuthority(op)).toBe(true);

      const named = quarantineUnsettledCleanupDeletions(op);

      // Nothing is left that only a live reconciliation could clear, so the
      // record stops holding the repository against a new setup. The principal
      // is not among them: its identity was unreadable, so no delete for it was
      // ever issued.
      expect(named).toBe(2);
      expect(unresolvedProviderMutations(op)).toEqual([]);
      expect(providerRecoveryManualGuidance(op)).toContain(
        "will not repeat that delete"
      );
      expect(hasUnfinishedCleanupAuthority(op)).toBe(false);
      // And it still refuses every destructive command, so the resource is
      // named rather than deleted a second time.
      expect(canStartRollback(op).ok).toBe(false);
      expect(canRetryCleanup(op).ok).toBe(false);
      expect(canExitSetup(op).ok).toBe(false);
    });

    it("names nothing when every delete settled", async () => {
      const op = azureOp();
      await cleanupAzureSetupArtifacts(op, {
        runAz: async () => ({ code: 0, stdout: "", stderr: "" })
      });

      expect(quarantineUnsettledCleanupDeletions(op)).toBe(0);
      expect(providerRecoveryManualGuidance(op)).toBeNull();
    });

    it("stops the pass when the journal cannot be saved", async () => {
      const op = azureOp();
      const deletes: string[][] = [];

      const pass = await cleanupAzureSetupArtifacts(op, {
        runAz: async (args) => {
          const identity = answersRecordedIdentity(args);
          if (identity) return identity;
          if (args.includes("delete")) deletes.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
        persistJournal: async () => {
          throw new Error("disk full");
        }
      });

      // Nothing was deleted and nothing after the failure was attempted: a
      // rollback that cannot account for its own deletions stops.
      expect(deletes).toEqual([]);
      expect(pass.state).toBe("succeeded_with_warnings");
      expect(pass.results).toHaveLength(1);
      expect(pass.results[0]).toMatchObject({
        outcome: "warning",
        detail: expect.stringContaining("could not save the record")
      });
      expect(op.setupArtifacts.azureApp.state).toBe("created");
    });
  });

  describe("a federated credential name the customer may have reused", () => {
    function claimed(providerId: string | null) {
      const op = newAzureOp();
      recordAzureApp(op, { state: "created", appId: "app-1" });
      recordCreatedFederatedCredential(op, {
        name: "radius-dev",
        subject: "repo:octo/app:environment:dev",
        ...(providerId === null ? {} : { providerId })
      });
      return op;
    }

    async function attempt(op: ReturnType<typeof claimed>, liveId: unknown) {
      const deletes: string[][] = [];
      const pass = await cleanupAzureSetupArtifacts(op, {
        runAz: async (args) => {
          const asksForId =
            args.includes("federated-credential") &&
            args[args.indexOf("--query") + 1] === "id";
          if (asksForId) return liveId as never;
          if (args.includes("delete")) deletes.push(args);
          return { code: 0, stdout: "", stderr: "" };
        }
      });
      return { pass, deletes };
    }

    const credentialOutcome = (pass: {
      results: Array<Record<string, unknown>>;
    }) =>
      pass.results.find(
        (entry) => entry.artifactType === "federated_credential"
      );

    it("deletes when the credential still carries the id Radius recorded", async () => {
      const op = claimed("fic-1");

      const { pass, deletes } = await attempt(op, {
        code: 0,
        stdout: "fic-1\n",
        stderr: ""
      });

      expect(
        deletes.filter((args) => args.includes("federated-credential"))
      ).toHaveLength(1);
      expect(credentialOutcome(pass)).toMatchObject({ outcome: "deleted" });
    });

    it("removes nothing when the name now answers for a different credential", async () => {
      const op = claimed("fic-1");

      const { pass, deletes } = await attempt(op, {
        code: 0,
        stdout: "fic-2\n",
        stderr: ""
      });

      expect(
        deletes.filter((args) => args.includes("federated-credential"))
      ).toEqual([]);
      expect(credentialOutcome(pass)).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining("different provider id")
      });
    });

    it("removes nothing for a record written before the id was captured", async () => {
      const op = claimed(null);

      const { pass, deletes } = await attempt(op, {
        code: 0,
        stdout: "fic-1\n",
        stderr: ""
      });

      expect(
        deletes.filter((args) => args.includes("federated-credential"))
      ).toEqual([]);
      expect(credentialOutcome(pass)).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining("without the provider id")
      });
    });

    it.each([
      [
        "the read is refused",
        {
          code: 1,
          stdout: "",
          stderr: "AuthorizationFailed: cannot read this credential"
        },
        "confirm its identity"
      ],
      [
        "Entra reports no id",
        { code: 0, stdout: "  \n", stderr: "" },
        "did not report an id"
      ]
    ])("removes nothing when %s", async (_label, liveId, expected) => {
      const op = claimed("fic-1");

      const { pass, deletes } = await attempt(op, liveId);

      expect(
        deletes.filter((args) => args.includes("federated-credential"))
      ).toEqual([]);
      expect(credentialOutcome(pass)).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining(expected)
      });
    });

    it("settles without a delete when the credential is already gone", async () => {
      const op = claimed("fic-1");

      const { pass, deletes } = await attempt(op, {
        code: 1,
        stdout: "",
        stderr: "Request_ResourceNotFound: the credential does not exist"
      });

      // Entra says it is not there. Nothing needs deleting, and a delete
      // addressed by name could only reach a later credential.
      expect(
        deletes.filter((args) => args.includes("federated-credential"))
      ).toEqual([]);
      expect(credentialOutcome(pass)?.outcome).toBe("not_found");
    });
  });

  // A principal is addressed by Entra's object id, never by the application it
  // belongs to: that application can be given a new principal, and a delete
  // keyed on the appId would remove the customer's.
  describe("a Service Principal the application may have replaced", () => {
    function claimed(objectId: string | null) {
      const op = newAzureOp();
      recordServicePrincipal(op, {
        state: "created",
        origin: "this_operation",
        appId: "app-1",
        ...(objectId === null ? {} : { objectId })
      });
      return op;
    }

    async function attempt(
      op: ReturnType<typeof claimed>,
      liveId: unknown = { code: 0, stdout: "sp-1\n", stderr: "" }
    ) {
      const deletes: string[][] = [];
      const pass = await cleanupAzureSetupArtifacts(op, {
        runAz: async (args) => {
          const asksForId =
            args[1] === "sp" &&
            args[2] === "show" &&
            args[args.indexOf("--query") + 1] === "id";
          if (asksForId) return liveId as never;
          if (args.includes("delete")) deletes.push(args);
          return { code: 0, stdout: "", stderr: "" };
        }
      });
      return { pass, deletes };
    }

    const outcome = (pass: { results: Array<Record<string, unknown>> }) =>
      pass.results.find((entry) => entry.artifactType === "service_principal");

    it("deletes by object id when that is what still answers", async () => {
      const op = claimed("sp-1");

      const { pass, deletes } = await attempt(op);

      expect(deletes).toEqual([["ad", "sp", "delete", "--id", "sp-1"]]);
      expect(outcome(pass)).toMatchObject({ outcome: "deleted" });
      expect(op.setupArtifacts.servicePrincipal.state).toBe("deleted");
    });

    it("writes the object id into the identity the journal records", async () => {
      const op = claimed("sp-1");

      const { pass } = await attempt(op);

      // Keyed on the object id, so a replacement for the same application is a
      // different target to the journal and to a retry.
      expect(outcome(pass)?.identity).toBe("sp-1|app-1");
    });

    it("removes nothing when the application now has a different principal", async () => {
      const op = claimed("sp-1");

      const { pass, deletes } = await attempt(op, {
        code: 0,
        stdout: "sp-2\n",
        stderr: ""
      });

      expect(deletes).toEqual([]);
      expect(outcome(pass)).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining("different provider id")
      });
      expect(op.setupArtifacts.servicePrincipal.state).toBe("created");
    });

    it("removes nothing for a record that only ever held the application id", async () => {
      const op = claimed(null);

      const { pass, deletes } = await attempt(op);

      expect(deletes).toEqual([]);
      expect(outcome(pass)).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining(
          "without Microsoft Entra's own object id"
        )
      });
      expect(op.setupArtifacts.servicePrincipal.state).toBe("created");
    });

    it.each([
      [
        "the read is refused",
        {
          code: 1,
          stdout: "",
          stderr: "AuthorizationFailed: caller cannot read this principal"
        },
        "confirm its identity"
      ],
      [
        "Entra reports no id",
        { code: 0, stdout: "  \n", stderr: "" },
        "did not report an id"
      ]
    ])("removes nothing when %s", async (_label, liveId, expected) => {
      const op = claimed("sp-1");

      const { pass, deletes } = await attempt(op, liveId);

      expect(deletes).toEqual([]);
      expect(outcome(pass)).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining(expected)
      });
      expect(op.setupArtifacts.servicePrincipal.state).toBe("created");
    });

    it("retries a target an earlier version keyed before the object id led", async () => {
      const op = claimed("sp-1");
      // What the previous build wrote: keyed on the application alone.
      recordCleanupState(op, {
        attempts: 1,
        state: "succeeded_with_warnings",
        results: [
          {
            attempt: 1,
            artifactType: "service_principal",
            target: "app-1",
            identity: "app-1",
            outcome: "warning",
            detail: "Entra was unreachable."
          }
        ]
      });

      const deletes: string[][] = [];
      const pass = await cleanupAzureSetupArtifacts(op, {
        // The retry names its targets from what the earlier pass recorded.
        only: new Set(unresolvedCleanupTargets(op).map(cleanupTargetKey)),
        runAz: async (args) => {
          const identity = answersRecordedIdentity(args);
          if (identity) return identity;
          if (args.includes("delete")) deletes.push(args);
          return { code: 0, stdout: "", stderr: "" };
        }
      });

      // The retry has to recognize its own outstanding target, or the
      // principal stays claimed and unremovable for good.
      expect(deletes).toEqual([["ad", "sp", "delete", "--id", "sp-1"]]);
      expect(outcome(pass)).toMatchObject({ outcome: "deleted" });
    });

    it("reconciles a lost delete against the exact object id", async () => {
      const op = claimed("sp-1");
      const reads: string[][] = [];
      const deletes: string[][] = [];

      await cleanupAzureSetupArtifacts(op, {
        runAz: async (args) => {
          if (args[2] === "show") {
            reads.push(args);
            return args.includes("--query") ?
                { code: 0, stdout: "sp-1\n", stderr: "" }
              : { code: 0, stdout: "", stderr: "" };
          }
          if (args.includes("delete")) {
            deletes.push(args);
            return { code: 1, stdout: "", stderr: "", timedOut: true };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
        persistJournal: async () => {}
      });

      // The delete went out once and was never answered. Reconciliation reads
      // the same object id back rather than repeating it.
      expect(deletes).toEqual([["ad", "sp", "delete", "--id", "sp-1"]]);
      expect(
        reads.filter((args) => args.includes("sp-1")).length
      ).toBeGreaterThan(1);
      // Journaled against the object id, so a reconciliation after a restart
      // reads back the exact principal the delete was aimed at.
      expect(
        op.providerRecovery.mutations.find(
          (entry: any) => entry.kind === "service_principal.cleanup_delete"
        )
      ).toMatchObject({ target: "sp-1|app-1" });
    });
  });

  it("is idempotent across repeated cleanup attempts", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });

    await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) =>
        answersRecordedIdentity(args) ?? { code: 0, stdout: "", stderr: "" }
    });
    // Proof of removal moves ownership: both artifacts are recorded as gone, so
    // a repeat attempt has nothing left it may act on and issues no `az` call.
    expect(op.setupArtifacts.servicePrincipal.state).toBe("deleted");
    expect(op.setupArtifacts.azureApp.state).toBe("deleted");
    const repeatedCalls: string[][] = [];
    const second = await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
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
      assignmentId: "assignment-1",
      role: "Contributor",
      scope: "/subscriptions/sub",
      principalObjectId: "sp-1"
    });

    // An interrupted rollback must still report exactly what it removed, so the
    // ledger is asked what it holds at the moment each delete returns.
    const observed: Array<{ outcomes: string[]; state: string }> = [];
    await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) =>
        answersRecordedIdentity(args) ?? { code: 0, stdout: "", stderr: "" },
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
      name: "dev",
      providerId: "env-1"
    });
    await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async () => {
        throw new Error("GitHub returned 502.");
      },
      // Nothing can prove the environment gone, so it stays claimed and a
      // rollback retry still has it to target.
      readEnvironment: environmentReader({
        listing: { code: 1, stdout: "", stderr: "HTTP 500: server error" },
        reread: { code: 1, stdout: "", stderr: "HTTP 500: server error" }
      })
    });
    recordCleanupState(op, {
      state: "running",
      results: [
        {
          attempt: 1,
          artifactType: "github_environment",
          target: "octo/app:dev",
          identity: "env-1|octo/app:dev",
          outcome: "warning",
          detail: "GitHub returned 502."
        }
      ]
    });

    const seen: string[][] = [];
    await cleanupAzureSetupArtifacts(op, {
      runAz: async (args: string[]) =>
        answersRecordedIdentity(args) ?? {
          code: 0,
          stdout: "",
          stderr: ""
        },
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
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });

    // First attempt: the Service Principal goes, the App Registration does not.
    await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) =>
        answersRecordedIdentity(args) ??
        (args.includes("app") && args.includes("delete") ?
          {
            code: 1,
            stdout: "",
            stderr: "TooManyRequests: Azure CLI is being throttled."
          }
        : { code: 0, stdout: "", stderr: "" })
    });
    expect(op.setupArtifacts.servicePrincipal.state).toBe("deleted");
    expect(op.setupArtifacts.azureApp.state).toBe("created");

    const retriedCalls: string[][] = [];
    const retry = await cleanupAzureSetupArtifacts(op, {
      only: new Set(["azure_app#app-1"]),
      runAz: async (args) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
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
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    expect(calls).toEqual([]);
    expect(result.state).toBe("not_needed");
    expect([...result.attemptedKeys]).toEqual([]);
    expect(op.setupArtifacts.azureApp.state).toBe("created");
  });

  it("reconciles a timed-out Azure delete by its stable provider id", async () => {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    const calls: string[][] = [];

    const cleanup = await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
        calls.push(args);
        return args.includes("delete") ?
            { code: 1, stdout: "", stderr: "terminated", timedOut: true }
          : {
              code: 1,
              stdout: "",
              stderr: "Request_ResourceNotFound: app was not found"
            };
      }
    });

    expect(cleanup.state).toBe("succeeded");
    expect(cleanup.results).toMatchObject([
      { artifactType: "azure_app", outcome: "not_found" }
    ]);
    expect(calls).toEqual([
      ["ad", "app", "delete", "--id", "app-1"],
      ["ad", "app", "show", "--id", "app-1", "-o", "none"]
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
      subject: "repo:octo/app:environment:dev",
      providerId: "fic-radius-dev"
    });
    recordCreatedRoleAssignment(op, {
      assignmentId: "assignment-1",
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      principalObjectId: "sp-1"
    });

    const calls: string[][] = [];
    const cleanup = await cleanupAzureSetupArtifacts(op, {
      runAz: async (args) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
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
        "--ids",
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Authorization/roleAssignments/assignment-1",
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
      ["ad", "sp", "delete", "--id", "sp-1"],
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
      name: "dev",
      providerId: "env-1"
    });
    const calls: string[][] = [];
    const steps: string[] = [];

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async (args) => {
        calls.push(args);
      },
      steps,
      readEnvironment: environmentReader()
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
        identity: "env-1|octo/app:dev",
        outcome: "deleted"
      }
    ]);
    expect(op.setupArtifacts.githubEnvironment.state).toBe("deleted");
    expect(steps).toEqual(['✅ Deleted GitHub environment "dev"']);
  });

  it("invalidates the listing cache for the repository it removed the environment from", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev",
      providerId: "env-1"
    });
    const invalidated: string[] = [];

    await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async () => {},
      invalidateEnvironmentListing: (repo) => {
        invalidated.push(repo);
      },
      readEnvironment: environmentReader()
    });

    // Without this the picker keeps serving the rolled-back environment from
    // the short-TTL listing cache, still labelled from its last verify run.
    expect(invalidated).toEqual(["octo/app"]);
  });

  it.each([
    [
      "the delete failed",
      "created",
      async () => {
        throw new Error("GitHub API request failed.");
      }
    ],
    [
      "the environment could not be claimed",
      "created_candidate",
      async () => {
        throw new Error("must not delete an environment it cannot claim");
      }
    ]
  ])(
    "leaves the listing cache alone when %s",
    async (_name, state, runDeleteEnvironment) => {
      const op = newAzureOp();
      recordGitHubEnvironment(op, { state, repo: "octo/app", name: "dev" });
      const invalidated: string[] = [];

      await cleanupGitHubEnvironmentArtifact(op, {
        attempt: 1,
        runDeleteEnvironment,
        invalidateEnvironmentListing: (repo) => {
          invalidated.push(repo);
        },
        readEnvironment: environmentReader()
      });

      // The environment is still there, so a listing that still shows it is
      // correct and must not be thrown away.
      expect(invalidated).toEqual([]);
    }
  );

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
      },
      readEnvironment: environmentReader()
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

  it("keeps claiming the environment when GitHub refuses the delete", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev",
      providerId: "env-1"
    });

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async () => {
        throw new Error("HTTP 403: Resource not accessible by integration");
      },
      readEnvironment: environmentReader()
    });

    // GitHub composed the refusal, so nothing was removed and the retry may
    // reissue exactly this delete.
    expect(result.results).toMatchObject([
      {
        outcome: "warning",
        detail: "HTTP 403: Resource not accessible by integration"
      }
    ]);
    expect(result.warnings[0]).toContain("HTTP 403");
    expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
    expect(
      op.providerRecovery.mutations.map(
        (entry: { kind: string; status: string }) =>
          `${entry.kind}:${entry.status}`
      )
    ).toEqual(["github_environment.cleanup_delete:not_applied"]);
  });

  it("leaves the environment delete unresolved when its answer is lost", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev",
      providerId: "env-1"
    });
    let deletes = 0;

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async () => {
        deletes += 1;
        throw new Error(
          "Outcome unknown after provider timeout; Radius will not repeat this delete blindly."
        );
      },
      // The environment cannot be read back either, so nothing settles it.
      readEnvironment: environmentReader({
        listing: { code: 1, stdout: "", stderr: "HTTP 500: server error" },
        reread: { code: 1, stdout: "", stderr: "HTTP 500: server error" }
      })
    });

    expect(deletes).toBe(1);
    expect(result.results[0].outcome).toBe("warning");
    // Unresolved, so the ledger still claims the environment and no pass may
    // report this rollback complete.
    expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
    expect(unresolvedProviderMutations(op).map((entry) => entry.kind)).toEqual([
      "github_environment.cleanup_delete"
    ]);
  });

  it("settles a lost environment delete once the environment reads back absent", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev",
      providerId: "env-1"
    });

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async () => {
        throw new Error(
          "Outcome unknown after provider timeout; Radius will not repeat this delete blindly."
        );
      },
      // The identity read, the listing the account can complete, then the
      // confirming reread. A bare 404 alone would not be enough.
      readEnvironment: environmentReader({ listing: envListing(["prod"]) })
    });

    expect(result.results[0].outcome).toBe("not_found");
    expect(op.setupArtifacts.githubEnvironment.state).toBe("deleted");
    expect(unresolvedProviderMutations(op)).toEqual([]);
  });

  it("refuses to delete an environment that came back after a lost delete", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev",
      providerId: "env-1"
    });
    let deletes = 0;
    const runDeleteEnvironment = async () => {
      deletes += 1;
      throw new Error(
        "Outcome unknown after provider timeout; Radius will not repeat this delete blindly."
      );
    };
    // The customer rebuilt the environment while Radius was down, so the name
    // now answers for their resource rather than this attempt's leftover.
    const readEnvironment = environmentReader({
      listing: envListing(["dev"]),
      reread: ENV_PRESENT
    });

    const first = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment,
      readEnvironment
    });
    const retry = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 2,
      runDeleteEnvironment,
      readEnvironment
    });

    expect(first.results[0].outcome).toBe("skipped");
    expect(retry.results[0].outcome).toBe("skipped");
    // One delete, ever. The retry resolves to the journal's refusal instead of
    // removing the replacement.
    expect(deletes).toBe(1);
    expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
  });

  describe("a DELETE the environments API answers 404", () => {
    function listing(names: string[]) {
      return {
        code: 0,
        stdout: JSON.stringify({
          total_count: names.length,
          environments: names.map((name) => ({ name }))
        }),
        stderr: ""
      };
    }

    function claimedEnvironment() {
      const op = newAzureOp();
      recordGitHubEnvironment(op, {
        state: "created",
        repo: "octo/app",
        name: "dev",
        providerId: "env-1"
      });
      return op;
    }

    it("does not report a removal when the listing is refused", async () => {
      const op = claimedEnvironment();
      const invalidated: string[] = [];
      let deletes = 0;

      const result = await cleanupGitHubEnvironmentArtifact(op, {
        attempt: 1,
        runDeleteEnvironment: async () => {
          deletes += 1;
          throw new Error("HTTP 404: Not Found");
        },
        // Repository metadata may be readable; the Actions environments API is
        // not. GitHub answers 404 per resource, so the DELETE's own 404 proves
        // nothing about whether the environment is gone.
        readEnvironment: environmentReader({
          listing: {
            code: 1,
            stdout: "",
            stderr: "HTTP 403: Resource not accessible"
          }
        }),
        invalidateEnvironmentListing: (repo) => invalidated.push(repo)
      });

      expect(deletes).toBe(1);
      expect(result.results[0].outcome).toBe("warning");
      // Ownership never moves and the picker's cache is never released.
      expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
      expect(invalidated).toEqual([]);
      expect(
        unresolvedProviderMutations(op).map((entry) => entry.kind)
      ).toEqual(["github_environment.cleanup_delete"]);
    });

    it("refuses when the listing still holds the environment", async () => {
      const op = claimedEnvironment();
      const invalidated: string[] = [];

      const result = await cleanupGitHubEnvironmentArtifact(op, {
        attempt: 1,
        runDeleteEnvironment: async () => {
          throw new Error("HTTP 404: Not Found");
        },
        // The name answers for something the account can list, so the 404 was
        // masked access rather than a removal.
        readEnvironment: environmentReader({
          listing: listing(["dev", "prod"]),
          reread: ENV_PRESENT
        }),
        invalidateEnvironmentListing: (repo) => invalidated.push(repo)
      });

      expect(result.results[0].outcome).toBe("skipped");
      expect(result.results[0].detail).toContain("still present");
      expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
      expect(invalidated).toEqual([]);
    });

    it("settles not_found only from an exhaustive listing and a confirming reread", async () => {
      const op = claimedEnvironment();
      const invalidated: string[] = [];
      const reads: string[] = [];
      const reader = environmentReader({
        listing: listing(["prod", "staging"])
      });

      const result = await cleanupGitHubEnvironmentArtifact(op, {
        attempt: 1,
        runDeleteEnvironment: async () => {
          throw new Error("HTTP 404: Not Found");
        },
        readEnvironment: (args: string[]) => {
          reads.push(args[1]);
          return reader(args);
        },
        invalidateEnvironmentListing: (repo) => invalidated.push(repo)
      });

      // Identity first, then the listing, then the confirming reread.
      expect(reads).toEqual([
        "/repos/octo/app/environments/dev",
        "/repos/octo/app/environments?per_page=100&page=1",
        "/repos/octo/app/environments/dev"
      ]);
      expect(result.results[0].outcome).toBe("not_found");
      expect(op.setupArtifacts.githubEnvironment.state).toBe("deleted");
      expect(invalidated).toEqual(["octo/app"]);
      expect(unresolvedProviderMutations(op)).toEqual([]);
    });

    it("issues the delete exactly once whatever the proof decides", async () => {
      const op = claimedEnvironment();
      let deletes = 0;
      const ports = {
        runDeleteEnvironment: async () => {
          deletes += 1;
          throw new Error("HTTP 404: Not Found");
        },
        readEnvironment: environmentReader({
          listing: listing(["dev"]),
          reread: ENV_PRESENT
        })
      };

      await cleanupGitHubEnvironmentArtifact(op, { attempt: 1, ...ports });
      await cleanupGitHubEnvironmentArtifact(op, { attempt: 2, ...ports });

      expect(deletes).toBe(1);
    });
  });

  describe("a name the customer may have reused", () => {
    function claimed(providerId: string | null) {
      const op = newAzureOp();
      recordGitHubEnvironment(op, {
        state: "created",
        repo: "octo/app",
        name: "dev",
        ...(providerId === null ? {} : { providerId })
      });
      return op;
    }

    async function attempt(
      op: ReturnType<typeof claimed>,
      readEnvironment?: (
        args: string[]
      ) => Promise<{ code: number; stdout: string; stderr: string }>
    ) {
      const deletes: string[][] = [];
      const invalidated: string[] = [];
      const result = await cleanupGitHubEnvironmentArtifact(op, {
        attempt: 1,
        runDeleteEnvironment: async (args) => {
          deletes.push(args);
        },
        ...(readEnvironment ? { readEnvironment } : {}),
        invalidateEnvironmentListing: (repo) => invalidated.push(repo)
      });
      return { result, deletes, invalidated };
    }

    it("deletes when the environment still carries the id Radius recorded", async () => {
      const op = claimed("env-1");

      const { result, deletes, invalidated } = await attempt(
        op,
        environmentReader()
      );

      expect(deletes).toHaveLength(1);
      expect(result.results[0].outcome).toBe("deleted");
      expect(op.setupArtifacts.githubEnvironment.state).toBe("deleted");
      expect(invalidated).toEqual(["octo/app"]);
    });

    it("removes nothing when the customer recreated the name under a new id", async () => {
      const op = claimed("env-1");

      const { result, deletes, invalidated } = await attempt(
        op,
        environmentReader({
          identity: {
            code: 0,
            stdout: JSON.stringify({ id: "env-2", name: "dev" }),
            stderr: ""
          }
        })
      );

      // Same name, different environment. Deleting it would remove the
      // customer's replacement rather than this attempt's leftover.
      expect(deletes).toEqual([]);
      expect(result.results[0]).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining("different id")
      });
      expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
      expect(invalidated).toEqual([]);
    });

    it("removes nothing for a record written before the id was captured", async () => {
      const op = claimed(null);

      const { result, deletes } = await attempt(op, environmentReader());

      expect(deletes).toEqual([]);
      expect(result.results[0]).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining("without GitHub's own id")
      });
      expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
    });

    it.each([
      [
        "the read is forbidden",
        { code: 1, stdout: "", stderr: "HTTP 403: Forbidden" },
        "confirm its identity"
      ],
      [
        "GitHub reports no id",
        { code: 0, stdout: JSON.stringify({ name: "dev" }), stderr: "" },
        "did not report an id"
      ],
      [
        "GitHub returns an unreadable body",
        { code: 0, stdout: "<html>", stderr: "" },
        "did not report an id"
      ]
    ])("removes nothing when %s", async (_label, identity, expected) => {
      const op = claimed("env-1");

      const { result, deletes } = await attempt(
        op,
        environmentReader({ identity })
      );

      expect(deletes).toEqual([]);
      expect(result.results[0]).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining(expected)
      });
      expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
    });

    it("settles without a delete when the environment is already gone", async () => {
      const op = claimed("env-1");

      const { result, deletes, invalidated } = await attempt(
        op,
        environmentReader({ identity: ENV_NOT_FOUND })
      );

      // Absence is proven from a listing the account can read, so there is
      // nothing to address a delete at — and issuing one anyway could only
      // ever reach whichever environment takes the name next.
      expect(deletes).toEqual([]);
      expect(result.results[0].outcome).toBe("not_found");
      expect(op.setupArtifacts.githubEnvironment.state).toBe("deleted");
      expect(invalidated).toEqual(["octo/app"]);
    });

    it("refuses when a 404 cannot be corroborated by a listing", async () => {
      const op = claimed("env-1");

      const { result, deletes } = await attempt(
        op,
        environmentReader({
          identity: ENV_NOT_FOUND,
          listing: { code: 1, stdout: "", stderr: "HTTP 403: Forbidden" }
        })
      );

      // GitHub answers 404 for an environment this token may not see, so the
      // endpoint alone proves nothing.
      expect(deletes).toEqual([]);
      expect(result.results[0]).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining("could not prove from a listing")
      });
      expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
    });

    it("refuses when the listing still reports the environment", async () => {
      const op = claimed("env-1");

      const { result, deletes } = await attempt(
        op,
        environmentReader({
          identity: ENV_NOT_FOUND,
          listing: envListing(["dev", "prod"])
        })
      );

      expect(deletes).toEqual([]);
      expect(result.results[0]).toMatchObject({ outcome: "skipped" });
      expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
    });

    it("removes nothing when it has no way to read the environment back", async () => {
      const op = claimed("env-1");

      const { result, deletes } = await attempt(op);

      expect(deletes).toEqual([]);
      expect(result.results[0]).toMatchObject({
        outcome: "skipped",
        detail: expect.stringContaining("no way to read")
      });
    });
  });

  it("stops before deleting the environment when the journal cannot be saved", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev",
      providerId: "env-1"
    });
    let deletes = 0;

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: async () => {
        deletes += 1;
      },
      persistJournal: async () => {
        throw new Error("disk full");
      },
      readEnvironment: environmentReader()
    });

    // The record of what Radius was about to delete did not reach disk, so the
    // delete never went out.
    expect(deletes).toBe(0);
    expect(result.results[0]).toMatchObject({
      outcome: "warning",
      detail: expect.stringContaining("could not save the record")
    });
    expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
  });

  it("reports the missing delete helper rather than claiming a rollback", async () => {
    const op = newAzureOp();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev",
      providerId: "env-1"
    });

    const result = await cleanupGitHubEnvironmentArtifact(op, {
      attempt: 1,
      runDeleteEnvironment: null,
      readEnvironment: environmentReader()
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
      },
      readEnvironment: environmentReader()
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
  // Reading the ledger back out is only meaningful for a record that has one,
  // so a missing ledger is a broken fixture rather than a soft assertion.
  function ledgerOf(op: Parameters<typeof getSetupArtifactLedger>[0]) {
    const ledger = getSetupArtifactLedger(op);
    if (!ledger) throw new Error("expected the operation to carry a ledger");
    return ledger;
  }

  // A setup that created cloud and GitHub resources and then issued the one
  // destructive request it makes on its own behalf: deleting the setup branch a
  // recovered attempt had created.
  function quarantinedSetup() {
    const op = newAzureOp();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev",
      providerId: "env-1"
    });
    prepareProviderMutation(op, {
      kind: "github_branch.delete",
      target: "octo/app\u0000radius/setup-dev\u0000base-1"
    });
    return op;
  }

  it("removes nothing while a provider mutation is quarantined", async () => {
    // The setup-branch delete GitHub refused settles as manual_required and the
    // record then says Radius started no rollback. Running the pre-commit
    // cleanup anyway would delete the Azure identity and the GitHub environment
    // in the same breath as that sentence.
    const op = quarantinedSetup();
    const guidance =
      'Radius could not remove the setup branch "radius/setup-dev" it recovered. Remove that exact branch yourself, then start setup again.';
    settleProviderMutation(
      op,
      op.providerRecovery.mutations[0].mutationId,
      "manual_required",
      guidance
    );

    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: guidance,
      code: "provider-mutation-manual-required",
      extra: { steps: [] },
      steps: [],
      runAz: async (args) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
        throw new Error(`Azure must not be mutated: ${args.join(" ")}`);
      },
      runDeleteEnvironment: async (args) => {
        throw new Error(`GitHub must not be mutated: ${args.join(" ")}`);
      }
    });

    expect(failure.body.providerRecoveryGuidance).toBe(guidance);
    expect(failure.body.cleanup).toMatchObject({
      rollbackAttempted: false,
      state: "not_needed"
    });
    // The resources are still recorded as present, so the customer can act on
    // them and a later rollback still has something to remove.
    expect(ledgerOf(op).githubEnvironment.state).toBe("created");
    expect(ledgerOf(op).azureApp.state).toBe("created");
  });

  it("removes nothing while a delete outcome is merely unproven", async () => {
    // The reconcile read failed, so the delete settles `outcome_unknown` rather
    // than `manual_required`. The request still reached GitHub, so the resource
    // set this attempt owns is just as unknown as in the refused case.
    const op = quarantinedSetup();
    settleProviderMutation(
      op,
      op.providerRecovery.mutations[0].mutationId,
      "outcome_unknown",
      "The delete response was lost."
    );

    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: "outcome unknown",
      code: "provider-mutation-outcome-unknown",
      extra: { steps: [] },
      steps: [],
      runAz: async (args) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
        throw new Error(`Azure must not be mutated: ${args.join(" ")}`);
      },
      runDeleteEnvironment: async (args) => {
        throw new Error(`GitHub must not be mutated: ${args.join(" ")}`);
      }
    });

    expect(failure.body.providerRecoveryGuidance).toContain(
      "has not confirmed the outcome of github_branch.delete"
    );
    expect(failure.body.cleanup).toMatchObject({ state: "not_needed" });
    expect(ledgerOf(op).githubEnvironment.state).toBe("created");
  });

  it("removes nothing when the quarantine is carried by a sticky rollback", async () => {
    // `settleProviderMutation` keeps `rollback_pending` and clears the
    // recovery-level guidance, so the refusal is readable only through the
    // mutation's own evidence. That is the shape production actually produces.
    const op = quarantinedSetup();
    op.providerRecovery.state = "rollback_pending";
    settleProviderMutation(
      op,
      op.providerRecovery.mutations[0].mutationId,
      "manual_required",
      "Remove that exact branch yourself, then start setup again."
    );
    expect(op.providerRecovery.state).toBe("rollback_pending");
    expect(op.providerRecovery.guidance).toBeNull();

    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: "refused",
      code: "provider-mutation-manual-required",
      extra: { steps: [] },
      steps: [],
      runAz: async (args) => {
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
        throw new Error(`Azure must not be mutated: ${args.join(" ")}`);
      },
      runDeleteEnvironment: async (args) => {
        throw new Error(`GitHub must not be mutated: ${args.join(" ")}`);
      }
    });

    expect(failure.body.providerRecoveryGuidance).toBe(
      "Remove that exact branch yourself, then start setup again."
    );
    expect(ledgerOf(op).githubEnvironment.state).toBe("created");
  });

  it("still rolls back once the quarantined mutation is settled", async () => {
    // The recovered delete succeeded, which is exactly the case that must go on
    // to remove the rest of what this attempt created.
    const op = quarantinedSetup();
    op.providerRecovery.state = "rollback_pending";
    settleProviderMutation(
      op,
      op.providerRecovery.mutations[0].mutationId,
      "confirmed",
      "GitHub confirmed the recovered setup branch is absent."
    );

    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: "rolled back",
      code: "provider-mutation-recovered-rollback",
      extra: { steps: [] },
      steps: [],
      runAz: async (args: string[]) =>
        answersRecordedIdentity(args) ?? {
          code: 0,
          stdout: "",
          stderr: ""
        },
      runDeleteEnvironment: async () => {},
      readEnvironment: environmentReader()
    });

    expect(failure.body.cleanup).toMatchObject({
      rollbackBeforeCommit: true,
      state: "succeeded"
    });
    expect(ledgerOf(op).githubEnvironment.state).toBe("deleted");
  });

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
      subject: "repo:octo/app:environment:dev",
      providerId: "fic-radius-dev"
    });
    recordCreatedRoleAssignment(op, {
      assignmentId: "assignment-1",
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      principalObjectId: "sp-1"
    });
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev",
      providerId: "env-1"
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
        const identity = answersRecordedIdentity(args);
        if (identity) return identity;
        azCalls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
      runDeleteEnvironment: async (args) => {
        ghCalls.push(args);
      },
      readEnvironment: environmentReader()
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
        "--ids",
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Authorization/roleAssignments/assignment-1",
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
      ["ad", "sp", "delete", "--id", "sp-1"],
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
      subject: "repo:octo/app:environment:dev",
      providerId: "fic-radius-dev"
    });
    recordCreatedRoleAssignment(op, {
      assignmentId: "assignment-1",
      role: "Contributor",
      scope: "/subscriptions/sub/resourceGroups/rg",
      principalObjectId: "sp-1"
    });
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "octo/app",
      name: "dev",
      providerId: "env-1"
    });

    const failure = await finalizeSetupFailure(op, {
      status: 400,
      error: "original failure",
      code: "original-failure",
      steps: [],
      runAz: async (args) =>
        answersRecordedIdentity(args) ??
        (args[0] === "role" ?
          {
            code: 1,
            stdout: "",
            stderr:
              "AuthorizationFailed: caller cannot delete this role assignment."
          }
        : { code: 0, stdout: "", stderr: "" }),
      runDeleteEnvironment: async () => {
        throw new Error("GitHub delete exploded");
      },
      readEnvironment: environmentReader({
        listing: { code: 1, stdout: "", stderr: "HTTP 500: server error" },
        reread: { code: 1, stdout: "", stderr: "HTTP 500: server error" }
      })
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
        // The GitHub delete's answer was never established, so the environment
        // stays claimed instead of being reported as removed.
        expect.stringContaining("Outcome unknown after provider timeout")
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
      reused: [expect.objectContaining({ target: "octo/app:dev" })]
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
      manualActionRequired: [
        expect.objectContaining({
          kind: "github_environment",
          target: "octo/app:dev"
        })
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
      name: "dev",
      providerId: "env-1"
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
      name: "dev",
      providerId: "env-1"
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
    expect((failure.body.cleanup as any).retainedArtifacts).toEqual([
      { kind: "azure_app", target: "radius-deploy-octo-app (app-1)" },
      {
        kind: "service_principal",
        target: "Service Principal for radius-deploy-octo-app (app-1)"
      },
      { kind: "github_environment", target: "octo/app:dev" },
      {
        kind: "workflow_file",
        target: ".github/workflows/radius-verify-credentials.yml on main"
      }
    ]);
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
    const state: CanvasState = {
      graphBuildGeneration: 2,
      graphProgressRecords: {
        graph: {
          graphBuildEvents: [
            {
              sequence: 1,
              stage: "checking_model",
              state: "running",
              detail: "current"
            }
          ],
          graphProgressGeneration: 1,
          graphProgressStartedAtMs: 0,
          graphProgressActive: true,
          graphProgressView: "graph",
          graphProgressKey: "octo/app",
          graphProgressOwner: 1,
          graphProgressAwaitingModel: false
        }
      }
    };

    expect(
      addGraphProgress(state, 1, "graph", {
        stage: "building_graph",
        state: "running",
        detail: "stale"
      })
    ).toBe(false);
    expect(
      addGraphProgress(state, 2, "graph", {
        stage: "building_graph",
        state: "running",
        detail: "latest"
      })
    ).toBe(true);
    expect(state.graphProgressRecords?.graph?.graphBuildEvents).toEqual([
      {
        sequence: 1,
        stage: "checking_model",
        state: "running",
        detail: "current"
      },
      {
        sequence: 2,
        stage: "building_graph",
        state: "running",
        detail: "latest"
      }
    ]);
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

  it("does not hand off an OIDC subject case mismatch", () => {
    const calls: DeployRepairHandoffInput[] = [];
    setDeployRepairHandoff((payload) => {
      calls.push(payload);
    });
    expect(
      triggerDeployRepairHandoff(
        failedEntry({
          deployErrorKind: DEPLOY_OIDC_SUBJECT_CASE_MISMATCH_KIND
        })
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

  it("clears concrete metadata from the previous deployment attempt", () => {
    const entry = failedEntry();
    entry.state.deployedGraph = [
      {
        id: "mysql",
        outputResources: [
          { id: "old-server", type: "Microsoft.DBforMySQL/flexibleServers" }
        ]
      }
    ];
    entry.state.deployedGraphRepo = "octo/app";

    beginDeployAttempt(entry.state, {
      repo: "octo/app",
      branch: "feat",
      provider: "azure",
      environment: "dev",
      appFile: ".radius/app.bicep",
      repairLoop: false
    });

    expect(entry.state.deployedGraph).toBeNull();
    expect(entry.state.deployedGraphRepo).toBeUndefined();
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
      tenantId,
      // The prose is unchanged; the runnable form of the same guidance rides
      // alongside it so the canvas can offer to run it.
      remediation: remediationView("azure-cli-login", { tenantId })
    });
    expect(azureLoginRequiredResponse({ tenantId }).remediation.command).toBe(
      `az login --use-device-code --tenant ${tenantId}`
    );
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

describe("azure-cli-assist registry migration contract", () => {
  // Frozen copies of the prompts this route produced before they moved into the
  // core remediation registry. `/api/azure-cli-assist` is a shipped contract, so
  // the migration is only correct if the bytes are unchanged, apart from the one
  // divergence recorded below.
  const LEGACY_LOGIN_INSTRUCTIONS = [
    "Run `az login --use-device-code --tenant 11111111-2222-3333-4444-555555555555` in this Copilot session.",
    "For that command, remove COPILOT_AGENT_SESSION_ID from the az process environment so Azure CLI does not inject it into the authentication request.",
    "Use the shell-appropriate way to unset the variable only for the login invocation, and show me the device code and sign-in URL."
  ].join(" ");
  const LEGACY_LOGIN_FOLLOW_UP =
    "After the login finishes, return to the Radius canvas and click Verify Credentials again.";
  const LEGACY_INSTALL_FOLLOW_UP =
    "After the install and login finish, return to the Radius canvas and click Verify Credentials again.";
  // The trailing follow-up line is the one deliberate divergence from the legacy
  // bytes. It is written in the user's voice and names a step in the canvas UI,
  // so the agent read it as its own next action and carried it out — deploying
  // for the user rather than stopping at the command it was asked to run. It is
  // now relayed as the user's step. Every line before it is still frozen.
  const relayed = (followUp: string): string =>
    `Your task ends when the command finishes. Then tell the user: ${followUp} Do not carry out that step yourself; it belongs to the user in the Radius canvas.`;
  const LEGACY_LOGIN_PROMPT = [
    "The Radius canvas needs an active Azure CLI session before it can verify these credentials.",
    LEGACY_LOGIN_INSTRUCTIONS,
    relayed(LEGACY_LOGIN_FOLLOW_UP)
  ].join("\n\n");
  const LEGACY_INSTALL_PROMPT = [
    "Azure CLI is not installed in this environment, so the Radius canvas can't verify Azure credentials yet.",
    `Please install Azure CLI, then ${LEGACY_LOGIN_INSTRUCTIONS.replace(" --tenant 11111111-2222-3333-4444-555555555555", "")}`,
    relayed(LEGACY_INSTALL_FOLLOW_UP)
  ].join("\n\n");

  it("reproduces the legacy login prompt, with the follow-up relayed", () => {
    expect(
      buildAzureCliAssistPrompt({
        action: "login",
        tenantId: "11111111-2222-3333-4444-555555555555"
      })
    ).toBe(LEGACY_LOGIN_PROMPT);
  });

  it("reproduces the legacy install prompt, with the follow-up relayed", () => {
    expect(buildAzureCliAssistPrompt({ action: "install" })).toBe(
      LEGACY_INSTALL_PROMPT
    );
  });

  it("reproduces the legacy display prompts byte for byte", () => {
    expect(azureCliAssistDisplayPrompt({ action: "login" })).toBe(
      "Signing in to Azure CLI so the Radius canvas can verify these Azure credentials."
    );
    expect(azureCliAssistDisplayPrompt({ action: "install" })).toBe(
      "Installing Azure CLI and signing in so the Radius canvas can verify these Azure credentials."
    );
  });

  it.each([
    ["an unknown action", { action: "wipe", tenantId: "" }],
    ["a non-string tenant id", { action: "login", tenantId: 7 }],
    ["a tenant id that is not a guid", { action: "login", tenantId: "nope" }]
  ])("stays on the tenant-agnostic login prompt for %s", (_label, input) => {
    expect(
      buildAzureCliAssistPrompt(
        input as Parameters<typeof buildAzureCliAssistPrompt>[0]
      )
    ).toBe(
      LEGACY_LOGIN_PROMPT.replace(
        " --tenant 11111111-2222-3333-4444-555555555555",
        ""
      )
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
