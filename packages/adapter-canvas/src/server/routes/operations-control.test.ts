import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createOperationsControlRoutes,
  handleRetryOperation,
  handleStopOperation,
  retryRefusalMessage,
  RETRY_OPERATION_ROUTE,
  STOP_OPERATION_ROUTE,
  type OperationsControlDependencies
} from "./operations-control.js";
import { routeKey } from "../route-table.js";
import {
  acceptCommand,
  applySetupResumePoint,
  applyStopRequest,
  announceOperationTerminal,
  beginRetryAttempt,
  buildStages,
  canRetryCleanup,
  canRetrySetup,
  canRetryVerification,
  createOperation,
  enterStage,
  finish,
  onOperationTerminal,
  recordAzureApp,
  recordCleanupState,
  recordCommitState,
  recordCommittedWorkflowFile,
  recordGitHubEnvironment,
  recordServicePrincipal,
  requireInput,
  rollbackRetryAttempt,
  setCommandState,
  setStageState,
  snapshotRetryState,
  toClientView,
  STAGE_VERIFY,
  type OperationControlRecord
} from "../../operations.js";
import type { OperationRecord } from "./operations-status.js";
import type { CanvasServerEntry } from "../types.js";

// `OperationRecord` stays a broad pass-through type (see operations-status.ts),
// but this suite reads `control`, `journey`, and `failure` back off records it
// created itself with the real `createOperation`/`finish` functions, so those
// fields are genuinely present at runtime. Widening the type here — rather than
// reaching for `as any`/`as unknown as` at each call site — keeps the access
// typed without loosening the shared route contract.
type OperationFixture = OperationRecord & {
  control: OperationControlRecord;
  journey: { notifiedAt: string | null; [key: string]: unknown };
  failure: { code: string | null; [key: string]: unknown } | null;
};

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

interface Journal {
  scheduled: Array<{ kind: string; instanceId: string; commandId?: string }>;
  persistCalls: number;
}

// Real model functions wherever they are pure state transitions — faking
// `applyStopRequest` or `canRetrySetup` would only let this suite drift from the
// eligibility rules it exists to protect. The doubles are the three seams a test
// must control: the registry lookup, the durable write, and the schedulers.
function dependencies(
  overrides: Partial<OperationsControlDependencies> = {}
): OperationsControlDependencies & { journal: Journal } {
  const journal: Journal = { scheduled: [], persistCalls: 0 };
  const base: OperationsControlDependencies = {
    get: () => {
      throw new Error("get not stubbed");
    },
    acquireForRetry: () => ({ ok: true }),
    persistOperations: () => {
      journal.persistCalls += 1;
      return Promise.resolve();
    },
    toClientView,
    applyStopRequest,
    announceOperationTerminal,
    snapshotRetryState,
    rollbackRetryAttempt,
    beginRetryAttempt,
    acceptCommand,
    setCommandState,
    canRetrySetup,
    canRetryVerification,
    canRetryCleanup,
    applySetupResumePoint,
    setStageState,
    enterStage,
    finish,
    stageVerify: STAGE_VERIFY,
    isPullRequestMerged: () => {
      throw new Error("isPullRequestMerged not stubbed");
    },
    scheduleSetupContinuation: (instanceId) => {
      journal.scheduled.push({ kind: "setup", instanceId });
      return true;
    },
    scheduleVerificationRetry: (instanceId, _operation, commandId) => {
      journal.scheduled.push({ kind: "verification", instanceId, commandId });
      return true;
    },
    scheduleCleanupRetry: (instanceId, _operation, commandId) => {
      journal.scheduled.push({ kind: "cleanup", instanceId, commandId });
      return true;
    },
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  };
  return Object.assign(base, overrides, { journal });
}

function newOperation(repo = "contoso/store"): OperationFixture {
  return createOperation({
    provider: "azure",
    repo,
    environment: "dev",
    stages: buildStages({ includeIdentity: true })
  }) as OperationFixture;
}

