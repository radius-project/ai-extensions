import { expect, it, vi } from "vitest";
import {
  authoredResponse,
  graphFailure,
  strictGraphReader
} from "../../../test/support/canonical-graphs.js";
import { graphRouteContext } from "../../../test/support/graph-route.js";
import { handleDeployedGraph, handleProgress } from "./graphs-planning.js";
import type { CanvasState } from "../../shared.js";

it.each([
  ["app", "app"],
  [{ invalid: true }, ""]
] as const)(
  "narrows legacy application metadata %j before the canonical read",
  async (appName, expected) => {
    const h = graphRouteContext("/api/deployed-graph");
    const state: CanvasState = {
      contextRepo: "owner/repo",
      envName: "dev",
      appName
    };
    const lifecycle = strictGraphReader();
    lifecycle.execute.mockResolvedValue(graphFailure());
    try {
      await handleDeployedGraph(h.context, {
        readInstanceEntry: () => ({ state }),
        lifecycle: () => lifecycle,
        now: () => 1000
      });
      expect(lifecycle.execute).toHaveBeenCalledWith({
        operation: "graph.get",
        target: {
          repo: "owner/repo",
          environment: "dev",
          application: expected
        },
        input: { kind: "deployed" }
      });
    } finally {
      h.close();
    }
  }
);

it("retains exact-run timeout diagnostics without claiming a deployed graph or deletion inventory", async () => {
  const h = graphRouteContext(
    "/api/deployed-graph?repo=owner/repo&environment=dev&application=app"
  );
  const lifecycle = strictGraphReader();
  lifecycle.execute.mockResolvedValue(graphFailure("RESULT_UNAVAILABLE"));
  const state: CanvasState = {
    deployingRepo: "owner/repo",
    deployEnvName: "dev",
    deployAppName: "app",
    deployRunId: 7,
    deployStatus: "failed",
    deployErrorKind: "run-unconfirmed",
    graphResources: [{ id: "authored-only" }],
    deployingResources: [
      {
        id: "observed",
        name: "web",
        type: "Radius.Compute/containers",
        deployStatus: "failed",
        deployMessage: "Monitoring timed out."
      }
    ]
  };
  try {
    await handleDeployedGraph(h.context, {
      readInstanceEntry: () => ({ state }),
      lifecycle: () => lifecycle,
      now: () => 1000
    });
    expect(JSON.parse(h.body())).toMatchObject({
      unavailable: true,
      reason: "RESULT_UNAVAILABLE",
      deletionInventory: null,
      retainedMonitoring: {
        runId: 7,
        resources: [
          {
            id: "observed",
            deployStatus: "failed",
            deployMessage: "Monitoring timed out."
          }
        ]
      }
    });
    expect(JSON.parse(h.body())).not.toHaveProperty("resources");
    expect(h.body()).not.toContain("authored-only");
  } finally {
    h.close();
  }
});

it.each(["error", "wrong-kind", "throws"] as const)(
  "does not fall back to authored topology after a %s deployed read",
  async (mode) => {
    const h = graphRouteContext(
      "/api/deployed-graph?repo=owner/repo&environment=dev&application=app"
    );
    const lifecycle = strictGraphReader();
    const state: CanvasState = { graphResources: [{ id: "authored-only" }] };
    if (mode === "throws")
      lifecycle.execute.mockRejectedValue(new Error("private"));
    else
      lifecycle.execute.mockResolvedValue(
        mode === "error" ? graphFailure() : authoredResponse()
      );
    try {
      await handleDeployedGraph(h.context, {
        readInstanceEntry: () => ({ state }),
        lifecycle: () => lifecycle,
        now: () => 1000
      });
      expect(JSON.parse(h.body())).toMatchObject({
        unavailable: true,
        deletionInventory: null
      });
      expect(h.body()).not.toContain("authored-only");
    } finally {
      h.close();
    }
  }
);
it("fences a late deployed read after the instance is replaced", async () => {
  const h = graphRouteContext("/api/deployed-graph?repo=owner/repo");
  let state: CanvasState = {};
  const lifecycle = strictGraphReader();
  let done: (value: ReturnType<typeof graphFailure>) => void = () => {
    throw new Error("Not started");
  };
  lifecycle.execute.mockImplementation(
    () =>
      new Promise((resolve) => {
        done = resolve;
      })
  );
  try {
    const pending = handleDeployedGraph(h.context, {
      readInstanceEntry: () => ({ state }),
      lifecycle: () => lifecycle,
      now: () => 1000
    });
    await vi.waitFor(() => expect(lifecycle.execute).toHaveBeenCalled());
    state = {};
    done(graphFailure());
    await pending;
    expect(JSON.parse(h.body())).toEqual({ stale: true });
  } finally {
    h.close();
  }
});
it.each(["deployRunId", "deployGeneration"] as const)(
  "fences monitoring evidence when %s changes during the deployed read",
  async (key) => {
    const h = graphRouteContext(
      "/api/deployed-graph?repo=owner/repo&environment=dev&application=app"
    );
    const state: CanvasState = { deployRunId: 7, deployGeneration: 1 };
    const lifecycle = strictGraphReader();
    lifecycle.execute.mockImplementation(async () => {
      state[key] = 8;
      return graphFailure();
    });
    try {
      await handleDeployedGraph(h.context, {
        readInstanceEntry: () => ({ state }),
        lifecycle: () => lifecycle,
        now: () => 1000
      });
      expect(JSON.parse(h.body())).toEqual({ stale: true });
    } finally {
      h.close();
    }
  }
);
it("preserves empty repository and progress response contracts without external reads", async () => {
  const h = graphRouteContext("/api/deployed-graph");
  const deps = {
    readInstanceEntry: () => undefined,
    lifecycle: () => {
      throw new Error("unexpected");
    },
    now: () => 1000
  };
  try {
    await handleDeployedGraph(h.context, deps);
    expect(JSON.parse(h.body())).toEqual({
      resources: [],
      repo: "",
      mode: "greyed",
      deletionInventory: null
    });
  } finally {
    h.close();
  }
  const progress = graphRouteContext("/api/progress");
  try {
    await handleProgress(progress.context, deps);
    expect(JSON.parse(progress.body())).toHaveProperty("messages", []);
    expect(progress.response.getHeader("Content-Type")).toBe(
      "application/json"
    );
  } finally {
    progress.close();
  }
});

it.each(["resolve", "reject"] as const)(
  "fences same-instance environment changes after a deployed %s",
  async (outcome) => {
    const h = graphRouteContext("/api/deployed-graph?repo=owner/repo");
    const state: CanvasState = { deployEnvName: "before" };
    const lifecycle = strictGraphReader();
    lifecycle.execute.mockImplementation(async () => {
      state.deployEnvName = "after";
      if (outcome === "reject") throw new Error("Private observer detail");
      return graphFailure();
    });
    try {
      await handleDeployedGraph(h.context, {
        readInstanceEntry: () => ({ state }),
        lifecycle: () => lifecycle,
        now: () => 1000
      });
      expect(JSON.parse(h.body())).toEqual({ stale: true });
    } finally {
      h.close();
    }
  }
);
