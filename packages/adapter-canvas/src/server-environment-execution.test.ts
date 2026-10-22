import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowFileCommitter } from "@radius-project/core";
import { bindWorkflowFileCommitterPorts } from "./server/routes/create-environment-workflow-committer.js";
import {
  createEnvironmentAccountContext,
  type EnvironmentAccountContext
} from "./runtime/environment-account-context.js";
import { createGitHubAccountCoordinator } from "./server/services/github-account-coordinator.js";
import { successfulSelectedGhExecutor } from "../test/support/server/selected-gh.js";
import type { SetupServices } from "./server/services/setup-outcome.js";
import { createSetupWorkflowRecoveryPort } from "./server/services/setup-workflow-recovery.js";
import {
  createInstanceRequestCoordinator,
  type EnvironmentOperationRunner
} from "./server.js";
import {
  createEnvironmentExecutionOwner,
  type EnvironmentExecutionOwner
} from "./runtime/environment-execution-owner.js";
import {
  acceptCommand,
  canStartRollback,
  createOperation,
  finish,
  fromPersistedOperation,
  operations,
  addLegacyStep,
  prepareProviderMutation,
  reconcileRestoredOperation,
  recordGitHubEnvironment,
  settleProviderMutation,
  requestStop,
  toPersistedOperation,
  STAGE_VERIFY
} from "./operations.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function unavailable(): Promise<never> {
  throw new Error("Unexpected external deletion");
}

function coordinator(
  owner: EnvironmentExecutionOwner,
  instanceId: string,
  runner?: EnvironmentOperationRunner,
  accountContext: EnvironmentAccountContext = createEnvironmentAccountContext(
    "runtime",
    {
      createReadOnlyExecutor: unavailable,
      withSelectedAccount: unavailable
    }
  ),
  setupServices: SetupServices = {
    authorizeAzure: unavailable,
    configureEnvironment: unavailable
  },
  awsEnvironmentAccess: Parameters<
    typeof createInstanceRequestCoordinator
  >[3]["awsEnvironmentAccess"] = { setup: unavailable }
) {
  return createInstanceRequestCoordinator(
    instanceId,
    () => `http://127.0.0.1:1/${instanceId}`,
    {
      deleteRadiusEnvironment: unavailable,
      runAz: unavailable,
      readAzureIdentity: unavailable,
      removeAwsEnvironmentAccess: unavailable,
      deleteGitHubEnvironment: unavailable,
      deleteStatePackage: unavailable,
      withCredentialProvenanceLock: (work) => work(),
      readCredentialProvenance: () => {
        throw new Error("Unexpected provenance read");
      },
      removeCredentialProvenance: unavailable,
      clearEnvironmentCredentialProvenance: unavailable,
      persist: () => operations.persist(),
      errorMessage: String,
      log: () => {
        throw new Error("Unexpected deletion diagnostic");
      }
    },
    {
      awsEnabled: false,
      awsEnvironmentAccess,
      executionOwner: owner,
      accountContext,
      setupServices,
      servers: new Map(),
      environmentOperationRunner: runner
    }
  );
}

function operation(id = "op") {
  const op = createOperation({
    operationId: id,
    repo: "fixture/app",
    environment: "dev",
    provider: "azure"
  });
  operations.put(op);
  return op;
}

function settled(owner: EnvironmentExecutionOwner, instanceId: string) {
  return new Promise<void>((resolve) => {
    const stop = owner.onEnvironmentTasksSettled(instanceId, () => {
      stop();
      resolve();
    });
  });
}

