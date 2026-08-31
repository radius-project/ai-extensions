import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createOperationsControlRoutes,
  handleCancelWorkflow,
  handleContinueOperation,
  handleExitOperation,
  handleRetryOperation,
  handleRollbackOperation,
  handleStopOperation,
  retryRefusalMessage,
  CONTINUE_OPERATION_ROUTE,
  CANCEL_WORKFLOW_ROUTE,
  EXIT_OPERATION_ROUTE,
  RETRY_OPERATION_ROUTE,
  ROLLBACK_OPERATION_ROUTE,
  STOP_OPERATION_ROUTE,
  type OperationsControlDependencies
} from "./operations-control.js";
import { routeKey } from "../route-table.js";
import {
  acceptCommand,
  beginRetryAttempt,
  buildDeleteStages,
  canRetryCleanup,
  createOperation,
  enterStage,
  finish,
  isProviderRestartDecision,
  finishSucceeded,
  markVerificationRetryAcquisition,
  onOperationTerminal,
  recordAzureApp,
  recordCleanupState,
  recordCommittedWorkflowFile,
  recordGitHubEnvironment,
  pauseForProviderRestart,
  requestStop,
  requireInput,
  setCommandState,
  setStageState,
  setVerificationWorkflowState,
  verificationWorkflowState,
  stopAtBoundary,
  toClientView,
  ABANDON_COMMAND_OUTCOME,
  EXIT_COMMAND_KIND,
  OPERATION_KIND_DELETE,
  STAGE_VERIFY
} from "../../operations.js";
import {
  mergeHandoff,
  newOperation,
  retryableSetup,
  reusedOnlyFailure,
  stoppedSetup,
  FIXTURE_REPO,
  type OperationFixture
} from "../../../test/support/server/operation-fixtures.js";
import type { CanvasServerEntry } from "../types.js";

// The terminal announcement is a single process-wide listener, so every test
// that touches it registers its own and clears it afterwards.
const announced: string[] = [];
afterEach(() => {
  onOperationTerminal(null);
  announced.length = 0;
});

function watchAnnouncements(): void {
  onOperationTerminal((operation: { operationId: string }) => {
    announced.push(operation.operationId);
  });
}

interface Recording {
  headers: Record<string, string>;
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = { headers: {}, status: 0, body: "" };
  const target = {
    setHeader(name: string, value: string) {
      recording.headers[name] = value;
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      return this;
    },
    end(value = "") {
      recording.body += value;
      return this;
    }
  };
  return {
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>,
    payload: () => JSON.parse(recording.body || "null")
  };
}

function postContext(
  url: string,
  response: ServerResponse<IncomingMessage>,
  instanceId = "panel-a"
): ReturnType<typeof createRequestContext> {
  const request = Object.assign(Readable.from(["{}"]), {
    url,
    method: "POST",
    headers: {}
  }) as unknown as IncomingMessage;
  return createRequestContext(
    request,
    response,
    instanceId,
    new Map<string, CanvasServerEntry>()
  );
}

type ControlHandler = (
  context: ReturnType<typeof createRequestContext>,
  dependencies: OperationsControlDependencies
) => Promise<void>;

/** The control path for one action on a saved record. */
function controlPath(op: { operationId: string }, action: string): string {
  return `/api/operations/${op.operationId}/${action}`;
}

function verificationRunId(operation: {
  verification?: unknown;
  [key: string]: unknown;
}): string {
  const verification = operation.verification;
  if (
    !verification ||
    typeof verification !== "object" ||
    !("runId" in verification)
  ) {
    throw new Error("test operation has no verification run");
  }
  return String(verification.runId);
}

async function call(
  handler: ControlHandler,
  path: string,
  deps: OperationsControlDependencies,
  instanceId = "panel-a"
): Promise<ReturnType<typeof recorder>> {
  const out = recorder();
  await handler(postContext(path, out.response, instanceId), deps);
  return out;
}

/**
 * Drive one control handler over a saved record and hand back the recording
 * with the journal the run wrote.
 *
 * Every scenario arranges a record, invokes exactly one handler, and reads the
 * status, payload, and journal back, so the plumbing is written once and each
 * test keeps only the arrangement and the assertions that make it distinct.
 */
async function drive(
  handler: ControlHandler,
  op: OperationFixture,
  action: string,
  overrides: Partial<OperationsControlDependencies> = {}
): Promise<ReturnType<typeof recorder> & { journal: Journal }> {
  const deps = dependencies({ get: () => op, ...overrides });
  const out = await call(handler, controlPath(op, action), deps);
  return Object.assign(out, { journal: deps.journal });
}

interface Journal {
  scheduled: Array<{ kind: string; instanceId: string; commandId: string }>;
  persistCalls: number;
  invalidatedListings: string[];
}

// The route module calls the pure model directly, so the only doubles a test
// needs are the genuine I/O seams: the registry lookup, the durable write, the
// merge proof, and the per-instance runner. `get` and `checkPullRequestMerge`
// throw until a scenario models them, so a route that reaches an seam it must
// not touch fails instead of quietly succeeding.
function dependencies(
  overrides: Partial<OperationsControlDependencies> = {}
): OperationsControlDependencies & { journal: Journal } {
  const journal: Journal = {
    scheduled: [],
    persistCalls: 0,
    invalidatedListings: []
  };
  const base: OperationsControlDependencies = {
    get: () => {
      throw new Error("get not stubbed");
    },
    acquireForRetry: () => ({ ok: true }),
    persistOperations: () => {
      journal.persistCalls += 1;
      return Promise.resolve();
    },
    checkPullRequestMerge: () => {
      throw new Error("checkPullRequestMerge not stubbed");
    },
    inspectVerificationWorkflow: () => Promise.resolve("inactive"),
    cancelVerificationWorkflow: () => Promise.resolve("inactive"),
    schedule: ({ kind, instanceId, commandId }) => {
      journal.scheduled.push({ kind, instanceId, commandId });
      return true;
    },
    invalidateEnvironmentListing: (repo) => {
      journal.invalidatedListings.push(repo);
    }
  };
  return Object.assign(base, overrides, { journal });
}

function retryableDeletion(): OperationFixture {
  const op = createOperation({
    provider: "azure",
    repo: FIXTURE_REPO,
    environment: "dev",
    kind: OPERATION_KIND_DELETE,
    stages: buildDeleteStages()
  }) as OperationFixture;
  op.stages[0].state = "succeeded";
  setStageState(op, op.stages[1].id, "failed");
  finish(op, "failed_partial", {
    failure: { code: "credential-delete-failed" }
  });
  return op;
}

