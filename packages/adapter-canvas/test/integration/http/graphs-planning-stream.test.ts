import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RadProcessError } from "@radius-project/adapter-shared";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import {
  createGraphsPlanningStreamRoutes,
  type LoadGraphStreamBicepSelection
} from "../../../src/server/routes/graphs-planning.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import { GRAPH_MODELING_FAILURE_MESSAGE } from "../../../src/graph-progress-contract.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type { CanvasGraphResource, CanvasState } from "../../../src/shared.js";
import type { CanvasServerEntry } from "../../../src/server/types.js";
import type { WorkspaceBranchResolution } from "../../../src/workspace.js";

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
  // When set, buildGraphViaRad emits its progress line, then blocks on this
  // promise before resolving. Lets a test prove progress frames reach the socket
  // WHILE the build is still in flight, not just once the stream has ended.
  buildGate?: Promise<void>;
  branchResolutionThrows?: Error;
  branchResolution?: WorkspaceBranchResolution;
}

interface Harness {
  state: CanvasState;
  script: Script;
  handoffs: { repo: string; branch: string }[];
  setEntryMissing(missing: boolean): void;
}

// This is a wire-level route test with controlled source-ref fakes. The fakes
// model token preparation and stale-commit rejection but deliberately do not
// claim to reproduce the source-ref helpers' wider invalidation and queueing
// behavior. Network, staging, and subprocess seams are scripted as well.
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
      resolveBranchForRequest: (_entry, _repo, requestedBranch) => {
        if (script.branchResolutionThrows) {
          return Promise.reject(script.branchResolutionThrows);
        }
        return Promise.resolve({
          ...(script.branchResolution ?? {
            status: "resolved" as const,
            branch:
              requestedBranch ||
              state.contextBranch ||
              state.workspaceBranch ||
              "main",
            followsWorkspaceBranch: false
          })
        });
      },
      commitBranchResolution: () => true,
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
      isCurrentSourceRef: (entry, expectedToken) =>
        entry.state.sourceRefContexts?.graph?.token === expectedToken,
      triggerAppBicepHandoff: (_entry, repo, branch) => {
        handoffs.push({ repo, branch });
      },
      triggerGraphRepairHandoff: () => ({
        attempt: 1,
        maxAttempts: 3,
        repairing: true,
        repairExhausted: false
      }),
      clearGraphRepairAttempt: () => {},
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
      listBranchPaths: () => Promise.resolve([]),
      workspaceGraphJsonPath: (_current, bicepRepoPath) =>
        `/ws/${bicepRepoPath}.graph.json`,
      radArtifactsDirForSelection: () =>
        Promise.resolve({ dir: "/tmp/rad", remote: true }),
      buildGraphViaRad: async (_content, _bicepPath, options) => {
        if (script.buildThrows) return Promise.reject(script.buildThrows);
        // Emit two log lines through the real progress callback so the stream
        // carries handler-authored frames, not just terminal ones.
        options.log("compiling app.bicep...");
        // Block here while a gate is held so a test can observe the emitted
        // progress frame on the socket before the build resolves.
        if (script.buildGate) await script.buildGate;
        return [
          { id: "res-a", name: "api", type: "Radius.Compute/containers" }
        ];
      },
      canvasGraphResources: (values) => values as CanvasGraphResource[],
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error),
      logError: () => {}
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

