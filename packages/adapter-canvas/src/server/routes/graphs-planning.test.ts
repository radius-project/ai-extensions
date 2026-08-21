import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { DeployStatus } from "@radius-project/core";
import { createRequestContext } from "../request-context.js";
import {
  createGraphsPlanningRoutes,
  handleDeployedGraph,
  handleProgress,
  type GraphsPlanningReadsDependencies
} from "./graphs-planning.js";
import type { DeployProgress } from "../../deploy-artifacts.js";
import { GRAPH_APP_BICEP_TIMEOUT_MESSAGE } from "../../graph-progress-contract.js";
import type {
  CanvasGraphResource,
  CanvasState,
  GraphProgressRecord,
  GraphProgressView
} from "../../shared.js";
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
// Every repo below is distinct, which makes the five-step repo precedence chain
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

function graphProgressState(
  view: GraphProgressView,
  overrides: Partial<GraphProgressRecord> = {}
): CanvasState {
  return {
    graphProgressRecords: {
      [view]: {
        graphBuildEvents: [],
        graphProgressGeneration: 1,
        graphProgressStartedAtMs: 0,
        graphProgressActive: false,
        graphProgressView: view,
        graphProgressKey: "",
        graphProgressOwner: 1,
        graphProgressAwaitingModel: false,
        ...overrides
      }
    }
  };
}

// Every state field the two routes may read. A case that misspells one would
// otherwise be completely silent: the override would land on a field nothing
// reads, and the case would collapse into the plain default while still
// asserting the same outcome.
const KNOWN_STATE_FIELDS: readonly (keyof CanvasState)[] = [
  "contextRepo",
  "contextBranch",
  "deployingRepo",
  "deployingBranch",
  "plannedRepo",
  "plannedBranch",
  "graphTargetRepo",
  "graphBranch",
  "workspaceRepo",
  "workspaceBranch",
  "deployEnvName",
  "envName",
  "deployAppName",
  "deployStatus",
  "deployErrorKind",
  "deployingResources",
  "deployRunId",
  "deployedGraph",
  "plannedResources",
  "graphResources",
  "graphProgressRecords",
  "progressMessages"
];

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
  modeledError?: string;
  modeledRetry?: boolean;
  modeledStatus?: number;
  modeledResources?: CanvasGraphResource[];
  nowMs?: number;
}

// Key derivation shared by the `deployStatusKeys` fake and the two map-builder
// fakes, so the first-wins seeding order is genuinely observable: seeded and
// artifact statuses collide on the same keys only because they agree here.
function keysOf(resource: unknown): string[] {
  const value = (resource ?? {}) as { id?: unknown; name?: unknown };
  return [String(value.id ?? ""), String(value.name ?? "")].filter(Boolean);
}