function retryableSetup(repo = "contoso/store"): OperationFixture {
  const op = newOperation(repo);
  op.resumeRequest = {
    needsAzureCredentials: true,
    azure: {},
    environment: { repo, environment: "dev", provider: "azure" }
  };
  recordAzureApp(op, {
    state: "created",
    appId: "app-1",
    displayName: "radius-app"
  });
  finish(op, "failed_partial", {
    failure: { code: "operation-stalled", message: "lost contact" }
  });
  return op;
}

function mergeHandoff(repo = "contoso/store"): OperationRecord {
  const op = newOperation(repo);
  recordAzureApp(op, { state: "created", appId: "app-1" });
  recordServicePrincipal(op, { state: "created", appId: "app-1" });
  recordCommittedWorkflowFile(op, {
    path: ".github/workflows/radius-verify-credentials.yml",
    mode: "pull_request",
    branch: "radius-setup"
  });
  recordCommitState(op, {
    mode: "pull_request",
    branch: "radius-setup",
    baseBranch: "main",
    pullRequestUrl: "https://github.com/contoso/store/pull/7"
  });
  enterStage(op, STAGE_VERIFY);
  op.verification = {
    dispatchedAt: Date.now(),
    workflow: "radius-verify-credentials.yml",
    ref: "main",
    environment: "dev",
    runId: null,
    runUrl: null
  };
  finish(op, "action_required", {
    terminal: {
      reason: "pr-merge-required",
      pullRequestUrl: "https://github.com/contoso/store/pull/7"
    }
  });
  return op;
}

describe("the route registry", () => {
  it("claims exactly the two declared control routes", () => {
    const registry = createOperationsControlRoutes(dependencies());
    expect(Object.keys(registry).sort()).toEqual(
      [
        routeKey({ method: "POST", path: STOP_OPERATION_ROUTE }),
        routeKey({ method: "POST", path: RETRY_OPERATION_ROUTE })
      ].sort()
    );
  });

  it("dispatches each declared key to its own handler", async () => {
    const op = newOperation();
    const deps = dependencies({ get: () => op });
    const registry = createOperationsControlRoutes(deps);
    const stop = recorder();
    await registry[`POST ${STOP_OPERATION_ROUTE}`](
      postContext(`/api/operations/${op.operationId}/stop`, stop.response)
    );
    expect(stop.payload().code).toBe("operation-stop-pending");

    const retry = recorder();
    await registry[`POST ${RETRY_OPERATION_ROUTE}`](
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        retry.response
      )
    );
    // The same record is now running, so a setup retry has nothing to continue.
    expect(retry.payload().code).toBe("operation-active");
  });
});

