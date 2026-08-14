import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import {
  createGraphsPlanningReadsRoutes,
  type DeployedGraphReaderOptions
} from "../../../src/server/routes/graphs-planning-reads.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import { LEGACY_ROUTE_INVENTORY } from "../../../src/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { DeployProgress } from "../../../src/deploy-artifacts.js";
import type { CanvasGraphResource, CanvasState } from "../../../src/shared.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

interface ReaderScript {
  graph?: { graph: unknown | null; status: string };
  progress?: DeployProgress | null;
  graphThrows?: Error;
}

interface Harness {
  state: CanvasState;
  reader: ReaderScript;
  readerOptions: DeployedGraphReaderOptions[];
  setEntryMissing(missing: boolean): void;
}

// Real helpers wherever the projection is pure, so the wire payload is the one
// production produces rather than a fixture the fakes invented. Only the
// artifact reader is scripted: it is the sole seam that would otherwise reach
// the network.
function keysOf(resource: unknown): string[] {
  const value = (resource ?? {}) as { id?: unknown; name?: unknown };
  return [String(value.id ?? ""), String(value.name ?? "")].filter(Boolean);
}

function start(): Harness {
  const state: CanvasState = {};
  const reader: ReaderScript = {};
  const readerOptions: DeployedGraphReaderOptions[] = [];
  let entryMissing = false;

  const routes = createTestRouteTable(
    createGraphsPlanningReadsRoutes({
      readInstanceEntry: () => (entryMissing ? undefined : { state }),
      createDeployStatusReader: (options) => {
        readerOptions.push(options);
        return {
          graph: () => {
            if (reader.graphThrows) return Promise.reject(reader.graphThrows);
            return Promise.resolve(
              reader.graph ?? { graph: null, status: "missing" }
            );
          },
          progress: () => Promise.resolve(reader.progress ?? null)
        };
      },
      buildDeployStatusMap: (progress) => {
        const map = new Map<string, "success" | "failed" | "in_progress">();
        for (const resource of progress?.resources ?? []) {
          if (!resource.status) continue;
          for (const key of keysOf(resource)) {
            if (!map.has(key)) {
              map.set(
                key,
                resource.status as "success" | "failed" | "in_progress"
              );
            }
          }
        }
        return map;
      },
      buildDeployMessageMap: (progress) => {
        const map = new Map<string, string>();
        for (const resource of progress?.resources ?? []) {
          if (!resource.message) continue;
          for (const key of keysOf(resource)) {
            if (!map.has(key)) map.set(key, resource.message);
          }
        }
        return map;
      },
      deployStatusKeys: keysOf,
      projectDeployedGraph: (modeled, statusByKey) =>
        modeled.map((resource) => ({
          ...(resource as Record<string, unknown>),
          deployStatus: statusByKey.get(keysOf(resource)[0] ?? "") ?? "pending"
        })),
      canvasGraphResources: (values) => values as CanvasGraphResource[],
      applyDeployMessages: (resources, messageMap) => {
        for (const resource of resources) {
          const message = messageMap.get(keysOf(resource)[0] ?? "");
          if (message) resource.deployMessage = message;
        }
      },
      record: (value) => {
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value)
        ) {
          return {};
        }
        return Object.fromEntries(Object.entries(value));
      },
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error),
      repoMatchesWorkspace: (current, repo) =>
        !!current.workspaceRepo && current.workspaceRepo === repo
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
    state,
    reader,
    readerOptions,
    setEntryMissing(missing) {
      entryMissing = missing;
    }
  };
}

