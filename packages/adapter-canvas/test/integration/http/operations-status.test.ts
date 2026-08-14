import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { createOperationsStatusRoutes } from "../../../src/server/routes/operations-status.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import { toClientView } from "../../../src/operations.js";
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

  const routes = createTestRouteTable(
    createOperationsStatusRoutes({
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
    })
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
    setLatest(record) {
      latest = record;
    }
  };
}

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

    // Only the GET routes are migrated. `POST /api/operations` is a declared
    // route owned by this family but still served by the legacy fallback, so a
    // POST must not reach the migrated handler.
    const posted = await fetch(`${entry.baseUrl}/api/operations`, {
      method: "POST"
    });
    expect(posted.status).toBe(418);

    // Unmigrated routes still reach the fallback.
    const residual = await fetch(`${entry.baseUrl}/api/list-applications`);
    expect(residual.status).toBe(418);
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
