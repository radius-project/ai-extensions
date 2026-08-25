import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { validateBrowserMutationRequest } from "../../../src/server/browser-mutation.js";
import type { CanvasRequestContext } from "../../../src/server/request-context.js";
import {
  createOperationsStatusRoutes,
  type OperationActionRecord
} from "../../../src/server/routes/operations-status.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import {
  buildStages,
  canResumeInput,
  canDismissOperation,
  createOperation,
  dismissOperation,
  finish,
  INPUT_REQUIRED_STATE,
  isTerminalState,
  requireInput,
  resumeAfterInput,
  toClientView
} from "../../../src/operations.js";
import {
  isAksClusterName,
  isResourceGroupName,
  isUuid,
  isValidRepoSlug
} from "../../../src/azure-oidc.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

interface Harness {
  records: Map<string, OperationActionRecord>;
  setLatest(record: unknown): void;
  latestCalls: string[];
  running: Map<string, { operationId: string }>;
  persistError: { value: Error | null };
  persistCalls: string[];
  scheduled: Array<{ instanceId: string; operationId: string }>;
  scheduleAccepted: { value: boolean };
  startConflict: {
    value: {
      ok: false;
      conflict: { operationId: string };
      reason: "operation-in-progress" | "previous-cleanup-required";
    } | null;
  };
}

const RUNNING: OperationActionRecord = {
  operationId: "op-running",
  schemaVersion: 1,
  provider: "azure",
  repo: "octo/app",
  environment: "dev",
  startedAt: "2026-08-01T00:00:00.000Z",
  lastActivityAt: "2026-08-01T00:00:05.000Z",
  state: "running",
  currentStage: "verify",
  stages: [{ id: "verify", label: "Verify", state: "running" }],
  steps: [{ seq: 1, text: "started" }],
  context: { repo: "octo/app" },
  journey: { kind: "setup" },
  failure: {
    code: "build_failed",
    stage: "verify",
    stepSeq: 3,
    message: "build failed",
    classification: "user",
    evidence: "attacker-influenced build log"
  }
};

function start(strictBrowserMutations = false): Harness {
  const records = new Map<string, OperationActionRecord>([
    ["op-running", RUNNING]
  ]);
  const latestCalls: string[] = [];
  let latest: unknown = null;

  // In-memory stand-ins for the registry writes and the per-instance scheduler.
  // Everything else in the create-deps is the REAL production function: the
  // validators and `createOperation`/`buildStages` are pure, and `finish` is
  // pure state mutation, so faking them would only let the test diverge from
  // production. `persistOperations` (disk I/O) and `scheduleEnvironmentOperation`
  // (spawns background work) are the two seams a test must control, so only
  // those are doubles — composed exactly as the server's composition root does.
  const running = new Map<string, { operationId: string }>();
  const persistError: { value: Error | null } = { value: null };
  const persistCalls: string[] = [];
  const scheduled: Array<{ instanceId: string; operationId: string }> = [];
  const scheduleAccepted = { value: true };
  const startConflict: Harness["startConflict"] = { value: null };
  const persistOperations = (): Promise<void> => {
    persistCalls.push("persist");
    return persistError.value ?
        Promise.reject(persistError.value)
      : Promise.resolve();
  };
  const scheduleEnvironmentOperation = (
    instanceId: string,
    operation: { operationId: string }
  ): boolean => {
    if (!scheduleAccepted.value) return false;
    scheduled.push({ instanceId, operationId: operation.operationId });
    return true;
  };
  const validateBrowserMutation = (context: CanvasRequestContext): boolean =>
    !strictBrowserMutations ||
    validateBrowserMutationRequest({
      request: context.request,
      baseUrl: `http://${context.request.headers.host || ""}`,
      nonce: "browser-nonce"
    });

  const routes = createTestRouteTable(
    createOperationsStatusRoutes(
      {
        latest: (repo) => {
          latestCalls.push(repo);
          return latest;
        },
        latestAny: () => {
          latestCalls.push("<any>");
          return latest;
        },
        get: (operationId) => records.get(operationId) ?? null,
        toClientView
      },
      {
        claimSelectionHandle: () => ({
          ok: true,
          login: "octocat",
          credentialSource: "keyring",
          commit() {},
          release() {}
        }),
        isValidRepoSlug,
        isResourceGroupName,
        isAksClusterName,
        isUuid,
        buildStages,
        createOperation,
        startConflict: (repo) => {
          if (startConflict.value) return startConflict.value;
          const existing = running.get(repo);
          return existing ?
              { ok: false, reason: "operation-in-progress", conflict: existing }
            : null;
        },
        startOperation: (op) => {
          const existing = running.get(op.repo as string);
          if (existing) return { ok: false, conflict: existing };
          running.set(op.repo as string, { operationId: op.operationId });
          records.set(op.operationId, op as OperationActionRecord);
          return { ok: true, operation: op };
        },
        persistOperations,
        finish,
        scheduleEnvironmentOperation,
        errorMessage: (error) =>
          error instanceof Error ? error.message : String(error)
      },
      {
        getOperation: (operationId) => records.get(operationId),
        canResumeInput,
        resumeAfterInput,
        requireInput,
        finish,
        isTerminalState,
        canDismissOperation,
        dismissOperation,
        persistOperations,
        toClientView,
        scheduleEnvironmentOperation,
        errorMessage: (error) =>
          error instanceof Error ? error.message : String(error),
        inputRequiredState: INPUT_REQUIRED_STATE
      }
    )
  );

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        validateBrowserMutation,
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
    latestCalls,
    running,
    persistError,
    persistCalls,
    scheduled,
    scheduleAccepted,
    startConflict,
    setLatest(record) {
      latest = record;
    }
  };
}