// Incrementally drain the SSE body from the socket, yielding parsed frames as
// their blank-line terminators arrive. Unlike `readFrames`, this does NOT wait
// for `end()`: it lets a test assert that early progress frames are flushed
// while the handler is still mid-build. A buffering regression that withheld
// every frame until the stream closed would hang `next()` here and fail.
function frameStream(response: Response): {
  next(): Promise<{ event: string; data: unknown }>;
  cancel(): Promise<void>;
} {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: { event: string; data: unknown }[] = [];

  const parse = (part: string): { event: string; data: unknown } => {
    const match = /^event: (\w+)\ndata: (.*)$/s.exec(part);
    if (!match) throw new Error(`malformed SSE frame: ${JSON.stringify(part)}`);
    return { event: match[1], data: JSON.parse(match[2]) };
  };

  const drainBuffer = (): void => {
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      pending.push(parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf("\n\n");
    }
  };

  return {
    async next() {
      while (pending.length === 0) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended before a frame arrived");
        buffer += decoder.decode(value, { stream: true });
        drainBuffer();
      }
      return pending.shift()!;
    },
    async cancel() {
      await reader.cancel();
    }
  };
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

    // GET-only: a POST to the same path reaches unmatched routing.
    const posted = await fetch(
      `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp`,
      { method: "POST" }
    );
    expect(posted.status).toBe(404);
  });

  it("streams the canonical workspace branch over the real socket", async () => {
    const harness = start();
    harness.script.branchResolution = {
      status: "resolved",
      branch: "renamed-worktree",
      followsWorkspaceBranch: true,
      workspaceSnapshot: {
        workspaceBranch: "old-name",
        contextBranch: "old-name"
      }
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp&branch=old-name&followWorkspaceBranch=true`
    );
    const result = await readFrames(response);

    expect(result.frames.at(-1)).toEqual({
      event: "done",
      data: {
        reload: true,
        resolvedBranch: "renamed-worktree"
      }
    });
  });

  it("streams branch resolution failures over the real socket", async () => {
    const harness = start();
    harness.script.branchResolutionThrows = new Error("branch probe crashed");
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp`
    );
    const result = await readFrames(response);

    expect(response.status).toBe(200);
    expect(result.frames).toEqual([
      {
        event: "done",
        data: { error: "branch probe crashed" }
      }
    ]);
  });

  it("does not replace source state when the repository is missing", async () => {
    const harness = start();
    harness.state.graphResources = [
      { id: "existing", name: "existing", type: "Radius.Compute/containers" }
    ];
    harness.state.sourceRefContexts = {
      graph: {
        view: "graph",
        repo: "octo/app",
        branch: "main",
        token: "graph|octo/app|main"
      }
    };
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(`${entry.baseUrl}/api/load-graph-stream`);
    const result = await readFrames(response);

    expect(result.frames).toEqual([
      {
        event: "done",
        data: { error: "Please select a repository." }
      }
    ]);
    expect(harness.state.graphResources).toEqual([
      { id: "existing", name: "existing", type: "Radius.Compute/containers" }
    ]);
    expect(harness.state.sourceRefContexts.graph).toMatchObject({
      repo: "octo/app",
      branch: "main",
      token: "graph|octo/app|main"
    });
  });

  it("flushes progress frames on the socket while the build is still in flight", async () => {
    const harness = start();
    // Hold the build open so the only way the first frames can be read is if the
    // handler flushed them incrementally rather than buffering to end().
    let releaseBuild!: () => void;
    harness.script.buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp`
    );
    const stream = frameStream(response);

    // These three arrive from a build that has NOT resolved yet — proof the
    // stream is live, not a single buffered response.
    expect(await stream.next()).toEqual({
      event: "progress",
      data: { message: "Checking octo/app for existing app.bicep..." }
    });
    expect(await stream.next()).toEqual({
      event: "progress",
      data: { message: "Found existing app.bicep — parsing resources..." }
    });
    expect(await stream.next()).toEqual({
      event: "progress",
      data: { message: "compiling app.bicep..." }
    });
    // The build has not committed yet, so no terminal state has been written.
    expect(harness.state.graphResources).toBeUndefined();

    releaseBuild();

    expect(await stream.next()).toEqual({
      event: "progress",
      data: { message: "Mapped 1 resource(s) — rendering graph..." }
    });
    expect(await stream.next()).toEqual({
      event: "done",
      data: { reload: true }
    });
    await stream.cancel();
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

  it("keeps compile diagnostics out of the terminal done frame", async () => {
    const harness = start();
    harness.script.buildThrows = new Error("rad app graph failed", {
      cause: new RadProcessError("rad exited 1", "BCP035: invalid model", "")
    });
    const entry = await container!.getOrCreate("panel-a");

    const response = await fetch(
      `${entry.baseUrl}/api/load-graph-stream?repo=octo%2Fapp`
    );
    const { frames } = await readFrames(response);
    expect(frames.at(-1)).toEqual({
      event: "done",
      data: {
        error: GRAPH_MODELING_FAILURE_MESSAGE,
        modelingFailed: true,
        attempt: 1,
        maxAttempts: 3,
        repairing: true,
        repairExhausted: false
      }
    });
    // A failed compile leaves no provenance behind.
    expect(harness.state.graphTargetRepo).toBeUndefined();
  });
});
