import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import type { CanvasServerEntry } from "../types.js";
import {
  createGraphsPlanningStreamRoutes,
  handleLoadGraphStream,
  type GraphsPlanningStreamDependencies,
  type LoadGraphStreamBicepSelection
} from "./graphs-planning.js";

// ── Recorder ─────────────────────────────────────────────────────────────────
// The stream handler writes SSE frames through `response.write` and terminates
// with `response.end`, so — unlike the reads recorder — this one captures the
// full ordered step log including every `write`. SSE fidelity is byte-order
// sensitive: an event that is set/written in the wrong order relative to the
// headers is a wire regression, so `steps` records header sets, `writeHead`,
// each `write`, and `end` in the exact sequence they happened.
interface Recording {
  headers: Record<string, string>;
  status: number;
  steps: string[];
  // The concatenated SSE payload as a client reading the socket would see it,
  // built only from `write` calls (not `end`, which the stream always calls with
  // no argument). This is what the frame assertions parse.
  stream: string;
  ended: boolean;
}

function recorder() {
  const recording: Recording = {
    headers: {},
    status: 0,
    steps: [],
    stream: "",
    ended: false
  };
  const target = {
    setHeader(name: string, value: string) {
      recording.headers[name] = value;
      recording.steps.push(`set:${name}=${value}`);
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      recording.steps.push(`writeHead:${status}`);
      return this;
    },
    write(chunk: string) {
      recording.stream += chunk;
      recording.steps.push(`write:${chunk}`);
      return true;
    },
    end(value = "") {
      if (value) recording.stream += value;
      recording.steps.push(value ? `end:${value}` : "end");
      recording.ended = true;
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

// ── Fixtures ─────────────────────────────────────────────────────────────────
const REPO = "octo/app";
const DEFAULT_BRANCH = "main";
const QUERY_BRANCH = "feature/x";
const BICEP_PATH = ".radius/app.bicep";
const RESOURCES: CanvasGraphResource[] = [
  { id: "res-1", name: "node-1", type: "Radius.Compute" }
];

function selection(
  overrides: Partial<LoadGraphStreamBicepSelection> = {}
): LoadGraphStreamBicepSelection {
  return {
    content: "resource x",
    fromWorkspace: true,
    branch: DEFAULT_BRANCH,
    bicepPath: BICEP_PATH,
    ...overrides
  };
}

// A minimal but complete `CanvasServerEntry`. The handler only reads/writes
// `state`, but the type requires the transport fields, so they are present and
// inert.
function entryWith(state: CanvasState): CanvasServerEntry {
  return {
    server: {} as CanvasServerEntry["server"],
    baseUrl: "",
    url: "",
    page: "",
    state
  };
}

interface Options {
  missingEntry?: boolean;
  readThrows?: unknown;
  state?: CanvasState;
  selection?: LoadGraphStreamBicepSelection;
  fetchThrows?: unknown;
  buildThrows?: unknown;
  commit?: boolean;
  token?: string;
}

interface Fakes {
  deps: GraphsPlanningStreamDependencies;
  entry: CanvasServerEntry | undefined;
  calls: string[];
}

// Every seam logs its call and — where it matters — is deliberately distinct
// from an identity/no-op so a handler that skips it produces a visibly different
// result. Any seam the scenario does not script throws, so a handler reaching
// for an unspecified dependency fails loudly rather than silently.
function fakes(options: Options = {}): Fakes {
  const calls: string[] = [];
  const entry =
    options.missingEntry ? undefined : entryWith(options.state ?? {});
  const sel = options.selection ?? selection();
  const deps: GraphsPlanningStreamDependencies = {
    readInstanceEntry: (instanceId) => {
      calls.push(`readInstanceEntry(${instanceId})`);
      if (options.readThrows) throw options.readThrows;
      return entry;
    },
    defaultBranchForState: (state) => {
      calls.push(`defaultBranchForState(${JSON.stringify(state)})`);
      return DEFAULT_BRANCH;
    },
    prepareSourceRef: (givenEntry, context) => {
      calls.push(`prepareSourceRef(${JSON.stringify(context)})`);
      expect(givenEntry).toBe(entry);
      return { token: options.token ?? "token-1" };
    },
    commitSourceRef: (givenEntry, resources, context, expectedToken) => {
      calls.push(
        `commitSourceRef(${JSON.stringify(context)}|${expectedToken}|${JSON.stringify(
          resources
        )})`
      );
      expect(givenEntry).toBe(entry);
      return options.commit ?? true;
    },
    triggerAppBicepHandoff: (givenEntry, repo, branch) => {
      calls.push(`triggerAppBicepHandoff(${repo}|${branch})`);
      expect(givenEntry).toBe(entry);
    },
    fetchBicepSelection: (givenEntry, repo, branch) => {
      calls.push(`fetchBicepSelection(${repo}|${branch})`);
      expect(givenEntry).toBe(entry);
      if (options.fetchThrows) return Promise.reject(options.fetchThrows);
      return Promise.resolve(sel);
    },
    workspaceGraphJsonPath: (_state, bicepRepoPath) => {
      calls.push(`workspaceGraphJsonPath(${bicepRepoPath})`);
      return `/ws/${bicepRepoPath}.graph.json`;
    },
    radArtifactsDirForSelection: (opts) => {
      calls.push(
        `radArtifactsDirForSelection(${opts.isLocal}|${opts.repo}|${opts.branch}|${opts.bicepRepoPath})`
      );
      return Promise.resolve({ dir: "/tmp/rad", remote: true });
    },
    buildGraphViaRad: (_content, bicepPath, opts) => {
      calls.push(
        `buildGraphViaRad(${bicepPath}|save=${opts.saveGraphJsonTo}|dir=${opts.radArtifactsDir}|cleanup=${opts.cleanupRadArtifactsDir})`
      );
      if (options.buildThrows) return Promise.reject(options.buildThrows);
      return Promise.resolve(RESOURCES as unknown[]);
    },
    // Marked rather than identity so a handler that skips the normalizer yields a
    // visibly different payload.
    canvasGraphResources: (values) => {
      calls.push(`canvasGraphResources(${values.length})`);
      return values.map((value) => ({
        ...(value as CanvasGraphResource),
        normalized: true
      }));
    },
    // Distinct from the raw message so a handler that formats the error itself
    // instead of using the injected formatter is detectable.
    errorMessage: (error) =>
      `formatted:${error instanceof Error ? error.message : String(error)}`
  };
  return { deps, entry, calls };
}

async function run(
  url: string,
  deps: GraphsPlanningStreamDependencies
): Promise<Recording> {
  const { recording, response } = recorder();
  const context = createRequestContext(
    request(url),
    response,
    "panel-a",
    new Map<string, CanvasServerEntry>()
  );
  await handleLoadGraphStream(context, deps);
  return recording;
}

// Parse the concatenated SSE stream into ordered { event, data } frames,
// asserting the exact framing along the way: every frame is `event: <name>\n`
// then `data: <json>\n` then a blank-line terminator `\n`. Anything that does
// not match that shape is a framing regression and fails the parse.
function frames(stream: string): { event: string; data: unknown }[] {
  const out: { event: string; data: unknown }[] = [];
  // Terminator is a blank line: two consecutive newlines. Splitting on it and
  // dropping the trailing empty segment reconstructs exactly the frames the
  // handler wrote, and a missing terminator shows up as a leftover segment.
  const parts = stream.split("\n\n");
  expect(parts[parts.length - 1]).toBe("");
  for (const part of parts.slice(0, -1)) {
    const match = /^event: (\w+)\ndata: (.*)$/s.exec(part);
    if (!match) throw new Error(`malformed SSE frame: ${JSON.stringify(part)}`);
    out.push({ event: match[1], data: JSON.parse(match[2]) });
  }
  return out;
}

describe("graphs-planning load-graph-stream route", () => {
  it("declares exactly the one route it owns", () => {
    const routes = createGraphsPlanningStreamRoutes(fakes().deps);
    expect(Object.keys(routes)).toEqual(["GET /api/load-graph-stream"]);
  });

  it("dispatches the registry entry to the handler", async () => {
    const { deps } = fakes({ selection: selection({ content: null }) });
    const routes = createGraphsPlanningStreamRoutes(deps);
    const { recording, response } = recorder();
    const context = createRequestContext(
      request(`/api/load-graph-stream?repo=${REPO}`),
      response,
      "panel-a",
      new Map<string, CanvasServerEntry>()
    );
    await routes["GET /api/load-graph-stream"](context);
    expect(recording.status).toBe(200);
    expect(recording.ended).toBe(true);
  });

  it("answers 503 with a plain-text body and NO SSE header when the instance has no entry", async () => {
    const { deps } = fakes({ missingEntry: true });
    const recording = await run(`/api/load-graph-stream?repo=${REPO}`, deps);
    expect(recording.status).toBe(503);
    // The 503 precedes every `setHeader`, so a missing instance never receives
    // an event-stream content type. This is the sharp edge of the port.
    expect(recording.headers).toEqual({});
    expect(recording.steps).toEqual([
      "writeHead:503",
      "end:Canvas server state is unavailable."
    ]);
    expect(recording.stream).toBe("Canvas server state is unavailable.");
  });

  it("sets the three SSE headers before any frame and terminates with a done frame", async () => {
    const { deps } = fakes({ selection: selection({ content: null }) });
    const recording = await run(`/api/load-graph-stream?repo=${REPO}`, deps);
    expect(recording.headers).toEqual({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    // Headers and writeHead(200) come before the first byte of the body.
    expect(recording.steps.slice(0, 4)).toEqual([
      "set:Content-Type=text/event-stream",
      "set:Cache-Control=no-cache",
      "set:Connection=keep-alive",
      "writeHead:200"
    ]);
    expect(recording.status).toBe(200);
    expect(recording.ended).toBe(true);
  });

  it("streams a repository-required done frame with no progress when repo is empty", async () => {
    const { deps, calls } = fakes();
    const recording = await run("/api/load-graph-stream", deps);
    // The empty-repo exit happens after the SSE headers are written but before
    // any progress frame or bicep fetch.
    expect(frames(recording.stream)).toEqual([
      { event: "done", data: { error: "Please select a repository." } }
    ]);
    expect(calls.some((c) => c.startsWith("fetchBicepSelection"))).toBe(false);
    expect(recording.ended).toBe(true);
  });

  it("hands off app.bicep generation and streams a needsAppBicep done frame when no bicep exists", async () => {
    const { deps, calls } = fakes({
      selection: selection({ content: null })
    });
    const recording = await run(`/api/load-graph-stream?repo=${REPO}`, deps);
    const parsed = frames(recording.stream);
    expect(parsed[0]).toEqual({
      event: "progress",
      data: { message: `Checking ${REPO} for existing app.bicep...` }
    });
    expect(parsed[1]).toEqual({
      event: "done",
      data: {
        error:
          "Copilot is generating .radius/app.bicep with the Radius app-bicep skill.",
        needsAppBicep: true,
        repo: REPO,
        branch: DEFAULT_BRANCH
      }
    });
    expect(calls).toContain(
      `triggerAppBicepHandoff(${REPO}|${DEFAULT_BRANCH})`
    );
    // The compile never runs on the handoff path.
    expect(calls.some((c) => c.startsWith("buildGraphViaRad"))).toBe(false);
  });

  it("models the app, commits the source ref, records provenance, and streams a reload done frame", async () => {
    const state: CanvasState = {};
    const { deps, calls, entry } = fakes({ state });
    const recording = await run(`/api/load-graph-stream?repo=${REPO}`, deps);
    const parsed = frames(recording.stream);
    expect(parsed.map((f) => f.event)).toEqual([
      "progress",
      "progress",
      "progress",
      "done"
    ]);
    expect(parsed[1]).toEqual({
      event: "progress",
      data: { message: "Found existing app.bicep — parsing resources..." }
    });
    expect(parsed[2]).toEqual({
      event: "progress",
      data: { message: "Mapped 1 resource(s) — rendering graph..." }
    });
    expect(parsed[3]).toEqual({ event: "done", data: { reload: true } });

    // Provenance mutations on the captured entry's state.
    expect(entry?.state.graphTargetRepo).toBe(REPO);
    expect(entry?.state.graphBranch).toBe(DEFAULT_BRANCH);
    expect(entry?.state.graphFromWorkspace).toBe(true);
    expect(entry?.state.activeGraphView).toBe("graph");

    // The normalized resources are what get committed, after the map, guarded by
    // the prepared token.
    const commit = calls.find((c) => c.startsWith("commitSourceRef"));
    expect(commit).toContain(`"repo":"${REPO}"`);
    expect(commit).toContain(`"branch":"${DEFAULT_BRANCH}"`);
    expect(commit).toContain("token-1");
    expect(commit).toContain('"normalized":true');
    // Workspace graph-json path is derived only because the selection is local.
    expect(calls).toContain(`workspaceGraphJsonPath(${BICEP_PATH})`);
  });

  it("uses the query branch over the state default when ?branch is present", async () => {
    const { deps, calls } = fakes();
    await run(
      `/api/load-graph-stream?repo=${REPO}&branch=${encodeURIComponent(
        QUERY_BRANCH
      )}`,
      deps
    );
    expect(calls).toContain(`fetchBicepSelection(${REPO}|${QUERY_BRANCH})`);
    // The default-branch seam is not consulted when the query supplies a branch.
    expect(calls.some((c) => c.startsWith("defaultBranchForState"))).toBe(
      false
    );
  });

  it("passes the empty graph-json path and skips workspace derivation for a remote selection", async () => {
    const { deps, calls } = fakes({
      selection: selection({ fromWorkspace: false, bicepPath: "" })
    });
    const recording = await run(`/api/load-graph-stream?repo=${REPO}`, deps);
    // No workspace path derivation for a remote (non-workspace) selection.
    expect(calls.some((c) => c.startsWith("workspaceGraphJsonPath"))).toBe(
      false
    );
    // A missing bicep path falls back to the default in both the artifacts
    // resolver and the compiler.
    expect(calls).toContain(
      `radArtifactsDirForSelection(false|${REPO}|${DEFAULT_BRANCH}|${BICEP_PATH})`
    );
    expect(calls).toContain(
      `buildGraphViaRad(${BICEP_PATH}|save=|dir=/tmp/rad|cleanup=true)`
    );
    expect(frames(recording.stream).at(-1)).toEqual({
      event: "done",
      data: { reload: true }
    });
  });

  // ── Legacy/migrated differential contract ────────────────────────────────────
  //
  // Phase 2 keeps the legacy dispatcher alive for residual routes, so migrations
  // also retain an executable transcription of the arm they removed. This oracle
  // does not call the migrated handler: it parses the raw request URL, performs
  // the legacy guards, writes the response, and invokes legacy-named ports
  // independently. Both sides receive fresh state and fakes, then `compareSides`
  // pins the complete ordered response transcript (including exact SSE bytes and
  // the terminal `end`), dependency calls, state mutation, and thrown outcome.
  interface LegacyStreamPorts {
    serversGet(instanceId: string): CanvasServerEntry | undefined;
    defaultBranchForState(state: CanvasState | undefined): string;
    prepareSourceRefResources(
      entry: CanvasServerEntry,
      view: "graph",
      context: { repo: string; branch: string }
    ): { token: string };
    setSourceRefResources(
      entry: CanvasServerEntry,
      view: "graph",
      resources: CanvasGraphResource[],
      context: { repo: string; branch: string },
      expectedToken: string
    ): boolean;
    triggerAppBicepHandoff(
      entry: CanvasServerEntry,
      repo: string,
      branch: string,
      page: "graph"
    ): void;
    fetchBicepSelection(
      entry: CanvasServerEntry,
      repo: string,
      branch: string
    ): Promise<LoadGraphStreamBicepSelection>;
    workspaceGraphJsonPath(state: CanvasState, bicepRepoPath: string): string;
    radArtifactsDirForSelection(
      options: Parameters<
        GraphsPlanningStreamDependencies["radArtifactsDirForSelection"]
      >[0] & { github: object }
    ): ReturnType<
      GraphsPlanningStreamDependencies["radArtifactsDirForSelection"]
    >;
    buildGraphViaRad: GraphsPlanningStreamDependencies["buildGraphViaRad"];
    canvasGraphResources: GraphsPlanningStreamDependencies["canvasGraphResources"];
    errorMessage: GraphsPlanningStreamDependencies["errorMessage"];
  }

  // Verbatim control flow from the removed `server.ts` arm, with only global
  // helpers replaced by the legacy-named ports above.
  async function legacyLoadGraphStream(
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>,
    instanceId: string,
    ports: LegacyStreamPorts
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://127.0.0.1`);
    const repo = url.searchParams.get("repo") || "";
    const entry = ports.serversGet(instanceId);
    if (!entry) {
      res.writeHead(503);
      res.end("Canvas server state is unavailable.");
      return;
    }
    const branch =
      url.searchParams.get("branch") ||
      ports.defaultBranchForState(entry?.state);
    const sourceRefContext =
      entry ?
        ports.prepareSourceRefResources(entry, "graph", { repo, branch })
      : null;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.writeHead(200);

    const sendProgress = (message: string): void => {
      res.write(`event: progress\ndata: ${JSON.stringify({ message })}\n\n`);
    };
    const sendDone = (data: unknown): void => {
      res.write(`event: done\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    };

    if (!repo) {
      sendDone({ error: "Please select a repository." });
      return;
    }

    try {
      sendProgress(`Checking ${repo} for existing app.bicep...`);
      const selected = await ports.fetchBicepSelection(entry, repo, branch);
      const content = selected.content;

      if (content) {
        sendProgress("Found existing app.bicep — parsing resources...");
      } else {
        ports.triggerAppBicepHandoff(entry, repo, branch, "graph");
        sendDone({
          error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
          needsAppBicep: true,
          repo,
          branch
        });
        return;
      }

      const graphJsonPath =
        entry && selected.fromWorkspace ?
          ports.workspaceGraphJsonPath(entry.state, selected.bicepPath)
        : "";
      const { dir: radArtifactsDir, remote: radArtifactsRemote } =
        await ports.radArtifactsDirForSelection({
          isLocal: !!(entry && selected.fromWorkspace),
          state: entry?.state,
          github: {},
          repo,
          branch,
          bicepRepoPath: selected.bicepPath || ".radius/app.bicep",
          log: sendProgress
        });
      const resources = ports.canvasGraphResources(
        await ports.buildGraphViaRad(
          content,
          selected.bicepPath || ".radius/app.bicep",
          {
            log: sendProgress,
            saveGraphJsonTo: graphJsonPath,
            radArtifactsDir,
            cleanupRadArtifactsDir: radArtifactsRemote
          }
        )
      );
      sendProgress(
        `Mapped ${resources.length} resource(s) — rendering graph...`
      );

      if (entry && sourceRefContext) {
        if (
          !ports.setSourceRefResources(
            entry,
            "graph",
            resources,
            { repo, branch },
            sourceRefContext.token
          )
        ) {
          sendDone({ stale: true });
          return;
        }
        entry.state.graphTargetRepo = repo;
        entry.state.graphBranch = branch;
        entry.state.graphFromWorkspace = selected.fromWorkspace;
        entry.state.activeGraphView = "graph";
      }

      sendDone({ reload: true });
    } catch (e) {
      sendDone({ error: ports.errorMessage(e) });
    }
  }

  interface DifferentialSide {
    recording: Recording;
    calls: string[];
    state: CanvasState | undefined;
    thrown: string | null;
    ran: boolean;
  }

  interface DifferentialCase {
    url: string;
    options?: Options;
  }

  function freshOptions(options: Options = {}): Options {
    return {
      ...options,
      state: options.state ? structuredClone(options.state) : undefined,
      selection:
        options.selection ? structuredClone(options.selection) : undefined
    };
  }

  function legacyPortsFrom(
    deps: GraphsPlanningStreamDependencies
  ): LegacyStreamPorts {
    return {
      serversGet: deps.readInstanceEntry,
      defaultBranchForState: deps.defaultBranchForState,
      prepareSourceRefResources: (entry, _view, context) =>
        deps.prepareSourceRef(entry, context),
      setSourceRefResources: (
        entry,
        _view,
        resources,
        context,
        expectedToken
      ) => deps.commitSourceRef(entry, resources, context, expectedToken),
      triggerAppBicepHandoff: (entry, repo, branch, _page) =>
        deps.triggerAppBicepHandoff(entry, repo, branch),
      fetchBicepSelection: deps.fetchBicepSelection,
      workspaceGraphJsonPath: deps.workspaceGraphJsonPath,
      radArtifactsDirForSelection: ({ github: _github, ...options }) =>
        deps.radArtifactsDirForSelection(options),
      buildGraphViaRad: deps.buildGraphViaRad,
      canvasGraphResources: deps.canvasGraphResources,
      errorMessage: deps.errorMessage
    };
  }

  function thrownMessage(error: unknown): string {
    return error instanceof Error ?
        `${error.name}: ${error.message}`
      : String(error);
  }

  async function recordLegacySide(
    input: DifferentialCase
  ): Promise<DifferentialSide> {
    const { deps, entry, calls } = fakes(freshOptions(input.options));
    const { recording, response } = recorder();
    let ran = false;
    try {
      ran = true;
      await legacyLoadGraphStream(
        request(input.url),
        response,
        "panel-a",
        legacyPortsFrom(deps)
      );
    } catch (error) {
      return {
        recording,
        calls,
        state: entry?.state,
        thrown: thrownMessage(error),
        ran
      };
    }
    return { recording, calls, state: entry?.state, thrown: null, ran };
  }

  async function recordMigratedSide(
    input: DifferentialCase
  ): Promise<DifferentialSide> {
    const { deps, entry, calls } = fakes(freshOptions(input.options));
    const { recording, response } = recorder();
    const context = createRequestContext(
      request(input.url),
      response,
      "panel-a",
      new Map<string, CanvasServerEntry>()
    );
    let ran = false;
    try {
      ran = true;
      await handleLoadGraphStream(context, deps);
    } catch (error) {
      return {
        recording,
        calls,
        state: entry?.state,
        thrown: thrownMessage(error),
        ran
      };
    }
    return { recording, calls, state: entry?.state, thrown: null, ran };
  }

  function compareSides(
    legacy: DifferentialSide,
    migrated: DifferentialSide
  ): void {
    expect(legacy.ran, "legacy side was not driven").toBe(true);
    expect(migrated.ran, "migrated side was not driven").toBe(true);
    expect(migrated.thrown).toEqual(legacy.thrown);
    expect(migrated.recording).toEqual(legacy.recording);
    expect(migrated.calls).toEqual(legacy.calls);
    expect(migrated.state).toEqual(legacy.state);
  }

  describe("load-graph-stream legacy/migrated differential contract", () => {
    it.each<[string, DifferentialCase]>([
      [
        "successful local compile",
        {
          url: `/api/load-graph-stream?repo=${REPO}&branch=${QUERY_BRANCH}`,
          options: { state: { activeGraphView: "planned" } }
        }
      ],
      [
        "missing entry",
        {
          url: `/api/load-graph-stream?repo=${REPO}`,
          options: { missingEntry: true }
        }
      ],
      [
        "app.bicep handoff",
        {
          url: `/api/load-graph-stream?repo=${REPO}`,
          options: { selection: selection({ content: null }) }
        }
      ],
      [
        "stale source-ref commit",
        {
          url: `/api/load-graph-stream?repo=${REPO}`,
          options: { commit: false }
        }
      ],
      [
        "build failure",
        {
          url: `/api/load-graph-stream?repo=${REPO}`,
          options: { buildThrows: new Error("rad failed") }
        }
      ],
      [
        "entry lookup throws before headers",
        {
          url: `/api/load-graph-stream?repo=${REPO}`,
          options: { readThrows: new Error("lookup failed") }
        }
      ]
    ])("matches the removed legacy arm for: %s", async (_label, input) => {
      const legacy = await recordLegacySide(input);
      const migrated = await recordMigratedSide(input);
      compareSides(legacy, migrated);
    });
  });

  it("streams a stale done frame and skips provenance when the source ref is superseded", async () => {
    const state: CanvasState = {};
    const { deps, entry } = fakes({ state, commit: false });
    const recording = await run(`/api/load-graph-stream?repo=${REPO}`, deps);
    expect(frames(recording.stream).at(-1)).toEqual({
      event: "done",
      data: { stale: true }
    });
    // A superseded request must not overwrite the newer request's provenance.
    expect(entry?.state.graphTargetRepo).toBeUndefined();
    expect(entry?.state.activeGraphView).toBeUndefined();
  });

  it("streams a formatted error done frame when the bicep fetch throws", async () => {
    const { deps } = fakes({ fetchThrows: new Error("boom") });
    const recording = await run(`/api/load-graph-stream?repo=${REPO}`, deps);
    // The error is formatted through the injected formatter, not raw.
    expect(frames(recording.stream).at(-1)).toEqual({
      event: "done",
      data: { error: "formatted:boom" }
    });
  });

  it("streams a formatted error done frame when the compile throws", async () => {
    const { deps } = fakes({ buildThrows: new Error("rad failed") });
    const recording = await run(`/api/load-graph-stream?repo=${REPO}`, deps);
    expect(frames(recording.stream).at(-1)).toEqual({
      event: "done",
      data: { error: "formatted:rad failed" }
    });
  });

  it("frames every event as event/data with a blank-line terminator and a single trailing terminator", async () => {
    const { deps } = fakes();
    const recording = await run(`/api/load-graph-stream?repo=${REPO}`, deps);
    // Byte-level framing: each frame is `event: <name>\ndata: <json>\n\n`, and
    // the stream ends with exactly one terminator (no trailing extra newline).
    expect(recording.stream).toMatch(/^(event: \w+\ndata: .*\n\n)+$/s);
    expect(recording.stream.endsWith("\n\n")).toBe(true);
    expect(recording.stream.endsWith("\n\n\n")).toBe(false);
    // The terminal frame is written and then `end()` is called with no body.
    const lastWrite = recording.steps
      .filter((s) => s.startsWith("write:"))
      .at(-1);
    expect(lastWrite).toContain("event: done");
    expect(recording.steps.at(-1)).toBe("end");
  });
});