describe("the route registry", () => {
  it("claims exactly the six declared control routes", () => {
    const registry = createOperationsControlRoutes(dependencies());
    expect(Object.keys(registry).sort()).toEqual(
      [
        routeKey({ method: "POST", path: STOP_OPERATION_ROUTE }),
        routeKey({ method: "POST", path: CONTINUE_OPERATION_ROUTE }),
        routeKey({ method: "POST", path: CANCEL_WORKFLOW_ROUTE }),
        routeKey({ method: "POST", path: ROLLBACK_OPERATION_ROUTE }),
        routeKey({ method: "POST", path: EXIT_OPERATION_ROUTE }),
        routeKey({ method: "POST", path: RETRY_OPERATION_ROUTE })
      ].sort()
    );
  });

  // Each declared key must reach the handler that answers for it. The record is
  // running, so only the stop has anything to accept; the other three refuse it
  // on their own terms, which is what proves the key was not mis-wired.
  it.each([
    [STOP_OPERATION_ROUTE, "stop", "operation-stop-pending"],
    [RETRY_OPERATION_ROUTE, "retry/setup", "operation-active"],
    [CONTINUE_OPERATION_ROUTE, "continue", "operation-active"],
    [ROLLBACK_OPERATION_ROUTE, "rollback", "operation-active"]
  ])("dispatches %s to its own handler", async (route, action, code) => {
    const op = newOperation();
    const registry = createOperationsControlRoutes(
      dependencies({ get: () => op })
    );
    const out = recorder();

    await registry[`POST ${route}`](
      postContext(controlPath(op, action), out.response)
    );

    expect(out.payload().code).toBe(code);
  });

  it("waits for the first command to persist before acknowledging its duplicate", async () => {
    const op = stoppedSetup();
    let releasePersist: (() => void) | undefined;
    let markPersisting: (() => void) | undefined;
    const persisting = new Promise<void>((resolve) => {
      markPersisting = resolve;
    });
    const persistence = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const deps = dependencies({
      get: () => op,
      persistOperations: () => {
        markPersisting?.();
        return persistence;
      }
    });
    const registry = createOperationsControlRoutes(deps);
    const path = controlPath(op, "rollback");
    const first = recorder();
    const firstRequest = registry[`POST ${ROLLBACK_OPERATION_ROUTE}`](
      postContext(path, first.response)
    );
    await persisting;

    const duplicate = recorder();
    const duplicateRequest = registry[`POST ${ROLLBACK_OPERATION_ROUTE}`](
      postContext(path, duplicate.response)
    );
    await Promise.resolve();

    expect(duplicate.recording.status).toBe(0);
    releasePersist?.();
    await Promise.all([firstRequest, duplicateRequest]);
    expect(first.recording.status).toBe(202);
    expect(duplicate.recording.status).toBe(202);
    expect(duplicate.payload()).toMatchObject({
      duplicate: true,
      commandId: first.payload().commandId
    });
    expect(deps.journal.scheduled).toHaveLength(1);
  });

  it("does not acknowledge a concurrent duplicate when persistence fails", async () => {
    const op = stoppedSetup();
    let rejectPersist: ((error: Error) => void) | undefined;
    let markPersisting: (() => void) | undefined;
    let persistCalls = 0;
    const persisting = new Promise<void>((resolve) => {
      markPersisting = resolve;
    });
    const firstPersistence = new Promise<void>((_resolve, reject) => {
      rejectPersist = reject;
    });
    const deps = dependencies({
      get: () => op,
      persistOperations: () => {
        persistCalls += 1;
        if (persistCalls === 1) {
          markPersisting?.();
          return firstPersistence;
        }
        return Promise.reject(new Error("disk still unavailable"));
      }
    });
    const registry = createOperationsControlRoutes(deps);
    const path = controlPath(op, "rollback");
    const first = recorder();
    const firstRequest = registry[`POST ${ROLLBACK_OPERATION_ROUTE}`](
      postContext(path, first.response)
    );
    await persisting;

    const duplicate = recorder();
    const duplicateRequest = registry[`POST ${ROLLBACK_OPERATION_ROUTE}`](
      postContext(path, duplicate.response)
    );
    await Promise.resolve();
    expect(duplicate.recording.status).toBe(0);

    rejectPersist?.(new Error("disk unavailable"));
    await Promise.all([firstRequest, duplicateRequest]);
    expect(first.recording.status).toBe(500);
    expect(duplicate.recording.status).toBe(500);
    expect(deps.journal.scheduled).toEqual([]);
    expect(op.control.commands).toEqual([]);
  });
});

describe("POST /api/operations/{id}/stop", () => {
  function interruptedVerificationOperation(): OperationFixture {
    const op = newOperation();
    op.context = { githubLogin: "alice" };
    op.resumeRequest = {
      environment: {
        repo: "contoso/store",
        environment: "dev",
        provider: "azure"
      }
    };
    enterStage(op, STAGE_VERIFY);
    op.verification = {
      dispatchedAt: Date.now(),
      workflow: "radius-verify-credentials.yml",
      ref: "main",
      environment: "dev",
      runId: "42"
    };
    pauseForProviderRestart(op);
    return op;
  }

  it("stops an interrupted setup before offering exact-run cancellation", async () => {
    const op = interruptedVerificationOperation();

    const out = await drive(handleStopOperation, op, "stop", {
      inspectVerificationWorkflow: () => Promise.resolve("active")
    });

    expect(out.recording.status).toBe(200);
    expect(out.journal.persistCalls).toBe(2);
    expect(op.state).toBe("cancelled");
    expect(
      out.payload().operation.actions.map((action: { id: string }) => action.id)
    ).toContain("cancel-workflow");
    expect(
      out.payload().operation.actions.map((action: { id: string }) => action.id)
    ).not.toContain("rollback");
  });

  it("restores the interrupted decision when stopping cannot be saved", async () => {
    const op = interruptedVerificationOperation();
    const out = await drive(handleStopOperation, op, "stop", {
      persistOperations: () => Promise.reject(new Error("disk gone"))
    });

    expect(out.recording.status).toBe(500);
    expect(out.payload()).toMatchObject({
      code: "operation-stop-persist-failed",
      detail: "disk gone"
    });
    expect(op.state).toBe("action_required");
    expect(isProviderRestartDecision(op)).toBe(true);
  });

  it("keeps cleanup blocked when workflow status and its update cannot be saved", async () => {
    const op = interruptedVerificationOperation();
    watchAnnouncements();
    let persists = 0;
    const out = await drive(handleStopOperation, op, "stop", {
      inspectVerificationWorkflow: () =>
        Promise.reject(new Error("GitHub unavailable")),
      persistOperations: () => {
        persists += 1;
        return persists === 1 ?
            Promise.resolve()
          : Promise.reject(new Error("disk gone"));
      }
    });

    expect(out.recording.status).toBe(200);
    expect(out.payload()).toMatchObject({
      code: "operation-stopped-workflow-status-unknown",
      detail:
        "GitHub unavailable Radius also could not save the unknown workflow status: disk gone"
    });
    expect(verificationWorkflowState(op)).toBe("unknown");
    expect(announced).toEqual([op.operationId]);
    expect(
      out.payload().operation.actions.map((action: { id: string }) => action.id)
    ).not.toContain("rollback");
  });

  it("records a stop for a running operation and reports it as pending", async () => {
    const op = newOperation();
    const out = await drive(handleStopOperation, op, "stop");

    expect(out.recording.status).toBe(202);
    expect(out.recording.headers["Cache-Control"]).toBe("no-store");
    const payload = out.payload();
    expect(payload.code).toBe("operation-stop-pending");
    expect(payload.statusUrl).toBe(`/api/operations/${op.operationId}`);
    expect(payload.operation.state).toBe("running");
    expect(payload.operation.stop.requested).toBe(true);
    expect(payload.operation.nextTransition.code).toBe("stopping");
    // Durable before the caller hears it was accepted.
    expect(out.journal.persistCalls).toBe(1);
    expect(op.control.stop.requestedAt).toBeTruthy();
  });

  it("cancels at once while the operation is parked on a prompt", async () => {
    watchAnnouncements();
    const op = newOperation();
    requireInput(op, {
      code: "app-selection-required",
      message: "Choose an identity."
    });

    const out = await drive(handleStopOperation, op, "stop");

    expect(out.recording.status).toBe(200);
    const payload = out.payload();
    expect(payload.code).toBe("operation-stopped");
    expect(payload.operation.terminalState).toBe("cancelled");
    expect(payload.operation.stop.boundary).toBe("input_prompt");
    // Announced only after the write landed.
    expect(announced).toEqual([op.operationId]);
    expect(op.journey.notifiedAt).toBeTruthy();
  });

  it.each(["rollback", "retry_cleanup", EXIT_COMMAND_KIND] as const)(
    "rejects Stop while %s cleanup owns the operation",
    async (kind) => {
      const op = newOperation();
      const accepted = acceptCommand(op, {
        kind,
        attempt: 1,
        target: "cleanup#owned"
      });
      setCommandState(op, accepted.command.commandId, "running");

      const out = await drive(handleStopOperation, op, "stop");

      expect(out.recording.status).toBe(409);
      expect(out.payload()).toMatchObject({
        code: "operation-cleanup-not-stoppable",
        error:
          "Cleanup is already running and cannot be stopped. Wait for it to finish."
      });
      expect(op.stopRequested).toBe(false);
      expect(out.journal.persistCalls).toBe(0);
    }
  );

  it("returns the saved result when the same stop arrives twice", async () => {
    const op = newOperation();
    requireInput(op, { code: "app-selection-required", message: "Choose." });
    const deps = dependencies({ get: () => op });

    const path = controlPath(op, "stop");
    const first = await call(handleStopOperation, path, deps);
    const second = await call(handleStopOperation, path, deps);

    expect(first.recording.status).toBe(200);
    expect(second.recording.status).toBe(200);
    expect(second.payload().code).toBe("operation-stopped");
    // The repeat writes nothing: the cancellation is already durable.
    expect(deps.journal.persistCalls).toBe(1);
  });

  it("refuses to stop an operation that already finished", async () => {
    const op = newOperation();
    finish(op, "succeeded");
    const out = await drive(handleStopOperation, op, "stop");

    expect(out.recording.status).toBe(409);
    expect(out.payload().code).toBe("operation-already-terminal");
    expect(out.journal.persistCalls).toBe(0);
  });

  it("puts the record back and reports the failure when the stop cannot be saved", async () => {
    watchAnnouncements();
    const op = newOperation();
    requireInput(op, { code: "app-selection-required", message: "Choose." });
    const out = await drive(handleStopOperation, op, "stop", {
      persistOperations: () => Promise.reject(new Error("disk gone"))
    });

    expect(out.recording.status).toBe(500);
    expect(out.payload()).toMatchObject({
      code: "operation-stop-persist-failed",
      detail: "disk gone"
    });
    // Nothing was stopped, and nothing was announced.
    expect(op.state).toBe("input_required");
    expect(op.control.stop.requestedAt).toBeNull();
    expect(announced).toEqual([]);
  });

  it("answers 404 rather than throwing on an undecodable operation id", async () => {
    const deps = dependencies({
      get: () => {
        throw new Error("lookup must not run for an undecodable id");
      }
    });
    const out = await call(handleStopOperation, "/api/operations/%/stop", deps);

    expect(out.recording.status).toBe(404);
    expect(out.payload().code).toBe("unknown-operation");
  });

  it("answers 404 rather than guessing when the path is not this route's shape", async () => {
    const deps = dependencies({
      get: () => {
        throw new Error("lookup must not run for a path outside the template");
      }
    });
    const out = await call(
      handleStopOperation,
      "/api/operations/op-1/stop/now",
      deps
    );

    expect(out.recording.status).toBe(404);
    expect(out.payload().code).toBe("unknown-operation");
  });

  it("decodes a percent-encoded operation id before the lookup", async () => {
    const op = newOperation();
    op.operationId = "octo/app:setup";
    const seen: string[] = [];
    const deps = dependencies({
      get: (operationId) => {
        seen.push(operationId);
        return op;
      }
    });
    const out = await call(
      handleStopOperation,
      `/api/operations/${encodeURIComponent("octo/app:setup")}/stop`,
      deps
    );

    expect(seen).toEqual(["octo/app:setup"]);
    expect(out.recording.status).toBe(202);
    expect(out.payload().statusUrl).toBe("/api/operations/octo%2Fapp%3Asetup");
  });
});

