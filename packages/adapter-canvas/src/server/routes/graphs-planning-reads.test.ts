import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { DeployStatus } from "@radius-project/core";
import { createRequestContext } from "../request-context.js";
import {
  createGraphsPlanningReadsRoutes,
  handleDeployedGraph,
  handleProgress,
  type GraphsPlanningReadsDependencies
} from "./graphs-planning-reads.js";
import type { DeployProgress } from "../../deploy-artifacts.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import type { CanvasServerEntry } from "../types.js";

interface Recording {
  headers: Record<string, string>;
  headerOrder: string[];
  // Header placement is observable: `/api/deployed-graph` sets `Content-Type`
  // *before* the empty-repo branch, so both of its exits carry it. `headers`
  // alone cannot express when the set happened relative to the write.
  headerSteps: string[];
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = {
    headers: {},
    headerOrder: [],
    headerSteps: [],
    status: 0,
    body: ""
  };
  const target = {
    setHeader(name: string, value: string) {
      // Mirrors Node: re-setting a header overwrites it and keeps its position.
      if (!(name in recording.headers)) recording.headerOrder.push(name);
      recording.headers[name] = value;
      recording.headerSteps.push(`set:${name}=${value}`);
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      recording.headerSteps.push(`writeHead:${status}`);
      return this;
    },
    end(value = "") {
      recording.body += value;
      recording.headerSteps.push("end");
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

// ── Fixtures ────────────────────────────────────────────────────────────────
// Named so the differential cases and the precondition guard reference the same
// values rather than repeating literals that could drift apart. Every repo below
// is distinct, which is what makes the five-step repo precedence chain
// discriminating: a handler reading the wrong link answers a different repo
// instead of a coincidentally identical one.

const QUERY_REPO = "octo/from-query";
const CONTEXT_REPO = "octo/from-context";
const DEPLOYING_REPO = "octo/from-deploying";
const PLANNED_REPO = "octo/from-planned";
const GRAPH_TARGET_REPO = "octo/from-graph-target";
const WORKSPACE_REPO = CONTEXT_REPO;
const WORKSPACE_BRANCH = "feature/x";

const DEPLOY_ENV = "Prod-Env";
const SESSION_ENV = "session-env";
const OTHER_ENV = "other-env";
const DEPLOY_APP = "session-app";
const ARTIFACT_APP = "artifact-app";
const QUERY_APP = "query-app";
const UPDATED_AT = "2026-08-13T00:00:00.000Z";

// Distinct per-source resource names so the topology precedence chain answers a
// different payload for each link rather than an identical one.
const DEPLOYING_RESOURCES: CanvasGraphResource[] = [
  { id: "res-deploying", name: "deploying-node", type: "Radius.Compute" }
];
const PLANNED_RESOURCES: CanvasGraphResource[] = [
  { id: "res-planned", name: "planned-node", type: "Radius.Compute" }
];
const GRAPH_RESOURCES: CanvasGraphResource[] = [
  { id: "res-graph", name: "graph-node", type: "Radius.Compute" }
];
const DEPLOYED_GRAPH: CanvasGraphResource[] = [
  { id: "res-deployed", name: "deployed-node", type: "Radius.Compute" }
];
const PUBLISHED_GRAPH = [
  { id: "res-published", name: "published-node", type: "Radius.Compute" }
];

function progressPayload(
  resources: DeployProgress["resources"],
  overrides: Partial<DeployProgress> = {}
): DeployProgress {
  return {
    schemaVersion: 1,
    application: ARTIFACT_APP,
    environment: DEPLOY_ENV,
    sequence: 1,
    updatedAt: UPDATED_AT,
    resources,
    ...overrides
  };
}

const ARTIFACT_PROGRESS = progressPayload([
  {
    id: "res-deploying",
    name: "deploying-node",
    type: "Radius.Compute",
    status: "failed",
    message: "artifact says failed"
  }
]);

// Every state field the two routes may read. A case that misspells one would
// otherwise be completely silent: the override would land on a field nothing
// reads, and the case would collapse into the plain default while still
// asserting the same outcome.
const KNOWN_STATE_FIELDS: readonly (keyof CanvasState)[] = [
  "contextRepo",
  "deployingRepo",
  "plannedRepo",
  "graphTargetRepo",
  "workspaceRepo",
  "workspaceBranch",
  "deployEnvName",
  "envName",
  "deployAppName",
  "deployStatus",
  "deployingResources",
  "deployRunId",
  "deployedGraph",
  "plannedResources",
  "graphResources",
  "progressMessages"
];

// The only query parameters these routes read.
const KNOWN_QUERY_PARAMS = ["repo", "environment", "application"];

// Default reader outcomes. A scripted outcome must *override* one of these,
// never add a new key.
const DEFAULT_READER: {
  graph: { graph: unknown | null; status: string };
  progress: DeployProgress | null;
} = {
  graph: { graph: null, status: "missing" },
  progress: null
};

interface Calls {
  log: string[];
}

interface FakeOptions {
  missingEntry?: boolean;
  state?: CanvasState;
  reader?: {
    graph?: { graph: unknown | null; status: string };
    progress?: DeployProgress | null;
  };
  graphThrows?: Error;
  progressThrows?: Error;
}

// Key derivation shared by the `deployStatusKeys` fake and the two map-builder
// fakes, so the first-wins seeding order is genuinely observable: seeded and
// artifact statuses collide on the same keys only because they agree here.
function keysOf(resource: unknown): string[] {
  const value = (resource ?? {}) as { id?: unknown; name?: unknown };
  return [String(value.id ?? ""), String(value.name ?? "")].filter(Boolean);
}

// One independent set of fakes plus the mutable state they read and write. Each
// side of a differential case builds its own, so a mutation on one side can
// never be masked by state shared with the other.
function fakes(
  calls: Calls,
  options: FakeOptions = {}
): { deps: GraphsPlanningReadsDependencies; state: CanvasState | undefined } {
  for (const key of Object.keys(options.state ?? {})) {
    if (!KNOWN_STATE_FIELDS.includes(key as keyof CanvasState)) {
      throw new Error(
        `scripted state field "${key}" overrides nothing; expected one of ${KNOWN_STATE_FIELDS.join(
          ", "
        )}`
      );
    }
  }
  for (const key of Object.keys(options.reader ?? {})) {
    if (!(key in DEFAULT_READER)) {
      throw new Error(
        `scripted reader result "${key}" overrides nothing; expected one of ${Object.keys(
          DEFAULT_READER
        ).join(", ")}`
      );
    }
  }
  const state =
    options.missingEntry ? undefined : structuredClone(options.state ?? {});
  // The entry indirection is reproduced rather than flattened: the handler reads
  // `entry?.state?.x` exactly as the legacy branch did, and one of those
  // expressions can throw with a message V8 builds from its source text.
  const entry = state === undefined ? undefined : { state };
  const reader = { ...DEFAULT_READER, ...(options.reader ?? {}) };
  const deps: GraphsPlanningReadsDependencies = {
    readInstanceEntry: (instanceId) => {
      calls.log.push(`readInstanceEntry(${instanceId})`);
      return entry;
    },
    createDeployStatusReader: (readerOptions) => {
      calls.log.push(
        `createDeployStatusReader(${JSON.stringify(readerOptions)})`
      );
      return {
        graph: () => {
          calls.log.push("reader.graph");
          if (options.graphThrows) return Promise.reject(options.graphThrows);
          return Promise.resolve(reader.graph);
        },
        progress: () => {
          calls.log.push("reader.progress");
          if (options.progressThrows) {
            return Promise.reject(options.progressThrows);
          }
          return Promise.resolve(reader.progress);
        }
      };
    },
    buildDeployStatusMap: (progress) => {
      calls.log.push(`buildDeployStatusMap(${JSON.stringify(progress)})`);
      const map = new Map<string, DeployStatus>();
      for (const resource of progress?.resources ?? []) {
        if (!resource.status) continue;
        for (const key of keysOf(resource)) {
          if (!map.has(key)) map.set(key, resource.status);
        }
      }
      return map;
    },
    buildDeployMessageMap: (progress) => {
      calls.log.push(`buildDeployMessageMap(${JSON.stringify(progress)})`);
      const map = new Map<string, string>();
      for (const resource of progress?.resources ?? []) {
        if (!resource.message) continue;
        for (const key of keysOf(resource)) {
          if (!map.has(key)) map.set(key, resource.message);
        }
      }
      return map;
    },
    deployStatusKeys: (resource) => {
      calls.log.push(`deployStatusKeys(${JSON.stringify(resource)})`);
      return keysOf(resource);
    },
    projectDeployedGraph: (modeled, statusByKey) => {
      calls.log.push(
        `projectDeployedGraph(${JSON.stringify(modeled)}|${JSON.stringify([
          ...statusByKey
        ])})`
      );
      return modeled.map((resource) => ({
        ...(resource as Record<string, unknown>),
        deployStatus: statusByKey.get(keysOf(resource)[0] ?? "") ?? "pending"
      }));
    },
    // Marked rather than identity, so a handler that skips the normalizer
    // produces a visibly different payload instead of the same one.
    canvasGraphResources: (values) => {
      calls.log.push(`canvasGraphResources(${JSON.stringify(values)})`);
      return values.map((value) => ({
        ...(value as CanvasGraphResource),
        normalized: true
      }));
    },
    applyDeployMessages: (resources, messageMap) => {
      calls.log.push(`applyDeployMessages(${JSON.stringify([...messageMap])})`);
      for (const resource of resources) {
        const message = messageMap.get(keysOf(resource)[0] ?? "");
        if (message) resource.deployMessage = message;
      }
    },
    record: (value) => {
      calls.log.push(`record(${JSON.stringify(value)})`);
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return {};
      }
      return Object.fromEntries(Object.entries(value));
    },
    // Deliberately distinct from the raw message, so a handler that formats the
    // read failure itself instead of using the injected formatter is detectable.
    errorMessage: (error) =>
      `formatted:${error instanceof Error ? error.message : String(error)}`,
    repoMatchesWorkspace: (current, repo) => {
      calls.log.push(`repoMatchesWorkspace(${current.workspaceRepo}|${repo})`);
      return !!current.workspaceRepo && current.workspaceRepo === repo;
    }
  };
  return { deps, state };
}

function dependencies(
  overrides: Partial<GraphsPlanningReadsDependencies> = {}
): GraphsPlanningReadsDependencies {
  const calls: Calls = { log: [] };
  return { ...fakes(calls).deps, ...overrides };
}

type Handler = (
  context: ReturnType<typeof createRequestContext>,
  deps: GraphsPlanningReadsDependencies
) => void | Promise<void>;

async function run(
  url: string,
  handler: Handler,
  deps: GraphsPlanningReadsDependencies
): Promise<Recording> {
  const { recording, response } = recorder();
  const context = createRequestContext(
    request(url),
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  await handler(context, deps);
  return recording;
}

const JSON_ONLY = ["Content-Type"];
const SET_THEN_WRITE = [
  "set:Content-Type=application/json",
  "writeHead:200",
  "end"
];

interface DeployedGraphPayload {
  resources: CanvasGraphResource[];
  repo: string;
  branch?: string;
  mode: string;
  updatedAt?: string | null;
  application?: string | null;
}

function payloadOf(recording: Recording): DeployedGraphPayload {
  return JSON.parse(recording.body) as DeployedGraphPayload;
}

describe("graphs-planning read routes (SU-09)", () => {
  it("declares exactly the two routes it owns", () => {
    const routes = createGraphsPlanningReadsRoutes(dependencies());
    expect(Object.keys(routes)).toEqual([
      "GET /api/progress",
      "GET /api/deployed-graph"
    ]);
  });

  it("dispatches both registry entries to their handlers", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, { state: { progressMessages: ["hello"] } });
    const routes = createGraphsPlanningReadsRoutes(deps);
    const first = recorder();
    await routes["GET /api/progress"](
      createRequestContext(
        request("/api/progress"),
        first.response,
        "panel-a",
        new Map<string, CanvasServerEntry>()
      )
    );
    expect(first.recording.body).toBe('{"messages":["hello"]}');

    const second = recorder();
    await routes["GET /api/deployed-graph"](
      createRequestContext(
        request("/api/deployed-graph"),
        second.response,
        "panel-a",
        new Map<string, CanvasServerEntry>()
      )
    );
    expect(second.recording.body).toBe(
      '{"resources":[],"repo":"","mode":"greyed"}'
    );
  });

  // ── GET /api/progress ─────────────────────────────────────────────────────

  it("serves the accumulated progress messages", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: { progressMessages: ["first", "second"] }
    });
    const recording = await run("/api/progress", handleProgress, deps);
    expect(recording.status).toBe(200);
    expect(recording.headerOrder).toEqual(JSON_ONLY);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE);
    expect(recording.body).toBe('{"messages":["first","second"]}');
    expect(calls.log).toEqual(["readInstanceEntry(panel-a)"]);
  });

  it("answers an empty list for a state that has never logged", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run("/api/progress", handleProgress, deps);
    expect(recording.body).toBe('{"messages":[]}');
  });

  it("answers an empty list for a missing instance entry", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, { missingEntry: true });
    const recording = await run("/api/progress", handleProgress, deps);
    expect(recording.status).toBe(200);
    expect(recording.body).toBe('{"messages":[]}');
  });

  // ── GET /api/deployed-graph ───────────────────────────────────────────────

  it("short circuits an unresolvable repo after setting Content-Type", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls);
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    expect(recording.status).toBe(200);
    expect(recording.headerSteps).toEqual(SET_THEN_WRITE);
    expect(recording.body).toBe('{"resources":[],"repo":"","mode":"greyed"}');
    // Nothing is read: the reader is never constructed.
    expect(calls.log).toEqual(["readInstanceEntry(panel-a)"]);
  });

  it("prefers the query repo over every state fallback and trims it", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployingRepo: DEPLOYING_REPO,
        plannedRepo: PLANNED_REPO,
        graphTargetRepo: GRAPH_TARGET_REPO
      }
    });
    const recording = await run(
      `/api/deployed-graph?repo=${encodeURIComponent(`  ${QUERY_REPO}  `)}`,
      handleDeployedGraph,
      deps
    );
    expect(payloadOf(recording).repo).toBe(QUERY_REPO);
  });

  it("falls back through context, deploying, planned, and graph target", async () => {
    const chain: [CanvasState, string][] = [
      [
        {
          contextRepo: CONTEXT_REPO,
          deployingRepo: DEPLOYING_REPO,
          plannedRepo: PLANNED_REPO,
          graphTargetRepo: GRAPH_TARGET_REPO
        },
        CONTEXT_REPO
      ],
      [
        {
          deployingRepo: DEPLOYING_REPO,
          plannedRepo: PLANNED_REPO,
          graphTargetRepo: GRAPH_TARGET_REPO
        },
        DEPLOYING_REPO
      ],
      [
        { plannedRepo: PLANNED_REPO, graphTargetRepo: GRAPH_TARGET_REPO },
        PLANNED_REPO
      ],
      [{ graphTargetRepo: GRAPH_TARGET_REPO }, GRAPH_TARGET_REPO]
    ];
    for (const [state, expected] of chain) {
      const calls: Calls = { log: [] };
      const { deps } = fakes(calls, { state });
      const recording = await run(
        "/api/deployed-graph",
        handleDeployedGraph,
        deps
      );
      expect(payloadOf(recording).repo).toBe(expected);
    }
  });

  it("reports the workspace branch only for the workspace repo", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        workspaceRepo: WORKSPACE_REPO,
        workspaceBranch: WORKSPACE_BRANCH
      }
    });
    expect(
      payloadOf(await run("/api/deployed-graph", handleDeployedGraph, deps))
        .branch
    ).toBe(WORKSPACE_BRANCH);

    const other: Calls = { log: [] };
    const otherDeps = fakes(other, {
      state: {
        contextRepo: PLANNED_REPO,
        workspaceRepo: WORKSPACE_REPO,
        workspaceBranch: WORKSPACE_BRANCH
      }
    }).deps;
    expect(
      payloadOf(
        await run("/api/deployed-graph", handleDeployedGraph, otherDeps)
      ).branch
    ).toBe("main");
  });

  it("scopes the reader to the run id only while deploying", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployStatus: "in_progress",
        deployEnvName: DEPLOY_ENV,
        deployAppName: DEPLOY_APP,
        deployRunId: 0
      }
    });
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    // `??` not `||`: run id 0 is a real id and must survive.
    expect(calls.log).toContain(
      `createDeployStatusReader(${JSON.stringify({
        repo: CONTEXT_REPO,
        environment: DEPLOY_ENV,
        application: DEPLOY_APP,
        runId: 0
      })})`
    );
    expect(payloadOf(recording).mode).toBe("live");
  });

  it("drops the run id when the selection does not match the session", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployStatus: "in_progress",
        deployEnvName: SESSION_ENV,
        deployRunId: 7
      }
    });
    const recording = await run(
      `/api/deployed-graph?environment=${OTHER_ENV}`,
      handleDeployedGraph,
      deps
    );
    expect(calls.log).toContain(
      `createDeployStatusReader(${JSON.stringify({
        repo: CONTEXT_REPO,
        environment: OTHER_ENV,
        application: "",
        runId: null
      })})`
    );
    expect(payloadOf(recording).mode).toBe("greyed");
  });

  it("matches the session environment case-insensitively", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployStatus: "in_progress",
        deployEnvName: DEPLOY_ENV
      }
    });
    const recording = await run(
      `/api/deployed-graph?environment=${DEPLOY_ENV.toUpperCase()}`,
      handleDeployedGraph,
      deps
    );
    expect(payloadOf(recording).mode).toBe("live");
  });

  it("treats an empty side of the environment comparison as a match", async () => {
    // Session env empty, request env set.
    const first: Calls = { log: [] };
    expect(
      payloadOf(
        await run(
          `/api/deployed-graph?environment=${OTHER_ENV}`,
          handleDeployedGraph,
          fakes(first, {
            state: {
              contextRepo: CONTEXT_REPO,
              deployStatus: "in_progress"
            }
          }).deps
        )
      ).mode
    ).toBe("live");

    // Request env empty, session env set.
    const second: Calls = { log: [] };
    expect(
      payloadOf(
        await run(
          "/api/deployed-graph?environment=%20%20",
          handleDeployedGraph,
          fakes(second, {
            state: {
              contextRepo: CONTEXT_REPO,
              deployStatus: "in_progress",
              envName: SESSION_ENV
            }
          }).deps
        )
      ).mode
    ).toBe("live");
  });

  it("seeds monitor statuses before the artifact and keeps the first", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployingResources: [
          {
            id: "res-deploying",
            name: "deploying-node",
            type: "Radius.Compute",
            deployStatus: "success"
          }
        ]
      },
      reader: { progress: ARTIFACT_PROGRESS }
    });
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    const payload = payloadOf(recording);
    // The artifact says failed; the seeded monitor status wins.
    expect(payload.resources[0].deployStatus).toBe("success");
    // The message map is not gated by the seeding, so it still applies.
    expect(payload.resources[0].deployMessage).toBe("artifact says failed");
    expect(payload.mode).toBe("terminal");
    expect(payload.application).toBe(ARTIFACT_APP);
    expect(payload.updatedAt).toBe(UPDATED_AT);
  });

  it("skips pending and statusless monitor resources when seeding", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployingResources: [
          {
            id: "res-deploying",
            name: "deploying-node",
            type: "Radius.Compute",
            deployStatus: "pending"
          },
          { id: "res-planned", name: "planned-node", type: "Radius.Compute" }
        ]
      }
    });
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    const payload = payloadOf(recording);
    expect(payload.mode).toBe("greyed");
    expect(payload.resources.map((r) => r.deployStatus)).toEqual([
      "pending",
      "pending"
    ]);
  });

  it("ignores monitor resources when the selection does not match", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        envName: SESSION_ENV,
        deployedGraph: DEPLOYED_GRAPH,
        deployingResources: [
          {
            id: "res-deploying",
            name: "deploying-node",
            type: "Radius.Compute",
            deployStatus: "success"
          }
        ]
      }
    });
    const recording = await run(
      `/api/deployed-graph?environment=${OTHER_ENV}`,
      handleDeployedGraph,
      deps
    );
    const payload = payloadOf(recording);
    // No seeded status, no deployedGraph fallback, and no deployingResources
    // topology: all three are gated by the same predicate.
    expect(payload.mode).toBe("greyed");
    expect(payload.resources).toEqual([]);
  });

  it("prefers a published graph array over every modeled fallback", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployingResources: DEPLOYING_RESOURCES,
        plannedResources: PLANNED_RESOURCES,
        graphResources: GRAPH_RESOURCES
      },
      reader: { graph: { graph: PUBLISHED_GRAPH, status: "ok" } }
    });
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    expect(payloadOf(recording).resources.map((r) => r.name)).toEqual([
      "published-node"
    ]);
  });

  it("reads the resources array off a published graph object", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        plannedResources: PLANNED_RESOURCES
      },
      reader: {
        graph: { graph: { resources: PUBLISHED_GRAPH }, status: "ok" }
      }
    });
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    expect(payloadOf(recording).resources.map((r) => r.name)).toEqual([
      "published-node"
    ]);
  });

  it("falls back through deploying, planned, and graph resources", async () => {
    const chain: [CanvasState, string][] = [
      [
        {
          contextRepo: CONTEXT_REPO,
          deployingResources: DEPLOYING_RESOURCES,
          plannedResources: PLANNED_RESOURCES,
          graphResources: GRAPH_RESOURCES
        },
        "deploying-node"
      ],
      [
        {
          contextRepo: CONTEXT_REPO,
          plannedResources: PLANNED_RESOURCES,
          graphResources: GRAPH_RESOURCES
        },
        "planned-node"
      ],
      [
        { contextRepo: CONTEXT_REPO, graphResources: GRAPH_RESOURCES },
        "graph-node"
      ]
    ];
    for (const [state, expected] of chain) {
      const calls: Calls = { log: [] };
      const { deps } = fakes(calls, { state });
      const recording = await run(
        "/api/deployed-graph",
        handleDeployedGraph,
        deps
      );
      expect(payloadOf(recording).resources.map((r) => r.name)).toEqual([
        expected
      ]);
    }
  });

  it("falls back to the cached deployed graph when the read has none", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: { contextRepo: CONTEXT_REPO, deployedGraph: DEPLOYED_GRAPH }
    });
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    const payload = payloadOf(recording);
    // A cached graph alone is enough to make the deployment terminal.
    expect(payload.mode).toBe("terminal");
    expect(payload.resources.map((r) => r.name)).toEqual(["deployed-node"]);
  });

  it("treats a stale read as a successful one", async () => {
    for (const status of ["ok", "stale"]) {
      const calls: Calls = { log: [] };
      const { deps } = fakes(calls, {
        state: { contextRepo: CONTEXT_REPO },
        reader: { graph: { graph: null, status } }
      });
      const recording = await run(
        "/api/deployed-graph",
        handleDeployedGraph,
        deps
      );
      expect(payloadOf(recording).mode).toBe("terminal");
    }
  });

  it("greys out an unreadable deployment with nothing modeled", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: { contextRepo: CONTEXT_REPO },
      reader: { graph: { graph: null, status: "error" } }
    });
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    const payload = payloadOf(recording);
    expect(payload.mode).toBe("greyed");
    expect(payload.resources).toEqual([]);
    expect(payload.updatedAt).toBeNull();
    expect(payload.application).toBeNull();
  });

  it("reports the requested application until the artifact names one", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: { contextRepo: CONTEXT_REPO, deployAppName: DEPLOY_APP }
    });
    expect(
      payloadOf(
        await run(
          `/api/deployed-graph?application=${QUERY_APP}`,
          handleDeployedGraph,
          deps
        )
      ).application
    ).toBe(QUERY_APP);

    const resolved: Calls = { log: [] };
    expect(
      payloadOf(
        await run(
          `/api/deployed-graph?application=${QUERY_APP}`,
          handleDeployedGraph,
          fakes(resolved, {
            state: { contextRepo: CONTEXT_REPO },
            reader: { progress: ARTIFACT_PROGRESS }
          }).deps
        )
      ).application
    ).toBe(ARTIFACT_APP);
  });

  it("records a read failure in the progress log the sibling route serves", async () => {
    const calls: Calls = { log: [] };
    const { deps, state } = fakes(calls, {
      state: { contextRepo: CONTEXT_REPO },
      graphThrows: new Error("artifact listing exploded")
    });
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    expect(recording.status).toBe(200);
    expect(state?.progressMessages).toEqual([
      "Deployed graph status read failed: formatted:artifact listing exploded"
    ]);
    // The very array `/api/progress` answers with.
    const progressRecording = await run("/api/progress", handleProgress, deps);
    expect(progressRecording.body).toBe(
      JSON.stringify({
        messages: [
          "Deployed graph status read failed: formatted:artifact listing exploded"
        ]
      })
    );
  });

  it("appends to an existing progress log rather than replacing it", async () => {
    const calls: Calls = { log: [] };
    const { deps, state } = fakes(calls, {
      state: { contextRepo: CONTEXT_REPO, progressMessages: ["earlier"] },
      progressThrows: new Error("progress exploded")
    });
    await run("/api/deployed-graph", handleDeployedGraph, deps);
    expect(state?.progressMessages).toEqual([
      "earlier",
      "Deployed graph status read failed: formatted:progress exploded"
    ]);
  });

  it("still answers when there is no entry to record the failure on", async () => {
    const calls: Calls = { log: [] };
    const { deps, state } = fakes(calls, {
      missingEntry: true,
      graphThrows: new Error("boom")
    });
    const recording = await run(
      `/api/deployed-graph?repo=${encodeURIComponent(QUERY_REPO)}`,
      handleDeployedGraph,
      deps
    );
    expect(state).toBeUndefined();
    expect(payloadOf(recording).mode).toBe("greyed");
  });
});

