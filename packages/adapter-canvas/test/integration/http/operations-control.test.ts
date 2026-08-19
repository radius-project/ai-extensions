import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { validateBrowserMutationRequest } from "../../../src/server/browser-mutation.js";
import { createOperationsControlRoutes } from "../../../src/server/routes/operations-control.js";
import { createOperationsStatusRoutes } from "../../../src/server/routes/operations-status.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import {
  buildStages,
  createOperation,
  enterStage,
  finish,
  isTerminalState,
  recordAzureApp,
  recordCommitState,
  recordCommittedWorkflowFile,
  recordGitHubEnvironment,
  recordServicePrincipal,
  requestStop,
  stopAtBoundary,
  toClientView,
  INPUT_REQUIRED_STATE,
  STAGE_VERIFY
} from "../../../src/operations.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type {
  OperationActionRecord,
  OperationRecord
} from "../../../src/server/routes/operations-status.js";

// Cooperative controls over a real loopback socket. Every external seam is an
// in-memory double — including the pull-request merge proof, so this suite never
// reaches GitHub — while the eligibility rules, command identity, and retry
// snapshot are the real production functions.

let container: CanvasServerContainer | undefined;

const BROWSER_NONCE = "browser-nonce";

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

interface Harness {
  records: Map<string, OperationRecord>;
  lock: { conflict: { operationId: string } | null };
  merged: { value: boolean };
  persistError: { value: Error | null };
  persistCalls: string[];
  scheduled: Array<{ kind: string; instanceId: string; commandId: string }>;
  schedulerAccepts: { value: boolean };
}

function start(): Harness {
  const records = new Map<string, OperationRecord>();
  const lock: Harness["lock"] = { conflict: null };
  const merged = { value: false };
  const persistError: { value: Error | null } = { value: null };
  const persistCalls: string[] = [];
  const scheduled: Harness["scheduled"] = [];
  const schedulerAccepts = { value: true };

  const persistOperations = () => {
    persistCalls.push("persist");
    return persistError.value ?
        Promise.reject(persistError.value)
      : Promise.resolve();
  };

  const routes = createTestRouteTable({
    ...createOperationsControlRoutes({
      get: (operationId) => records.get(operationId) ?? null,
      acquireForRetry: () =>
        lock.conflict ? { ok: false, conflict: lock.conflict } : { ok: true },
      persistOperations,
      isPullRequestMerged: () => Promise.resolve(merged.value),
      schedule: ({ kind, instanceId, commandId }) => {
        if (!schedulerAccepts.value) return false;
        scheduled.push({ kind, instanceId, commandId });
        return true;
      }
    }),
    // The by-id read is composed too: a client that just issued a command polls
    // this route next, so the two must agree over the same socket.
    ...createOperationsStatusRoutes(
      {
        latest: () => null,
        latestAny: () => null,
        get: (operationId) => records.get(operationId) ?? null,
        toClientView
      },
      {
        isValidRepoSlug: () => false,
        isResourceGroupName: () => false,
        isAksClusterName: () => false,
        isUuid: () => false,
        buildStages: () => [],
        createOperation: () => ({ operationId: "", currentStage: null }),
        // The create arm is never exercised here — this suite drives the control
        // routes and the by-id read — so the account-selection claim is a stub
        // that refuses rather than a working handle store.
        claimSelectionHandle: () => ({ ok: false, error: "missing" }),
        startOperation: () => ({
          ok: true,
          operation: { operationId: "", currentStage: null }
        }),
        persistOperations,
        finish,
        scheduleEnvironmentOperation: () => true,
        errorMessage: (error) => String(error)
      },
      // The resume and abandon actions round out the family. They are declared
      // next to the controls and must keep answering for themselves, so they get
      // real handlers here rather than the throwing stub.
      {
        // The seeded fixtures are real records; the action port declares a
        // narrower request shape than the control port, so the read is asserted
        // rather than widening the fixture type for one dependency.
        getOperation: (operationId) =>
          (records.get(operationId) ?? null) as OperationActionRecord | null,
        canResumeInput: () => false,
        resumeAfterInput: () => {},
        requireInput: () => {},
        finish,
        isTerminalState,
        persistOperations,
        toClientView,
        scheduleEnvironmentOperation: () => true,
        errorMessage: (error) => String(error),
        inputRequiredState: INPUT_REQUIRED_STATE
      }
    )
  });

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        validateBrowserMutation: (context) =>
          validateBrowserMutationRequest({
            request: context.request,
            baseUrl: `http://${context.request.headers.host || ""}`,
            nonce: BROWSER_NONCE
          }),
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => ({}),
    defaultPage: "graph",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return {
    records,
    lock,
    merged,
    persistError,
    persistCalls,
    scheduled,
    schedulerAccepts
  };
}