describe("POST /api/operations/{id}/retry/{kind}", () => {
  it("continues an interrupted setup from the first unfinished step", async () => {
    const op = retryableSetup();
    const out = await drive(handleRetryOperation, op, "retry/setup");

    expect(out.recording.status).toBe(202);
    const payload = out.payload();
    expect(payload.attempt).toBe(2);
    expect(payload.commandId).toBe(`${op.operationId}:retry_setup:2:setup`);
    expect(payload.operation.state).toBe("running");
    // The prior verdict survives as history rather than being overwritten.
    expect(payload.operation.outcomes).toEqual([
      expect.objectContaining({ kind: "setup", state: "failed_partial" })
    ]);
    // The ledger already proves the App Registration, so the retry resumes past
    // it rather than creating a second one.
    expect(op.resumeFrom).toBe("service_principal");
    expect(out.journal.scheduled).toEqual([
      {
        kind: "setup_continuation",
        instanceId: "panel-a",
        commandId: payload.commandId
      }
    ]);
    // Saved before any work was scheduled.
    expect(out.journal.persistCalls).toBe(1);
  });

  it("retries only unfinished delete stages with the delete runner", async () => {
    const op = retryableDeletion();
    const out = await drive(handleRetryOperation, op, "retry/deletion");

    expect(out.recording.status).toBe(202);
    const payload = out.payload();
    expect(payload.attempt).toBe(1);
    expect(payload.commandId).toBe(
      `${op.operationId}:retry_deletion:1:${op.stages[1].id}`
    );
    expect(op.state).toBe("running");
    expect(op.stages.map((stage) => stage.state)).toEqual([
      "succeeded",
      "pending",
      "pending",
      "pending",
      "pending"
    ]);
    expect(op.currentStage).toBe(op.stages[1].id);
    expect(out.journal.scheduled).toEqual([
      {
        kind: "deletion_retry",
        instanceId: "panel-a",
        commandId: payload.commandId
      }
    ]);
    expect(out.journal.persistCalls).toBe(1);
  });

  it("refuses a setup retry whose ownership the ledger cannot prove", async () => {
    const op = retryableSetup();
    recordGitHubEnvironment(op, {
      state: "created_candidate",
      repo: "contoso/store",
      name: "dev"
    });
    const out = await drive(handleRetryOperation, op, "retry/setup");

    expect(out.recording.status).toBe(409);
    const payload = out.payload();
    expect(payload.code).toBe("setup-retry-ownership-ambiguous");
    expect(payload.error).toContain("duplicate a resource");
    expect(payload.detail).toContain("without proven ownership");
    // Refusing never reopens the record or schedules work.
    expect(op.state).toBe("failed_partial");
    expect(out.journal.scheduled).toEqual([]);
  });

  it("refuses verification retry while the setup pull request is still open", async () => {
    const op = mergeHandoff();
    const asked: Array<string | null> = [];
    const out = await drive(handleRetryOperation, op, "retry/verification", {
      checkPullRequestMerge: (_operation, pullRequestUrl) => {
        asked.push(pullRequestUrl);
        return Promise.resolve({ state: "open" });
      }
    });

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "verification-retry-pull-request-open",
      pullRequestUrl: "https://github.com/contoso/store/pull/7"
    });
    expect(asked).toEqual(["https://github.com/contoso/store/pull/7"]);
    expect(op.state).toBe("action_required");
    expect(out.journal.scheduled).toEqual([]);
  });

  it("repeats verification once the setup pull request has merged", async () => {
    const op = mergeHandoff();
    const out = await drive(handleRetryOperation, op, "retry/verification", {
      checkPullRequestMerge: () => Promise.resolve({ state: "merged" })
    });

    expect(out.recording.status).toBe(202);
    const payload = out.payload();
    expect(payload.commandId).toBe(
      `${op.operationId}:retry_verification:1:verification`
    );
    expect(payload.operation.currentStage).toBe(STAGE_VERIFY);
    expect(op.verification).toMatchObject({
      acquisitionPending: true,
      retryCommandId: payload.commandId,
      retryClassification: "workflow-installation-pending"
    });
    // The action_required verdict is kept as history.
    expect(payload.operation.outcomes).toEqual([
      expect.objectContaining({
        kind: "verification",
        state: "action_required",
        code: "pr-merge-required"
      })
    ]);
    expect(out.journal.scheduled).toEqual([
      {
        kind: "verification_retry",
        instanceId: "panel-a",
        commandId: payload.commandId
      }
    ]);
  });

  it("removes the pending acquisition marker when verification retry cannot be saved", async () => {
    const op = mergeHandoff();
    const previousVerification = structuredClone(op.verification);
    const out = await drive(handleRetryOperation, op, "retry/verification", {
      checkPullRequestMerge: () => Promise.resolve({ state: "merged" }),
      persistOperations: () => Promise.reject(new Error("disk gone"))
    });

    expect(out.recording.status).toBe(500);
    expect(out.payload()).toMatchObject({
      code: "verification-retry-persist-failed",
      detail: "disk gone"
    });
    expect(op.state).toBe("action_required");
    expect(op.verification).toEqual(previousVerification);
    expect(out.journal.scheduled).toEqual([]);
  });

  it("restores the pre-request verification state when the accepted retry cannot be saved", async () => {
    const op = mergeHandoff();
    const previousVerification = structuredClone(op.verification);
    let persistCalls = 0;
    const out = await drive(handleRetryOperation, op, "retry/verification", {
      checkPullRequestMerge: () => Promise.resolve({ state: "merged" }),
      persistOperations: () => {
        persistCalls += 1;
        return persistCalls === 1 ?
            Promise.resolve()
          : Promise.reject(new Error("disk gone after merge proof"));
      }
    });

    expect(out.recording.status).toBe(500);
    expect(out.payload()).toMatchObject({
      code: "operation-retry-persist-failed",
      detail: "disk gone after merge proof"
    });
    expect(op.state).toBe("action_required");
    expect(op.verification).toEqual(previousVerification);
    expect(out.journal.scheduled).toEqual([]);
  });

  it("reuses only the provisional deadline minted by the current request", async () => {
    const op = mergeHandoff();
    const deadlines: number[] = [];
    const out = await drive(handleRetryOperation, op, "retry/verification", {
      checkPullRequestMerge: () => Promise.resolve({ state: "merged" }),
      persistOperations: () => {
        deadlines.push(
          Number(
            (op.verification as { acquisitionDeadline?: unknown } | undefined)
              ?.acquisitionDeadline
          )
        );
        return Promise.resolve();
      }
    });

    expect(out.recording.status).toBe(202);
    expect(deadlines).toHaveLength(2);
    expect(deadlines[1]).toBe(deadlines[0]);
    expect(op.verification).not.toHaveProperty("acquisitionProvisional");
    expect(op.verification).not.toHaveProperty("acquisitionProvisionalToken");
  });

  it("repeats verification without a merge proof for an Azure RBAC failure", async () => {
    // Role propagation needs no pull request, so the merge port must not be
    // reached at all: asking GitHub about a pull request this failure does not
    // depend on would make the retry fail for an unrelated reason.
    const op = mergeHandoff();
    op.state = "failed_partial";
    op.terminal = null;
    op.failure = { code: "verify-run-failed", message: "role not ready" };
    const out = await drive(handleRetryOperation, op, "retry/verification");

    expect(out.recording.status).toBe(202);
    const payload = out.payload();
    expect(payload.commandId).toBe(
      `${op.operationId}:retry_verification:1:verification`
    );
    expect(out.journal.scheduled).toEqual([
      {
        kind: "verification_retry",
        instanceId: "panel-a",
        commandId: payload.commandId
      }
    ]);
  });

  it("does not reuse a stale provisional deadline when no merge proof is required", async () => {
    const op = mergeHandoff();
    op.state = "failed_partial";
    op.terminal = null;
    op.failure = { code: "verify-run-failed", message: "role not ready" };
    op.verification = {
      ...(op.verification || {}),
      acquisitionProvisional: true,
      acquisitionProvisionalToken: "older-request",
      acquisitionDeadline: 1
    };
    const before = Date.now();

    const out = await drive(handleRetryOperation, op, "retry/verification");

    expect(out.recording.status).toBe(202);
    expect(
      Number(
        (op.verification as { acquisitionDeadline?: unknown } | undefined)
          ?.acquisitionDeadline
      )
    ).toBeGreaterThan(before);
    expect(op.verification).not.toHaveProperty("acquisitionProvisional");
    expect(op.verification).not.toHaveProperty("acquisitionProvisionalToken");
  });

  it("refuses when the record changed while the pull request was checked", async () => {
    const op = mergeHandoff();
    const out = await drive(handleRetryOperation, op, "retry/verification", {
      checkPullRequestMerge: () => {
        // A concurrent retry reopened the record while GitHub was answering.
        beginRetryAttempt(op, "verification");
        return Promise.resolve({ state: "merged" });
      }
    });

    expect(out.recording.status).toBe(409);
    expect(out.payload().code).toBe("operation-active");
    expect(out.journal.scheduled).toEqual([]);
  });

  it("fails closed when the saved record names no pull request", async () => {
    // A merge-required record whose pull-request URL was never saved cannot be
    // checked, so the retry must refuse rather than proceed on an unverifiable
    // claim.
    const op = mergeHandoff({ pullRequestUrl: null });
    const out = await drive(handleRetryOperation, op, "retry/verification", {
      checkPullRequestMerge: (_operation, pullRequestUrl) => {
        expect(pullRequestUrl).toBeNull();
        return Promise.resolve({ state: "open" });
      }
    });

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "verification-retry-pull-request-open",
      pullRequestUrl: null
    });
  });

  it("does not restore stale provisional state over a concurrent accepted retry", async () => {
    const op = mergeHandoff();
    const out = await drive(handleRetryOperation, op, "retry/verification", {
      checkPullRequestMerge: () => {
        beginRetryAttempt(op, "verification");
        op.verification = {
          operationMarker: "concurrent-marker"
        };
        markVerificationRetryAcquisition(op, "concurrent-command");
        return Promise.resolve({ state: "open" });
      }
    });

    expect(out.recording.status).toBe(409);
    expect(op.verification).toMatchObject({
      operationMarker: "concurrent-marker",
      retryCommandId: "concurrent-command"
    });
  });

  it("does not restore stale provisional state when its persistence fails", async () => {
    const op = mergeHandoff();
    const out = await drive(handleRetryOperation, op, "retry/verification", {
      persistOperations: () => {
        beginRetryAttempt(op, "verification");
        op.verification = {
          operationMarker: "concurrent-marker"
        };
        markVerificationRetryAcquisition(op, "concurrent-command");
        return Promise.reject(new Error("disk unavailable"));
      }
    });

    expect(out.recording.status).toBe(500);
    expect(out.payload().code).toBe("verification-retry-persist-failed");
    expect(op.verification).toMatchObject({
      operationMarker: "concurrent-marker",
      retryCommandId: "concurrent-command"
    });
  });

  it("fails closed when the selected account cannot verify the setup pull request", async () => {
    const op = mergeHandoff();
    op.context = { githubLogin: "alice" };
    const out = await drive(handleRetryOperation, op, "retry/verification", {
      checkPullRequestMerge: () =>
        Promise.resolve({
          state: "unavailable",
          login: "alice",
          detail: "selected credential unavailable"
        })
    });

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "verification-retry-github-account-unavailable",
      error:
        "Radius could not verify the setup pull request with @alice. Re-check that GitHub account and try again.",
      detail: "selected credential unavailable",
      pullRequestUrl: "https://github.com/contoso/store/pull/7"
    });
    expect(op.state).toBe("action_required");
    expect(out.journal.persistCalls).toBe(1);
    expect(out.journal.scheduled).toEqual([]);
  });

  it("names no repository rather than the word undefined in a lock conflict", async () => {
    const op = retryableSetup();
    delete op.repo;
    const out = await drive(handleRetryOperation, op, "retry/setup", {
      acquireForRetry: () => ({
        ok: false,
        conflict: { operationId: "op_live" }
      })
    });

    expect(out.recording.status).toBe(409);
    expect(out.payload().error).toBe("Another setup is already running for .");
    expect(out.recording.body).not.toContain("undefined");
  });

  it("refuses a verification retry for a failure it cannot classify", async () => {
    const op = newOperation();
    finish(op, "failed_partial", {
      failure: { code: "who-knows", message: "unclassified" }
    });
    const out = await drive(handleRetryOperation, op, "retry/verification");

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "verification-retry-not-retryable",
      error:
        "This result is not one Radius can fix by checking credentials again."
    });
  });

  it("retries cleanup only for a proven-owned unresolved resource", async () => {
    const op = newOperation();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordCleanupState(op, {
      state: "succeeded_with_warnings",
      attempts: 1,
      results: [
        {
          attempt: 1,
          artifactType: "azure_app",
          target: "radius (app-1)",
          identity: "app-1",
          outcome: "warning",
          detail: "Azure CLI returned 429."
        }
      ]
    });
    finish(op, "failed_partial", { failure: { code: "setup-failed" } });
    const eligibility = canRetryCleanup(op);
    const out = await drive(handleRetryOperation, op, "retry/cleanup");

    expect(out.recording.status).toBe(202);
    const payload = out.payload();
    expect(eligibility.ok).toBe(true);
    expect(payload.commandId).toBe(
      `${op.operationId}:retry_cleanup:1:${eligibility.target}`
    );
    expect(payload.commandId).toMatch(
      new RegExp(`^${op.operationId}:retry_cleanup:1:cleanup#[0-9a-f]{16}$`)
    );
    expect(op.control.commands.at(-1)).toMatchObject({
      commandId: payload.commandId,
      target: eligibility.target
    });
    expect(out.journal.scheduled).toEqual([
      {
        kind: "cleanup_retry",
        instanceId: "panel-a",
        commandId: payload.commandId
      }
    ]);
  });

  it("resolves a repeated submission to the command already in flight", async () => {
    const op = retryableSetup();
    const deps = dependencies({ get: () => op });

    const path = controlPath(op, "retry/setup");
    const first = await call(handleRetryOperation, path, deps);
    // The second submission arrives before the first attempt finished, so the
    // attempt counter has already advanced and the derived id is the same.
    finish(op, "failed_partial", { failure: { code: "operation-stalled" } });
    op.control.attempts.setup = 1;
    const second = await call(handleRetryOperation, path, deps);

    expect(first.payload().duplicate).toBeUndefined();
    expect(second.recording.status).toBe(202);
    expect(second.payload()).toMatchObject({
      duplicate: true,
      commandId: `${op.operationId}:retry_setup:2:setup`
    });
    // The duplicate never reopens the record a second time or schedules again.
    expect(op.state).toBe("failed_partial");
    expect(deps.journal.scheduled).toHaveLength(1);
  });

  it("resolves a repeated deletion retry to the command already in flight", async () => {
    const op = retryableDeletion();
    const deps = dependencies({ get: () => op });
    const path = controlPath(op, "retry/deletion");

    const first = await call(handleRetryOperation, path, deps);
    const second = await call(handleRetryOperation, path, deps);

    expect(first.payload().duplicate).toBeUndefined();
    expect(second.recording.status).toBe(202);
    expect(second.payload()).toMatchObject({
      duplicate: true,
      commandId: first.payload().commandId
    });
    expect(deps.journal.scheduled).toHaveLength(1);
  });

  it("closes a reopened operation no runner accepted", async () => {
    const op = retryableSetup();
    const persists: string[] = [];
    const out = await drive(handleRetryOperation, op, "retry/setup", {
      persistOperations: () => {
        persists.push("persist");
        return Promise.resolve();
      },
      schedule: () => false
    });

    // The 202 is already on the wire and cannot be recalled, so the failure has
    // to be observable through the status the client is polling.
    expect(out.recording.status).toBe(202);
    expect(op.state).toBe("failed");
    expect(op.failure?.code).toBe("operation-scheduling-failed");
    expect(op.control.commands.at(-1)).toMatchObject({
      state: "finished",
      outcome: "unscheduled"
    });
    expect(persists).toEqual(["persist", "persist"]);
  });

  it("keeps the terminal record when the scheduling-failure write also fails", async () => {
    const op = retryableSetup();
    let calls = 0;
    const out = await drive(handleRetryOperation, op, "retry/setup", {
      persistOperations: () => {
        calls += 1;
        return calls === 1 ?
            Promise.resolve()
          : Promise.reject(new Error("disk gone"));
      },
      schedule: () => false
    });

    expect(out.recording.status).toBe(202);
    expect(op.state).toBe("failed");
    expect(calls).toBe(2);
  });

  it("refuses a retry kind it does not implement", async () => {
    const op = retryableSetup();
    const out = await drive(handleRetryOperation, op, "retry/everything");

    expect(out.recording.status).toBe(400);
    expect(out.payload()).toMatchObject({ code: "unsupported-retry" });
    expect(op.state).toBe("failed_partial");
  });

  it("refuses an undecodable retry kind rather than throwing", async () => {
    const op = retryableSetup();
    const deps = dependencies({ get: () => op });
    const out = await call(
      handleRetryOperation,
      `/api/operations/${op.operationId}/retry/%`,
      deps
    );

    expect(out.recording.status).toBe(400);
    expect(out.payload().code).toBe("unsupported-retry");
  });
});