// ── Differential oracle ─────────────────────────────────────────────────────
// Verbatim transcriptions of the two branches deleted from the legacy if-chain
// in `server.ts`, kept only so the migrated handlers can be proven identical
// while the fallback still exists. Each side is driven separately against its
// own fakes and its own cloned state, and the two recordings are compared
// afterwards — never through a single shared runner, because these paths mutate
// state and a shared runner can pass while only exercising one side.

interface LegacyPorts {
  readInstanceEntry: GraphsPlanningReadsDependencies["readInstanceEntry"];
  createDeployStatusReader: GraphsPlanningReadsDependencies["createDeployStatusReader"];
  buildDeployStatusMap: GraphsPlanningReadsDependencies["buildDeployStatusMap"];
  buildDeployMessageMap: GraphsPlanningReadsDependencies["buildDeployMessageMap"];
  deployStatusKeys: GraphsPlanningReadsDependencies["deployStatusKeys"];
  projectDeployedGraph: GraphsPlanningReadsDependencies["projectDeployedGraph"];
  canvasGraphResources: GraphsPlanningReadsDependencies["canvasGraphResources"];
  applyDeployMessages: GraphsPlanningReadsDependencies["applyDeployMessages"];
  record: GraphsPlanningReadsDependencies["record"];
  errorMessage: GraphsPlanningReadsDependencies["errorMessage"];
  repoMatchesWorkspace: GraphsPlanningReadsDependencies["repoMatchesWorkspace"];
}

function legacyErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function legacyProgress(
  _url: string,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): void {
  const entry = ports.readInstanceEntry("panel-a");
  const messages = entry?.state?.progressMessages || [];
  res.setHeader("Content-Type", "application/json");
  res.writeHead(200);
  res.end(JSON.stringify({ messages }));
}

async function legacyDeployedGraph(
  url: string,
  res: ServerResponse<IncomingMessage>,
  ports: LegacyPorts
): Promise<void> {
  const entry = ports.readInstanceEntry("panel-a");
  const reqUrl = new URL(url || "/", `http://127.0.0.1`);
  const repo =
    (reqUrl.searchParams.get("repo") || "").trim() ||
    entry?.state?.contextRepo ||
    entry?.state?.deployingRepo ||
    entry?.state?.plannedRepo ||
    entry?.state?.graphTargetRepo ||
    "";
  res.setHeader("Content-Type", "application/json");
  if (!repo) {
    res.writeHead(200);
    res.end(JSON.stringify({ resources: [], repo: "", mode: "greyed" }));
    return;
  }
  const state = entry?.state || {};
  const branch =
    state.workspaceBranch && ports.repoMatchesWorkspace(state, repo) ?
      state.workspaceBranch
    : "main";

  const sessionEnv = state.deployEnvName || state.envName || "";
  const requestedEnv =
    (reqUrl.searchParams.get("environment") || "").trim() || sessionEnv;
  const requestedApp =
    (reqUrl.searchParams.get("application") || "").trim() ||
    state.deployAppName ||
    "";

  const sessionMatchesSelection =
    !requestedEnv ||
    !sessionEnv ||
    requestedEnv.toLowerCase() === sessionEnv.toLowerCase();
  const deploying =
    state.deployStatus === "in_progress" && sessionMatchesSelection;

  const statusByKey = new Map<string, DeployStatus>();
  if (sessionMatchesSelection && Array.isArray(state.deployingResources)) {
    for (const resource of state.deployingResources) {
      const status = resource?.deployStatus as DeployStatus | undefined;
      if (!status || status === "pending") continue;
      for (const key of ports.deployStatusKeys(resource)) {
        if (!statusByKey.has(key)) statusByKey.set(key, status);
      }
    }
  }

  let graph: unknown = null;
  let readOk = false;
  let updatedAt: string | null = null;
  let resolvedApp: string | null = requestedApp || null;
  const messageByKey = new Map<string, string>();
  try {
    const reader = ports.createDeployStatusReader({
      repo,
      environment: requestedEnv,
      application: requestedApp,
      runId: deploying ? (state.deployRunId ?? null) : null
    });
    const result = await reader.graph();
    graph = result.graph;
    readOk = result.status === "ok" || result.status === "stale";
    const progress = await reader.progress();
    updatedAt = progress?.updatedAt || null;
    if (progress?.application) resolvedApp = progress.application;
    for (const [key, status] of ports.buildDeployStatusMap(progress)) {
      if (!statusByKey.has(key)) statusByKey.set(key, status);
    }
    for (const [key, message] of ports.buildDeployMessageMap(progress)) {
      if (!messageByKey.has(key)) messageByKey.set(key, message);
    }
  } catch (e) {
    if (entry?.state) {
      if (!entry.state.progressMessages) entry.state.progressMessages = [];
      entry.state.progressMessages.push(
        `Deployed graph status read failed: ${ports.errorMessage(e)}`
      );
    }
  }
  if (!graph && sessionMatchesSelection && state.deployedGraph)
    graph = state.deployedGraph;

  const mode: "live" | "terminal" | "greyed" =
    deploying ? "live"
    : statusByKey.size > 0 || readOk || graph ? "terminal"
    : "greyed";

  const graphRecord = ports.record(graph);
  let topology: unknown[] =
    Array.isArray(graph) ? graph
    : Array.isArray(graphRecord.resources) ? graphRecord.resources
    : [];
  if (topology.length === 0) {
    topology =
      (sessionMatchesSelection ? state.deployingResources : null) ||
      state.plannedResources ||
      state.graphResources ||
      [];
  }

  const resources = ports.canvasGraphResources(
    ports.projectDeployedGraph(topology, statusByKey)
  );
  ports.applyDeployMessages(resources, messageByKey);
  res.writeHead(200);
  res.end(
    JSON.stringify({
      resources,
      repo,
      branch,
      mode,
      updatedAt,
      application: resolvedApp
    })
  );
}

