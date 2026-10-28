import { describe, expect, it, vi } from "vitest";
import { stoppedSetup } from "../../../test/support/server/operation-fixtures.js";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import { createEnvironmentExecutionOwner } from "../../runtime/environment-execution-owner.js";
import {
  fromPersistedOperation,
  toPersistedOperation
} from "../../operations.js";
import type { OperationRecord } from "../routes/operations-status.js";
import {
  createOperationsControlService,
  type OperationControlInput,
  type OperationsControlDependencies
} from "./operation-control.js";
import {
  cancelVerificationWorkflow,
  readVerificationWorkflowState
} from "./verification-workflow-cancellation.js";
import {
  captureWorkflowCancellationTarget,
  matchesWorkflowCancellationTarget
} from "./workflow-cancellation-target.js";

function fixture() {
  const operation = stoppedSetup();
  operation.context = { githubLogin: "saved-account" };
  operation.verification = { runId: "42", workflowState: "active" };
  let current: OperationRecord | null = operation;
  const owner = createEnvironmentExecutionOwner();
  const executor = successfulSelectedGhExecutor({ login: "saved-account" });
  const run = vi.fn(async (_executor: typeof executor, args: string[]) => {
    if (args[0] === "run")
      return { code: 0, stdout: '{"status":"in_progress"}', stderr: "" };
    if (args.includes("POST")) return { code: 0, stdout: "", stderr: "" };
    throw new Error("Unexpected command");
  });
  const persist = vi.fn(async () => {});
  const diagnostic = vi.fn();
  const dependencies: OperationsControlDependencies = {
    claimAdmission: owner.claimAdmission,
    isShuttingDown: owner.isShuttingDown,
    get: () => current,
    acquireForRetry: () => {
      throw new Error("Unexpected retry");
    },
    persistOperations: persist,
    reportOperationDiagnostic: diagnostic,
    checkPullRequestMerge: async () => {
      throw new Error("Unexpected merge check");
    },
    inspectVerificationWorkflow: async (target, assertCurrent) => {
      assertCurrent();
      const state = await readVerificationWorkflowState(executor, target, {
        run
      });
      assertCurrent();
      return state;
    },
    cancelVerificationWorkflow: (target, authority) =>
      cancelVerificationWorkflow(executor, target, {
        run: (selected, args, beforeExecute) => {
          beforeExecute?.();
          return run(selected, args);
        },
        authority
      }),
    schedule: () => {
      throw new Error("Unexpected schedule");
    },
    invalidateEnvironmentListing: () => {
      throw new Error("Unexpected invalidation");
    }
  };
  const control = createOperationsControlService(dependencies);
  const input: OperationControlInput = {
    operationId: operation.operationId,
    command: "cancel-workflow"
  };
  return {
    operation,
    owner,
    run,
    persist,
    diagnostic,
    dependencies,
    control,
    input,
    replace(value: OperationRecord | null) {
      current = value;
    }
  };
}