describe("graphs-planning reads real-loopback HIT (RF-05)", () => {
  it("greys out an unresolvable repo without constructing a reader", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(
      '{"resources":[],"repo":"","mode":"greyed"}'
    );
    expect(harness.readerOptions).toEqual([]);

    // Only GET is declared, so other methods still fall through.
    const posted = await fetch(`${entry.baseUrl}/api/deployed-graph`, {
      method: "POST"
    });
    expect(posted.status).toBe(418);
  });

  it("paints the published topology with artifact status over a real socket", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.workspaceRepo = "octo/app";
    harness.state.workspaceBranch = "feature/x";
    harness.state.deployEnvName = "prod";
    harness.state.deployAppName = "billing";
    harness.reader.graph = {
      graph: {
        resources: [
          { id: "res-a", name: "api", type: "Radius.Compute/containers" }
        ]
      },
      status: "ok"
    };
    harness.reader.progress = {
      schemaVersion: 1,
      application: "billing-resolved",
      environment: "prod",
      sequence: 3,
      updatedAt: "2026-08-13T00:00:00.000Z",
      resources: [
        {
          id: "res-a",
          name: "api",
          type: "Radius.Compute/containers",
          status: "failed",
          message: "recipe failed"
        }
      ]
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      resources: [
        {
          id: "res-a",
          name: "api",
          type: "Radius.Compute/containers",
          deployStatus: "failed",
          deployMessage: "recipe failed"
        }
      ],
      repo: "octo/app",
      branch: "feature/x",
      mode: "terminal",
      updatedAt: "2026-08-13T00:00:00.000Z",
      application: "billing-resolved"
    });
    // The selectors reach the reader as the page sent them.
    expect(harness.readerOptions).toEqual([
      {
        repo: "octo/app",
        environment: "prod",
        application: "billing",
        runId: null
      }
    ]);
  });

  it("follows the query selectors and scopes a live deploy to its run", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.deployStatus = "in_progress";
    harness.state.deployEnvName = "prod";
    harness.state.deployRunId = 0;
    harness.state.deployingResources = [
      { id: "res-a", name: "api", deployStatus: "in_progress" }
    ];
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/deployed-graph?repo=octo%2Fother&environment=PROD&application=billing`
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      mode: string;
      repo: string;
      branch: string;
      resources: CanvasGraphResource[];
    };
    expect(payload.mode).toBe("live");
    expect(payload.repo).toBe("octo/other");
    expect(payload.branch).toBe("main");
    expect(payload.resources).toEqual([
      { id: "res-a", name: "api", deployStatus: "in_progress" }
    ]);
    // Run id 0 survives, and the case-insensitive environment match is what
    // keeps the session's own run in scope.
    expect(harness.readerOptions).toEqual([
      {
        repo: "octo/other",
        environment: "PROD",
        application: "billing",
        runId: 0
      }
    ]);
  });

  it("publishes a read failure to the sibling progress route", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.plannedResources = [{ id: "res-a", name: "api" }];
    harness.reader.graphThrows = new Error("artifact listing exploded");
    const entry = await container!.getOrCreate("panel-a");

    const empty = await fetch(`${entry.baseUrl}/api/progress`);
    expect(empty.status).toBe(200);
    expect(empty.headers.get("content-type")).toBe("application/json");
    expect(await empty.text()).toBe('{"messages":[]}');

    const graph = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    expect(graph.status).toBe(200);
    // The tab is not blanked: the modeled topology still renders.
    expect(
      ((await graph.json()) as { resources: CanvasGraphResource[] }).resources
    ).toEqual([{ id: "res-a", name: "api", deployStatus: "pending" }]);

    const logged = await fetch(`${entry.baseUrl}/api/progress`);
    expect(await logged.text()).toBe(
      '{"messages":["Deployed graph status read failed: artifact listing exploded"]}'
    );
  });

  it("answers both routes when the instance entry is gone", async () => {
    const harness = start();
    harness.setEntryMissing(true);
    harness.reader.graphThrows = new Error("boom");
    const entry = await container!.getOrCreate("panel-a");

    const progress = await fetch(`${entry.baseUrl}/api/progress`);
    expect(progress.status).toBe(200);
    expect(await progress.text()).toBe('{"messages":[]}');

    const graph = await fetch(
      `${entry.baseUrl}/api/deployed-graph?repo=octo%2Fapp`
    );
    expect(graph.status).toBe(200);
    expect(await graph.json()).toEqual({
      resources: [],
      repo: "octo/app",
      branch: "main",
      mode: "greyed",
      updatedAt: null,
      application: null
    });

    // Unmigrated routes still reach the fallback. The probe target is derived
    // from the inventory rather than named: a named probe inherits the
    // migration expiry of the route it names, and silently stops testing the
    // fallback once that route migrates. Deriving it means the probe follows
    // whatever is still residual, and fails loudly when nothing is.
    const [residualKey] = LEGACY_ROUTE_INVENTORY;
    if (!residualKey) {
      throw new Error(
        "No residual route remains, so the legacy fallback can no longer be " +
          "probed. Delete the fallback and this probe together."
      );
    }
    const [method, path] = residualKey.split(" ");
    expect(path?.startsWith("/api/")).toBe(true);
    const residual = await fetch(`${entry.baseUrl}${path}`, { method });
    expect(residual.status).toBe(418);
  });
});