function seed(harness: Harness, repo = "contoso/store"): OperationRecord {
  const op = createOperation({
    provider: "azure",
    repo,
    environment: "dev",
    stages: buildStages({ includeIdentity: true })
  }) as OperationRecord;
  harness.records.set(op.operationId, op);
  return op;
}

function retryableSetup(harness: Harness): OperationRecord {
  const op = seed(harness);
  op.resumeRequest = {
    needsAzureCredentials: true,
    azure: {},
    environment: {
      repo: "contoso/store",
      environment: "dev",
      provider: "azure"
    }
  };
  recordAzureApp(op, { state: "created", appId: "app-1" });
  finish(op, "failed_partial", { failure: { code: "operation-stalled" } });
  return op;
}

function mergeHandoff(harness: Harness): OperationRecord {
  const op = seed(harness);
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

// A setup the customer deliberately stopped, with resources this attempt
// created and can prove it owns.
function stoppedSetup(harness: Harness): OperationRecord {
  const op = seed(harness);
  op.resumeRequest = {
    needsAzureCredentials: true,
    azure: {},
    environment: {
      repo: "contoso/store",
      environment: "dev",
      provider: "azure"
    }
  };
  recordAzureApp(op, {
    state: "created",
    appId: "app-1",
    displayName: "radius-deploy"
  });
  recordServicePrincipal(op, {
    state: "created",
    appId: "app-1",
    objectId: "sp-1"
  });
  recordGitHubEnvironment(op, {
    state: "created",
    repo: "contoso/store",
    name: "dev"
  });
  requestStop(op);
  stopAtBoundary(op, "after_environment");
  return op;
}

function post(
  baseUrl: string,
  path: string,
  headers: Readonly<Record<string, string>> = browserHeaders(baseUrl)
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}"
  });
}

// The controls are declared `nonce-required`, so a real browser request carries
// the same-origin proof and the instance nonce. Sending them here keeps the
// suite on the production path rather than around it.
function browserHeaders(baseUrl: string): Readonly<Record<string, string>> {
  return {
    Origin: new URL(baseUrl).origin,
    "Sec-Fetch-Site": "same-origin",
    "X-Radius-Mutation-Nonce": BROWSER_NONCE
  };
}