afterEach(() => {
  operations.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("production coordinator scheduling scopes", () => {
  it.each([
    "not_applied",
    "cancelled",
    "unknown",
    "persistence failure"
  ] as const)(
    "keeps core recovery %s fail closed through owner settlement and saved-record admission",
    async (outcome) => {
      const owner = createEnvironmentExecutionOwner({
        deferTask: async () => {},
        microtask: queueMicrotask,
        reconciliationTimer: () => () => {}
      });
      const op = operation("op_recovery");
      recordGitHubEnvironment(op, {
        state: "created",
        repo: "fixture/app",
        environment: "dev"
      });
      const target = "fixture/app\0setup-branch\0original-head";
      const creation = prepareProviderMutation(op, {
        kind: "github_branch.create",
        target
      });
      settleProviderMutation(op, creation.mutationId, "confirmed", null);
      op.providerRecovery.state = "rollback_pending";
      let saved = toPersistedOperation(op);
      const failure = new Error("Recovery storage unavailable.");
      const persist = async () => {
        if (
          outcome === "persistence failure" &&
          op.providerRecovery.mutations.some(
            (mutation: { status: string }) =>
              mutation.status === "manual_required"
          )
        ) {
          throw failure;
        }
        saved = toPersistedOperation(op);
      };
      vi.spyOn(operations, "persist").mockImplementation(persist);
      const ports = bindWorkflowFileCommitterPorts({
        getDefaultBranch: async () => "main",
        getBranchHeadSha: unavailable,
        createBranchRef: unavailable,
        runGh: async (args) => {
          expect(args).toEqual([
            "api",
            "/repos/fixture/app/git/ref/heads/setup-branch"
          ]);
          return {
            code: 0,
            stdout: '{"object":{"sha":"original-head"}}',
            stderr: ""
          };
        },
        runGhWorkflow: unavailable,
        mutationRecovery: { operation: op, persist },
        tempFile: {
          write: () => {
            throw new Error("Unexpected workflow write");
          },
          remove: () => {
            throw new Error("Unexpected workflow cleanup");
          }
        },
        errorMessage: String,
        pushStep: () => {
          throw new Error("Unexpected publication success");
        },
        now: () => 0
      });
      const recovery = ports.mutationRecovery;
      if (!recovery) throw new Error("Missing workflow recovery binding");
      const execute = recovery.execute;
      recovery.execute = async (input) => {
        if (input.kind !== "github_branch.delete") return execute(input);
        const deletion = prepareProviderMutation(op, input);
        settleProviderMutation(
          op,
          deletion.mutationId,
          outcome === "unknown" ? "outcome_unknown" : "not_applied",
          null
        );
        await persist();
        if (outcome === "unknown") throw failure;
        return { state: outcome === "cancelled" ? "cancelled" : "not_applied" };
      };
      const fetcher = vi.fn(unavailable);
      vi.stubGlobal("fetch", fetcher);
      let observed: unknown;
      const handler = coordinator(owner, "a", async () => {
        try {
          await createWorkflowFileCommitter(ports, {
            targetRepo: "fixture/app",
            envName: "dev"
          }).commitWorkflowFileSmart(
            ".github/workflows/verify.yml",
            "content",
            "message"
          );
        } catch (error) {
          observed = error;
          throw error;
        }
      });
      handler.scheduleEnvironmentOperation(op);
      await settled(owner, "a");
      if (outcome === "unknown" || outcome === "persistence failure") {
        expect(observed).toBe(failure);
      } else {
        expect(observed).toMatchObject({
          code: "provider-mutation-manual-required"
        });
      }
      const refusal = {
        ok: false,
        code:
          outcome === "unknown" ? "operation-active" : (
            "rollback-provider-outcome-unknown"
          )
      };
      expect(canStartRollback(op)).toMatchObject(refusal);
      const restored = fromPersistedOperation(saved);
      reconcileRestoredOperation(restored);
      expect(canStartRollback(restored)).toMatchObject(refusal);
      if (outcome === "persistence failure") {
        expect(restored.providerRecovery.mutations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "github_branch.create",
              status: "confirmed"
            }),
            expect.objectContaining({
              kind: "github_branch.delete",
              status: "not_applied"
            })
          ])
        );
      }
      expect(restored.setupArtifacts.githubEnvironment).toMatchObject({
        state: "created"
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(owner.hasActiveEnvironmentTasks("a")).toBe(false);
      owner.markEnvironmentInstanceShuttingDown("a");
    }
  );

  it.each(["recovery scan", "task settlement"] as const)(
    "does not schedule destructive recovery after non-applied branch deletion during %s",
    async (trigger) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      const block = () => {
        const mutation = prepareProviderMutation(op, {
          kind: "github_branch.delete",
          target: "fixture/app\0setup-branch\0original-head"
        });
        settleProviderMutation(
          op,
          mutation.mutationId,
          "not_applied",
          "The recorded branch remains."
        );
        finish(op, "failed_partial");
        op.providerRecovery.state = "rollback_pending";
      };
      const fetcher = vi.fn(unavailable);
      vi.stubGlobal("fetch", fetcher);
      const handler = coordinator(owner, "a", async () => block());
      if (trigger === "recovery scan") {
        block();
        handler.startRecoveredTasks();
      } else {
        handler.scheduleEnvironmentOperation(op);
        await settled(owner, "a");
      }
      await Promise.resolve();
      expect(fetcher).not.toHaveBeenCalled();
      expect(owner.hasActiveEnvironmentTasks("a")).toBe(false);
    }
  );

  it("keeps downstream cleanup blocked when saving the manual blocker fails", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    const target = "fixture/app\0setup-branch\0original-head";
    const creation = prepareProviderMutation(op, {
      kind: "github_branch.create",
      target
    });
    settleProviderMutation(op, creation.mutationId, "confirmed", null);
    op.providerRecovery.state = "rollback_pending";
    const persist = vi.fn(async () => {
      throw new Error("Recovery storage unavailable.");
    });
    const recovery = createSetupWorkflowRecoveryPort(op, persist);
    const fetcher = vi.fn(unavailable);
    vi.stubGlobal("fetch", fetcher);
    const handler = coordinator(owner, "a", async () => {
      recovery.settleManual(
        "github_branch.create",
        target,
        "Review the recovered branch before cleanup."
      );
      finish(op, "failed_partial");
      await recovery.persist();
    });
    handler.scheduleEnvironmentOperation(op);
    await settled(owner, "a");
    handler.startRecoveredTasks();
    await Promise.resolve();
    expect(persist).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    expect(owner.hasActiveEnvironmentTasks("a")).toBe(false);
  });

  it.each(["authorizeAzure", "configureEnvironment"] as const)(
    "requires the explicit %s service at construction",
    (name) => {
      const services: SetupServices = {
        authorizeAzure: unavailable,
        configureEnvironment: unavailable
      };
      Reflect.deleteProperty(services, name);
      expect(() =>
        coordinator(
          createEnvironmentExecutionOwner(),
          "panel",
          undefined,
          undefined,
          services
        )
      ).toThrow(
        `Missing request coordinator dependency: setupServices.${name}`
      );
    }
  );

  it.each(["before", "during"] as const)(
    "refuses setup after shutdown %s a direct Azure invocation",
    async (when) => {
      vi.spyOn(operations, "persist").mockResolvedValue(undefined);
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      op.context.githubLogin = "saved-account";
      op.request = { needsAzureCredentials: true, azure: {}, environment: {} };
      const run = vi.fn(async (args: string[]) => {
        const command = args.join(" ");
        if (command === "api user")
          return { code: 0, stdout: '{"login":"saved-account"}', stderr: "" };
        if (
          command === "api repos/fixture/app" ||
          command === "api /repos/fixture/app"
        )
          return {
            code: 0,
            stdout: '{"full_name":"fixture/app","permissions":{"admin":true}}',
            stderr: ""
          };
        if (command === "api /repos/fixture/app/environments/dev") {
          if (when === "before")
            owner.markEnvironmentInstanceShuttingDown("panel");
          return { code: 0, stdout: '{"name":"dev","id":17}', stderr: "" };
        }
        throw new Error(`Unexpected command: ${command}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run
      });
      const context = createEnvironmentAccountContext(
        "runtime",
        createGitHubAccountCoordinator({
          createExecutor: async () => executor,
          getActiveKeyringLogin: async () => "original",
          switchKeyringAccount: unavailable,
          resetIdentityCache: () => {}
        })
      );
      const entered = deferred();
      const gate = deferred();
      const authorizeAzure = vi.fn<SetupServices["authorizeAzure"]>(
        async () => {
          entered.resolve();
          await gate.promise;
          return {
            kind: "completed",
            status: 200,
            body: { clientId: "completed-group" }
          };
        }
      );
      const configureEnvironment = vi.fn(unavailable);
      const unregister = vi.spyOn(context, "unregisterExecutor");
      const handler = coordinator(owner, "panel", undefined, context, {
        authorizeAzure,
        configureEnvironment
      });
      const done = settled(owner, "panel");
      handler.scheduleEnvironmentOperation(op);
      try {
        if (when === "during") {
          await Promise.race([entered.promise, done]);
          expect(op.failure, JSON.stringify(run.mock.calls)).toBeNull();
          expect(authorizeAzure).toHaveBeenCalledOnce();
          owner.markEnvironmentInstanceShuttingDown("panel");
          expect(context.getExecutor(op.operationId)).toBe(executor);
        }
      } finally {
        gate.resolve();
        await done;
      }
      expect(authorizeAzure).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
      expect(configureEnvironment).not.toHaveBeenCalled();
      expect(op.state).not.toBe("succeeded");
      expect(op.failure, JSON.stringify(run.mock.calls)).toBeNull();
      expect(op.endedAt).toBeNull();
      expect(context.getExecutor(op.operationId)).toBeUndefined();
      expect(unregister).toHaveBeenCalledExactlyOnceWith(op.operationId);
      expect(run.mock.calls.every(([args]) => !args.includes("--method"))).toBe(
        true
      );
    }
  );

  it.each([false, true])(
    "hands an AWS operation to the AWS identity setup with its account (shutting down: %s)",
    async (shuttingDown) => {
      vi.spyOn(operations, "persist").mockResolvedValue(undefined);
      const owner = createEnvironmentExecutionOwner();
      const op = createOperation({
        operationId: "op-aws",
        repo: "fixture/app",
        environment: "dev",
        provider: "aws"
      });
      operations.put(op);
      op.context.githubLogin = "saved-account";
      op.request = {
        environment: {
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "shop"
        }
      };
      const run = vi.fn(async (args: string[]) => {
        const command = args.join(" ");
        if (command === "api user")
          return { code: 0, stdout: '{"login":"saved-account"}', stderr: "" };
        if (
          command === "api repos/fixture/app" ||
          command === "api /repos/fixture/app"
        )
          return {
            code: 0,
            stdout: '{"full_name":"fixture/app","permissions":{"admin":true}}',
            stderr: ""
          };
        if (command === "api /repos/fixture/app/environments/dev") {
          if (shuttingDown) owner.markEnvironmentInstanceShuttingDown("panel");
          return { code: 0, stdout: '{"name":"dev","id":17}', stderr: "" };
        }
        if (
          command ===
          "api /repos/fixture/app/environments/dev/variables?per_page=100"
        )
          return { code: 0, stdout: '{"variables":[]}', stderr: "" };
        throw new Error(`Unexpected command: ${command}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run
      });
      const context = createEnvironmentAccountContext(
        "runtime",
        createGitHubAccountCoordinator({
          createExecutor: async () => executor,
          getActiveKeyringLogin: async () => "original",
          switchKeyringAccount: unavailable,
          resetIdentityCache: () => {}
        })
      );
      const setup = vi.fn(async () => ({
        ok: false as const,
        status: 400,
        error: "AWS CLI not found. Nothing was created in AWS.",
        code: "aws-cli-missing"
      }));
      const configureEnvironment = vi.fn(unavailable);
      const handler = coordinator(
        owner,
        "panel",
        undefined,
        context,
        { authorizeAzure: unavailable, configureEnvironment },
        { setup }
      );
      const done = settled(owner, "panel");
      handler.scheduleEnvironmentOperation(op);
      await done;

      expect(configureEnvironment).not.toHaveBeenCalled();
      if (shuttingDown) {
        expect(setup).not.toHaveBeenCalled();
        expect(op.failure, JSON.stringify(run.mock.calls)).toBeNull();
        expect(op.endedAt).toBeNull();
      } else {
        expect(setup).toHaveBeenCalledExactlyOnceWith(
          op,
          expect.objectContaining({
            repo: "fixture/app",
            environment: "dev",
            accountId: "123456789012",
            region: "us-west-2",
            cluster: "shop"
          }),
          executor
        );
        expect(op.failure).toMatchObject({
          code: "aws-cli-missing",
          message: expect.stringContaining("Nothing was created in AWS.")
        });
        expect(op.state).not.toBe("succeeded");
      }
    }
  );

  it.each(["accountContext", "awsEnabled", "awsEnvironmentAccess"])(
    "requires an explicit %s",
    (name) => {
      const dependencies = {
        awsEnabled: false,
        awsEnvironmentAccess: { setup: unavailable },
        executionOwner: createEnvironmentExecutionOwner(),
        accountContext: createEnvironmentAccountContext("runtime", {
          createReadOnlyExecutor: unavailable,
          withSelectedAccount: unavailable
        }),
        servers: new Map(),
        setupServices: {
          authorizeAzure: unavailable,
          configureEnvironment: unavailable
        }
      };
      Reflect.deleteProperty(dependencies, name);
      expect(() =>
        createInstanceRequestCoordinator(
          "panel",
          () => "",
          {
            deleteRadiusEnvironment: unavailable,
            runAz: unavailable,
            readAzureIdentity: unavailable,
            removeAwsEnvironmentAccess: unavailable,
            deleteGitHubEnvironment: unavailable,
            deleteStatePackage: unavailable,
            withCredentialProvenanceLock: (work) => work(),
            readCredentialProvenance: () => [],
            removeCredentialProvenance: unavailable,
            clearEnvironmentCredentialProvenance: unavailable,
            persist: unavailable,
            errorMessage: String,
            log: () => {}
          },
          dependencies
        )
      ).toThrow(`Missing request coordinator dependency: ${name}`);
    }
  );

  it("leases setup under the runtime key and saved account before honoring a stop", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    op.context.githubLogin = "saved-account";
    op.request = { github: { login: "new-panel-account" } };
    requestStop(op);
    const executor = successfulSelectedGhExecutor({
      login: "saved-account",
      requiresKeyringSwitch: false
    });
    const accountCoordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) => {
        expect(login).toBe("saved-account");
        return executor;
      },
      getActiveKeyringLogin: async () => "original",
      switchKeyringAccount: unavailable,
      resetIdentityCache: () => {}
    });
    const lease = vi.spyOn(accountCoordinator, "withSelectedAccount");
    const context = createEnvironmentAccountContext(
      "runtime",
      accountCoordinator
    );
    const registered = vi.spyOn(context, "registerExecutor");
    coordinator(
      owner,
      "panel",
      undefined,
      context
    ).scheduleEnvironmentOperation(op);
    await settled(owner, "panel");
    expect(lease).toHaveBeenCalledExactlyOnceWith(
      "saved-account",
      { ownerKey: "runtime", operationId: op.operationId },
      expect.any(Function),
      30000
    );
    expect(registered).toHaveBeenCalledExactlyOnceWith(
      op.operationId,
      executor
    );
    expect(context.getExecutor(op.operationId)).toBeUndefined();
    expect(op.state).toBe("cancelled");
  });

  it.each([false, true])(
    "keeps a recovered verification's shared executor until transport settles (failure=%s)",
    async (failure) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      op.currentStage = STAGE_VERIFY;
      op.recoveryState = "verification_pending";
      op.context.githubLogin = "saved-account";
      op.verification = { runId: "17", dispatchedAt: Date.now() };
      const executor = successfulSelectedGhExecutor({ login: "saved-account" });
      const createExecutor = vi.fn(async () => executor);
      const context = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: createExecutor,
        withSelectedAccount: unavailable
      });
      const gate = deferred();
      const entered = deferred();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          entered.resolve();
          await gate.promise;
          if (failure) throw new Error("verification unavailable");
          return Response.json({ state: "success" });
        })
      );
      const first = coordinator(owner, "panel", undefined, context);
      const second = coordinator(owner, "reopened", undefined, context);
      first.startRecoveredTasks();
      try {
        await entered.promise;
        second.startRecoveredTasks();
        expect(createExecutor).toHaveBeenCalledExactlyOnceWith("saved-account");
        expect(context.getExecutor(op.operationId)).toBe(executor);
      } finally {
        gate.resolve();
        await settled(owner, "panel");
      }
      expect(context.getExecutor(op.operationId)).toBeUndefined();
      if (failure) expect(op.failure.message).toBe("verification unavailable");
    }
  );

  it.each(["missing", "terminal"] as const)(
    "releases a failed task whose operation is %s without overwriting a verdict",
    async (state) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      if (state === "missing") operations.clear();
      else finish(op, "succeeded");
      coordinator(owner, "a", async () => {
        throw new Error("late failure");
      }).scheduleEnvironmentOperation(op);
      await settled(owner, "a");
      expect(owner.hasActiveEnvironmentTasks("a")).toBe(false);
      if (state === "terminal") expect(op.state).toBe("succeeded");
      else expect(operations.get(op.operationId)).toBeNull();
    }
  );

  it.each([
    ["string", "provider failure"],
    [
      "stackless error",
      Object.assign(new Error("provider failure"), { stack: "" })
    ]
  ])(
    "records a %s failure without inventing stack evidence",
    async (_name, error) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      coordinator(owner, "a", async () => {
        throw error;
      }).scheduleEnvironmentOperation(op);
      await settled(owner, "a");
      expect(op.failure).toMatchObject({
        message: "provider failure",
        evidence: null
      });
    }
  );

  it("does not repeat the existing reconciliation notice on another uncertain reply", async () => {
    const owner = createEnvironmentExecutionOwner({
      deferTask: async () => {},
      microtask: queueMicrotask,
      reconciliationTimer: () => undefined
    });
    const op = operation();
    const notice =
      "⏳ A provider step's outcome could not be confirmed. Radius is reconciling it without repeating the mutation.";
    addLegacyStep(op, notice);
    prepareProviderMutation(op, {
      kind: "azure_app.create",
      target: "fixture"
    });
    coordinator(owner, "a", async () => {
      throw new Error("reply lost");
    }).scheduleEnvironmentOperation(op);
    await settled(owner, "a");
    expect(
      op.steps.filter((step: { label: string }) => step.label === notice)
    ).toHaveLength(1);
  });

  it("prioritizes unresolved branch deletion and refuses recovery without the original account", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    op.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(op, {
      kind: "github_branch.delete",
      target: "fixture/app:setup",
      intent: { repo: "fixture/app", branch: "setup" }
    });
    const runner = vi.fn(async () => {});
    coordinator(owner, "a", runner).startRecoveredTasks();
    await settled(owner, "a");
    expect(runner).not.toHaveBeenCalled();
    expect(op.failure.code).toBe("setup-branch-delete-unresolved");
    expect(op.providerRecovery.state).toBe("manual_required");
  });

  it("finishes recovery without scheduling cleanup when no artifact is proven owned", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    op.recoveryState = "provider_reconciliation_pending";
    op.providerRecovery = { state: "rollback_pending", mutations: [] };
    const runner = vi.fn(async () => {});
    coordinator(owner, "a", runner).startRecoveredTasks();
    await settled(owner, "a");
    expect(runner).not.toHaveBeenCalled();
    expect(op.failure.code).toBe("setup-rollback-nothing-owned");
  });

  it.each([
    "rollback",
    "retry_cleanup",
    "exit_setup",
    "retry_verification"
  ] as const)(
    "recovers the saved %s command identity instead of starting forward setup",
    async (kind) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      op.recoveryState = "provider_reconciliation_pending";
      const { command } = acceptCommand(op, {
        kind,
        attempt: 1,
        target: "fixture"
      });
      if (kind === "retry_verification") {
        prepareProviderMutation(op, {
          kind: "github_workflow.dispatch_retry",
          target: "fixture"
        });
      }
      const runner = vi.fn(async () => {});
      coordinator(owner, "a", runner).startRecoveredTasks();
      await settled(owner, "a");
      expect(runner).toHaveBeenCalledExactlyOnceWith(
        op.operationId,
        command.commandId
      );
    }
  );

  it("deduplicates delete resume only within its attachment", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    op.kind = "delete";
    const gate = deferred();
    const entered = deferred();
    const runner = vi.fn(async () => {
      if (runner.mock.calls.length === 2) entered.resolve();
      await gate.promise;
    });
    const a = coordinator(owner, "a", runner);
    const b = coordinator(owner, "b", runner);
    a.startRecoveredTasks();
    a.startRecoveredTasks();
    b.startRecoveredTasks();
    await entered.promise;
    expect(runner).toHaveBeenCalledTimes(2);
    gate.resolve();
    await Promise.all([settled(owner, "a"), settled(owner, "b")]);
  });

  it("does not add a provider-reconciliation claim or a cross-panel queue", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    op.recoveryState = "provider_reconciliation_pending";
    const gate = deferred();
    const entered = deferred();
    const runner = vi.fn(async () => {
      if (runner.mock.calls.length === 2) entered.resolve();
      await gate.promise;
    });
    const a = coordinator(owner, "a", runner);
    a.startRecoveredTasks();
    a.startRecoveredTasks();
    coordinator(owner, "b", runner).startRecoveredTasks();
    await entered.promise;
    expect(runner).toHaveBeenCalledTimes(2);
    gate.resolve();
    await Promise.all([settled(owner, "a"), settled(owner, "b")]);
    expect(runner).toHaveBeenCalledTimes(3);
  });

  it("shares the acquisition monitor claim across attachments and releases it at completion", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    op.currentStage = STAGE_VERIFY;
    op.recoveryState = "verification_acquisition_pending";
    op.verification = { retryCommandId: "retry-1" };
    const gate = deferred();
    const entered = deferred();
    const runner = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
    });
    const a = coordinator(owner, "a", runner);
    const b = coordinator(owner, "b", runner);
    a.startRecoveredTasks();
    b.startRecoveredTasks();
    await entered.promise;
    expect(runner).toHaveBeenCalledExactlyOnceWith("op", "retry-1");
    expect(owner.hasActiveEnvironmentTasks("b")).toBe(false);
    gate.resolve();
    await settled(owner, "a");
    b.startRecoveredTasks();
    await settled(owner, "b");
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("fails recovered monitoring closed without a saved account and releases its claim", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    op.currentStage = STAGE_VERIFY;
    op.recoveryState = "verification_pending";
    coordinator(owner, "a").startRecoveredTasks();
    await settled(owner, "a");
    expect(op.failure.code).toBe("verification-retry-github-account-missing");
    expect(owner.claimVerificationMonitor(op.operationId)).toBe(true);
    owner.releaseVerificationMonitor(op.operationId);
  });

  it.each([
    "rollback",
    "cleanup_retry",
    "exit_setup",
    "verification_retry",
    "verification_monitor"
  ] as const)(
    "keeps %s commands behind the same attachment's running setup",
    async (kind) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      const gate = deferred();
      const entered = deferred();
      const runner = vi.fn(async (_id: string, commandId?: string) => {
        if (!commandId) {
          entered.resolve();
          await gate.promise;
        }
      });
      const a = coordinator(owner, "a", runner);
      a.scheduleEnvironmentOperation(op);
      a.scheduleCommandTask(kind, op, "command");
      await entered.promise;
      expect(runner).toHaveBeenCalledExactlyOnceWith("op");
      gate.resolve();
      await settled(owner, "a");
      expect(runner.mock.calls).toEqual([["op"], ["op", "command"]]);
    }
  );

  it("keeps automatic rollback claims per attachment and releases failed posts", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    finish(op, "failed");
    op.providerRecovery = { state: "rollback_pending" };
    const gate = deferred();
    const posted = deferred();
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length === 2) posted.resolve();
      await gate.promise;
      return Response.json({ error: "rollback refused" }, { status: 409 });
    });
    vi.stubGlobal("fetch", fetcher);
    const report = vi.spyOn(operations, "report");
    const a = coordinator(owner, "a");
    const b = coordinator(owner, "b");
    a.startRecoveredTasks();
    a.startRecoveredTasks();
    b.startRecoveredTasks();
    await posted.promise;
    expect(fetcher).toHaveBeenCalledTimes(2);
    gate.resolve();
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    a.startRecoveredTasks();
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(3));
    expect(report).toHaveBeenCalledWith({
      scope: "provider-recovery-auto-rollback",
      operationId: "op",
      message: "rollback refused"
    });
  });

  it("retains finalizer rollback scheduling after shutdown marking", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    const posted = deferred();
    const fetcher = vi.fn(async () => {
      posted.resolve();
      return Response.json({});
    });
    vi.stubGlobal("fetch", fetcher);
    const a = coordinator(owner, "a", async () => {
      finish(op, "failed");
      op.providerRecovery = { state: "rollback_pending" };
      owner.markEnvironmentInstanceShuttingDown("a");
    });
    a.scheduleEnvironmentOperation(op);
    await posted.promise;
    await settled(owner, "a");
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:1/a/api/operations/op/rollback",
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Radius-Server-Owned": expect.any(String)
        })
      })
    );
  });

  it.each(["shutdown", "reopened", "removed", "terminal", "resolved"] as const)(
    "preserves reconciliation timer callback predicates when %s",
    async (state) => {
      const timers: Array<() => void> = [];
      const owner = createEnvironmentExecutionOwner({
        deferTask: async () => {},
        microtask: queueMicrotask,
        reconciliationTimer: (callback) => {
          timers.push(callback);
        }
      });
      const op = operation();
      const mutation = prepareProviderMutation(op, {
        kind: "azure_app.create",
        target: "fixture-app",
        intent: {}
      });
      const runner = vi.fn(async () => {
        if (runner.mock.calls.length === 1)
          throw new Error("provider reply lost");
      });
      const a = coordinator(owner, "a", runner);
      a.scheduleEnvironmentOperation(op);
      const stop = owner.onEnvironmentTasksSettled("a", () => {
        owner.markEnvironmentInstanceShuttingDown("a");
      });
      await settled(owner, "a");
      stop();
      // Settlement notifications precede the finalizer's follow-up scheduling.
      expect(timers).toHaveLength(1);
      if (state !== "shutdown") owner.markEnvironmentInstanceStarted("a");
      if (state === "removed") operations.clear();
      if (state === "terminal") finish(op, "failed");
      if (state === "resolved") {
        settleProviderMutation(op, mutation.mutationId, "confirmed");
      }
      timers[0]();
      await settled(owner, "a");
      expect(runner).toHaveBeenCalledTimes(state === "reopened" ? 2 : 1);
    }
  );

  it.each([false, true])(
    "preserves failure handling with shutdown=%s",
    async (shutdown) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      if (shutdown) owner.markEnvironmentInstanceShuttingDown("a");
      coordinator(owner, "a", async () => {
        throw new Error("runner failed");
      }).scheduleEnvironmentOperation(op);
      await settled(owner, "a");
      expect(op.endedAt !== null).toBe(!shutdown);
      if (!shutdown) expect(op.failure.code).toBe("server-owned-task-failed");
    }
  );
});
