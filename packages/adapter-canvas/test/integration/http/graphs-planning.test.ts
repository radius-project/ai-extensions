import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { deployStatusKeys, projectDeployedGraph } from "@radius-project/core";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import {
  createGraphsPlanningRoutes,
  type DeployedGraphReaderOptions
} from "../../../src/server/routes/graphs-planning.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { DeployProgress } from "../../../src/deploy-artifacts.js";
import {
  buildDeployMessageMap,
  buildDeployStatusMap,
  settleDeployStatuses
} from "../../../src/deploy-artifacts.js";
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
  modeledLoads: Array<{ repo: string; branch: string }>;
  modeledOutcome: { status: number; error?: string; retry?: boolean };
  modeledResources: CanvasGraphResource[];
  setEntryMissing(missing: boolean): void;
  advanceClock(ms: number): void;
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
  const modeledLoads: Array<{ repo: string; branch: string }> = [];
  const modeledOutcome: { status: number; error?: string; retry?: boolean } = {
    status: 200
  };
  const modeledResources: CanvasGraphResource[] = [];
  let entryMissing = false;
  let nowMs = 0;

  const routes = createTestRouteTable(
    createGraphsPlanningRoutes({
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
      loadModeledGraph: (_instanceId, repo, branch) => {
        modeledLoads.push({ repo, branch });
        state.graphTargetRepo = repo;
        state.graphBranch = branch;
        state.graphResources = structuredClone(modeledResources);
        return Promise.resolve({ ...modeledOutcome });
      },
      buildDeployStatusMap,
      buildDeployMessageMap,
      deployStatusKeys,
      projectDeployedGraph,
      canvasGraphResources: (values) => values as CanvasGraphResource[],
      applyDeployMessages: (resources, messageMap) => {
        for (const resource of resources) {
          const message = messageMap.get(keysOf(resource)[0] ?? "");
          if (message) resource.deployMessage = message;
        }
      },
      settleDeployStatuses,
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error),
      repoMatchesWorkspace: (current, repo) =>
        !!current.workspaceRepo && current.workspaceRepo === repo,
      now: () => nowMs
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
    state,
    reader,
    readerOptions,
    modeledLoads,
    modeledOutcome,
    modeledResources,
    setEntryMissing(missing) {
      entryMissing = missing;
    },
    advanceClock(ms) {
      nowMs += ms;
    }
  };
}