describe("retryRefusalMessage", () => {
  it("explains every closed refusal code in the customer's terms", () => {
    expect(
      retryRefusalMessage("cleanup", "cleanup-retry-provenance-incomplete")
    ).toBe(
      "Radius did not save enough about the workflow files it committed to prove they are unchanged, so it will not remove them or anything they depend on."
    );
    expect(
      retryRefusalMessage("rollback", "rollback-environment-verified")
    ).toBe(
      "Credential verification succeeded for this environment, so it is finished setup. Remove it with Delete Environment instead."
    );
    expect(retryRefusalMessage("setup", "operation-active")).toBe(
      "This setup is still running, so there is nothing to retry yet."
    );
  });

  it("stays honest about a code it does not recognise", () => {
    expect(retryRefusalMessage("setup", "brand-new-code")).toBe(
      "Radius cannot retry setup for this operation (brand-new-code)."
    );
  });
});

// ─── Stop, continue, roll back ───────────────────────────────────────────────
// A stopped attempt offers two decisions, and the routes below keep them apart:
// continuing walks the ledger forward, rolling back removes only what the
// ledger proves this attempt created, and neither can start while the other
// owns the record.

describe("POST /api/operations/{id}/continue", () => {
  it("continues recovered verification by monitoring without redispatching", async () => {
    const op = newOperation();
    op.context = { githubLogin: "alice" };
    op.resumeRequest = {
      environment: {
        repo: "contoso/store",
        environment: "dev",
        provider: "azure"
      }
    };
    enterStage(op, STAGE_VERIFY);
    op.verification = {
      dispatchedAt: Date.now(),
      workflow: "radius-verify-credentials.yml",
      ref: "main",
      environment: "dev",
      runId: "42"
    };
    pauseForProviderRestart(op);

    const out = await drive(handleContinueOperation, op, "continue");

    expect(out.recording.status).toBe(202);
    expect(out.journal.scheduled).toEqual([
      {
        kind: "verification_monitor",
        instanceId: "panel-a",
        commandId: out.payload().commandId
      }
    ]);
  });

  it("continues a stopped setup from the first unfinished step", async () => {
    const op = stoppedSetup();
    const out = await drive(handleContinueOperation, op, "continue");

    expect(out.recording.status).toBe(202);
    const payload = out.payload();
    expect(payload.commandId).toBe(
      `${op.operationId}:continue_setup:2:continue`
    );
    expect(payload.attempt).toBe(2);
    expect(payload.operation.state).toBe("running");
    expect(op.resumeFrom).toBe("federated_credentials");
    expect(out.journal.scheduled).toEqual([
      {
        kind: "setup_continuation",
        instanceId: "panel-a",
        commandId: payload.commandId
      }
    ]);
    // The command is saved before any work is handed to a runner.
    expect(out.journal.persistCalls).toBe(1);
  });

  describe("POST /api/operations/{id}/cancel-workflow", () => {
    it("cancels only the exact run after setup is stopped", async () => {
      const op = stoppedSetup();
      op.verification = { runId: "42" };
      setVerificationWorkflowState(op, "active");
      const seen: string[] = [];

      const out = await drive(handleCancelWorkflow, op, "cancel-workflow", {
        cancelVerificationWorkflow: (operation) => {
          seen.push(verificationRunId(operation));
          return Promise.resolve("inactive");
        }
      });

      expect(out.recording.status).toBe(200);
      expect(out.payload().code).toBe("workflow-cancelled");
      expect(seen).toEqual(["42"]);
      expect(toClientView(op).verification).toEqual({ dispatchedAt: null });
      expect(out.journal.persistCalls).toBe(2);
    });

    it("can retry exact-run cancellation after a transient failure", async () => {
      const op = stoppedSetup();
      op.verification = { runId: "42" };
      setVerificationWorkflowState(op, "active");
      let cancellations = 0;
      const dependencies = {
        cancelVerificationWorkflow: () => {
          cancellations += 1;
          if (cancellations === 1) {
            return Promise.reject(new Error("GitHub temporarily unavailable"));
          }
          return Promise.resolve("inactive" as const);
        },
        inspectVerificationWorkflow: () => Promise.resolve("active" as const)
      };

      const failed = await drive(
        handleCancelWorkflow,
        op,
        "cancel-workflow",
        dependencies
      );
      expect(failed.recording.status).toBe(502);
      expect(verificationWorkflowState(op)).toBe("unknown");

      const checked = await drive(
        handleCancelWorkflow,
        op,
        "cancel-workflow",
        dependencies
      );
      expect(checked.payload().code).toBe("workflow-status-checked");
      expect(verificationWorkflowState(op)).toBe("active");

      const retried = await drive(
        handleCancelWorkflow,
        op,
        "cancel-workflow",
        dependencies
      );
      expect(retried.payload().code).toBe("workflow-cancelled");
      expect(cancellations).toBe(2);
      expect(
        op.control.commands
          .filter((command) => command.kind === "cancel_workflow")
          .map((command) => command.attempt)
      ).toEqual([0, 1]);
    });

    it("surfaces a failed status check while keeping cleanup blocked", async () => {
      const op = stoppedSetup();
      op.verification = { runId: "42" };
      setVerificationWorkflowState(op, "unknown");
      const out = await drive(handleCancelWorkflow, op, "cancel-workflow", {
        inspectVerificationWorkflow: () =>
          Promise.reject(new Error("GitHub unavailable"))
      });

      expect(out.recording.status).toBe(502);
      expect(out.payload()).toMatchObject({
        code: "workflow-status-read-failed",
        detail: "GitHub unavailable"
      });
      expect(verificationWorkflowState(op)).toBe("unknown");
    });

    it("checks status without repeating cancellation while GitHub is still settling", async () => {
      const op = stoppedSetup();
      op.verification = { runId: "42" };
      setVerificationWorkflowState(op, "cancelling");
      let cancellations = 0;
      const out = await drive(handleCancelWorkflow, op, "cancel-workflow", {
        inspectVerificationWorkflow: () => Promise.resolve("active"),
        cancelVerificationWorkflow: () => {
          cancellations += 1;
          return Promise.resolve("inactive");
        }
      });

      expect(out.recording.status).toBe(200);
      expect(out.payload().code).toBe("workflow-status-checked");
      expect(verificationWorkflowState(op)).toBe("active");
      expect(cancellations).toBe(0);
      expect(op.control.commands).toEqual([]);
    });

    it("keeps an observed status unknown when it cannot be saved", async () => {
      const op = stoppedSetup();
      op.verification = { runId: "42" };
      setVerificationWorkflowState(op, "unknown");
      const out = await drive(handleCancelWorkflow, op, "cancel-workflow", {
        inspectVerificationWorkflow: () => Promise.resolve("active"),
        persistOperations: () => Promise.reject(new Error("disk gone"))
      });

      expect(out.recording.status).toBe(500);
      expect(out.payload()).toMatchObject({
        code: "workflow-status-persist-failed",
        detail: "disk gone"
      });
      expect(verificationWorkflowState(op)).toBe("unknown");
    });

    it("does not contact GitHub when the cancellation intent cannot be saved", async () => {
      const op = stoppedSetup();
      op.verification = { runId: "42" };
      setVerificationWorkflowState(op, "active");
      let cancellations = 0;
      const out = await drive(handleCancelWorkflow, op, "cancel-workflow", {
        persistOperations: () => Promise.reject(new Error("disk gone")),
        cancelVerificationWorkflow: () => {
          cancellations += 1;
          return Promise.resolve("inactive");
        }
      });

      expect(out.recording.status).toBe(500);
      expect(out.payload()).toMatchObject({
        code: "workflow-cancel-persist-failed",
        detail: "disk gone"
      });
      expect(cancellations).toBe(0);
      expect(verificationWorkflowState(op)).toBe("active");
      expect(
        op.control.commands.filter(
          (command) => command.kind === "cancel_workflow"
        )
      ).toEqual([]);
    });

    it("reports when neither cancellation nor its unknown status can be saved", async () => {
      const op = stoppedSetup();
      op.verification = { runId: "42" };
      setVerificationWorkflowState(op, "active");
      let persists = 0;
      const out = await drive(handleCancelWorkflow, op, "cancel-workflow", {
        persistOperations: () => {
          persists += 1;
          return persists === 1 ?
              Promise.resolve()
            : Promise.reject(new Error("disk gone"));
        },
        cancelVerificationWorkflow: () =>
          Promise.reject(new Error("GitHub unavailable"))
      });

      expect(out.recording.status).toBe(502);
      expect(out.payload()).toMatchObject({
        code: "workflow-cancel-failed",
        detail:
          "GitHub unavailable Radius also could not save the workflow status: disk gone"
      });
      expect(verificationWorkflowState(op)).toBe("unknown");
    });

    it("refuses cancellation before setup is stopped", async () => {
      const op = newOperation();
      op.verification = { runId: "42" };
      const out = await drive(handleCancelWorkflow, op, "cancel-workflow");

      expect(out.recording.status).toBe(409);
      expect(out.payload().code).toBe("workflow-cancel-not-available");
      expect(out.journal.persistCalls).toBe(0);
    });
  });

  it("refuses to continue a setup whose ownership the ledger cannot prove", async () => {
    const op = stoppedSetup();
    recordGitHubEnvironment(op, {
      state: "created_candidate",
      repo: "contoso/store",
      name: "dev"
    });
    const out = await drive(handleContinueOperation, op, "continue");

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "setup-continue-ownership-ambiguous",
      detail: "A GitHub environment may exist without proven ownership."
    });
    expect(op.state).toBe("cancelled");
    expect(out.journal.scheduled).toEqual([]);
  });

  it("refuses to continue a running operation", async () => {
    const op = newOperation();
    const out = await drive(handleContinueOperation, op, "continue");

    expect(out.recording.status).toBe(409);
    expect(out.payload().code).toBe("operation-active");
    expect(out.journal.scheduled).toEqual([]);
  });
});