// One independent set of fakes plus the mutable state they read and write.
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
  // `entry?.state?.x`, and one of those expressions can throw with a message V8
  // builds from its source text.
  const entry = state === undefined ? undefined : { state };
  const reader = { ...DEFAULT_READER, ...(options.reader ?? {}) };
  const nowMs = options.nowMs ?? 0;
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
    loadModeledGraph: (_instanceId, repo, branch) => {
      calls.log.push(`loadModeledGraph(${repo}|${branch})`);
      if (state) {
        state.graphTargetRepo = repo;
        state.graphBranch = branch;
        state.graphResources = structuredClone(options.modeledResources ?? []);
      }
      return Promise.resolve({
        status: options.modeledStatus ?? 200,
        error: options.modeledError,
        retry: options.modeledRetry
      });
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
    settleDeployStatuses: (resources, conclusion) => {
      calls.log.push(`settleDeployStatuses(${conclusion})`);
      for (const resource of resources) {
        if (conclusion === "success") {
          resource.deployStatus = "success";
        } else if (
          resource.deployStatus === undefined ||
          resource.deployStatus === "pending" ||
          resource.deployStatus === "in_progress"
        ) {
          resource.deployStatus = "failed";
        }
      }
    },
    // Deliberately distinct from the raw message, so a handler that formats the
    // read failure itself instead of using the injected formatter is detectable.
    errorMessage: (error) =>
      `formatted:${error instanceof Error ? error.message : String(error)}`,
    repoMatchesWorkspace: (current, repo) => {
      calls.log.push(`repoMatchesWorkspace(${current.workspaceRepo}|${repo})`);
      return !!current.workspaceRepo && current.workspaceRepo === repo;
    },
    now: () => nowMs
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
    const routes = createGraphsPlanningRoutes(dependencies());
    expect(Object.keys(routes)).toEqual([
      "GET /api/progress",
      "GET /api/deployed-graph"
    ]);
  });

  it("dispatches both registry entries to their handlers", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, { state: { progressMessages: ["hello"] } });
    const routes = createGraphsPlanningRoutes(deps);
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

  it("serves typed graph events without dropping deployed diagnostics", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        progressMessages: ["diagnostic"],
        ...graphProgressState("graph", {
          graphBuildEvents: [
            {
              sequence: 1,
              stage: "building_graph",
              state: "running",
              detail: "Building graph."
            }
          ]
        })
      }
    });
    const recording = await run("/api/progress", handleProgress, deps);
    expect(JSON.parse(recording.body)).toEqual({
      messages: ["diagnostic"],
      generation: 1,
      active: false,
      view: "graph",
      elapsedMs: 0,
      events: [
        {
          sequence: 1,
          stage: "building_graph",
          state: "running",
          detail: "Building graph."
        }
      ]
    });
  });

  // A build outlives the page that started it: the user can navigate away and
  // come back, and the app.bicep handoff runs entirely outside the panel. The
  // record therefore reports its own liveness, owner and age, and a returning
  // page adopts those instead of restarting its clock at zero.
  it("reports the record as live, its owning view, and real elapsed time", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      nowMs: 61_000,
      state: graphProgressState("diff", {
        graphProgressActive: true,
        graphProgressStartedAtMs: 1_000,
        graphBuildEvents: [
          {
            sequence: 1,
            stage: "building_graph",
            state: "running",
            detail: "Building graph."
          }
        ]
      })
    });
    const recording = await run("/api/progress", handleProgress, deps);
    const payload = JSON.parse(recording.body) as Record<string, unknown>;
    expect(payload.active).toBe(true);
    expect(payload.view).toBe("diff");
    expect(payload.elapsedMs).toBe(60_000);
  });

  it("serves the requested view without letting a newer view replace it", async () => {
    const calls: Calls = { log: [] };
    const graph = graphProgressState("graph", {
      graphProgressActive: true,
      graphProgressStartedAtMs: 1_000,
      graphBuildEvents: [
        {
          sequence: 1,
          stage: "creating_model",
          state: "running",
          detail: "Waiting for the modeled application."
        }
      ]
    }).graphProgressRecords?.graph;
    const planned = graphProgressState("planned", {
      graphProgressActive: true,
      graphProgressStartedAtMs: 2_000,
      graphBuildEvents: [
        {
          sequence: 1,
          stage: "resolving_recipes",
          state: "running",
          detail: "Planning the deployment."
        }
      ]
    }).graphProgressRecords?.planned;
    const { deps } = fakes(calls, {
      nowMs: 3_000,
      state: { graphProgressRecords: { graph, planned } }
    });

    const modeled = JSON.parse(
      (await run("/api/progress?view=graph", handleProgress, deps)).body
    ) as Record<string, unknown>;
    const ambient = JSON.parse(
      (await run("/api/progress", handleProgress, deps)).body
    ) as Record<string, unknown>;

    expect(modeled.view).toBe("graph");
    expect(modeled.elapsedMs).toBe(2_000);
    expect(ambient.view).toBe("planned");
  });

  // A record that settled still carries its stages so the page can render the
  // finished checklist, but it must not claim to still be running.
  it("reports a settled record as no longer in flight", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      nowMs: 5_000,
      state: graphProgressState("graph", {
        graphProgressActive: false,
        graphProgressStartedAtMs: 2_000,
        graphBuildEvents: [
          {
            sequence: 1,
            stage: "building_graph",
            state: "succeeded",
            detail: ""
          }
        ]
      })
    });
    const payload = JSON.parse(
      (await run("/api/progress", handleProgress, deps)).body
    ) as Record<string, unknown>;
    expect(payload.active).toBe(false);
    expect(payload.view).toBe("graph");
    expect(payload.elapsedMs).toBe(3_000);
  });

  it("expires an abandoned app.bicep wait on the server clock", async () => {
    const calls: Calls = { log: [] };
    const scriptedState = graphProgressState("graph", {
      graphProgressActive: true,
      graphProgressAwaitingModel: true,
      graphProgressDeadlineAtMs: 60_000,
      graphProgressStartedAtMs: 1_000,
      graphBuildEvents: [
        {
          sequence: 1,
          stage: "creating_model",
          state: "running",
          detail: "Copilot is creating the model."
        }
      ]
    });
    const { deps, state } = fakes(calls, {
      nowMs: 60_000,
      state: scriptedState
    });

    const payload = JSON.parse(
      (await run("/api/progress", handleProgress, deps)).body
    ) as Record<string, unknown>;

    expect(payload.active).toBe(false);
    expect(state?.graphProgressRecords?.graph?.graphProgressAwaitingModel).toBe(
      false
    );
    expect(
      state?.graphProgressRecords?.graph?.graphProgressDeadlineAtMs
    ).toBeUndefined();
    expect(
      state?.graphProgressRecords?.graph?.graphBuildEvents.at(-1)
    ).toMatchObject({
      stage: "creating_model",
      state: "failed",
      detail: GRAPH_APP_BICEP_TIMEOUT_MESSAGE
    });
  });

  // A clock that jumped backwards must not produce a negative age, which would
  // render as a nonsense elapsed time.
  it("clamps elapsed time when the clock moves backwards", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      nowMs: 500,
      state: graphProgressState("graph", {
        graphProgressActive: true,
        graphProgressStartedAtMs: 4_000,
        graphBuildEvents: [
          { sequence: 1, stage: "building_graph", state: "running", detail: "" }
        ]
      })
    });
    const payload = JSON.parse(
      (await run("/api/progress", handleProgress, deps)).body
    ) as Record<string, unknown>;
    expect(payload.elapsedMs).toBe(0);
  });

  it("identifies the owning stream so a reader can reject a stale snapshot", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: graphProgressState("graph", {
        graphProgressGeneration: 4,
        graphBuildEvents: [
          {
            sequence: 1,
            stage: "checking_model",
            state: "running",
            detail: "Checking for an application model."
          }
        ]
      })
    });
    const recording = await run("/api/progress", handleProgress, deps);
    expect(JSON.parse(recording.body).generation).toBe(4);
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
      modeledResources: [
        {
          id: "res-deploying",
          name: "deploying-node",
          type: "Radius.Compute"
        }
      ],
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

  it("settles every modeled node from the fresh terminal monitor outcome", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployStatus: "complete",
        deployingResources: [
          {
            id: "res-deploying",
            name: "deploying-node",
            type: "Radius.Compute",
            deployStatus: "success"
          }
        ]
      },
      modeledResources: [DEPLOYING_RESOURCES[0], PLANNED_RESOURCES[0]],
      reader: {
        progress: progressPayload(
          [
            {
              id: "res-deploying",
              name: "deploying-node",
              type: "Radius.Compute",
              status: "failed"
            }
          ],
          { state: "failed" }
        )
      }
    });

    const payload = payloadOf(
      await run("/api/deployed-graph", handleDeployedGraph, deps)
    );

    expect(payload.resources.map((resource) => resource.deployStatus)).toEqual([
      "success",
      "success"
    ]);
    expect(calls.log).toContain("settleDeployStatuses(success)");
  });

  it("lets a different artifact run supersede stale terminal monitor state", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployStatus: "complete",
        deployRunId: 7,
        deployingResources: [
          {
            ...DEPLOYING_RESOURCES[0],
            deployStatus: "success"
          }
        ]
      },
      modeledResources: DEPLOYING_RESOURCES,
      reader: {
        progress: progressPayload(
          [
            {
              id: "res-deploying",
              name: "deploying-node",
              type: "Radius.Compute",
              status: "failed"
            }
          ],
          { runId: 8, state: "failed" }
        )
      }
    });

    const payload = payloadOf(
      await run("/api/deployed-graph", handleDeployedGraph, deps)
    );

    expect(payload.resources[0].deployStatus).toBe("failed");
    expect(calls.log).toContain("settleDeployStatuses(failure)");
    expect(calls.log).not.toContain("settleDeployStatuses(success)");
  });

  it("does not settle a pre-dispatch session failure", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployStatus: "failed",
        deployErrorKind: "branch-not-pushed"
      },
      modeledResources: GRAPH_RESOURCES
    });

    const payload = payloadOf(
      await run("/api/deployed-graph", handleDeployedGraph, deps)
    );

    expect(payload.mode).toBe("greyed");
    expect(payload.resources[0].deployStatus).toBe("pending");
    expect(
      calls.log.some((call) => call.startsWith("settleDeployStatuses"))
    ).toBe(false);
  });

  it("settles unfinished nodes after a confirmed in-session run failure", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployStatus: "failed",
        deployRunId: 7,
        deployingResources: [
          {
            ...DEPLOYING_RESOURCES[0],
            deployStatus: "success"
          }
        ]
      },
      modeledResources: [DEPLOYING_RESOURCES[0], PLANNED_RESOURCES[0]]
    });

    const payload = payloadOf(
      await run("/api/deployed-graph", handleDeployedGraph, deps)
    );

    expect(payload.resources.map((resource) => resource.deployStatus)).toEqual([
      "success",
      "failed"
    ]);
    expect(calls.log).toContain("settleDeployStatuses(failure)");
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
      },
      modeledResources: [DEPLOYING_RESOURCES[0], PLANNED_RESOURCES[0]]
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

  it("keeps modeled topology when the published graph is sparse", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        graphTargetRepo: CONTEXT_REPO,
        graphBranch: "main",
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
      "graph-node"
    ]);
    expect(calls.log).not.toContain(`loadModeledGraph(${CONTEXT_REPO}|main)`);
  });

  it("builds modeled topology instead of reading published graph resources", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: { contextRepo: CONTEXT_REPO },
      modeledResources: GRAPH_RESOURCES,
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
      "graph-node"
    ]);
    expect(calls.log).toContain(`loadModeledGraph(${CONTEXT_REPO}|main)`);
  });

  it("surfaces a cold modeled-graph workflow failure", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: { contextRepo: CONTEXT_REPO },
      modeledError: "Application model compilation failed.",
      modeledRetry: true,
      modeledStatus: 400
    });

    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    expect(recording.status).toBe(400);
    expect(recording.body).toBe(
      '{"error":"Application model compilation failed.","retry":true}'
    );
  });

  it("does not use deploying or planned resources as topology", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: {
        contextRepo: CONTEXT_REPO,
        deployingResources: DEPLOYING_RESOURCES,
        plannedResources: PLANNED_RESOURCES
      },
      modeledResources: GRAPH_RESOURCES
    });
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    expect(payloadOf(recording).resources.map((r) => r.name)).toEqual([
      "graph-node"
    ]);
  });

  it("uses a cached deployed graph only as terminal metadata", async () => {
    const calls: Calls = { log: [] };
    const { deps } = fakes(calls, {
      state: { contextRepo: CONTEXT_REPO, deployedGraph: DEPLOYED_GRAPH },
      modeledResources: GRAPH_RESOURCES
    });
    const recording = await run(
      "/api/deployed-graph",
      handleDeployedGraph,
      deps
    );
    const payload = payloadOf(recording);
    expect(payload.mode).toBe("terminal");
    expect(payload.resources.map((r) => r.name)).toEqual(["graph-node"]);
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

  it("replaces a stale deployed diagnostic instead of growing the log", async () => {
    const calls: Calls = { log: [] };
    const { deps, state } = fakes(calls, {
      state: { contextRepo: CONTEXT_REPO, progressMessages: ["earlier"] },
      progressThrows: new Error("progress exploded")
    });
    await run("/api/deployed-graph", handleDeployedGraph, deps);
    expect(state?.progressMessages).toEqual([
      "Deployed graph status read failed: formatted:progress exploded"
    ]);
  });

  it("clears a previous deployed diagnostic after a successful read", async () => {
    const calls: Calls = { log: [] };
    const { deps, state } = fakes(calls, {
      state: { contextRepo: CONTEXT_REPO, progressMessages: ["earlier"] }
    });

    await run("/api/deployed-graph", handleDeployedGraph, deps);

    expect(state?.progressMessages).toEqual([]);
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
