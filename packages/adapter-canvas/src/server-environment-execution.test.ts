import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowFileCommitter } from "@radius-project/core";
import { bindWorkflowFileCommitterPorts } from "./server/routes/create-environment-workflow-committer.js";
import {
  createEnvironmentAccountContext,
  type EnvironmentAccountContext
} from "./runtime/environment-account-context.js";
import { createGitHubAccountCoordinator } from "./server/services/github-account-coordinator.js";
import { successfulSelectedGhExecutor } from "../test/support/server/selected-gh.js";
import { stoppedSetup } from "../test/support/server/operation-fixtures.js";
import type { SetupServices } from "./server/services/setup-outcome.js";
import {
  createOperationsControlService,
  type OperationControlService
} from "./server/services/operation-control.js";
import type {
  VerificationStatusInput,
  VerificationStatusResult
} from "./server/services/verification-status.js";
import { createSetupWorkflowRecoveryPort } from "./server/services/setup-workflow-recovery.js";
import {
  createEnvironmentOperationExecution,
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
  onOperationTerminal,
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
  verificationStatus: (
    input: VerificationStatusInput
  ) => Promise<VerificationStatusResult> = unavailable,
  operationControl: OperationControlService = unavailable
) {
  return createInstanceRequestCoordinator(
    instanceId,
    () => `http://127.0.0.1:1/${instanceId}`,
    {
      deleteRadiusEnvironment: unavailable,
      runAz: unavailable,
      readAzureIdentity: unavailable,
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
      executionOwner: owner,
      accountContext,
      setupServices,
      verificationStatus,
      operationControl,
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
  onOperationTerminal(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("production coordinator scheduling scopes", () => {
  it.each(["removed", "shutdown", "superseded"] as const)(
    "does not recover deferred admission after its context is %s",
    (change) => {
      const callbacks: Array<() => void> = [];
      const owner = createEnvironmentExecutionOwner({
        deferTask: async () => {},
        microtask: (callback) => {
          callbacks.push(callback);
        },
        reconciliationTimer: () => {
          throw new Error("Unexpected timer");
        }
      });
      const op = operation("deferred");
      op.kind = "delete";
      const claim = owner.claimAdmission(op.operationId);
      if (!claim) throw new Error("Missing admission");
      const runner = vi.fn(unavailable);
      const handler = coordinator(owner, "panel", runner);
      handler.startRecoveredTasks();
      if (change === "removed") operations.delete(op.operationId);
      else if (change === "shutdown")
        owner.markEnvironmentInstanceShuttingDown("panel");
      else coordinator(owner, "panel", runner);
      claim.release();
      expect(callbacks).toHaveLength(1);
      for (const callback of callbacks) callback();
      expect(runner).not.toHaveBeenCalled();
      expect(owner.hasActiveEnvironmentTasks("panel")).toBe(false);
    }
  );
  it("re-evaluates deferred recovery against the replacement record after corrective persistence", async () => {
    const owner = createEnvironmentExecutionOwner();
    const original = stoppedSetup();
    operations.put(original);
    const entered = deferred();
    const save = deferred();
    const recovered = deferred();
    const taskGate = deferred();
    let writes = 0;
    const schedule = vi.fn(() => true);
    const service = createOperationsControlService({
      claimAdmission: owner.claimAdmission,
      get: (id) => operations.get(id),
      acquireForRetry: (op) => operations.acquireForRetry(op),
      persistOperations: async () => {
        if (++writes === 1) {
          entered.resolve();
          await save.promise;
        }
      },
      reportOperationDiagnostic: () => {
        throw new Error("Unexpected diagnostic");
      },
      checkPullRequestMerge: unavailable,
      inspectVerificationWorkflow: unavailable,
      cancelVerificationWorkflow: unavailable,
      schedule,
      invalidateEnvironmentListing: () => {
        throw new Error("Unexpected invalidation");
      }
    });
    const pending = service({
      operationId: original.operationId,
      command: "continue"
    });
    await entered.promise;
    const replacement = createOperation({
      operationId: original.operationId,
      repo: original.repo,
      environment: "replacement",
      provider: "azure",
      kind: "delete"
    });
    operations.put(replacement);
    const runner = vi.fn(async (id: string) => {
      expect(operations.get(id)).toBe(replacement);
      expect(writes).toBe(2);
      recovered.resolve();
      await taskGate.promise;
    });
    const handler = coordinator(owner, "replacement", runner);
    try {
      handler.startRecoveredTasks();
      handler.startRecoveredTasks();
      expect(owner.hasActiveEnvironmentTasks("replacement")).toBe(false);
      save.resolve();
      expect(await pending).toMatchObject({
        status: 409,
        body: { code: "operation-context-changed" }
      });
      await recovered.promise;
      expect(runner).toHaveBeenCalledOnce();
      expect(schedule).not.toHaveBeenCalled();
      expect(operations.get(original.operationId)).toBe(replacement);
    } finally {
      save.resolve();
      taskGate.resolve();
      await settled(owner, "replacement");
    }
  });
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
      const control = vi.fn<OperationControlService>(unavailable);
      const a = coordinator(
        owner,
        "a",
        async () => block(),
        undefined,
        undefined,
        undefined,
        control
      );
      if (trigger === "recovery scan") {
        block();
        a.startRecoveredTasks();
      } else {
        a.scheduleEnvironmentOperation(op);
        await settled(owner, "a");
      }
      await Promise.resolve();
      expect(control).not.toHaveBeenCalled();
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
    const control = vi.fn<OperationControlService>(unavailable);
    const a = coordinator(
      owner,
      "a",
      async () => {
        recovery.settleManual(
          "github_branch.create",
          target,
          "Review the recovered branch before cleanup."
        );
        finish(op, "failed_partial");
        await recovery.persist();
      },
      undefined,
      undefined,
      undefined,
      control
    );
    a.scheduleEnvironmentOperation(op);
    await settled(owner, "a");
    await Promise.resolve();
    expect(persist).toHaveBeenCalledOnce();
    expect(control).not.toHaveBeenCalled();
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

  it.each([false, true])(
    "saves Stop before terminal announcement and suppresses it after persistence failure=%s",
    async (failure) => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const owner = createEnvironmentExecutionOwner();
      const op = operation("stop-verification");
      op.currentStage = STAGE_VERIFY;
      op.recoveryState = "verification_pending";
      op.context.githubLogin = "saved-account";
      op.verification = { runId: "17", dispatchedAt: Date.now() };
      const executor = successfulSelectedGhExecutor({ login: "saved-account" });
      const account = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: async () => executor,
        withSelectedAccount: unavailable
      });
      const saved = deferred();
      const order: string[] = [];
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        expect(op.control.stop.boundary).toBe("verification-observation");
        expect(op.state).toBe("cancelled");
        order.push("persist");
        await saved.promise;
        if (failure) throw new Error("disk unavailable");
        order.push("saved");
      });
      const report = vi
        .spyOn(operations, "report")
        .mockImplementation(() => {});
      onOperationTerminal(() => {
        order.push("announce");
      });
      let scope: VerificationStatusInput["observation"];
      const verify = vi.fn(async (input: VerificationStatusInput) => {
        scope = input.observation;
        requestStop(op);
        return { status: 200, body: { state: "pending" } };
      });
      const handler = coordinator(
        owner,
        "panel",
        undefined,
        account,
        undefined,
        verify
      );
      const done = settled(owner, "panel");
      handler.startRecoveredTasks();
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(verify).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(5000);
        expect(order).toEqual(["persist"]);
        expect(account.getExecutor(op.operationId)).toBe(executor);
      } finally {
        saved.resolve();
        await done;
      }
      expect(order).toEqual(
        failure ? ["persist"] : ["persist", "saved", "announce"]
      );
      expect(report).toHaveBeenCalledTimes(failure ? 1 : 0);
      expect(verify).toHaveBeenCalledOnce();
      expect(scope?.stopped).toBe(true);
      expect(account.getExecutor(op.operationId)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each([
    {
      status: 200,
      body: { state: "expired", error: "Saved tracking expired." }
    },
    { status: 200, body: { state: "pending", terminal: true } },
    { status: 503, body: { state: "pending", error: "Observation stopped." } },
    { status: 502, body: { state: "unknown" } }
  ])(
    "settles direct tracking refusal or failed observation: %j",
    async (outcome) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation("expired-verification");
      op.currentStage = STAGE_VERIFY;
      op.recoveryState = "verification_pending";
      op.context.githubLogin = "saved-account";
      op.verification = { runId: "17", dispatchedAt: Date.now() };
      const executor = successfulSelectedGhExecutor({ login: "saved-account" });
      const account = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: async () => executor,
        withSelectedAccount: unavailable
      });
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      let scope: VerificationStatusInput["observation"];
      const verify = vi.fn(async (input: VerificationStatusInput) => {
        scope = input.observation;
        return outcome;
      });
      const handler = coordinator(
        owner,
        "panel",
        undefined,
        account,
        undefined,
        verify
      );
      const done = settled(owner, "panel");
      handler.startRecoveredTasks();
      await done;
      expect(op.failure).toMatchObject({
        code:
          outcome.status === 200 ?
            "verification-tracking-expired"
          : "server-owned-task-failed",
        message:
          outcome.body.error ||
          (outcome.status === 200 ?
            "Credential verification is no longer being tracked."
          : `Verification status failed with HTTP ${outcome.status}.`)
      });
      expect(persist).toHaveBeenCalledOnce();
      expect(verify).toHaveBeenCalledOnce();
      expect(scope?.stopped).toBe(true);
      expect(account.getExecutor(op.operationId)).toBeUndefined();
    }
  );

  it.each([
    "accountContext",
    "verificationStatus",
    "operationControl"
  ] as const)("requires the explicit %s dependency", (name) => {
    const dependencies = {
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext: createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: unavailable,
        withSelectedAccount: unavailable
      }),
      servers: new Map(),
      verificationStatus: unavailable,
      operationControl: unavailable,
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
  });

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
    "keeps a recovered verification's shared executor until direct observation settles (failure=%s)",
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
      const fetch = vi.fn(unavailable);
      vi.stubGlobal("fetch", fetch);
      let observation: VerificationStatusInput["observation"];
      const verify = vi.fn(async (input: VerificationStatusInput) => {
        expect(input).toMatchObject({
          repo: op.repo,
          environment: op.environment,
          operationId: op.operationId
        });
        expect(input.compatibility).toBeUndefined();
        observation = input.observation;
        expect(observation?.stopped).toBe(false);
        entered.resolve();
        await gate.promise;
        if (failure) throw new Error("verification unavailable");
        return { status: 200, body: { state: "success" } };
      });
      const first = coordinator(
        owner,
        "panel",
        undefined,
        context,
        undefined,
        verify
      );
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
      expect(verify).toHaveBeenCalledOnce();
      expect(observation?.stopped).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      if (failure) expect(op.failure.message).toBe("verification unavailable");
    }
  );

  it.each(["removed", "terminal"] as const)(
    "does not begin observation after the operation becomes %s during account acquisition",
    async (state) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      op.currentStage = STAGE_VERIFY;
      op.recoveryState = "verification_pending";
      op.context.githubLogin = "saved-account";
      op.verification = { runId: "17", dispatchedAt: Date.now() };
      const executor = successfulSelectedGhExecutor({ login: "saved-account" });
      const account = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: async () => {
          if (state === "removed") operations.clear();
          else finish(op, "cancelled");
          return executor;
        },
        withSelectedAccount: unavailable
      });
      const verify = vi.fn(unavailable);
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      coordinator(
        owner,
        "panel",
        undefined,
        account,
        undefined,
        verify
      ).startRecoveredTasks();
      await settled(owner, "panel");
      expect(verify).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(account.getExecutor(op.operationId)).toBeUndefined();
      expect(op.failure).toBeNull();
      if (state === "terminal") expect(op.state).toBe("cancelled");
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
      reconciliationTimer: () => vi.fn()
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

  it("deduplicates provider-reconciliation work across panel subscribers", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    op.recoveryState = "provider_reconciliation_pending";
    const gate = deferred();
    const entered = deferred();
    const runner = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
    });
    const a = coordinator(owner, "a", runner);
    a.startRecoveredTasks();
    a.startRecoveredTasks();
    coordinator(owner, "b", runner).startRecoveredTasks();
    await entered.promise;
    expect(runner).toHaveBeenCalledOnce();
    gate.resolve();
    await Promise.all([settled(owner, "a"), settled(owner, "b")]);
    expect(runner).toHaveBeenCalledOnce();
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
    const release = owner.claimVerificationMonitor(op.operationId);
    expect(release).toEqual(expect.any(Function));
    release?.();
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

  it("shares automatic rollback claims across attachments and releases failed admissions", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    finish(op, "failed");
    op.providerRecovery = { state: "rollback_pending" };
    const gate = deferred();
    const posted = deferred();
    const control = vi.fn<OperationControlService>(async () => {
      posted.resolve();
      await gate.promise;
      return { body: { error: "rollback refused" }, status: 409 };
    });
    const fetcher = vi.fn(unavailable);
    vi.stubGlobal("fetch", fetcher);
    const report = vi.spyOn(operations, "report");
    const a = coordinator(
      owner,
      "a",
      undefined,
      undefined,
      undefined,
      undefined,
      control
    );
    const b = coordinator(
      owner,
      "b",
      undefined,
      undefined,
      undefined,
      undefined,
      control
    );
    a.startRecoveredTasks();
    a.startRecoveredTasks();
    b.startRecoveredTasks();
    await posted.promise;
    expect(control).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    a.startRecoveredTasks();
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(report).toHaveBeenCalledWith({
      scope: "provider-recovery-auto-rollback",
      operationId: "op",
      message: "rollback refused"
    });
  });

  it.each(["removed", "replaced", "id", "repository", "environment"] as const)(
    "fences a %s recovery target at queued admission",
    async (change) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      finish(op, "failed");
      op.providerRecovery = { state: "rollback_pending" };
      const get = vi.fn(() => op);
      const schedule = vi.fn(() => true);
      const service = createOperationsControlService({
        claimAdmission: owner.claimAdmission,
        get,
        acquireForRetry: () => ({ ok: true }),
        persistOperations: unavailable,
        reportOperationDiagnostic: () => {
          throw new Error("Unexpected diagnostic");
        },
        checkPullRequestMerge: unavailable,
        inspectVerificationWorkflow: unavailable,
        cancelVerificationWorkflow: unavailable,
        schedule,
        invalidateEnvironmentListing: () => {
          throw new Error("Unexpected invalidation");
        }
      });
      const report = vi.spyOn(operations, "report");
      const handler = coordinator(
        owner,
        "a",
        undefined,
        undefined,
        undefined,
        undefined,
        service
      );
      handler.startRecoveredTasks();
      if (change === "removed") operations.clear();
      else if (change === "replaced") operations.put(structuredClone(op));
      else if (change === "id") op.operationId = "different-id";
      else if (change === "repository") op.repo = "other/repository";
      else op.environment = "other-environment";
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith({
          scope: "provider-recovery-auto-rollback",
          operationId: "op",
          message:
            "The operation changed before the queued command was admitted."
        })
      );
      expect(get).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
      expect(op.control.commands).toEqual([]);
    }
  );

  it.each(["missing-error", "exception"] as const)(
    "reports automatic admission %s and releases the claim for recovery",
    async (failure) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      finish(op, "failed");
      op.providerRecovery = { state: "rollback_pending" };
      const control = vi.fn<OperationControlService>(async () => {
        if (failure === "exception") throw new Error("admission offline");
        return { status: 503, body: {} };
      });
      const report = vi.spyOn(operations, "report");
      const handler = coordinator(
        owner,
        "a",
        undefined,
        undefined,
        undefined,
        undefined,
        control
      );
      for (let attempt = 1; attempt <= 2; attempt++) {
        handler.startRecoveredTasks();
        await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(attempt));
      }
      expect(control).toHaveBeenCalledTimes(2);
      expect(report).toHaveBeenLastCalledWith({
        scope: "provider-recovery-auto-rollback",
        operationId: "op",
        message:
          failure === "exception" ? "admission offline" : (
            "Operation control failed with status 503."
          )
      });
    }
  );

  it("ignores a panel-only shutdown marker when settling shared setup", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation();
    const requested = deferred();
    const control = vi.fn<OperationControlService>(async () => {
      requested.resolve();
      return { status: 202, body: {} };
    });
    const fetcher = vi.fn(unavailable);
    vi.stubGlobal("fetch", fetcher);
    const a = coordinator(
      owner,
      "a",
      async () => {
        finish(op, "failed");
        op.providerRecovery = { state: "rollback_pending" };
        owner.markEnvironmentInstanceShuttingDown("a");
      },
      undefined,
      undefined,
      undefined,
      control
    );
    a.scheduleEnvironmentOperation(op);
    await requested.promise;
    await settled(owner, "a");
    expect(control).toHaveBeenCalledExactlyOnceWith({
      instanceId: "a",
      operationId: "op",
      isCurrent: expect.any(Function),
      command: "rollback"
    });
    expect(fetcher).not.toHaveBeenCalled();
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
          return () => {
            const index = timers.indexOf(callback);
            if (index >= 0) timers.splice(index, 1);
          };
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
      const callback = timers[0];
      if (state === "shutdown") owner.shutdown();
      if (state !== "shutdown") owner.markEnvironmentInstanceStarted("a");
      if (state === "removed") operations.clear();
      if (state === "terminal") finish(op, "failed");
      if (state === "resolved") {
        settleProviderMutation(op, mutation.mutationId, "confirmed");
      }
      callback();
      await settled(owner, "a");
      expect(runner).toHaveBeenCalledTimes(state === "reopened" ? 2 : 1);
    }
  );

  it.each([false, true])(
    "preserves failure handling with shutdown=%s",
    async (shutdown) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      coordinator(owner, "a", async () => {
        if (shutdown) owner.shutdown();
        throw new Error("runner failed");
      }).scheduleEnvironmentOperation(op);
      await settled(owner, "a");
      expect(op.endedAt !== null).toBe(!shutdown);
      if (!shutdown) expect(op.failure.code).toBe("server-owned-task-failed");
    }
  );

  it.each([false, true])(
    "retains deletion shutdown fencing with unresolved mutation=%s",
    async (unresolved) => {
      const timers = vi.fn(() => () => {});
      const owner = createEnvironmentExecutionOwner({
        deferTask: async () => {},
        microtask: queueMicrotask,
        reconciliationTimer: timers
      });
      const op = operation("deletion-shutdown");
      op.kind = "delete";
      if (unresolved)
        prepareProviderMutation(op, {
          kind: "azure_app.create",
          target: "fixture-app"
        });
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      coordinator(owner, "panel", async () => {
        owner.markEnvironmentInstanceShuttingDown("panel");
        throw new Error("In-flight deletion interrupted");
      }).scheduleEnvironmentOperation(op);
      await settled(owner, "panel");
      expect(op.endedAt).toBeNull();
      expect(op.failure).toBeNull();
      expect(op.executionActive).toBe(false);
      expect(persist).not.toHaveBeenCalled();
      expect(timers).not.toHaveBeenCalled();
    }
  );

  it.each(["recovered", "retry"] as const)(
    "cancels %s selected-account acquisition backoff on shutdown without another read or terminal failure",
    async (kind) => {
      vi.useFakeTimers();
      const owner = createEnvironmentExecutionOwner();
      const op = operation("shutdown-account-backoff");
      op.currentStage = STAGE_VERIFY;
      op.recoveryState = "verification_pending";
      op.context.githubLogin = "saved-account";
      op.verification = {
        runId: "17",
        dispatchedAt: Date.now(),
        acquisitionDeadline: Date.now() + 60_000
      };
      const acquire = vi.fn(async () => {
        throw new Error("HTTP 429: API rate limit exceeded");
      });
      const account = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: acquire,
        withSelectedAccount: unavailable
      });
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      const handler = coordinator(owner, "panel", undefined, account);
      if (kind === "recovered") handler.startRecoveredTasks();
      else handler.scheduleCommandTask("verification_retry", op, "retry");
      const done = settled(owner, "panel");
      await vi.advanceTimersByTimeAsync(0);
      expect(acquire).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      owner.shutdown();
      await done;
      expect(acquire).toHaveBeenCalledOnce();
      expect(op.endedAt).toBeNull();
      expect(persist).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(account.getExecutor(op.operationId)).toBeUndefined();
    }
  );

  it("persists expired recovered account acquisition without another read or executor", async () => {
    const owner = createEnvironmentExecutionOwner();
    const op = operation("expired-account");
    op.currentStage = STAGE_VERIFY;
    op.recoveryState = "verification_pending";
    op.context.githubLogin = "saved-account";
    op.verification = { runId: "17", acquisitionDeadline: Date.now() - 1 };
    const acquire = vi.fn(unavailable);
    const account = createEnvironmentAccountContext("runtime", {
      createReadOnlyExecutor: acquire,
      withSelectedAccount: unavailable
    });
    const persist = vi
      .spyOn(operations, "persist")
      .mockResolvedValue(undefined);
    coordinator(owner, "panel", undefined, account).startRecoveredTasks();
    await settled(owner, "panel");
    expect(acquire).not.toHaveBeenCalled();
    expect(op.state).toBe("failed_partial");
    expect(op.failure).toMatchObject({ code: "verification-tracking-expired" });
    expect(persist).toHaveBeenCalledOnce();
    expect(account.getExecutor(op.operationId)).toBeUndefined();
  });

  it.each([false, true])(
    "keeps the retry executor through Stop persistence with failure=%s",
    async (failure) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation("retry-stop");
      op.currentStage = STAGE_VERIFY;
      op.context.githubLogin = "saved-account";
      op.verification = {
        runId: "17",
        accountUnavailablePhase: "monitor",
        acquisitionDeadline: Date.now() + 60_000
      };
      const accepted = acceptCommand(op, {
        kind: "retry_verification",
        attempt: 1,
        target: STAGE_VERIFY
      });
      requestStop(op);
      const executor = successfulSelectedGhExecutor({ login: "saved-account" });
      const account = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: async () => executor,
        withSelectedAccount: unavailable
      });
      const entered = deferred();
      const gate = deferred();
      const report = vi
        .spyOn(operations, "report")
        .mockImplementation(() => {});
      const announce = vi.fn();
      onOperationTerminal(announce);
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        if (op.state !== "cancelled") return;
        entered.resolve();
        await gate.promise;
        if (failure) throw new Error("stop storage unavailable");
      });
      const verify = vi.fn(unavailable);
      coordinator(
        owner,
        "panel",
        undefined,
        account,
        undefined,
        verify
      ).scheduleCommandTask(
        "verification_retry",
        op,
        accepted.command.commandId
      );
      const done = settled(owner, "panel");
      try {
        await Promise.race([entered.promise, done]);
        expect(op.state).toBe("cancelled");
        expect(account.getExecutor(op.operationId)).toBe(executor);
        expect(announce).not.toHaveBeenCalled();
      } finally {
        gate.resolve();
        await done;
        owner.shutdown();
      }
      expect(account.getExecutor(op.operationId)).toBeUndefined();
      expect(owner.hasActiveEnvironmentTasks("panel")).toBe(false);
      expect(verify).not.toHaveBeenCalled();
      expect(announce).toHaveBeenCalledTimes(failure ? 0 : 1);
      expect(report).toHaveBeenCalledTimes(failure ? 1 : 0);
      if (failure)
        expect(report).toHaveBeenCalledWith({
          code: "operation-store-write-failed",
          message: `Could not persist setup operation ${op.operationId}: stop storage unavailable`
        });
      expect(op.control.commands[0]).toMatchObject({
        state: "finished",
        outcome: "cancelled"
      });
    }
  );

  it.each(["completed", "shutdown", "removed"] as const)(
    "settles an acknowledged retry dispatch before executor release when %s",
    async (state) => {
      const shutdown = state === "shutdown";
      const owner = createEnvironmentExecutionOwner();
      const op = operation("retry-dispatch");
      op.currentStage = STAGE_VERIFY;
      op.context.githubLogin = "saved-account";
      op.verification = {
        workflow: "radius-verify-credentials.yml",
        ref: "topic",
        environment: "dev",
        operationMarker: op.operationId,
        acquisitionDeadline: Date.now() + 60_000
      };
      const accepted = acceptCommand(op, {
        kind: "retry_verification",
        attempt: 1,
        target: STAGE_VERIFY
      });
      const entered = deferred();
      const gate = deferred();
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === "run" && args[1] === "list")
          return { code: 0, stdout: '[{"databaseId":16}]', stderr: "" };
        if (args[0] !== "workflow")
          throw new Error(`Unexpected command: ${args.join(" ")}`);
        entered.resolve();
        await gate.promise;
        return {
          code: 0,
          stdout: "https://github.com/fixture/app/actions/runs/17",
          stderr: ""
        };
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        run
      });
      const account = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: async () => executor,
        withSelectedAccount: unavailable
      });
      const snapshots: (typeof op)[] = [];
      vi.spyOn(operations, "persist").mockImplementation(async () => {
        snapshots.push(structuredClone(op));
      });
      const verify = vi.fn(async () => {
        if (state === "removed") operations.clear();
        else finish(op, "succeeded");
        return { status: 200, body: { state: "success" } };
      });
      coordinator(
        owner,
        "panel",
        undefined,
        account,
        undefined,
        verify
      ).scheduleCommandTask(
        "verification_retry",
        op,
        accepted.command.commandId
      );
      const done = settled(owner, "panel");
      try {
        await Promise.race([entered.promise, done]);
        expect(account.getExecutor(op.operationId)).toBe(executor);
        if (shutdown) owner.shutdown();
        expect(run).toHaveBeenCalledTimes(2);
        expect(snapshots.at(-1)?.providerRecovery.mutations).toEqual([
          expect.objectContaining({ status: "prepared" })
        ]);
      } finally {
        gate.resolve();
        await done;
        owner.shutdown();
      }
      expect(account.getExecutor(op.operationId)).toBeUndefined();
      expect(owner.hasActiveEnvironmentTasks("panel")).toBe(false);
      expect(run).toHaveBeenCalledTimes(2);
      expect(verify).toHaveBeenCalledTimes(shutdown ? 0 : 1);
      expect(op.endedAt === null).toBe(state !== "completed");
      expect(snapshots.at(-1)?.providerRecovery.mutations).toEqual([
        expect.objectContaining({
          kind: "github_workflow.dispatch_retry",
          status: "confirmed"
        })
      ]);
      expect(op.verification.runId).toBe("17");
    }
  );

  it.each([false, true])(
    "fails recovered saved-account acquisition closed with known run=%s",
    async (knownRun) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation("unavailable-account");
      op.currentStage = STAGE_VERIFY;
      op.recoveryState = "verification_pending";
      op.context.githubLogin = "saved-account";
      op.verification = {
        runId: knownRun ? "17" : null,
        acquisitionDeadline: Date.now() + 60_000
      };
      const acquire = vi.fn(async () => {
        throw new Error("Selected account unavailable");
      });
      const account = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: acquire,
        withSelectedAccount: unavailable
      });
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      coordinator(owner, "panel", undefined, account).startRecoveredTasks();
      await settled(owner, "panel");
      expect(acquire).toHaveBeenCalledExactlyOnceWith("saved-account");
      expect(op.failure).toMatchObject({
        code: "verification-retry-github-account-unavailable",
        evidence: "Selected account unavailable"
      });
      expect(op.verification.accountUnavailablePhase).toBe(
        knownRun ? "monitor" : "dispatch"
      );
      expect(persist).toHaveBeenCalledOnce();
      expect(account.getExecutor(op.operationId)).toBeUndefined();
      owner.shutdown();
    }
  );

  it.each([false, true])(
    "keeps verification continuation settlement behind shared shutdown=%s",
    async (shutdown) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation("continuation-shutdown");
      op.currentStage = STAGE_VERIFY;
      op.context.githubLogin = "saved-account";
      op.verification = { runId: "17", dispatchedAt: Date.now() };
      const accepted = acceptCommand(op, {
        kind: "continue_setup",
        attempt: 1,
        target: STAGE_VERIFY
      });
      const executor = successfulSelectedGhExecutor({ login: "saved-account" });
      const account = createEnvironmentAccountContext("runtime", {
        createReadOnlyExecutor: async () => executor,
        withSelectedAccount: unavailable
      });
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      const verify = vi.fn(async () => {
        if (shutdown) owner.shutdown();
        else finish(op, "succeeded");
        return { status: 200, body: { state: "success" } };
      });
      coordinator(
        owner,
        "panel",
        undefined,
        account,
        undefined,
        verify
      ).scheduleCommandTask(
        "verification_monitor",
        op,
        accepted.command.commandId
      );
      await settled(owner, "panel");
      expect(verify).toHaveBeenCalledOnce();
      expect(account.getExecutor(op.operationId)).toBeUndefined();
      expect(persist).toHaveBeenCalledTimes(shutdown ? 0 : 1);
      expect(op.endedAt === null).toBe(shutdown);
      expect(op.control.commands[0].state).toBe(
        shutdown ? "accepted" : "finished"
      );
    }
  );

  it("cannot execute environment deletion through panel-free setup construction", async () => {
    const owner = createEnvironmentExecutionOwner();
    const scope = owner.attachRuntime();
    const op = operation();
    op.kind = "delete";
    const persist = vi
      .spyOn(operations, "persist")
      .mockResolvedValue(undefined);
    const account = createEnvironmentAccountContext("runtime", {
      createReadOnlyExecutor: unavailable,
      withSelectedAccount: unavailable
    });
    const execution = createEnvironmentOperationExecution({
      executionOwner: owner,
      scope,
      accountContext: account,
      setupServices: {
        authorizeAzure: unavailable,
        configureEnvironment: unavailable
      },
      verificationStatus: unavailable,
      admitRecoveryRollback: unavailable
    });
    expect(persist).not.toHaveBeenCalled();
    execution.scheduleEnvironmentOperation(op);
    await new Promise<void>((resolve) => {
      const stop = scope.onTasksSettled(() => {
        stop();
        resolve();
      });
    });
    expect(op.failure).toMatchObject({
      code: "server-owned-task-failed",
      message: "Environment deletion requires the server-ready deletion runner."
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(scope.hasActiveTasks()).toBe(false);
  });

  it.each([
    "account",
    "before",
    "during",
    "replacement-before-configuration",
    "replacement-during-configuration"
  ] as const)(
    "honors setup shutdown and presentation-generation boundaries (%s)",
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
          if (when === "before") owner.shutdown();
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
          createExecutor: async () => {
            if (when === "account") owner.shutdown();
            return executor;
          },
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
      const configureEnvironment = vi.fn<SetupServices["configureEnvironment"]>(
        async (_request, instanceId, isCurrentPresentation) => {
          expect(instanceId).toBe("panel");
          expect(isCurrentPresentation).toEqual(expect.any(Function));
          expect(isCurrentPresentation?.()).toBe(
            when === "replacement-during-configuration"
          );
          if (when === "replacement-during-configuration") {
            coordinator(owner, "panel");
            expect(isCurrentPresentation?.()).toBe(false);
          }
          return { kind: "completed", status: 200, body: {} };
        }
      );
      const handler = coordinator(owner, "panel", undefined, context, {
        authorizeAzure,
        configureEnvironment
      });
      const done = settled(owner, "panel");
      handler.scheduleEnvironmentOperation(op);
      try {
        if (when !== "before" && when !== "account") {
          await Promise.race([entered.promise, done]);
          expect(op.failure, JSON.stringify(run.mock.calls)).toBeNull();
          expect(authorizeAzure).toHaveBeenCalledOnce();
          if (when === "during") {
            owner.shutdown();
          } else if (when === "replacement-before-configuration") {
            coordinator(owner, "panel");
          }
          expect(context.getExecutor(op.operationId)).toBe(executor);
        }
      } finally {
        gate.resolve();
        await done;
      }
      expect(authorizeAzure).toHaveBeenCalledTimes(
        when === "before" || when === "account" ? 0 : 1
      );
      expect(configureEnvironment).toHaveBeenCalledTimes(
        when.startsWith("replacement") ? 1 : 0
      );
      expect(op.state).not.toBe("succeeded");
      expect(op.failure, JSON.stringify(run.mock.calls)).toBeNull();
      expect(op.endedAt).toBeNull();
      expect(context.getExecutor(op.operationId)).toBeUndefined();
      expect(run.mock.calls.every(([args]) => !args.includes("--method"))).toBe(
        true
      );
    }
  );

  it.each(["refused", "missing-error", "rejected"] as const)(
    "shares automatic rollback claims and releases %s admissions",
    async (failure) => {
      const owner = createEnvironmentExecutionOwner();
      const op = operation();
      finish(op, "failed");
      op.providerRecovery = { state: "rollback_pending" };
      const gate = deferred();
      const requested = deferred();
      const control = vi.fn<OperationControlService>(async () => {
        requested.resolve();
        await gate.promise;
        if (failure === "rejected") throw new Error("admission unavailable");
        return failure === "refused" ?
            { status: 409, body: { error: "rollback refused" } }
          : { status: 503, body: {} };
      });
      const fetcher = vi.fn(unavailable);
      vi.stubGlobal("fetch", fetcher);
      const report = vi.spyOn(operations, "report");
      const a = coordinator(
        owner,
        "a",
        undefined,
        undefined,
        undefined,
        undefined,
        control
      );
      const b = coordinator(
        owner,
        "b",
        undefined,
        undefined,
        undefined,
        undefined,
        control
      );
      a.startRecoveredTasks();
      a.startRecoveredTasks();
      b.startRecoveredTasks();
      await requested.promise;
      expect(control).toHaveBeenCalledOnce();
      expect(control).toHaveBeenCalledWith({
        instanceId: "a",
        operationId: "op",
        isCurrent: expect.any(Function),
        command: "rollback"
      });
      expect(fetcher).not.toHaveBeenCalled();
      gate.resolve();
      await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
      b.startRecoveredTasks();
      await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
      expect(control).toHaveBeenLastCalledWith({
        instanceId: "b",
        operationId: "op",
        isCurrent: expect.any(Function),
        command: "rollback"
      });
      expect(report).toHaveBeenCalledWith({
        scope: "provider-recovery-auto-rollback",
        operationId: "op",
        message:
          failure === "refused" ? "rollback refused"
          : failure === "rejected" ? "admission unavailable"
          : "Operation control failed with status 503."
      });
    }
  );
});