describe("operation controls real-loopback HIT", () => {
  it("accepts a stop over the socket and shows it on the status route", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness);

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/stop`
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      code: string;
      statusUrl: string;
      operation: { stop: { requested: boolean } };
    };
    expect(body.code).toBe("operation-stop-pending");
    expect(body.operation.stop.requested).toBe(true);
    expect(harness.persistCalls).toEqual(["persist"]);

    // The status URL the response hands back reports the same pending stop.
    const polled = await fetch(`${entry.baseUrl}${body.statusUrl}`);
    expect(polled.status).toBe(200);
    const polledBody = (await polled.json()) as {
      operation: {
        stop: { requested: boolean };
        nextTransition: { code: string };
      };
    };
    expect(polledBody.operation.stop.requested).toBe(true);
    expect(polledBody.operation.nextTransition.code).toBe("stopping");
  });

  it("continues an interrupted setup and schedules it on the receiving instance", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-b");
    const op = retryableSetup(harness);

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/retry/setup`
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      attempt: number;
      commandId: string;
      operation: { state: string };
    };
    expect(body.attempt).toBe(2);
    expect(body.commandId).toBe(`${op.operationId}:retry_setup:2:setup`);
    expect(body.operation.state).toBe("running");
    expect(harness.scheduled).toEqual([
      {
        kind: "setup_continuation",
        instanceId: "panel-b",
        commandId: body.commandId
      }
    ]);
  });

  it("repeats verification once the pull request has merged", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = mergeHandoff(harness);
    harness.merged.value = true;

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/retry/verification`
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      commandId: string;
      operation: { currentStage: string };
    };
    expect(body.commandId).toBe(
      `${op.operationId}:retry_verification:1:verification`
    );
    expect(body.operation.currentStage).toBe(STAGE_VERIFY);
    expect(harness.scheduled).toEqual([
      {
        kind: "verification_retry",
        instanceId: "panel-a",
        commandId: body.commandId
      }
    ]);
  });

  it("closes a reopened operation when no runner accepts it", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = retryableSetup(harness);
    harness.schedulerAccepts.value = false;

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/retry/setup`
    );
    const body = (await response.json()) as { statusUrl: string };
    expect(response.status).toBe(202);

    // The failure is observable through the status route the client polls.
    const polled = await fetch(`${entry.baseUrl}${body.statusUrl}`);
    const polledBody = (await polled.json()) as {
      operation: { terminalState: string; failure: { code: string } };
    };
    expect(polledBody.operation.terminalState).toBe("failed");
    expect(polledBody.operation.failure.code).toBe(
      "operation-scheduling-failed"
    );
  });

  it("leaves the family's other sub-routes to their own handlers", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness);

    // Abandon and resume sit one segment away from stop and retry. They must
    // reach the operations-status handlers — which refuse this record on their
    // own terms — rather than being claimed by a control template.
    const abandon = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/abandon`
    );
    expect(abandon.status).toBe(409);
    expect(((await abandon.json()) as { code: string }).code).toBe(
      "operation-abandon-mismatch"
    );

    const resume = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/resume/app-selection-required`
    );
    expect(resume.status).toBe(409);
    expect(((await resume.json()) as { code: string }).code).toBe(
      "operation-resume-mismatch"
    );

    // A path this family never declared still falls through to the unmatched
    // handler instead of being swallowed by a neighbouring template.
    const unknown = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/pause`
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("unmatched");
  });

  it("refuses a control request that cannot prove it came from the panel", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness);

    for (const path of [
      `/api/operations/${op.operationId}/stop`,
      `/api/operations/${op.operationId}/retry/setup`
    ]) {
      const response = await post(entry.baseUrl, path, {
        Origin: new URL(entry.baseUrl).origin,
        "Sec-Fetch-Site": "same-origin"
      });

      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe(
        "browser-mutation-validation-failed"
      );
    }
    // The refusal lands before the handler, so nothing was recorded on the
    // operation and no runner was asked to pick it up.
    expect(harness.persistCalls).toEqual([]);
    expect(harness.scheduled).toEqual([]);
  });
});

// The stop → decide → act journey over the real socket. Stopping is one
// request, and what happens next is the customer's choice between two more:
// continue the setup, or roll back what the attempt created.
describe("stop, then continue or roll back, over the socket", () => {
  it("stops a running operation and then continues it from the saved resume point", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness);
    op.resumeRequest = {
      needsAzureCredentials: true,
      azure: {},
      environment: {
        repo: "contoso/store",
        environment: "dev",
        provider: "azure"
      }
    };
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, { state: "created", appId: "app-1" });

    // 1. Stop, and let the executor honor it at its next safe boundary.
    const stopped = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/stop`
    );
    expect(stopped.status).toBe(202);
    stopAtBoundary(op, "after_service_principal");

    // 2. The stopped record projects both paths, forward first.
    const polled = await fetch(
      `${entry.baseUrl}/api/operations/${op.operationId}`
    );
    const view = (await polled.json()) as {
      operation: {
        terminalState: string;
        headline: { title: string };
        actions: Array<{ id: string; label: string; path: string }>;
      };
    };
    expect(view.operation.terminalState).toBe("cancelled");
    expect(view.operation.headline.title).toBe("Environment setup stopped");
    expect(view.operation.actions.map((entry) => entry.label)).toEqual([
      "Continue setup",
      "Roll back created resources"
    ]);

    // 3. Continuing reuses the same operation id and the retained ledger.
    const continuePath = view.operation.actions[0].path;
    const continued = await post(entry.baseUrl, continuePath);
    expect(continued.status).toBe(202);
    const body = (await continued.json()) as {
      operationId: string;
      commandId: string;
      operation: { state: string };
    };
    expect(body.operationId).toBe(op.operationId);
    expect(body.commandId).toBe(`${op.operationId}:continue_setup:2:continue`);
    expect(body.operation.state).toBe("running");
    expect(harness.scheduled).toEqual([
      {
        kind: "setup_continuation",
        instanceId: "panel-a",
        commandId: body.commandId
      }
    ]);
  });

  it("stops a running operation and then rolls it back through the same record", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-b");
    const op = stoppedSetup(harness);

    const polled = await fetch(
      `${entry.baseUrl}/api/operations/${op.operationId}`
    );
    const view = (await polled.json()) as {
      operation: {
        actions: Array<{
          id: string;
          path: string;
          tone: string;
          requiresConfirmation: boolean;
          preview: { removes: Array<{ kind: string }> };
        }>;
      };
    };
    const rollback = view.operation.actions.find(
      (entry) => entry.id === "rollback"
    )!;
    expect(rollback.tone).toBe("danger");
    expect(rollback.requiresConfirmation).toBe(true);
    // The preview the dialog renders is the server's own, in deletion order.
    expect(rollback.preview.removes.map((entry) => entry.kind)).toEqual([
      "github_environment",
      "service_principal",
      "azure_app"
    ]);

    const response = await post(entry.baseUrl, rollback.path);
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      operationId: string;
      commandId: string;
      statusUrl: string;
    };
    expect(body.operationId).toBe(op.operationId);
    expect(harness.scheduled).toEqual([
      { kind: "rollback", instanceId: "panel-b", commandId: body.commandId }
    ]);

    // While cleanup owns the record, no forward retry and no stop are offered.
    const during = await fetch(`${entry.baseUrl}${body.statusUrl}`);
    const duringBody = (await during.json()) as {
      operation: {
        actions: unknown[];
        nextTransition: { code: string; message: string };
      };
    };
    expect(duringBody.operation.actions).toEqual([]);
    expect(duringBody.operation.nextTransition).toEqual({
      code: "rolling-back",
      message: "Rolling back created resources…"
    });
  });

  it("accepts a second continue after the customer stops the continuation", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = stoppedSetup(harness);

    const first = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/continue`
    );
    expect(first.status).toBe(202);
    expect((await first.json()) as { duplicate?: boolean }).not.toMatchObject({
      duplicate: true
    });

    // The customer stops the continuation, then decides to continue again. The
    // saved command from the first attempt must not swallow the second click.
    stopAtBoundary(op, "after_service_principal");
    const second = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/continue`
    );

    expect(second.status).toBe(202);
    const body = (await second.json()) as {
      duplicate?: boolean;
      commandId: string;
      attempt: number;
    };
    expect(body.duplicate).toBeUndefined();
    expect(body.attempt).toBe(3);
    expect(body.commandId).toBe(`${op.operationId}:continue_setup:3:continue`);
    expect(harness.scheduled).toHaveLength(2);
  });

  it("schedules one rollback for a repeated request", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = stoppedSetup(harness);

    const first = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/rollback`
    );
    const second = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/rollback`
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstBody = (await first.json()) as { commandId: string };
    expect(await second.json()).toMatchObject({
      duplicate: true,
      commandId: firstBody.commandId
    });
    expect(harness.scheduled).toHaveLength(1);
  });

  it("restores the stopped record when the rollback cannot be saved", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = stoppedSetup(harness);
    harness.persistError.value = new Error("store offline");

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/rollback`
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "operation-rollback-persist-failed"
    });
    harness.persistError.value = null;

    const polled = await fetch(
      `${entry.baseUrl}/api/operations/${op.operationId}`
    );
    const view = (await polled.json()) as {
      operation: {
        terminalState: string;
        actions: Array<{ id: string }>;
      };
    };
    expect(view.operation.terminalState).toBe("cancelled");
    expect(view.operation.actions.map((entry) => entry.id)).toEqual([
      "continue-setup",
      "rollback"
    ]);
    expect(harness.scheduled).toEqual([]);
  });

  it("fails closed on an unprovable commit, an empty ledger, and an ambiguous-only record", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    // Committed before Radius saved workflow provenance: the file may or may
    // not still be what Radius wrote, so nothing may be removed.
    const committed = stoppedSetup(harness);
    recordCommittedWorkflowFile(committed, {
      path: ".github/workflows/radius-deploy.yml",
      mode: "default_branch",
      branch: "main"
    });
    const empty = seed(harness, "contoso/empty");
    finish(empty, "cancelled", { terminal: { reason: "stopped-at-boundary" } });
    const ambiguous = seed(harness, "contoso/ambiguous");
    recordGitHubEnvironment(ambiguous, {
      state: "created_candidate",
      repo: "contoso/ambiguous",
      name: "dev"
    });
    finish(ambiguous, "cancelled", {
      terminal: { reason: "stopped-at-boundary" }
    });

    for (const [operation, code] of [
      [committed, "rollback-provenance-incomplete"],
      [empty, "rollback-nothing-owned"],
      [ambiguous, "rollback-nothing-owned"]
    ] as const) {
      const response = await post(
        entry.baseUrl,
        `/api/operations/${operation.operationId}/rollback`
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code });
    }
    expect(harness.scheduled).toEqual([]);
  });

  it("offers and accepts a post-commit rollback after verification failed", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    // The journey the product model names: workflows committed, verification
    // dispatched, the run failed at Azure Login. The environment is unfinished,
    // so both choices are on offer over the same socket.
    const op = seed(harness, "contoso/store");
    recordAzureApp(op, {
      state: "created",
      appId: "app-1",
      displayName: "radius-store"
    });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "contoso/store",
      name: "dev"
    });
    recordCommittedWorkflowFile(op, {
      path: ".github/workflows/radius-verify-credentials.yml",
      mode: "default_branch",
      branch: "main",
      commitSha: "c".repeat(40),
      blobSha: "b".repeat(40),
      contentSha256: "d".repeat(64),
      previousBlobSha: null
    });
    recordCommitState(op, { mode: "default_branch", branch: "main" });
    op.verification = {
      workflow: "radius-verify-credentials.yml",
      ref: "main",
      environment: "dev",
      runId: "4242"
    };
    enterStage(op, STAGE_VERIFY);
    finish(op, "failed_partial", {
      failure: {
        code: "verify-run-failed",
        stage: STAGE_VERIFY,
        message: "Credential verification failed.",
        classification: "user-fixable",
        evidence: "Azure Login (OIDC) failed."
      }
    });

    const view = (await (
      await fetch(`${entry.baseUrl}/api/operations/${op.operationId}`)
    ).json()) as {
      operation: {
        actions: Array<{
          id: string;
          label: string;
          scope?: string;
          preview?: { removes: Array<{ kind: string; target: string }> };
        }>;
      };
    };
    expect(view.operation.actions.map((action) => action.id)).toEqual([
      "retry-verification",
      "rollback"
    ]);
    const rollback = view.operation.actions.find(
      (action) => action.id === "rollback"
    );
    expect(rollback?.label).toBe("Roll back environment setup");
    expect(rollback?.scope).toBe("post_commit");
    expect(rollback?.preview?.removes[0]).toEqual({
      kind: "workflow_file",
      target: ".github/workflows/radius-verify-credentials.yml on main"
    });

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/rollback`
    );
    expect(response.status).toBe(202);
    expect(harness.scheduled.map((entry) => entry.kind)).toEqual(["rollback"]);
  });
});
