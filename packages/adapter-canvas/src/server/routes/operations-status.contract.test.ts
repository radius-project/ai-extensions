import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  handleLatestOperation,
  handleOperationById,
  type OperationsStatusDependencies
} from "./operations-status.js";
import { toClientView } from "../../operations.js";
import type { CanvasServerEntry } from "../types.js";

// Verbatim transcription of the two branches this slice removed from the legacy
// `createLegacyRequestHandler` if-chain in `src/server.ts` (`/api/operations` at
// ~2387 and `/api/operations/` at ~2398 before the migration). It exists only
// to prove byte-for-byte equivalence while both implementations conceptually
// exist, and is deleted with the rest of the fallback in the removal slice.
interface LegacyWorld {
  operations: {
    latest(repo: string): unknown;
    latestAny(): unknown;
    get(operationId: string): unknown;
  };
}

function legacyLatest(
  url: URL,
  res: ServerResponse<IncomingMessage>,
  { operations }: LegacyWorld
): void {
  const repo = url.searchParams.get("repo") || "";
  const record = repo ? operations.latest(repo) : operations.latestAny();
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(200);
  res.end(JSON.stringify({ operation: record ? toClientView(record) : null }));
}

function legacyById(
  pathname: string,
  res: ServerResponse<IncomingMessage>,
  { operations }: LegacyWorld
): void {
  const operationId = decodeURIComponent(
    pathname.slice("/api/operations/".length)
  );
  const record = operations.get(operationId);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.writeHead(record ? 200 : 404);
  res.end(
    JSON.stringify(
      record ?
        { operation: toClientView(record) }
      : { error: "Unknown operation." }
    )
  );
}

interface Recording {
  headers: Record<string, string>;
  headerOrder: string[];
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = {
    headers: {},
    headerOrder: [],
    status: 0,
    body: ""
  };
  const target = {
    setHeader(name: string, value: string) {
      // Mirrors Node: re-setting a header overwrites it and keeps its position.
      if (!(name in recording.headers)) recording.headerOrder.push(name);
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
    response: target as unknown as ServerResponse<IncomingMessage>
  };
}

function request(url: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    url,
    method: "GET",
    headers: {}
  }) as unknown as IncomingMessage;
}

const INSTANCE_ID = "panel-a";

function migratedDependencies(
  legacy: LegacyWorld
): OperationsStatusDependencies {
  return {
    latest: (repo) => legacy.operations.latest(repo),
    latestAny: () => legacy.operations.latestAny(),
    get: (operationId) => legacy.operations.get(operationId),
    toClientView
  };
}

function world(records: Record<string, unknown>, latest: unknown): LegacyWorld {
  return {
    operations: {
      latest: () => latest,
      latestAny: () => latest,
      get: (operationId) => records[operationId] ?? null
    }
  };
}

function differential(
  url: string,
  legacy: LegacyWorld,
  route: "latest" | "byId"
): [Recording, Recording] {
  const parsed = new URL(url, "http://localhost");

  const legacyRecorder = recorder();
  if (route === "latest") legacyLatest(parsed, legacyRecorder.response, legacy);
  else legacyById(parsed.pathname, legacyRecorder.response, legacy);

  const migratedRecorder = recorder();
  const context = createRequestContext(
    request(url),
    migratedRecorder.response,
    INSTANCE_ID,
    new Map<string, CanvasServerEntry>()
  );
  const handler =
    route === "latest" ? handleLatestOperation : handleOperationById;
  handler(context, migratedDependencies(legacy));

  return [legacyRecorder.recording, migratedRecorder.recording];
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
  journey: { kind: "setup" }
};

const FAILED = {
  ...RUNNING,
  operationId: "op-failed",
  state: "failed",
  endedAt: "2026-08-01T00:01:00.000Z",
  failure: {
    code: "build_failed",
    stage: "verify",
    stepSeq: 3,
    message: "build failed",
    classification: "user",
    evidence: "attacker-influenced build log"
  }
};

describe("operations-status legacy/migrated differential contract", () => {
  it.each([
    ["latest by repo", "/api/operations?repo=octo%2Fapp", RUNNING],
    ["latest without repo", "/api/operations", RUNNING],
    ["latest terminal record", "/api/operations?repo=octo%2Fapp", FAILED],
    ["latest empty state", "/api/operations", null]
  ])("produces an identical %s response", (_label, url, latest) => {
    const [legacy, migrated] = differential(url, world({}, latest), "latest");
    expect(migrated).toEqual(legacy);
    expect(migrated.status).toBe(200);
    expect(migrated.headerOrder).toEqual(["Content-Type", "Cache-Control"]);
    expect(migrated.headers["Cache-Control"]).toBe("no-store");
  });

  it.each([
    ["known id", "/api/operations/op-running", 200],
    ["encoded id", "/api/operations/op%2Drunning", 200],
    ["unknown id", "/api/operations/nope", 404],
    ["empty id", "/api/operations/", 404]
  ])("produces an identical %s response", (_label, url, status) => {
    const [legacy, migrated] = differential(
      url,
      world({ "op-running": RUNNING }, null),
      "byId"
    );
    expect(migrated).toEqual(legacy);
    expect(migrated.status).toBe(status);
    expect(migrated.headerOrder).toEqual(["Content-Type", "Cache-Control"]);
  });

  it("redacts raw failure evidence identically on both paths", () => {
    const [legacy, migrated] = differential(
      "/api/operations/op-failed",
      world({ "op-failed": FAILED }, null),
      "byId"
    );
    expect(migrated).toEqual(legacy);
    expect(migrated.body).not.toContain("attacker-influenced");
  });

  it("throws identically on a malformed percent escape", () => {
    const legacy = world({}, null);
    const legacyRecorder = recorder();
    expect(() =>
      legacyById("/api/operations/%", legacyRecorder.response, legacy)
    ).toThrow(URIError);
    expect(() => differential("/api/operations/%", legacy, "byId")).toThrow(
      URIError
    );
    // Neither implementation writes anything before throwing.
    expect(legacyRecorder.recording.status).toBe(0);
  });
});