describe("POST /api/operations/{id}/rollback", () => {
  it("accepts a rollback for a stopped attempt and schedules it once", async () => {
    const op = stoppedSetup();
    const out = await drive(handleRollbackOperation, op, "rollback");

    expect(out.recording.status).toBe(202);
    const payload = out.payload();
    expect(payload.attempt).toBe(1);
    // The identity names the exact artifact set, so a repeat of the same
    // request is the same command and a different set is not.
    expect(payload.commandId).toMatch(
      new RegExp(`^${op.operationId}:rollback:1:cleanup#[0-9a-f]{16}$`)
    );
    expect(out.journal.persistCalls).toBe(1);
    expect(out.journal.scheduled).toEqual([
      { kind: "rollback", instanceId: "panel-a", commandId: payload.commandId }
    ]);
  });

  it("refuses a post-commit rollback the ledger cannot prove", async () => {
    const op = stoppedSetup();
    // No blob or content digest: the shape every record written before
    // provenance existed still has.
    recordCommittedWorkflowFile(op, {
      path: ".github/workflows/radius-deploy.yml",
      mode: "default_branch",
      branch: "main"
    });
    const out = await drive(handleRollbackOperation, op, "rollback");

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "rollback-provenance-incomplete",
      error:
        "Radius did not save enough about the workflow files it committed to prove they are unchanged, so it will not remove them or anything they depend on."
    });
    expect(out.journal.scheduled).toEqual([]);
  });

  it("accepts a post-commit rollback whose workflow provenance is complete", async () => {
    const op = stoppedSetup();
    recordCommittedWorkflowFile(op, {
      path: ".github/workflows/radius-deploy.yml",
      mode: "default_branch",
      branch: "main",
      commitSha: "c".repeat(40),
      blobSha: "b".repeat(40),
      contentSha256: "d".repeat(64),
      previousBlobSha: null,
      previousBlobKnown: true
    });
    const out = await drive(handleRollbackOperation, op, "rollback");

    expect(out.recording.status).toBe(202);
    expect(out.journal.scheduled).toEqual([
      {
        kind: "rollback",
        instanceId: "panel-a",
        commandId: out.payload().commandId
      }
    ]);
  });

  it("refuses a rollback for an environment whose verification succeeded", async () => {
    const op = newOperation();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    finishSucceeded(op);
    const out = await drive(handleRollbackOperation, op, "rollback");

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "rollback-environment-verified"
    });
    expect(out.journal.scheduled).toEqual([]);
  });

  it("refuses a rollback when the attempt created nothing it can prove it owns", async () => {
    const op = newOperation();
    recordGitHubEnvironment(op, {
      state: "created_candidate",
      repo: "contoso/store",
      name: "dev"
    });
    requestStop(op);
    stopAtBoundary(op, "after_environment");
    const out = await drive(handleRollbackOperation, op, "rollback");

    expect(out.recording.status).toBe(409);
    expect(out.payload().code).toBe("rollback-nothing-owned");
    expect(out.journal.scheduled).toEqual([]);
  });

  it("refuses a rollback while the operation is still running", async () => {
    const op = newOperation();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    const out = await drive(handleRollbackOperation, op, "rollback");

    expect(out.recording.status).toBe(409);
    expect(out.payload().code).toBe("operation-active");
    expect(out.journal.scheduled).toEqual([]);
  });

  it("still restores the decision when the follow-up write also fails", async () => {
    const op = stoppedSetup();
    let allowFirstWrite = true;
    const out = await drive(handleRollbackOperation, op, "rollback", {
      schedule: () => false,
      persistOperations: () => {
        if (allowFirstWrite) {
          allowFirstWrite = false;
          return Promise.resolve();
        }
        return Promise.reject(new Error("store offline"));
      }
    });

    // The durable write is best effort here: the in-memory record is already
    // back on the stopped decision, so polling reports the truth either way.
    expect(out.recording.status).toBe(503);
    expect(op.state).toBe("cancelled");
    expect(op.control.attempts.cleanup).toBe(0);
  });
});

