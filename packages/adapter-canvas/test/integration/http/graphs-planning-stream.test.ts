import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import {
  createGraphsPlanningStreamRoutes,
  type LoadGraphStreamBicepSelection
} from "../../../src/server/routes/graphs-planning-reads.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { CanvasGraphResource, CanvasState } from "../../../src/shared.js";
import type { CanvasServerEntry } from "../../../src/server/types.js";

let container: CanvasServerContainer | undefined;

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

interface Script {
  selection?: LoadGraphStreamBicepSelection;
  fetchThrows?: Error;
  buildThrows?: Error;
  commit?: boolean;
}

interface Harness {
  state: CanvasState;
  script: Script;
  handoffs: { repo: string; branch: string }[];
  setEntryMissing(missing: boolean): void;
}

// The pure source-ref helpers are the real ones, so the wire behavior is
// production's: token derivation, first-wins supersession and the state
// mutations it performs all run for real. Only the seams that would otherwise
// spawn a subprocess or hit the network are scripted — `fetchBicepSelection`
// (GitHub/workspace read), `radArtifactsDirForSelection` (staging) and
// `buildGraphViaRad` (the `rad` CLI).
function start(): Harness {
  const state: CanvasState = {};
  const script: Script = {};
  const handoffs: { repo: string; branch: string }[] = [];
  let entryMissing = false;

  const entryFor = (
    resolved: CanvasServerEntry | undefined
  ): CanvasServerEntry | undefined => (entryMissing ? undefined : resolved);

  const routes = createTestRouteTable(
    createGraphsPlanningStreamRoutes({
      readInstanceEntry: () => entryFor({ state } as CanvasServerEntry),
      defaultBranchForState: (current) =>
        current?.contextBranch || current?.workspaceBranch || "main",
      // The real source-ref token derivation and first-wins commit guard, run
      // against the live state the handler mutates.
      prepareSourceRef: (entry, context) => {
        const token = `graph|${context.repo}|${context.branch}`;
        entry.state.sourceRefContexts ??= {};
        entry.state.sourceRefContexts.graph = {
          ...context,
          view: "graph",
          token
        };
        return { token };
      },
      commitSourceRef: (entry, resources, _context, expectedToken) => {
        const current = entry.state.sourceRefContexts?.graph?.token;
        if (expectedToken && current !== expectedToken) return false;
        if (script.commit === false) return false;
        entry.state.graphResources = resources;
        return true;
      },
      triggerAppBicepHandoff: (_entry, repo, branch) => {
        handoffs.push({ repo, branch });
      },
      fetchBicepSelection: (_entry, _repo, _branch) => {
        if (script.fetchThrows) return Promise.reject(script.fetchThrows);
        return Promise.resolve(
          script.selection ?? {
            content: "resource x",
            fromWorkspace: true,
            branch: "main",
            bicepPath: ".radius/app.bicep"
          }
        );
      },
      workspaceGraphJsonPath: (_current, bicepRepoPath) =>
        `/ws/${bicepRepoPath}.graph.json`,
      radArtifactsDirForSelection: () =>
        Promise.resolve({ dir: "/tmp/rad", remote: true }),
      buildGraphViaRad: (_content, _bicepPath, options) => {
        if (script.buildThrows) return Promise.reject(script.buildThrows);
        // Emit two log lines through the real progress callback so the stream
        // carries handler-authored frames, not just terminal ones.
        options.log("compiling app.bicep...");
        return Promise.resolve([
          { id: "res-a", name: "api", type: "Radius.Compute/containers" }
        ]);
      },
      canvasGraphResources: (values) => values as CanvasGraphResource[],
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error)
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
    script,
    handoffs,
    setEntryMissing(missing) {
      entryMissing = missing;
    }
  };
}

// Read the whole SSE body off the socket, exactly as bytes arrived, and parse it
// into ordered frames. This asserts the framing a client actually receives, not
// a re-serialized approximation: the split on the blank-line terminator and the
// leftover-empty-segment check catch a dropped terminator or a trailing newline.
async function readFrames(
  response: Response
): Promise<{ raw: string; frames: { event: string; data: unknown }[] }> {
  const raw = await response.text();
  const parts = raw.split("\n\n");
  expect(parts[parts.length - 1]).toBe("");
  const frames = parts.slice(0, -1).map((part) => {
    const match = /^event: (\w+)\ndata: (.*)$/s.exec(part);
    if (!match) throw new Error(`malformed SSE frame: ${JSON.stringify(part)}`);
    return { event: match[1], data: JSON.parse(match[2]) };
  });
  return { raw, frames };
}

describe("graphs-planning load-graph-stream real-loopback HIT", () => {
  it("sets SSE headers and streams progress then a reload done frame over a real socket", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("connection")).toBe("keep-alive");

    const { raw, frames } = await readFrames(response);
    expect(frames).toEqual([
      {
        event: "progress",
        data: { message: "Checking octo/app for existing app.bicep..." }
      },
      {
        event: "progress",
        data: { message: "Found existing app.bicep — parsing resources..." }
      },
      { event: "progress", data: { message: "compiling app.bicep..." } },
      {
        event: "progress",
        data: { message: "Mapped 1 resource(s) — rendering graph..." }
      },
      { event: "done", data: { reload: true } }
    ]);
    // Byte-exact framing: no leading data, single trailing terminator.
    expect(raw.startsWith("event: progress\ndata: ")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(true);
    expect(raw.endsWith("\n\n\n")).toBe(false);

    // The compile committed the modeled resources and recorded provenance on the
    // live state, over the wire.
    expect(harness.state.graphTargetRepo).toBe("octo/app");
    expect(harness.state.graphBranch).toBe("main");
    expect(harness.state.graphFromWorkspace).toBe(true);
    expect(harness.state.activeGraphView).toBe("graph");
    expect(harness.state.graphResources).toEqual([
      { id: "res-a", name: "api", type: "Radius.Compute/containers" }
    ]);

    // GET-only: a POST to the same path still falls through to the fallback.
    const posted = await fetch(
      `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp`,
      { method: "POST" }
    );
    expect(posted.status).toBe(418);
  });

  it("answers 503 with a plain body and no event-stream header when the instance is gone", async () => {
    const harness = start();
    harness.setEntryMissing(true);
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp`
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).not.toBe("text/event-stream");
    expect(await response.text()).toBe("Canvas server state is unavailable.");
  });

  it("streams a single repository-required done frame when repo is empty", async () => {
    start();
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/load-graph-stream`);
    expect(response.status).toBe(200);
    const { frames } = await readFrames(response);
    expect(frames).toEqual([
      { event: "done", data: { error: "Please select a repository." } }
    ]);
  });

  it("hands off generation and streams needsAppBicep when no app.bicep exists", async () => {
    const harness = start();
    harness.script.selection = {
      content: null,
      fromWorkspace: false,
      branch: "main",
      bicepPath: ""
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp&branch=feature%2Fx`
    );
    const { frames } = await readFrames(response);
    expect(frames.at(-1)).toEqual({
      event: "done",
      data: {
        error:
          "Copilot is generating .radius/app.bicep with the Radius app-bicep skill.",
        needsAppBicep: true,
        repo: "octo/app",
        branch: "feature/x"
      }
    });
    // The query branch reached the handoff, not the state default.
    expect(harness.handoffs).toEqual([
      { repo: "octo/app", branch: "feature/x" }
    ]);
  });

  it("streams a formatted error done frame when the compile fails", async () => {
    const harness = start();
    harness.script.buildThrows = new Error("rad exited 1");
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp`
    );
    const { frames } = await readFrames(response);
    expect(frames.at(-1)).toEqual({
      event: "done",
      data: { error: "rad exited 1" }
    });
    // A failed compile leaves no provenance behind.
    expect(harness.state.graphTargetRepo).toBeUndefined();
  });
});