type Route = "progress" | "deployed-graph";

interface DifferentialCase {
  route: Route;
  query?: Record<string, string>;
  options?: FakeOptions;
}

interface Side {
  recording: Recording;
  calls: string[];
  state: CanvasState | undefined;
  thrown: string | null;
  // Recorded rather than inferred. A side that never ran leaves this false, and
  // `compare` asserts it on BOTH sides — that is what stops a case from silently
  // degenerating into a one-sided test when one implementation throws or
  // short-circuits before the other is reached.
  ran: boolean;
}

function compare(legacy: Side, migrated: Side): void {
  expect(legacy.ran, "legacy side was not driven").toBe(true);
  expect(migrated.ran, "migrated side was not driven").toBe(true);
  expect(migrated.thrown).toEqual(legacy.thrown);
  expect(migrated.recording).toEqual(legacy.recording);
  expect(migrated.calls).toEqual(legacy.calls);
  expect(migrated.state).toEqual(legacy.state);
}

function legacyPortsFrom(deps: GraphsPlanningReadsDependencies): LegacyPorts {
  return {
    readInstanceEntry: deps.readInstanceEntry,
    createDeployStatusReader: deps.createDeployStatusReader,
    buildDeployStatusMap: deps.buildDeployStatusMap,
    buildDeployMessageMap: deps.buildDeployMessageMap,
    deployStatusKeys: deps.deployStatusKeys,
    projectDeployedGraph: deps.projectDeployedGraph,
    canvasGraphResources: deps.canvasGraphResources,
    applyDeployMessages: deps.applyDeployMessages,
    record: deps.record,
    errorMessage: deps.errorMessage,
    repoMatchesWorkspace: deps.repoMatchesWorkspace
  };
}