describe("POST /api/operations/{id}/stop", () => {
  it("records a stop for a running operation and reports it as pending", async () => {
    const op = newOperation();
    const deps = dependencies({ get: () => op });
    const out = recorder();

    await handleStopOperation(
      postContext(`/api/operations/${op.operationId}/stop`, out.response),
      deps
    );

    expect(out.recording.status).toBe(202);
    expect(out.recording.headers["Cache-Control"]).toBe("no-store");
    const payload = out.payload();
    expect(payload.code).toBe("operation-stop-pending");
    expect(payload.statusUrl).toBe(`/api/operations/${op.operationId}`);
    expect(payload.operation.state).toBe("running");
    expect(payload.operation.stop.requested).toBe(true);
    expect(payload.operation.nextTransition.code).toBe("stopping");
    // Durable before the caller hears it was accepted.
    expect(deps.journal.persistCalls).toBe(1);
    expect(op.control.stop.requestedAt).toBeTruthy();
  });

  it("cancels at once while the operation is parked on a prompt", async () => {
    watchAnnouncements();
    const op = newOperation();
    requireInput(op, {
      code: "app-selection-required",
      message: "Choose an identity."
    });
    const deps = dependencies({ get: () => op });
    const out = recorder();

    await handleStopOperation(
      postContext(`/api/operations/${op.operationId}/stop`, out.response),
      deps
    );

    expect(out.recording.status).toBe(200);
    const payload = out.payload();
    expect(payload.code).toBe("operation-stopped");
    expect(payload.operation.terminalState).toBe("cancelled");
    expect(payload.operation.stop.boundary).toBe("input_prompt");
    // Announced only after the write landed.
    expect(announced).toEqual([op.operationId]);
    expect(op.journey.notifiedAt).toBeTruthy();
  });

  it("returns the saved result when the same stop arrives twice", async () => {
    const op = newOperation();
    requireInput(op, { code: "app-selection-required", message: "Choose." });
    const deps = dependencies({ get: () => op });

    const first = recorder();
    await handleStopOperation(
      postContext(`/api/operations/${op.operationId}/stop`, first.response),
      deps
    );
    const second = recorder();
    await handleStopOperation(
      postContext(`/api/operations/${op.operationId}/stop`, second.response),
      deps
    );

    expect(second.recording.status).toBe(200);
    expect(second.payload().code).toBe("operation-stopped");
    // The repeat writes nothing: the cancellation is already durable.
    expect(deps.journal.persistCalls).toBe(1);
  });

  it("refuses to stop an operation that already finished", async () => {
    const op = newOperation();
    finish(op, "succeeded");
    const deps = dependencies({ get: () => op });
    const out = recorder();

    await handleStopOperation(
      postContext(`/api/operations/${op.operationId}/stop`, out.response),
      deps
    );

    expect(out.recording.status).toBe(409);
    expect(out.payload().code).toBe("operation-already-terminal");
    expect(deps.journal.persistCalls).toBe(0);
  });

  it("puts the record back and reports the failure when the stop cannot be saved", async () => {
    watchAnnouncements();
    const op = newOperation();
    requireInput(op, { code: "app-selection-required", message: "Choose." });
    const deps = dependencies({
      get: () => op,
      persistOperations: () => Promise.reject(new Error("disk gone"))
    });
    const out = recorder();

    await handleStopOperation(
      postContext(`/api/operations/${op.operationId}/stop`, out.response),
      deps
    );

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

  it("answers 404 for an operation it does not know", async () => {
    const deps = dependencies({ get: () => null });
    const out = recorder();

    await handleStopOperation(
      postContext("/api/operations/op_missing/stop", out.response),
      deps
    );

    expect(out.recording.status).toBe(404);
    expect(out.payload()).toEqual({
      error: "Unknown operation.",
      code: "unknown-operation"
    });
  });

  it("answers 404 rather than throwing on an undecodable operation id", async () => {
    const deps = dependencies({
      get: () => {
        throw new Error("lookup must not run for an undecodable id");
      }
    });
    const out = recorder();

    await handleStopOperation(
      postContext("/api/operations/%/stop", out.response),
      deps
    );

    expect(out.recording.status).toBe(404);
    expect(out.payload().code).toBe("unknown-operation");
  });

  it("answers 404 rather than guessing when the path is not this route's shape", async () => {
    const deps = dependencies({
      get: () => {
        throw new Error("lookup must not run for a path outside the template");
      }
    });
    const out = recorder();

    await handleStopOperation(
      postContext("/api/operations/op-1/stop/now", out.response),
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
    const out = recorder();

    await handleStopOperation(
      postContext(
        `/api/operations/${encodeURIComponent("octo/app:setup")}/stop`,
        out.response
      ),
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
    const deps = dependencies({ get: () => op });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        out.response
      ),
      deps
    );

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
    expect(deps.journal.scheduled).toEqual([
      { kind: "setup", instanceId: "panel-a" }
    ]);
    // Saved before any work was scheduled.
    expect(deps.journal.persistCalls).toBe(1);
  });

  it("refuses a setup retry whose ownership the ledger cannot prove", async () => {
    const op = retryableSetup();
    recordGitHubEnvironment(op, {
      state: "created_candidate",
      repo: "contoso/store",
      name: "dev"
    });
    const deps = dependencies({ get: () => op });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(409);
    const payload = out.payload();
    expect(payload.code).toBe("setup-retry-ownership-ambiguous");
    expect(payload.error).toContain("duplicate a resource");
    expect(payload.detail).toContain("without proven ownership");
    // Refusing never reopens the record or schedules work.
    expect(op.state).toBe("failed_partial");
    expect(deps.journal.scheduled).toEqual([]);
  });

  it("refuses verification retry while the setup pull request is still open", async () => {
    const op = mergeHandoff();
    const asked: Array<string | null> = [];
    const deps = dependencies({
      get: () => op,
      isPullRequestMerged: (_operation, pullRequestUrl) => {
        asked.push(pullRequestUrl);
        return Promise.resolve(false);
      }
    });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/verification`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "verification-retry-pull-request-open",
      pullRequestUrl: "https://github.com/contoso/store/pull/7"
    });
    expect(asked).toEqual(["https://github.com/contoso/store/pull/7"]);
    expect(op.state).toBe("action_required");
    expect(deps.journal.scheduled).toEqual([]);
  });

  it("repeats verification once the setup pull request has merged", async () => {
    const op = mergeHandoff();
    const deps = dependencies({
      get: () => op,
      isPullRequestMerged: () => Promise.resolve(true)
    });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/verification`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(202);
    const payload = out.payload();
    expect(payload.commandId).toBe(
      `${op.operationId}:retry_verification:1:verification`
    );
    expect(payload.operation.currentStage).toBe(STAGE_VERIFY);
    // The action_required verdict is kept as history.
    expect(payload.operation.outcomes).toEqual([
      expect.objectContaining({
        kind: "verification",
        state: "action_required",
        code: "pr-merge-required"
      })
    ]);
    expect(deps.journal.scheduled).toEqual([
      {
        kind: "verification",
        instanceId: "panel-a",
        commandId: payload.commandId
      }
    ]);
  });

  it("refuses when the record changed while the pull request was checked", async () => {
    const op = mergeHandoff();
    const deps = dependencies({
      get: () => op,
      isPullRequestMerged: () => {
        // A concurrent retry reopened the record while GitHub was answering.
        beginRetryAttempt(op, "verification");
        return Promise.resolve(true);
      }
    });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/verification`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(409);
    expect(out.payload().code).toBe("operation-active");
    expect(deps.journal.scheduled).toEqual([]);
  });

  it("fails closed when the eligibility result names no pull request", async () => {
    const op = mergeHandoff();
    const deps = dependencies({
      get: () => op,
      // A retryable verdict that carries no pull request cannot be checked, so
      // the retry must refuse rather than proceed on an unverifiable claim.
      canRetryVerification: () => ({
        ok: true,
        code: "verification-retry-allowed",
        requiresMergedPullRequest: true
      }),
      isPullRequestMerged: (_operation, pullRequestUrl) => {
        expect(pullRequestUrl).toBeNull();
        return Promise.resolve(false);
      }
    });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/verification`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toMatchObject({
      code: "verification-retry-pull-request-open",
      pullRequestUrl: null
    });
  });

  it("names no repository rather than the word undefined in a lock conflict", async () => {
    const op = retryableSetup();
    delete op.repo;
    const deps = dependencies({
      get: () => op,
      acquireForRetry: () => ({
        ok: false,
        conflict: { operationId: "op_live" }
      })
    });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(409);
    expect(out.payload().error).toBe("Another setup is already running for .");
    expect(out.recording.body).not.toContain("undefined");
  });

  it("reports a refused command registration without inventing an id", async () => {
    const op = retryableSetup();
    const deps = dependencies({
      get: () => op,
      acceptCommand: () => ({ ok: false, duplicate: false, command: null })
    });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(202);
    expect(out.payload()).toMatchObject({ duplicate: true, commandId: null });
    // Nothing was reopened and nothing was scheduled.
    expect(op.state).toBe("failed_partial");
    expect(deps.journal.scheduled).toEqual([]);
  });

  it("refuses a verification retry for a failure it cannot classify", async () => {
    const op = newOperation();
    finish(op, "failed_partial", {
      failure: { code: "who-knows", message: "unclassified" }
    });
    const deps = dependencies({ get: () => op });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/verification`,
        out.response
      ),
      deps
    );

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
    const deps = dependencies({ get: () => op });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/cleanup`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(202);
    const payload = out.payload();
    expect(payload.commandId).toBe(`${op.operationId}:retry_cleanup:1:cleanup`);
    expect(deps.journal.scheduled).toEqual([
      { kind: "cleanup", instanceId: "panel-a", commandId: payload.commandId }
    ]);
  });

  it("refuses a retry while another operation owns the repository", async () => {
    const op = retryableSetup();
    const deps = dependencies({
      get: () => op,
      acquireForRetry: () => ({
        ok: false,
        conflict: { operationId: "op_live" }
      })
    });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(409);
    expect(out.payload()).toEqual({
      error: "Another setup is already running for contoso/store.",
      code: "operation-in-progress",
      operationId: "op_live"
    });
    expect(op.state).toBe("failed_partial");
    expect(deps.journal.scheduled).toEqual([]);
  });

  it("resolves a repeated submission to the command already in flight", async () => {
    const op = retryableSetup();
    const deps = dependencies({ get: () => op });

    const first = recorder();
    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        first.response
      ),
      deps
    );
    // The second submission arrives before the first attempt finished, so the
    // attempt counter has already advanced and the derived id is the same.
    finish(op, "failed_partial", { failure: { code: "operation-stalled" } });
    op.control.attempts.setup = 1;
    const second = recorder();
    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        second.response
      ),
      deps
    );

    expect(second.recording.status).toBe(202);
    expect(second.payload()).toMatchObject({
      duplicate: true,
      commandId: `${op.operationId}:retry_setup:2:setup`
    });
    // The duplicate never reopens the record a second time or schedules again.
    expect(op.state).toBe("failed_partial");
    expect(deps.journal.scheduled).toHaveLength(1);
  });

  it("puts the record back when the retry cannot be saved", async () => {
    const op = retryableSetup();
    const deps = dependencies({
      get: () => op,
      persistOperations: () => Promise.reject(new Error("disk gone"))
    });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(500);
    expect(out.payload()).toMatchObject({
      code: "operation-retry-persist-failed",
      detail: "disk gone"
    });
    expect(op.state).toBe("failed_partial");
    expect(op.control.attempts.setup).toBe(1);
    expect(op.control.commands).toEqual([]);
    expect(deps.journal.scheduled).toEqual([]);
  });

  it("closes a reopened operation no runner accepted", async () => {
    const op = retryableSetup();
    const persists: string[] = [];
    const deps = dependencies({
      get: () => op,
      persistOperations: () => {
        persists.push("persist");
        return Promise.resolve();
      },
      scheduleSetupContinuation: () => false
    });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        out.response
      ),
      deps
    );

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
    const deps = dependencies({
      get: () => op,
      persistOperations: () => {
        calls += 1;
        return calls === 1 ?
            Promise.resolve()
          : Promise.reject(new Error("disk gone"));
      },
      scheduleSetupContinuation: () => false
    });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/setup`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(202);
    expect(op.state).toBe("failed");
    expect(calls).toBe(2);
  });

  it("answers 404 for a retry against an unknown operation", async () => {
    const deps = dependencies({ get: () => null });
    const out = recorder();

    await handleRetryOperation(
      postContext("/api/operations/op_missing/retry/setup", out.response),
      deps
    );

    expect(out.recording.status).toBe(404);
    expect(out.payload().code).toBe("unknown-operation");
  });

  it("refuses a retry kind it does not implement", async () => {
    const op = retryableSetup();
    const deps = dependencies({ get: () => op });
    const out = recorder();

    await handleRetryOperation(
      postContext(
        `/api/operations/${op.operationId}/retry/everything`,
        out.response
      ),
      deps
    );

    expect(out.recording.status).toBe(400);
    expect(out.payload()).toMatchObject({ code: "unsupported-retry" });
    expect(op.state).toBe("failed_partial");
  });

  it("refuses an undecodable retry kind rather than throwing", async () => {
    const op = retryableSetup();
    const deps = dependencies({ get: () => op });
    const out = recorder();

    await handleRetryOperation(
      postContext(`/api/operations/${op.operationId}/retry/%`, out.response),
      deps
    );

    expect(out.recording.status).toBe(400);
    expect(out.payload().code).toBe("unsupported-retry");
  });
});

describe("retryRefusalMessage", () => {
  it("explains every closed refusal code in the customer's terms", () => {
    expect(retryRefusalMessage("cleanup", "cleanup-retry-after-commit")).toBe(
      "The workflows were already committed, so these resources are retained on purpose rather than removed."
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