describe("run-bound workflow cancellation", () => {
  it.each(
    ["preexisting", "new"].flatMap((task) =>
      ["shutdown", "target", "correction-failure"].map((change) => ({
        task,
        change
      }))
    )
  )(
    "corrects only unissued owned projection with $task task after $change",
    async ({ task, change }) => {
      const h = fixture();
      const scope = h.owner.attachRuntime();
      let release = () => {};
      let settled = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const done = new Promise<void>((resolve) => {
        settled = resolve;
      });
      const schedule = () =>
        scope.schedule(h.operation.operationId, {
          run: () => gate,
          failed: async () => {
            throw new Error("Unexpected task failure");
          },
          settling() {},
          settled
        });
      if (task === "preexisting") schedule();
      h.run.mockImplementationOnce(async () => {
        if (task === "new") schedule();
        h.operation.failure = {
          code: null,
          message: "independent task evidence"
        };
        if (change === "target")
          h.operation.verification = { runId: "43", workflowState: "active" };
        else h.owner.shutdown();
        return { code: 0, stdout: '{"status":"in_progress"}', stderr: "" };
      });
      if (change === "correction-failure")
        h.persist
          .mockResolvedValueOnce()
          .mockRejectedValueOnce(new Error("correction offline"));
      try {
        const result = await h.control(h.input);
        expect(result.status).toBe(
          change === "correction-failure" ? 500
          : change === "target" ? 409
          : 503
        );
        expect(h.operation.failure).toEqual({
          code: null,
          message: "independent task evidence"
        });
        expect(h.operation.control.commands).toHaveLength(
          task === "preexisting" ? 0 : 1
        );
        expect(h.operation.verification).toEqual({
          runId: change === "target" ? "43" : "42",
          workflowState:
            change === "target" || task === "preexisting" ?
              "active"
            : "cancelling"
        });
        expect(h.run).toHaveBeenCalledTimes(1);
        const claim = h.owner.claimAdmission(h.operation.operationId);
        expect(claim === null).toBe(change === "correction-failure");
        claim?.release();
      } finally {
        release();
        await done;
      }
    }
  );

  it("propagates an unavailable currentness check without accepting or issuing work", async () => {
    const h = fixture();
    const isCurrent = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockImplementation(() => {
        throw new Error("currentness read unavailable");
      });
    await expect(h.control({ ...h.input, isCurrent })).rejects.toThrow(
      "currentness read unavailable"
    );
    expect(h.run).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it("freezes the confirmed identity and persists its acknowledged result across hydration", async () => {
    const h = fixture();
    const target = captureWorkflowCancellationTarget(h.operation);
    expect(Object.isFrozen(target)).toBe(true);
    const result = await h.control({ ...h.input, cancellationTarget: target });
    expect(result).toMatchObject({
      status: 202,
      body: { cancellation: { target, state: "cancelling", issued: true } }
    });
    const restored = fromPersistedOperation(toPersistedOperation(h.operation));
    expect(restored.control.commands.at(-1)).toMatchObject({
      target: "42",
      outcome: "cancelling",
      workflowCancellation: target
    });
    h.replace(restored);
    const calls = h.run.mock.calls.length;
    expect(await h.control(h.input)).toMatchObject({
      status: 200,
      body: { code: "workflow-status-checked" }
    });
    expect(
      h.run.mock.calls.slice(calls).every(([, args]) => args[0] === "run")
    ).toBe(true);
  });

  it.each([
    null,
    {},
    { repo: "x", runId: "42" },
    { ...Object.fromEntries([]), cancellationAttempt: -1 }
  ])(
    "drops malformed saved target provenance without granting cancellation authority: %j",
    (target) => {
      const h = fixture();
      const saved = toPersistedOperation(h.operation);
      saved.control.commands = [
        {
          kind: "cancel_workflow",
          commandId: "saved-command",
          state: "finished",
          target: "42",
          attempt: 0,
          outcome: "unknown",
          workflowCancellation: target
        }
      ];
      expect(
        fromPersistedOperation(saved).control.commands[0].workflowCancellation
      ).toBeUndefined();
    }
  );

  it.each([
    "run",
    "repo",
    "environment",
    "login",
    "attempt",
    "operationId"
  ] as const)("rejects changed immutable %s before saving", async (change) => {
    const h = fixture();
    const target = captureWorkflowCancellationTarget(h.operation);
    if (change === "run") h.operation.verification = { runId: "43" };
    if (change === "repo") h.operation.repo = "different/repo";
    if (change === "environment") h.operation.environment = "other";
    if (change === "login") h.operation.context = {};
    if (change === "attempt") h.operation.control.attempts.verification++;
    if (change === "operationId") h.operation.operationId = "other";
    expect(matchesWorkflowCancellationTarget(h.operation, target)).toBe(false);
    expect(
      await h.control({ ...h.input, cancellationTarget: target })
    ).toMatchObject({
      status: 409,
      body: { code: "operation-context-changed" }
    });
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });

  it.each(["repo", "environment", "login"] as const)(
    "refuses missing %s",
    async (missing) => {
      const h = fixture();
      if (missing === "login") h.operation.context = null;
      else h.operation[missing] = "";
      expect(await h.control(h.input)).toMatchObject({
        status: 409,
        body: { code: "workflow-cancel-not-available" }
      });
      expect(h.run).not.toHaveBeenCalled();
    }
  );

  it("refuses a competing admission", async () => {
    const h = fixture();
    const claim = h.owner.claimAdmission(h.operation.operationId);
    try {
      expect(await h.control(h.input)).toMatchObject({ status: 409 });
      expect(h.run).not.toHaveBeenCalled();
    } finally {
      claim?.release();
    }
  });

  it.each(["shutdown", "target", "command"] as const)(
    "unwinds unissued cancellation after %s during status read",
    async (change) => {
      const h = fixture();
      h.run.mockImplementationOnce(async () => {
        if (change === "shutdown") h.owner.shutdown();
        if (change === "target")
          h.operation.verification = { runId: "43", workflowState: "active" };
        if (change === "command") h.operation.control.commands = [];
        return { code: 0, stdout: '{"status":"in_progress"}', stderr: "" };
      });
      const result = await h.control(h.input);
      expect(result.status).toBe(change === "shutdown" ? 503 : 409);
      expect(h.run).toHaveBeenCalledTimes(1);
      expect(h.operation.control.commands).toEqual([]);
      expect(h.operation.verification).toEqual({
        runId: change === "target" ? "43" : "42",
        workflowState: change === "command" ? "cancelling" : "active"
      });
    }
  );

  it.each(["intent", "read", "correction"] as const)(
    "surfaces pre-issue %s failure",
    async (failure) => {
      const h = fixture();
      if (failure === "intent")
        h.persist.mockRejectedValueOnce(new Error("intent disk error"));
      else h.run.mockRejectedValueOnce(new Error("status unavailable"));
      if (failure === "correction")
        h.persist
          .mockResolvedValueOnce()
          .mockRejectedValueOnce(new Error("undo disk error"));
      const result = await h.control(h.input);
      expect(result).toMatchObject({ status: failure === "read" ? 502 : 500 });
      expect(h.run.mock.calls.some(([, args]) => args.includes("POST"))).toBe(
        false
      );
      expect(h.operation.verification).toEqual({
        runId: "42",
        workflowState: "active"
      });
      if (failure === "correction") {
        expect(h.diagnostic).toHaveBeenCalledWith(
          expect.objectContaining({
            code: "operation-control-recovery-persist-failed"
          })
        );
        expect(h.owner.claimAdmission(h.operation.operationId)).toBeNull();
      }
    }
  );

  it.each(["unknown", "cancelling"] as const)(
    "fences status-only %s across shutdown and never posts",
    async (state) => {
      const h = fixture();
      h.operation.verification = { runId: "42", workflowState: state };
      h.run.mockImplementationOnce(async () => {
        h.owner.shutdown();
        return { code: 0, stdout: '{"status":"completed"}', stderr: "" };
      });
      expect(await h.control(h.input)).toMatchObject({ status: 503 });
      expect(h.persist).not.toHaveBeenCalled();
      expect(h.operation.verification).toEqual({
        runId: "42",
        workflowState: state
      });
      expect(h.run).toHaveBeenCalledTimes(1);
    }
  );

  it("refuses a status-only result made stale while saving it", async () => {
    const h = fixture();
    h.operation.verification = { runId: "42", workflowState: "unknown" };
    h.persist.mockImplementationOnce(async () => {
      h.operation.verification = { runId: "43", workflowState: "active" };
    });
    expect(await h.control(h.input)).toMatchObject({ status: 409 });
    expect(h.operation.verification).toEqual({
      runId: "43",
      workflowState: "active"
    });
  });

  it.each(["success", "failure", "throw", "completion"] as const)(
    "settles issued %s despite shutdown without overwriting the replacement run",
    async (outcome) => {
      const h = fixture();
      h.run.mockImplementationOnce(async () => ({
        code: 0,
        stdout: '{"status":"in_progress"}',
        stderr: ""
      }));
      h.run.mockImplementationOnce(async () => {
        h.owner.shutdown();
        h.operation.verification = { runId: "43", workflowState: "active" };
        if (outcome === "throw") throw new Error("transport lost");
        return {
          code: outcome === "success" ? 0 : 1,
          stdout: "",
          stderr: "remote rejected"
        };
      });
      if (outcome === "completion")
        h.run.mockResolvedValueOnce({
          code: 0,
          stdout: '{"status":"completed"}',
          stderr: ""
        });
      const result = await h.control(h.input);
      const state =
        outcome === "success" ? "cancelling"
        : outcome === "completion" ? "inactive"
        : "unknown";
      expect(result).toMatchObject({
        body: {
          cancellation: {
            target: { runId: "42", login: "saved-account" },
            state,
            issued: true
          }
        }
      });
      expect(h.operation.verification).toEqual({
        runId: "43",
        workflowState: "active"
      });
      expect(h.operation.control.commands.at(-1)).toMatchObject({
        target: "42",
        outcome: state,
        state: "finished"
      });
      expect(h.persist).toHaveBeenCalledTimes(2);
    }
  );

  it("preserves a completed live observation racing POST settlement", async () => {
    const h = fixture();
    h.run.mockImplementationOnce(async () => ({
      code: 0,
      stdout: '{"status":"in_progress"}',
      stderr: ""
    }));
    h.run.mockImplementationOnce(async () => {
      h.operation.verification = { runId: "42", workflowState: "inactive" };
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(await h.control(h.input)).toMatchObject({ status: 202 });
    expect(h.operation.verification).toEqual({
      runId: "42",
      workflowState: "inactive"
    });
  });

  it.each(["post", "save"] as const)(
    "surfaces detached result during %s without resurrecting operation",
    async (boundary) => {
      const h = fixture();
      const replacement = structuredClone(h.operation);
      if (boundary === "post") {
        h.run.mockImplementationOnce(async () => ({
          code: 0,
          stdout: '{"status":"in_progress"}',
          stderr: ""
        }));
        h.run.mockImplementationOnce(async () => {
          h.replace(replacement);
          return { code: 0, stdout: "", stderr: "" };
        });
      } else {
        h.persist.mockResolvedValueOnce().mockImplementationOnce(async () => {
          h.replace(replacement);
        });
      }
      expect(await h.control(h.input)).toMatchObject({
        status: 502,
        body: {
          code: "workflow-cancellation-result-detached",
          cancellation: { state: "cancelling" }
        }
      });
      expect(replacement.control.commands).toEqual([]);
      expect(h.diagnostic).toHaveBeenCalledOnce();
    }
  );

  it("retains acknowledgement when result persistence fails", async () => {
    const h = fixture();
    h.persist
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error("result disk error"));
    expect(await h.control(h.input)).toMatchObject({
      status: 500,
      body: {
        code: "workflow-cancel-result-persist-failed",
        cancellation: { state: "cancelling", issued: true }
      }
    });
    expect(h.operation.control.commands.at(-1)?.outcome).toBe("cancelling");
    expect(h.diagnostic).toHaveBeenCalledOnce();
  });

  it("reports the original unknown result when the operation disappears during POST", async () => {
    const h = fixture();
    h.run.mockImplementationOnce(async () => ({
      code: 0,
      stdout: '{"status":"in_progress"}',
      stderr: ""
    }));
    h.run.mockImplementationOnce(async () => {
      h.replace(null);
      throw new Error("connection lost after send");
    });
    expect(await h.control(h.input)).toMatchObject({
      status: 502,
      body: {
        code: "workflow-cancellation-result-detached",
        cancellation: {
          target: { runId: "42" },
          state: "unknown",
          issued: true
        },
        error: expect.stringContaining("connection lost after send")
      }
    });
    expect(h.persist).toHaveBeenCalledTimes(1);
  });

  it("rejects a superseded command identity without changing saved history", async () => {
    const h = fixture();
    const target = captureWorkflowCancellationTarget(h.operation);
    const result = await h.control({
      ...h.input,
      cancellationTarget: { ...target, commandId: "superseded" }
    });
    expect(result).toMatchObject({ status: 409 });
    expect(h.operation.control.commands).toEqual([]);
    expect(h.persist).not.toHaveBeenCalled();
  });

  it.each(["completed", "retargeted"])(
    "does not issue or unwind another owner's %s command",
    async (change) => {
      const h = fixture();
      h.run.mockImplementationOnce(async () => {
        const command = h.operation.control.commands.at(-1);
        if (!command) throw new Error("Missing admitted command");
        if (change === "completed") command.state = "finished";
        else command.target = "43";
        command.outcome = "other-owner";
        return { code: 0, stdout: '{"status":"in_progress"}', stderr: "" };
      });
      expect(await h.control(h.input)).toMatchObject({ status: 409 });
      expect(h.operation.control.commands.at(-1)?.outcome).toBe("other-owner");
      expect(h.run).toHaveBeenCalledTimes(1);
    }
  );

  it.each(["in_progress", "completed"])(
    "serializes repeated cancellation of %s and observes instead of reposting",
    async (status) => {
      const h = fixture();
      if (status === "completed")
        h.run.mockResolvedValue({
          code: 0,
          stdout: '{"status":"completed"}',
          stderr: ""
        });
      const results = await Promise.all([
        h.control(h.input),
        h.control(h.input)
      ]);
      expect(results.map((result) => result.body.code)).toEqual([
        status === "completed" ? "workflow-cancelled" : (
          "workflow-cancellation-pending"
        ),
        "workflow-status-checked"
      ]);
      expect(
        h.run.mock.calls.filter(([, args]) => args.includes("POST"))
      ).toHaveLength(status === "completed" ? 0 : 1);
    }
  );

  it("refuses shutdown after the last identity await before POST issuance", async () => {
    const h = fixture();
    const executor = successfulSelectedGhExecutor();
    h.dependencies.cancelVerificationWorkflow = (target, authority) =>
      cancelVerificationWorkflow(executor, target, {
        authority,
        run: async (selected, args, beforeExecute) => {
          if (beforeExecute) {
            await Promise.resolve();
            h.owner.shutdown();
            beforeExecute();
          }
          return h.run(selected, args);
        }
      });
    expect(await h.control(h.input)).toMatchObject({ status: 503 });
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.operation.control.commands).toEqual([]);
  });

  it.each(["post", "save"])(
    "does not overwrite mutated command identity during %s settlement",
    async (boundary) => {
      const h = fixture();
      const change = () => {
        const command = h.operation.control.commands.at(-1);
        if (!command) throw new Error("Missing command");
        command.target = "43";
        command.outcome = "replacement";
      };
      if (boundary === "post") {
        h.run.mockImplementationOnce(async () => ({
          code: 0,
          stdout: '{"status":"in_progress"}',
          stderr: ""
        }));
        h.run.mockImplementationOnce(async () => {
          change();
          return { code: 0, stdout: "", stderr: "" };
        });
      } else
        h.persist.mockResolvedValueOnce().mockImplementationOnce(async () => {
          change();
        });
      expect(await h.control(h.input)).toMatchObject({
        status: 502,
        body: { code: "workflow-cancellation-result-detached" }
      });
      expect(h.operation.control.commands.at(-1)).toMatchObject({
        target: "43",
        outcome: "replacement"
      });
    }
  );
});