function urlFor(input: DifferentialCase): string {
  for (const key of Object.keys(input.query ?? {})) {
    if (!KNOWN_QUERY_PARAMS.includes(key)) {
      throw new Error(
        `scripted query parameter "${key}" overrides nothing; expected one of ${KNOWN_QUERY_PARAMS.join(
          ", "
        )}`
      );
    }
  }
  const search = new URLSearchParams(input.query ?? {}).toString();
  return `/api/${input.route}${search ? `?${search}` : ""}`;
}

const LEGACY_TRANSCRIPTIONS: Record<
  Route,
  (
    url: string,
    res: ServerResponse<IncomingMessage>,
    ports: LegacyPorts
  ) => void | Promise<void>
> = {
  progress: legacyProgress,
  "deployed-graph": legacyDeployedGraph
};

async function recordLegacy(input: DifferentialCase): Promise<Side> {
  const calls: Calls = { log: [] };
  const { deps, state } = fakes(calls, input.options ?? {});
  const { recording, response } = recorder();
  // Looked up rather than branched, so an unmapped route leaves `ran` false
  // instead of falling through to some other transcription.
  const transcription = LEGACY_TRANSCRIPTIONS[input.route];
  if (!transcription) {
    return { recording, calls: calls.log, state, thrown: null, ran: false };
  }
  let ran = false;
  try {
    ran = true;
    await transcription(urlFor(input), response, legacyPortsFrom(deps));
  } catch (e) {
    return {
      recording,
      calls: calls.log,
      state,
      thrown: legacyErrorMessage(e),
      ran
    };
  }
  return { recording, calls: calls.log, state, thrown: null, ran };
}