describe("POST /api/operations/{id}/exit", () => {
  it("closes a setup that owns nothing without scheduling any deletion", async () => {
    const op = reusedOnlyFailure();
    const out = await drive(handleExitOperation, op, "exit");

    expect(out.recording.status).toBe(200);
    expect(out.payload()).toMatchObject({
      code: "setup-exited",
      removed: false,
      statusUrl: `/api/operations/${op.operationId}`
    });
    expect(out.journal.scheduled).toEqual([]);
    // Durable before the caller heard it was accepted, and recorded as a
    // finished command so a reload reads the same decision back.
    expect(out.journal.persistCalls).toBe(1);
    expect(op.control.commands).toEqual([
      expect.objectContaining({
        kind: "exit_setup",
        state: "finished",
        outcome: "exited"
      })
    ]);
    // The record keeps its own verdict: how the setup ended and whether the
    // customer left it are different facts.
    expect(op.state).toBe("failed_partial");
    expect(out.payload().operation.headline).toMatchObject({
      code: "setup-exited"
    });
    expect(out.payload().operation.actions).toEqual([]);
    expect(out.journal.invalidatedListings).toEqual(["contoso/store"]);
  });

  it("schedules the disposal when the ledger proves this attempt created something", async () => {
    const op = stoppedSetup();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "contoso/store",
      name: "dev"
    });

    const out = await drive(handleExitOperation, op, "exit");

    expect(out.recording.status).toBe(202);
    const payload = out.payload();
    expect(payload.commandId).toMatch(
      new RegExp(`^${op.operationId}:exit_setup:1:cleanup#[0-9a-f]{16}$`)
    );
    expect(out.journal.scheduled).toEqual([
      {
        kind: "exit_setup",
        instanceId: "panel-a",
        commandId: payload.commandId
      }
    ]);
    // The deletion is the runner's to report, so nothing is invalidated here:
    // the pass drops the listing when it proves the environment is gone.
    expect(out.journal.invalidatedListings).toEqual([]);
    expect(op.state).toBe("running");
  });

  it("abandons an active external workflow without scheduling deletion", async () => {
    const op = stoppedSetup();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "contoso/store",
      name: "dev"
    });
    op.verification = { runId: "42" };
    setVerificationWorkflowState(op, "active");

    const out = await drive(handleExitOperation, op, "exit?mode=abandon");

    expect(out.recording.status).toBe(200);
    expect(out.payload()).toMatchObject({
      code: "setup-exited",
      removed: false,
      operation: {
        headline: {
          code: "setup-exited",
          title: "Environment setup abandoned"
        },
        actions: []
      }
    });
    expect(out.journal.scheduled).toEqual([]);
    expect(op.control.commands).toEqual([
      expect.objectContaining({
        kind: EXIT_COMMAND_KIND,
        state: "finished",
        outcome: ABANDON_COMMAND_OUTCOME
      })
    ]);
  });

  it("rejects a stale abandonment request when ordinary cleanup is safe", async () => {
    const op = stoppedSetup();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "contoso/store",
      name: "dev"
    });
    setVerificationWorkflowState(op, "inactive");

    const out = await drive(handleExitOperation, op, "exit?mode=abandon");

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "operation-abandon-not-available"
    });
    expect(out.journal.scheduled).toEqual([]);
    expect(op.control.commands).toEqual([]);
  });

  it("requires an explicit abandonment request when cleanup becomes unsafe", async () => {
    const op = stoppedSetup();
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "contoso/store",
      name: "dev"
    });
    setVerificationWorkflowState(op, "active");

    const out = await drive(handleExitOperation, op, "exit");

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "operation-exit-requires-abandon"
    });
    expect(out.journal.scheduled).toEqual([]);
    expect(op.control.commands).toEqual([]);
  });

  it("refuses to exit an environment whose verification succeeded", async () => {
    const op = newOperation();
    recordAzureApp(op, { state: "created", appId: "app-1" });
    finishSucceeded(op);
    const out = await drive(handleExitOperation, op, "exit");

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "exit-environment-ready",
      error:
        "This environment finished setup, so there is nothing to exit. Remove it with Delete Environment instead."
    });
    expect(out.journal.scheduled).toEqual([]);
    expect(out.journal.invalidatedListings).toEqual([]);
  });

  it("refuses a second exit for a setup the customer already closed", async () => {
    const op = reusedOnlyFailure();
    const deps = dependencies({ get: () => op });
    await handleExitOperation(
      postContext(controlPath(op, "exit"), recorder().response),
      deps
    );

    const second = await call(
      handleExitOperation,
      controlPath(op, "exit"),
      deps
    );

    expect(second.recording.status).toBe(409);
    expect(second.payload()).toMatchObject({
      code: "setup-already-exited",
      error: "Radius already closed this setup."
    });
    expect(deps.journal.persistCalls).toBe(1);
    expect(deps.journal.invalidatedListings).toEqual(["contoso/store"]);
  });

  it("leaves the setup open and the listing cached when the close cannot be saved", async () => {
    const op = reusedOnlyFailure();
    const out = await drive(handleExitOperation, op, "exit", {
      persistOperations: () => Promise.reject(new Error("disk full"))
    });

    expect(out.recording.status).toBe(500);
    expect(out.payload()).toMatchObject({
      code: "operation-exit-persist-failed",
      error:
        "Radius could not save the request to exit setup, so the setup is still open. Try again.",
      detail: "disk full"
    });
    // Nothing was written, so nothing is remembered: the exit command is gone
    // and the panel still offers the way out.
    expect(op.control.commands).toEqual([]);
    expect(out.journal.invalidatedListings).toEqual([]);
  });
});