describe("graphs-planning reads real-loopback HIT (RF-05)", () => {
  it("serves typed graph progress events over a real socket", async () => {
    const harness = start();
    harness.state.progressMessages = ["deployed diagnostic"];
    harness.state.graphProgressRecords = {
      graph: {
        graphProgressGeneration: 7,
        graphProgressActive: true,
        graphProgressView: "graph",
        graphProgressStartedAtMs: 1_000,
        graphProgressKey: "octo/app",
        graphProgressOwner: 1,
        graphProgressAwaitingModel: false,
        graphBuildEvents: [
          {
            sequence: 1,
            stage: "building_graph",
            state: "running",
            detail: "Building graph."
          }
        ]
      }
    };
    const entry = await container!.getOrCreate("panel-a");
    harness.advanceClock(5_000);
    const graphEvents =
      harness.state.graphProgressRecords.graph?.graphBuildEvents;
    expect(graphEvents).toBeDefined();

    const response = await fetch(`${entry.baseUrl}/api/progress`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      messages: ["deployed diagnostic"],
      generation: 7,
      events: graphEvents,
      active: true,
      view: "graph",
      // The server measures the build's age, so a client whose clock disagrees
      // still reports the time the build has actually been running.
      elapsedMs: 4_000
    });
  });

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
    expect(posted.status).toBe(404);
  });

  it("returns a modeled workflow failure without reading deployment artifacts", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.modeledOutcome.status = 400;
    harness.modeledOutcome.error = "Application model compilation failed.";
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({
      error: "Application model compilation failed.",
      retry: false
    });
    expect(harness.readerOptions).toEqual([]);
  });

  it("paints modeled topology with artifact status over a real socket", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.workspaceRepo = "octo/app";
    harness.state.workspaceBranch = "feature/x";
    harness.state.deployEnvName = "prod";
    harness.state.deployAppName = "billing";
    harness.modeledResources.push({
      id: "res-a",
      name: "api",
      type: "Radius.Compute/containers"
    });
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
          deployMessage: "recipe failed",
          connections: [],
          outputResources: []
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
    expect(harness.modeledLoads).toEqual([
      { repo: "octo/app", branch: "feature/x" }
    ]);
  });

  it("preserves full modeled topology and settles a partial failed deploy", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/voting";
    harness.state.contextBranch = "feature/topology";
    harness.state.deployEnvName = "prod";
    harness.modeledResources.push(
      {
        id: "frontend",
        name: "frontend",
        type: "Radius.Compute/containers",
        connections: [{ id: "redis" }, { id: "frontend-image" }]
      },
      {
        id: "backend",
        name: "backend",
        type: "Radius.Compute/containers",
        connections: [{ id: "postgres" }, { id: "backend-image" }]
      },
      {
        id: "votes",
        name: "votes",
        type: "Radius.Compute/containers",
        connections: [{ id: "redis" }, { id: "votes-image" }]
      },
      {
        id: "redis",
        name: "redis",
        type: "Applications.Datastores/redisCaches"
      },
      {
        id: "postgres",
        name: "postgres",
        type: "Applications.Datastores/postgreSqlDatabases"
      },
      {
        id: "frontend-image",
        name: "frontend-image",
        type: "Radius.Compute/containerImages",
        connections: [{ id: "registry-secret" }]
      },
      {
        id: "backend-image",
        name: "backend-image",
        type: "Radius.Compute/containerImages",
        connections: [{ id: "registry-secret" }]
      },
      {
        id: "votes-image",
        name: "votes-image",
        type: "Radius.Compute/containerImages",
        connections: [{ id: "registry-secret" }]
      },
      {
        id: "registry-secret",
        name: "radius-ghcr-registry-creds",
        type: "Radius.Security/secrets",
        connections: [{ id: "frontend-image" }]
      }
    );
    harness.reader.graph = {
      graph: {
        resources: [
          {
            id: "frontend-image",
            name: "frontend-image",
            type: "Radius.Compute/containerImages",
            connections: []
          },
          {
            id: "backend-image",
            name: "backend-image",
            type: "Radius.Compute/containerImages",
            connections: []
          },
          {
            id: "votes-image",
            name: "votes-image",
            type: "Radius.Compute/containerImages",
            connections: []
          },
          {
            id: "redis",
            name: "redis",
            type: "Applications.Datastores/redisCaches",
            connections: []
          },
          {
            id: "registry-secret",
            name: "radius-ghcr-registry-creds",
            type: "Radius.Security/secrets",
            connections: []
          },
          {
            id: "postgres",
            name: "postgres",
            type: "Applications.Datastores/postgreSqlDatabases",
            connections: []
          }
        ]
      },
      status: "ok"
    };
    harness.reader.progress = {
      schemaVersion: 1,
      application: "voting",
      environment: "prod",
      sequence: 4,
      state: "failed",
      resources: [
        {
          id: "frontend",
          name: "frontend",
          type: "Radius.Compute/containers",
          status: "failed",
          message: "container deployment failed"
        },
        {
          id: "redis",
          name: "redis",
          type: "Applications.Datastores/redisCaches",
          status: "success"
        }
      ]
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/deployed-graph`);
    const payload = (await response.json()) as {
      resources: CanvasGraphResource[];
      mode: string;
      branch: string;
    };

    expect(payload.mode).toBe("terminal");
    expect(payload.branch).toBe("feature/topology");
    expect(
      payload.resources.map(({ name, deployStatus }) => ({
        name,
        deployStatus
      }))
    ).toEqual([
      { name: "frontend", deployStatus: "failed" },
      { name: "backend", deployStatus: "failed" },
      { name: "votes", deployStatus: "failed" },
      { name: "redis", deployStatus: "success" },
      { name: "postgres", deployStatus: "failed" }
    ]);
    expect(
      payload.resources.map(({ name, connections }) => ({
        name,
        connections
      }))
    ).toEqual([
      { name: "frontend", connections: [{ id: "redis" }] },
      { name: "backend", connections: [{ id: "postgres" }] },
      { name: "votes", connections: [{ id: "redis" }] },
      { name: "redis", connections: [] },
      { name: "postgres", connections: [] }
    ]);
    expect(payload.resources[0].deployMessage).toBe(
      "container deployment failed"
    );
  });

  it("does not apply live session state to another repository", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.deployStatus = "in_progress";
    harness.state.deployEnvName = "prod";
    harness.state.deployRunId = 0;
    harness.state.deployingResources = [
      { id: "res-a", name: "api", deployStatus: "in_progress" }
    ];
    harness.modeledResources.push({
      id: "res-a",
      name: "api",
      deployStatus: "pending"
    });
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
    expect(payload.mode).toBe("greyed");
    expect(payload.repo).toBe("octo/other");
    expect(payload.branch).toBe("main");
    expect(payload.resources).toEqual([
      {
        id: "res-a",
        name: "api",
        deployStatus: "pending",
        connections: [],
        outputResources: []
      }
    ]);
    expect(harness.readerOptions).toEqual([
      {
        repo: "octo/other",
        environment: "PROD",
        application: "billing",
        runId: null
      }
    ]);
  });

  it("publishes a read failure to the sibling progress route", async () => {
    const harness = start();
    harness.state.contextRepo = "octo/app";
    harness.state.plannedResources = [{ id: "res-a", name: "api" }];
    harness.modeledResources.push({ id: "res-a", name: "api" });
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
    ).toEqual([
      {
        id: "res-a",
        name: "api",
        deployStatus: "pending",
        connections: [],
        outputResources: []
      }
    ]);

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
  });
});