const HANDLERS: Record<Route, Handler> = {
  progress: handleProgress,
  "deployed-graph": handleDeployedGraph
};

async function recordMigrated(input: DifferentialCase): Promise<Side> {
  const calls: Calls = { log: [] };
  const { deps, state } = fakes(calls, input.options ?? {});
  const { recording, response } = recorder();
  // Resolved from a registry rather than branched, so a route this harness
  // forgot to wire leaves `ran` false rather than quietly comparing two empty
  // recordings.
  const handler = HANDLERS[input.route];
  if (!handler) {
    return { recording, calls: calls.log, state, thrown: null, ran: false };
  }
  const context = createRequestContext(
    request(urlFor(input)),
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  let ran = false;
  try {
    ran = true;
    await handler(context, deps);
  } catch (e) {
    return {
      recording,
      calls: calls.log,
      state,
      thrown: legacyErrorMessage(e),
      ran
    };
  }
  return { recording, calls: calls.log, state, thrown: null, ran };
}

describe("graphs-planning reads legacy/migrated differential contract", () => {
  // Fixture-precondition guard. Several cases below only discriminate while an
  // unstated relationship between fixture values holds — if two repos in the
  // precedence chain collapsed to the same string, if two resource sets shared a
  // name, or if the artifact application equalled the session one, the
  // corresponding cases would keep passing while silently re-testing a path
  // another case already covers.
  it("holds the fixture preconditions the differential cases depend on", () => {
    const repos = [
      QUERY_REPO,
      CONTEXT_REPO,
      DEPLOYING_REPO,
      PLANNED_REPO,
      GRAPH_TARGET_REPO
    ];
    expect(new Set(repos).size).toBe(repos.length);
    // The workspace-branch case needs the workspace repo to be one of the
    // chain's repos, otherwise it could never match.
    expect(repos).toContain(WORKSPACE_REPO);

    const names = [
      ...DEPLOYING_RESOURCES,
      ...PLANNED_RESOURCES,
      ...GRAPH_RESOURCES,
      ...DEPLOYED_GRAPH,
      ...PUBLISHED_GRAPH
    ].map((resource) => resource.name);
    expect(new Set(names).size).toBe(names.length);

    // The environment cases turn on a case-insensitive comparison, so the two
    // environments must differ by more than case, and the session environment
    // must not already be lowercase or the case-folding case would be inert.
    expect(DEPLOY_ENV.toLowerCase()).not.toBe(OTHER_ENV.toLowerCase());
    expect(DEPLOY_ENV).not.toBe(DEPLOY_ENV.toLowerCase());
    expect(SESSION_ENV.toLowerCase()).not.toBe(OTHER_ENV.toLowerCase());

    // The resolved-application cases only discriminate while all three names
    // differ.
    expect(new Set([DEPLOY_APP, ARTIFACT_APP, QUERY_APP]).size).toBe(3);
    expect(ARTIFACT_PROGRESS.application).toBe(ARTIFACT_APP);

    // The seeding case needs the artifact to disagree with the monitor on a
    // resource they both key, or first-wins would be unobservable.
    expect(ARTIFACT_PROGRESS.resources[0].status).toBe("failed");
    expect(keysOf(ARTIFACT_PROGRESS.resources[0])).toEqual(
      keysOf(DEPLOYING_RESOURCES[0])
    );

    // The reader defaults must express "nothing known", so a case that scripts
    // a successful read is genuinely changing the outcome.
    expect(DEFAULT_READER.graph).toEqual({ graph: null, status: "missing" });
    expect(DEFAULT_READER.progress).toBeNull();
  });

  it("rejects a scripted state field that overrides nothing", () => {
    expect(() =>
      fakes(
        { log: [] },
        {
          state: { deployinggRepo: DEPLOYING_REPO } as unknown as CanvasState
        }
      )
    ).toThrow("overrides nothing");
  });

  it("rejects a scripted reader result that overrides nothing", () => {
    expect(() =>
      fakes(
        { log: [] },
        {
          reader: {
            graphs: DEFAULT_READER.graph
          } as unknown as FakeOptions["reader"]
        }
      )
    ).toThrow("overrides nothing");
  });

  it("rejects a scripted query parameter that overrides nothing", () => {
    expect(() =>
      urlFor({ route: "deployed-graph", query: { repoo: QUERY_REPO } })
    ).toThrow("overrides nothing");
  });

  it.each<[string, DifferentialCase]>([
    ["empty log", { route: "progress" }],
    [
      "populated log",
      {
        route: "progress",
        options: { state: { progressMessages: ["a", "b"] } }
      }
    ],
    ["missing entry", { route: "progress", options: { missingEntry: true } }],
    [
      // Falsy but present: `|| []` substitutes the empty array where `?? []`
      // would serialize the empty string. Pins the operator, not just the
      // nullish case.
      "falsy non-nullish log",
      {
        route: "progress",
        options: {
          state: { progressMessages: "" } as unknown as CanvasState
        }
      }
    ],
    [
      // Truthy non-array log: serialized straight through, no coercion.
      "non-array log",
      {
        route: "progress",
        options: {
          state: { progressMessages: "oops" } as unknown as CanvasState
        }
      }
    ]
  ])("matches /api/progress for: %s", async (_label, input) => {
    const legacy = await recordLegacy(input);
    const migrated = await recordMigrated(input);
    compare(legacy, migrated);
  });

  it.each<[string, DifferentialCase]>([
    ["unresolvable repo", { route: "deployed-graph" }],
    [
      "missing entry",
      { route: "deployed-graph", options: { missingEntry: true } }
    ],
    [
      "missing entry with a query repo",
      {
        route: "deployed-graph",
        query: { repo: QUERY_REPO },
        options: { missingEntry: true }
      }
    ],
    [
      "whitespace-only query repo",
      { route: "deployed-graph", query: { repo: "   " } }
    ],
    [
      "query repo shadowing every state repo",
      {
        route: "deployed-graph",
        query: { repo: `  ${QUERY_REPO}  ` },
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployingRepo: DEPLOYING_REPO,
            plannedRepo: PLANNED_REPO,
            graphTargetRepo: GRAPH_TARGET_REPO
          }
        }
      }
    ],
    [
      "context repo",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployingRepo: DEPLOYING_REPO,
            plannedRepo: PLANNED_REPO,
            graphTargetRepo: GRAPH_TARGET_REPO
          }
        }
      }
    ],
    [
      "deploying repo",
      {
        route: "deployed-graph",
        options: {
          state: {
            deployingRepo: DEPLOYING_REPO,
            plannedRepo: PLANNED_REPO,
            graphTargetRepo: GRAPH_TARGET_REPO
          }
        }
      }
    ],
    [
      "planned repo",
      {
        route: "deployed-graph",
        options: {
          state: {
            plannedRepo: PLANNED_REPO,
            graphTargetRepo: GRAPH_TARGET_REPO
          }
        }
      }
    ],
    [
      "graph target repo",
      {
        route: "deployed-graph",
        options: { state: { graphTargetRepo: GRAPH_TARGET_REPO } }
      }
    ],
    [
      "workspace branch for the workspace repo",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            workspaceRepo: WORKSPACE_REPO,
            workspaceBranch: WORKSPACE_BRANCH
          }
        }
      }
    ],
    [
      "workspace branch for another repo",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: PLANNED_REPO,
            workspaceRepo: WORKSPACE_REPO,
            workspaceBranch: WORKSPACE_BRANCH
          }
        }
      }
    ],
    [
      "workspace repo with no workspace branch",
      {
        route: "deployed-graph",
        options: {
          state: { contextRepo: CONTEXT_REPO, workspaceRepo: WORKSPACE_REPO }
        }
      }
    ],
    [
      "live deploy scoped to run id zero",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployStatus: "in_progress",
            deployEnvName: DEPLOY_ENV,
            deployAppName: DEPLOY_APP,
            deployRunId: 0
          }
        }
      }
    ],
    [
      "live deploy with no run id",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployStatus: "in_progress",
            deployEnvName: DEPLOY_ENV
          }
        }
      }
    ],
    [
      "deploy for another environment",
      {
        route: "deployed-graph",
        query: { environment: OTHER_ENV },
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployStatus: "in_progress",
            deployEnvName: SESSION_ENV,
            deployRunId: 7,
            deployedGraph: DEPLOYED_GRAPH,
            deployingResources: [
              {
                id: "res-deploying",
                name: "deploying-node",
                deployStatus: "success"
              }
            ]
          }
        }
      }
    ],
    [
      "environment matched case-insensitively",
      {
        route: "deployed-graph",
        query: { environment: DEPLOY_ENV.toUpperCase() },
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployStatus: "in_progress",
            deployEnvName: DEPLOY_ENV
          }
        }
      }
    ],
    [
      "requested environment with no session environment",
      {
        route: "deployed-graph",
        query: { environment: OTHER_ENV },
        options: {
          state: { contextRepo: CONTEXT_REPO, deployStatus: "in_progress" }
        }
      }
    ],
    [
      "blank requested environment with a session environment",
      {
        route: "deployed-graph",
        query: { environment: "  " },
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployStatus: "in_progress",
            envName: SESSION_ENV
          }
        }
      }
    ],
    [
      "session environment preferring the deploy name",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployEnvName: DEPLOY_ENV,
            envName: SESSION_ENV
          }
        }
      }
    ],
    [
      "requested application shadowing the session one",
      {
        route: "deployed-graph",
        query: { application: `  ${QUERY_APP}  ` },
        options: {
          state: { contextRepo: CONTEXT_REPO, deployAppName: DEPLOY_APP }
        }
      }
    ],
    [
      "application resolved by the artifact",
      {
        route: "deployed-graph",
        query: { application: QUERY_APP },
        options: {
          state: { contextRepo: CONTEXT_REPO },
          reader: { progress: ARTIFACT_PROGRESS }
        }
      }
    ],
    [
      "artifact without an application",
      {
        route: "deployed-graph",
        options: {
          state: { contextRepo: CONTEXT_REPO },
          reader: {
            progress: progressPayload([], { application: "", updatedAt: "" })
          }
        }
      }
    ],
    [
      "monitor status seeded before the artifact",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployingResources: [
              {
                id: "res-deploying",
                name: "deploying-node",
                type: "Radius.Compute",
                deployStatus: "success"
              }
            ]
          },
          reader: { progress: ARTIFACT_PROGRESS }
        }
      }
    ],
    [
      "pending and statusless monitor resources",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployingResources: [
              {
                id: "res-deploying",
                name: "deploying-node",
                deployStatus: "pending"
              },
              { id: "res-planned", name: "planned-node" }
            ]
          }
        }
      }
    ],
    [
      "duplicate monitor keys",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployingResources: [
              {
                id: "res-deploying",
                name: "deploying-node",
                deployStatus: "success"
              },
              {
                id: "res-deploying",
                name: "deploying-node",
                deployStatus: "failed"
              }
            ]
          }
        }
      }
    ],
    [
      "non-array deploying resources",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployingResources: null,
            plannedResources: PLANNED_RESOURCES
          }
        }
      }
    ],
    [
      "published graph array",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployingResources: DEPLOYING_RESOURCES,
            plannedResources: PLANNED_RESOURCES,
            graphResources: GRAPH_RESOURCES
          },
          reader: { graph: { graph: PUBLISHED_GRAPH, status: "ok" } }
        }
      }
    ],
    [
      "published graph object",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            plannedResources: PLANNED_RESOURCES
          },
          reader: {
            graph: { graph: { resources: PUBLISHED_GRAPH }, status: "ok" }
          }
        }
      }
    ],
    [
      // Truthy non-array `resources`: the Array.isArray guard rejects it and the
      // modeled fallback renders. Without the guard a string would be carried
      // into the projection with a non-zero `length`, defeating the fallback.
      "published graph object with a truthy non-array resource field",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            plannedResources: PLANNED_RESOURCES
          },
          reader: {
            graph: { graph: { resources: "not-an-array" }, status: "ok" }
          }
        }
      }
    ],
    [
      "published graph object with an empty resource array",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            plannedResources: PLANNED_RESOURCES
          },
          reader: { graph: { graph: { resources: [] }, status: "ok" } }
        }
      }
    ],
    [
      "published graph object with no resource array",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            graphResources: GRAPH_RESOURCES
          },
          reader: { graph: { graph: { other: true }, status: "ok" } }
        }
      }
    ],
    [
      "scalar published graph",
      {
        route: "deployed-graph",
        options: {
          state: { contextRepo: CONTEXT_REPO },
          reader: { graph: { graph: 42, status: "ok" } }
        }
      }
    ],
    [
      "deploying topology fallback",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployingResources: DEPLOYING_RESOURCES,
            plannedResources: PLANNED_RESOURCES,
            graphResources: GRAPH_RESOURCES
          }
        }
      }
    ],
    [
      "planned topology fallback",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            plannedResources: PLANNED_RESOURCES,
            graphResources: GRAPH_RESOURCES
          }
        }
      }
    ],
    [
      "graph topology fallback",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            graphResources: GRAPH_RESOURCES
          }
        }
      }
    ],
    [
      "cached deployed graph fallback",
      {
        route: "deployed-graph",
        options: {
          state: { contextRepo: CONTEXT_REPO, deployedGraph: DEPLOYED_GRAPH }
        }
      }
    ],
    [
      "cached deployed graph beaten by a published one",
      {
        route: "deployed-graph",
        options: {
          state: { contextRepo: CONTEXT_REPO, deployedGraph: DEPLOYED_GRAPH },
          reader: { graph: { graph: PUBLISHED_GRAPH, status: "ok" } }
        }
      }
    ],
    [
      "stale read",
      {
        route: "deployed-graph",
        options: {
          state: { contextRepo: CONTEXT_REPO },
          reader: { graph: { graph: null, status: "stale" } }
        }
      }
    ],
    [
      "ok read with no graph",
      {
        route: "deployed-graph",
        options: {
          state: { contextRepo: CONTEXT_REPO },
          reader: { graph: { graph: null, status: "ok" } }
        }
      }
    ],
    [
      "errored read",
      {
        route: "deployed-graph",
        options: {
          state: { contextRepo: CONTEXT_REPO },
          reader: { graph: { graph: null, status: "error" } }
        }
      }
    ],
    [
      "artifact messages",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            plannedResources: [{ id: "res-deploying", name: "deploying-node" }]
          },
          reader: { progress: ARTIFACT_PROGRESS }
        }
      }
    ],
    [
      "artifact messages with duplicate keys",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            plannedResources: [{ id: "res-dup", name: "dup-node" }]
          },
          reader: {
            progress: progressPayload([
              {
                id: "res-dup",
                name: "dup-node",
                type: "Radius.Compute",
                status: "success",
                message: "first message"
              },
              {
                id: "res-dup",
                name: "dup-node",
                type: "Radius.Compute",
                status: "failed",
                message: "second message"
              }
            ])
          }
        }
      }
    ],
    [
      "artifact resource without a message",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            plannedResources: [{ id: "res-quiet", name: "quiet-node" }]
          },
          reader: {
            progress: progressPayload([
              {
                id: "res-quiet",
                name: "quiet-node",
                type: "Radius.Compute",
                status: "success"
              }
            ])
          }
        }
      }
    ],
    [
      "throwing graph read",
      {
        route: "deployed-graph",
        options: {
          state: { contextRepo: CONTEXT_REPO },
          graphThrows: new Error("artifact listing exploded")
        }
      }
    ],
    [
      "throwing progress read over an existing log",
      {
        route: "deployed-graph",
        options: {
          state: { contextRepo: CONTEXT_REPO, progressMessages: ["earlier"] },
          progressThrows: new Error("progress exploded")
        }
      }
    ],
    [
      "throwing read with seeded statuses",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployingResources: DEPLOYING_RESOURCES.map((resource) => ({
              ...resource,
              deployStatus: "failed" as const
            }))
          },
          graphThrows: new Error("boom")
        }
      }
    ],
    [
      "throwing read with a missing entry",
      {
        route: "deployed-graph",
        query: { repo: QUERY_REPO },
        options: { missingEntry: true, graphThrows: new Error("boom") }
      }
    ],
    // Truthy non-string values driven through every coercion and fallback
    // expression the handler transcribes. These are the cases that catch a
    // "behavior-neutral" cleanup that is not: a shared `String(...)` helper
    // swallows a throw the legacy expression raises, and V8 builds the
    // TypeError message from the *source text* of the failing expression, so
    // even the thrown message is observable. Each expression below is
    // transcribed inline for exactly that reason.
    [
      "non-string context repo",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: 42,
            workspaceRepo: 42,
            workspaceBranch: WORKSPACE_BRANCH
          } as unknown as CanvasState
        }
      }
    ],
    [
      "non-string workspace branch",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            workspaceRepo: CONTEXT_REPO,
            workspaceBranch: 5
          } as unknown as CanvasState
        }
      }
    ],
    [
      // `requestedEnv.toLowerCase()` is unguarded, so a truthy non-string
      // session environment throws out of the handler before the try block.
      // Both sides must throw the same message, which is built from the source
      // text of the expression.
      "non-string session environment",
      {
        route: "deployed-graph",
        query: { environment: OTHER_ENV },
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployEnvName: 123
          } as unknown as CanvasState
        }
      }
    ],
    [
      "non-string session application",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployAppName: 7
          } as unknown as CanvasState
        }
      }
    ],
    [
      // `state.deployRunId ?? null` keeps an empty string; `|| null` would not.
      "empty-string run id while deploying",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployStatus: "in_progress",
            deployRunId: ""
          }
        }
      }
    ],
    [
      // `entry.progressMessages` is only checked for truthiness before `.push`,
      // so a truthy non-array throws inside the catch and out of the handler.
      "non-array progress log during a read failure",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            progressMessages: "oops"
          } as unknown as CanvasState,
          graphThrows: new Error("boom")
        }
      }
    ],
    [
      "non-string deployed graph",
      {
        route: "deployed-graph",
        options: {
          state: {
            contextRepo: CONTEXT_REPO,
            deployedGraph: 9
          } as unknown as CanvasState
        }
      }
    ]
  ])("matches /api/deployed-graph for: %s", async (_label, input) => {
    const legacy = await recordLegacy(input);
    const migrated = await recordMigrated(input);
    compare(legacy, migrated);
  });
});