// The five routes carry different decisions but share one command executor, so
// the behavior that does not vary by route is asserted once over every route
// that reaches it rather than repeated in each suite. What each row states is
// the part that is genuinely per-route: the code, the message, and the record
// the customer is put back on.
describe("contracts shared by every control route", () => {
  const routes = [
    {
      name: "stop",
      path: (id: string) => `/api/operations/${id}/stop`,
      handler: handleStopOperation
    },
    {
      name: "continue",
      path: (id: string) => `/api/operations/${id}/continue`,
      handler: handleContinueOperation
    },
    {
      name: "rollback",
      path: (id: string) => `/api/operations/${id}/rollback`,
      handler: handleRollbackOperation
    },
    {
      name: "exit",
      path: (id: string) => `/api/operations/${id}/exit`,
      handler: handleExitOperation
    },
    {
      name: "retry",
      path: (id: string) => `/api/operations/${id}/retry/setup`,
      handler: handleRetryOperation
    }
  ] as const;

  it.each(routes)(
    "answers 404 for an unknown operation on $name",
    async ({ path, handler }) => {
      const deps = dependencies({ get: () => null });
      const out = recorder();

      await handler(postContext(path("op_missing"), out.response), deps);

      expect(out.recording.status).toBe(404);
      expect(out.payload()).toEqual({
        error: "Unknown operation.",
        code: "unknown-operation"
      });
      expect(deps.journal.persistCalls).toBe(0);
    }
  );

  it.each(routes)(
    "refuses a delete operation on $name without mutating it",
    async ({ path, handler }) => {
      // A deletion is not a setup, so none of the setup controls apply. The
      // route must refuse it outright — never record a stop, schedule a
      // command, or persist — so the delete runner's fixed teardown is the only
      // thing that ever acts on the record.
      const deleteOp = createOperation({
        provider: "azure",
        repo: FIXTURE_REPO,
        environment: "dev",
        kind: OPERATION_KIND_DELETE,
        stages: buildDeleteStages()
      }) as OperationFixture;
      const deps = dependencies({ get: () => deleteOp });
      const out = await call(handler, path(deleteOp.operationId), deps);

      expect(out.recording.status).toBe(409);
      expect(out.payload()).toMatchObject({
        code: "operation-not-setup-controllable"
      });
      expect(deps.journal.persistCalls).toBe(0);
      expect(deps.journal.scheduled).toEqual([]);
      expect(deleteOp.control.stop.requestedAt).toBeFalsy();
      expect(deleteOp.state).not.toBe("cancelled");
    }
  );

  const commandRoutes = [
    {
      name: "continue",
      path: (id: string) => `/api/operations/${id}/continue`,
      handler: handleContinueOperation,
      operation: () => stoppedSetup(),
      restoredState: "cancelled",
      attemptKind: "setup",
      restoredAttempt: 1,
      persistFailureCode: "operation-continue-persist-failed",
      persistFailureError:
        "Radius could not save the request to continue setup, so no work was started. Try again."
    },
    {
      name: "rollback",
      path: (id: string) => `/api/operations/${id}/rollback`,
      handler: handleRollbackOperation,
      operation: () => stoppedSetup(),
      restoredState: "cancelled",
      attemptKind: "cleanup",
      restoredAttempt: 0,
      persistFailureCode: "operation-rollback-persist-failed",
      persistFailureError:
        "Radius could not save the rollback request, so no cleanup began. Try again."
    },
    {
      name: "exit",
      path: (id: string) => `/api/operations/${id}/exit`,
      handler: handleExitOperation,
      operation: () => stoppedSetup(),
      restoredState: "cancelled",
      attemptKind: "cleanup",
      restoredAttempt: 0,
      persistFailureCode: "operation-exit-persist-failed",
      persistFailureError:
        "Radius could not save the request to exit setup, so nothing was removed and the setup is still open. Try again."
    },
    {
      name: "retry/setup",
      path: (id: string) => `/api/operations/${id}/retry/setup`,
      handler: handleRetryOperation,
      operation: retryableSetup,
      restoredState: "failed_partial",
      attemptKind: "setup",
      restoredAttempt: 1,
      persistFailureCode: "operation-retry-persist-failed",
      persistFailureError:
        "Radius could not save the retry request, so no work was started. Try again."
    },
    {
      name: "retry/deletion",
      path: (id: string) => `/api/operations/${id}/retry/deletion`,
      handler: handleRetryOperation,
      operation: retryableDeletion,
      restoredState: "failed_partial",
      attemptKind: "deletion",
      restoredAttempt: 0,
      persistFailureCode: "operation-retry-persist-failed",
      persistFailureError:
        "Radius could not save the retry request, so no work was started. Try again."
    }
  ] as const;

  it.each(commandRoutes)(
    "puts the record back and starts nothing when $name cannot be saved",
    async (route) => {
      const op = route.operation();
      const deps = dependencies({
        get: () => op,
        persistOperations: () => Promise.reject(new Error("disk gone"))
      });
      const out = await call(route.handler, route.path(op.operationId), deps);

      expect(out.recording.status).toBe(500);
      expect(out.payload()).toMatchObject({
        code: route.persistFailureCode,
        error: route.persistFailureError,
        detail: "disk gone"
      });
      expect(op.state).toBe(route.restoredState);
      expect(op.control.attempts[route.attemptKind]).toBe(
        route.restoredAttempt
      );
      expect(op.control.commands).toEqual([]);
      expect(deps.journal.scheduled).toEqual([]);
    }
  );

  it.each(commandRoutes)(
    "refuses $name while another operation owns the repository",
    async (route) => {
      const op = route.operation();
      const deps = dependencies({
        get: () => op,
        acquireForRetry: () => ({
          ok: false,
          conflict: { operationId: "op_live" }
        })
      });
      const out = await call(route.handler, route.path(op.operationId), deps);

      expect(out.recording.status).toBe(409);
      expect(out.payload()).toEqual({
        error:
          route.name === "retry/deletion" ?
            "Another environment operation is already running for contoso/store."
          : "Another setup is already running for contoso/store.",
        code: "operation-in-progress",
        operationId: "op_live"
      });
      expect(op.state).toBe(route.restoredState);
      expect(deps.journal.scheduled).toEqual([]);
    }
  );

  // The two first-choice commands answer a repeated submission with the command
  // already in flight, so a double click never continues or deletes twice.
  const firstChoiceRoutes = commandRoutes.filter(
    (route) => route.name !== "retry/setup" && route.name !== "retry/deletion"
  );

  it.each(firstChoiceRoutes)(
    "resolves a repeated $name to the command already in flight",
    async (route) => {
      const op = route.operation();
      const deps = dependencies({ get: () => op });

      const first = recorder();
      await route.handler(
        postContext(route.path(op.operationId), first.response),
        deps
      );
      const second = recorder();
      await route.handler(
        postContext(route.path(op.operationId), second.response),
        deps
      );

      expect(second.recording.status).toBe(202);
      expect(second.payload()).toMatchObject({
        duplicate: true,
        commandId: first.payload().commandId
      });
      expect(deps.journal.scheduled).toHaveLength(1);
    }
  );

  it.each(firstChoiceRoutes)(
    "restores the stopped decision when no runner accepts $name",
    async (route) => {
      const op = route.operation();
      const deps = dependencies({ get: () => op, schedule: () => false });
      const out = await call(route.handler, route.path(op.operationId), deps);

      // Nothing ran, so the customer is put back on the same decision rather
      // than shown a failure that never happened, and no command is left behind
      // to absorb their next click.
      expect(out.recording.status).toBe(503);
      expect(out.payload()).toMatchObject({
        code: "operation-command-unscheduled"
      });
      expect(op.state).toBe("cancelled");
      expect(op.control.attempts[route.attemptKind]).toBe(
        route.restoredAttempt
      );
      expect(op.control.commands).toEqual([]);
      expect(
        out.payload().operation.actions.map((entry: { id: string }) => entry.id)
      ).toEqual(["continue-setup", "rollback", "exit-setup"]);
    }
  );
});