// A valid azure setup body that clears every real guard, so the loopback tests
// reach the registration path rather than a 400.
const VALID_AZURE_BODY = {
  repo: "octo/app",
  clientId: "existing-client",
  resourceGroup: "my-rg",
  cluster: "my-aks",
  tenantId: "11111111-1111-1111-1111-111111111111",
  subscriptionId: "22222222-2222-2222-2222-222222222222"
};

describe("operations-status real-loopback HIT (RF-08)", () => {
  it("serves latest and by-id operation status over a real socket", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const empty = await fetch(`${entry.baseUrl}/api/operations`);
    expect(empty.status).toBe(200);
    expect(empty.headers.get("content-type")).toBe("application/json");
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect(await empty.text()).toBe('{"operation":null}');
    expect(harness.latestCalls).toEqual(["<any>"]);

    harness.setLatest(RUNNING);
    const byRepo = await fetch(
      `${entry.baseUrl}/api/operations?repo=${encodeURIComponent("octo/app")}`
    );
    expect(byRepo.status).toBe(200);
    const latestPayload = (await byRepo.json()) as {
      operation: { operationId: string };
    };
    expect(latestPayload.operation.operationId).toBe("op-running");
    expect(harness.latestCalls).toEqual(["<any>", "octo/app"]);

    // Resumability: the id discovered by polling latest rejoins the same record.
    const byId = await fetch(`${entry.baseUrl}/api/operations/op-running`);
    expect(byId.status).toBe(200);
    expect(byId.headers.get("content-type")).toBe("application/json");
    expect(byId.headers.get("cache-control")).toBe("no-store");
    const byIdText = await byId.text();
    expect(JSON.parse(byIdText)).toEqual(latestPayload);
    // Raw failure evidence never reaches the wire.
    expect(byIdText).not.toContain("attacker-influenced");

    const unknown = await fetch(`${entry.baseUrl}/api/operations/nope`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(await unknown.text()).toBe('{"error":"Unknown operation."}');

    // The exact route is not swallowed by the by-id prefix rule.
    const trailing = await fetch(`${entry.baseUrl}/api/operations/`);
    expect(trailing.status).toBe(404);
  });

  it("registers a POST /api/operations over the socket, returns 202, and schedules setup", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/operations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_AZURE_BODY)
    });
    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/json");
    const body = (await response.json()) as {
      operationId: string;
      statusUrl: string;
    };
    expect(body.operationId).toBeTruthy();
    expect(body.statusUrl).toBe(
      `/api/operations/${encodeURIComponent(body.operationId)}`
    );
    // The Location header points at the same status URL the panel then polls.
    expect(response.headers.get("location")).toBe(body.statusUrl);
    // Registration persisted before the response, and scheduling ran after it
    // with the instance that received the request.
    expect(harness.persistCalls).toEqual(["persist"]);
    expect(harness.scheduled).toEqual([
      { instanceId: "panel-a", operationId: body.operationId }
    ]);

    // The record is now resumable by id over the same socket.
    const byId = await fetch(`${entry.baseUrl}${body.statusUrl}`);
    expect(byId.status).toBe(200);
    expect(
      ((await byId.json()) as { operation: { operationId: string } }).operation
        .operationId
    ).toBe(body.operationId);
  });

  it("answers 400 invalid-json for a malformed POST body without scheduling", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/operations`, {
      method: "POST",
      body: "{not json"
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid JSON body.",
      code: "invalid-json"
    });
    expect(harness.scheduled).toEqual([]);
    expect(harness.persistCalls).toEqual([]);
  });

  it("answers 409 when a setup for the repo is already running", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const first = await fetch(`${entry.baseUrl}/api/operations`, {
      method: "POST",
      body: JSON.stringify(VALID_AZURE_BODY)
    });
    const firstBody = (await first.json()) as { operationId: string };

    const second = await fetch(`${entry.baseUrl}/api/operations`, {
      method: "POST",
      body: JSON.stringify(VALID_AZURE_BODY)
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      error: "Setup is already running for octo/app.",
      code: "operation-in-progress",
      operationId: firstBody.operationId
    });
    // Only the first request scheduled work.
    expect(harness.scheduled).toHaveLength(1);
  });

  it("returns the prior cleanup operation without registering or scheduling a new setup", async () => {
    const harness = start();
    harness.startConflict.value = {
      ok: false,
      conflict: { operationId: "op-cleanup" },
      reason: "previous-cleanup-required"
    };
    const recordCount = harness.records.size;
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/operations`, {
      method: "POST",
      body: JSON.stringify(VALID_AZURE_BODY)
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "An earlier setup for octo/app must finish rollback before a new setup can start.",
      code: "previous-cleanup-required",
      operationId: "op-cleanup"
    });
    expect(harness.records.size).toBe(recordCount);
    expect(harness.persistCalls).toEqual([]);
    expect(harness.scheduled).toEqual([]);
  });

  it("answers 500 and never schedules when durable registration fails", async () => {
    const harness = start();
    harness.persistError.value = new Error("disk gone");
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/operations`, {
      method: "POST",
      body: JSON.stringify(VALID_AZURE_BODY)
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error:
        "Radius could not durably register the environment operation. No setup work was started.",
      code: "operation-registration-persist-failed"
    });
    expect(harness.scheduled).toEqual([]);
  });

  it("resumes, abandons, and dismisses through typed templates", async () => {
    const harness = start(true);
    const entry = await container!.getOrCreate("panel-a");
    const browserHeaders = {
      Origin: entry.baseUrl,
      "Sec-Fetch-Site": "same-origin",
      "X-Radius-Mutation-Nonce": "browser-nonce"
    };

    const resumable = createOperation({
      provider: "azure",
      repo: "octo/resume",
      environment: "dev",
      stages: buildStages()
    }) as OperationActionRecord;
    resumable.request = {
      azure: {},
      environment: { repo: "octo/resume" }
    };
    requireInput(resumable, {
      code: "service-management-reference-required",
      checkpoint: "azure-service-management-reference",
      message: "Enter the Service Management Reference."
    });
    harness.records.set(resumable.operationId, resumable);

    const untrustedResume = await fetch(
      `${entry.baseUrl}/api/operations/${encodeURIComponent(resumable.operationId)}/resume/service-management-reference-required`,
      { method: "POST", body: "{}" }
    );
    expect(untrustedResume.status).toBe(403);

    const resumed = await fetch(
      `${entry.baseUrl}/api/operations/${encodeURIComponent(resumable.operationId)}/resume/service-management-reference-required`,
      {
        method: "POST",
        headers: browserHeaders,
        body: JSON.stringify({
          checkpoint: "azure-service-management-reference",
          repo: resumable.repo,
          environment: resumable.environment,
          provider: resumable.provider,
          serviceManagementReference: "11111111-1111-1111-1111-111111111111"
        })
      }
    );
    expect(resumed.status).toBe(202);
    expect(resumable.state).toBe("running");
    expect(resumable.request.azure.serviceManagementReference).toBe(
      "11111111-1111-1111-1111-111111111111"
    );
    expect(harness.scheduled).toContainEqual({
      instanceId: "panel-a",
      operationId: resumable.operationId
    });

    const abandonable = createOperation({
      provider: "azure",
      repo: "octo/abandon",
      environment: "dev",
      stages: buildStages()
    }) as OperationActionRecord;
    requireInput(abandonable, {
      code: "app-selection-required",
      checkpoint: "azure-app-selection",
      message: "Choose an app."
    });
    harness.records.set(abandonable.operationId, abandonable);
    const untrustedAbandon = await fetch(
      `${entry.baseUrl}/api/operations/${encodeURIComponent(abandonable.operationId)}/abandon`,
      { method: "POST" }
    );
    expect(untrustedAbandon.status).toBe(403);
    const abandoned = await fetch(
      `${entry.baseUrl}/api/operations/${encodeURIComponent(abandonable.operationId)}/abandon`,
      { method: "POST", headers: browserHeaders }
    );
    expect(abandoned.status).toBe(200);
    expect(abandonable.state).toBe("cancelled");
    expect(
      ((await abandoned.json()) as { operation: { state: string } }).operation
        .state
    ).toBe("cancelled");

    const dismissable = createOperation({
      provider: "azure",
      repo: "octo/dismiss",
      environment: "dev",
      stages: buildStages()
    }) as OperationActionRecord;
    finish(dismissable, "succeeded");
    harness.records.set(dismissable.operationId, dismissable);
    const dismissed = await fetch(
      `${entry.baseUrl}/api/operations/${encodeURIComponent(dismissable.operationId)}/dismiss`,
      { method: "POST", headers: browserHeaders }
    );
    expect(dismissed.status).toBe(200);
    expect(dismissable.dismissedAt).toEqual(expect.any(String));
    expect(await dismissed.json()).toEqual({
      operationId: dismissable.operationId
    });

    // The templates are anchored. An unknown POST subpath still falls through
    // exactly as before instead of being swallowed by a broad operations prefix.
    const unknownPost = await fetch(
      `${entry.baseUrl}/api/operations/${resumable.operationId}/unknown`,
      { method: "POST" }
    );
    expect(unknownPost.status).toBe(404);
    expect(await unknownPost.text()).toBe("unmatched");

    // The same paths as GET are claimed by the typed prefix route and 404 on the
    // composite tail read as an operation id, preserving established behavior.
    const asGet = await fetch(
      `${entry.baseUrl}/api/operations/op-running/abandon`
    );
    expect(asGet.status).toBe(404);
    expect(await asGet.text()).toBe('{"error":"Unknown operation."}');
  });

  it("refuses a persisted resume record with no saved request", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const resumable = createOperation({
      provider: "azure",
      repo: "octo/resume",
      environment: "dev",
      stages: buildStages()
    }) as OperationActionRecord;
    delete resumable.request;
    delete resumable.resumeRequest;
    requireInput(resumable, {
      code: "service-management-reference-required",
      checkpoint: "azure-service-management-reference",
      message: "Enter the Service Management Reference."
    });
    harness.records.set(resumable.operationId, resumable);

    const response = await fetch(
      `${entry.baseUrl}/api/operations/${encodeURIComponent(resumable.operationId)}/resume/service-management-reference-required`,
      {
        method: "POST",
        body: JSON.stringify({
          checkpoint: "azure-service-management-reference",
          repo: resumable.repo,
          environment: resumable.environment,
          provider: resumable.provider,
          serviceManagementReference: "11111111-1111-1111-1111-111111111111"
        })
      }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "The operation cannot be resumed because its saved request is unavailable.",
      code: "operation-resume-request-unavailable",
      operationId: resumable.operationId
    });
    expect(resumable.state).toBe("input_required");
    expect(resumable.request).toBeUndefined();
    expect(harness.persistCalls).toEqual([]);
    expect(harness.scheduled).toEqual([]);
  });

  it("returns 202, then exposes a terminal failure when resumed work cannot be scheduled", async () => {
    const harness = start();
    harness.scheduleAccepted.value = false;
    const entry = await container!.getOrCreate("panel-missing");
    const resumable = createOperation({
      provider: "azure",
      repo: "octo/resume",
      environment: "dev",
      stages: buildStages()
    }) as OperationActionRecord;
    resumable.request = {
      azure: {},
      environment: { repo: "octo/resume" }
    };
    requireInput(resumable, {
      code: "service-management-reference-required",
      checkpoint: "azure-service-management-reference",
      message: "Enter the Service Management Reference."
    });
    harness.records.set(resumable.operationId, resumable);

    const response = await fetch(
      `${entry.baseUrl}/api/operations/${encodeURIComponent(resumable.operationId)}/resume/service-management-reference-required`,
      {
        method: "POST",
        body: JSON.stringify({
          checkpoint: "azure-service-management-reference",
          repo: resumable.repo,
          environment: resumable.environment,
          provider: resumable.provider,
          serviceManagementReference: "11111111-1111-1111-1111-111111111111"
        })
      }
    );

    expect(response.status).toBe(202);
    expect(harness.scheduled).toEqual([]);
    expect(harness.persistCalls).toEqual(["persist", "persist"]);
    expect(resumable.state).toBe("failed");
    expect(resumable.failure).toMatchObject({
      code: "operation-scheduling-failed",
      stage: resumable.currentStage,
      message:
        "Radius accepted the environment operation but could not start any setup work for it.",
      evidence:
        "No server-owned task runner was available for instance panel-missing."
    });

    const status = await fetch(
      `${entry.baseUrl}/api/operations/${encodeURIComponent(resumable.operationId)}`
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      operation: {
        operationId: resumable.operationId,
        state: "failed",
        failure: { code: "operation-scheduling-failed" }
      }
    });
  });

  it("answers 410 for an expired resume prompt without persisting or scheduling", async () => {
    const harness = start();
    const expired = {
      ...RUNNING,
      operationId: "op-expired",
      state: "failed_partial",
      failure: {
        ...RUNNING.failure,
        code: "operation-input-expired",
        message: "The requested input expired."
      }
    };
    harness.records.set(expired.operationId, expired);
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/operations/op-expired/resume/app-selection-required`,
      { method: "POST", body: "{not json" }
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: "The requested input expired.",
      code: "operation-input-expired",
      operation: { operationId: "op-expired" }
    });
    expect(harness.persistCalls).toEqual([]);
    expect(harness.scheduled).toEqual([]);
  });

  it("decodes a percent-encoded operation id on the wire", async () => {
    const harness = start();
    harness.records.set("octo/app:setup", { ...RUNNING, operationId: "enc" });
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/operations/${encodeURIComponent("octo/app:setup")}`
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { operation: { operationId: string } })
        .operation.operationId
    ).toBe("enc");
  });
});
