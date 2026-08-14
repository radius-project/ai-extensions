import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createOperationsStatusRoutes } from "../../../src/server/routes/operations-status.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import {
  buildStages,
  createOperation,
  finish,
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
  records: Map<string, unknown>;
  setLatest(record: unknown): void;
  latestCalls: string[];
  running: Map<string, { operationId: string }>;
  persistError: { value: Error | null };
  persistCalls: string[];
  scheduled: Array<{ instanceId: string; operationId: string }>;
}

const RUNNING = {
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

function start(): Harness {
  const records = new Map<string, unknown>([["op-running", RUNNING]]);
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
        isValidRepoSlug,
        isResourceGroupName,
        isAksClusterName,
        isUuid,
        buildStages,
        createOperation,
        startOperation: (op) => {
          const existing = running.get(op.repo as string);
          if (existing) return { ok: false, conflict: existing };
          running.set(op.repo as string, { operationId: op.operationId });
          records.set(op.operationId, op);
          return { ok: true, operation: op };
        },
        persistOperations: () => {
          persistCalls.push("persist");
          return persistError.value ?
              Promise.reject(persistError.value)
            : Promise.resolve();
        },
        finish,
        scheduleEnvironmentOperation: (instanceId, op) => {
          scheduled.push({ instanceId, operationId: op.operationId });
          return true;
        },
        errorMessage: (error) =>
          error instanceof Error ? error.message : String(error)
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
        legacyFallback: (_request, response) => {
          response.writeHead(418);
          response.end("legacy");
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

    // Unmigrated routes still reach the fallback.
    const residual = await fetch(`${entry.baseUrl}/api/list-environments`);
    expect(residual.status).toBe(418);
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

  it("leaves main's undeclared POST sub-routes to the legacy fallback", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");

    // `main` matches these two with regexes in the legacy chain rather than
    // declaring them, and they sit under this family's migrated GET prefix.
    // Over a real socket they must still reach the fallback: the dispatcher
    // consults the route table before the legacy chain, so GET/POST
    // disjointness is now the only thing keeping them reachable.
    for (const path of [
      "/api/operations/op-running/resume/abc",
      "/api/operations/op-running/abandon"
    ]) {
      const response = await fetch(`${entry.baseUrl}${path}`, {
        method: "POST"
      });
      expect(response.status).toBe(418);
      expect(await response.text()).toBe("legacy");
    }

    // The same paths as GET are claimed by the migrated prefix route and 404 on
    // the composite tail read as an operation id. That matches legacy, whose
    // GET prefix branch also claimed them, so it is pinned rather than fixed.
    const asGet = await fetch(
      `${entry.baseUrl}/api/operations/op-running/abandon`
    );
    expect(asGet.status).toBe(404);
    expect(await asGet.text()).toBe('{"error":"Unknown operation."}');
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
