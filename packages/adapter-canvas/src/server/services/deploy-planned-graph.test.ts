import { describe, expect, it } from "vitest";
import {
  createPlannedGraphRecoveryService,
  type PlannedGraphRecoveryDependencies
} from "./deploy-planned-graph.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";

function dependencies(
  overrides: Partial<PlannedGraphRecoveryDependencies> = {}
): PlannedGraphRecoveryDependencies {
  return {
    prepareSourceRefResources: () => ({ token: "planned|acme/widgets|feat" }),
    setSourceRefResources: () => true,
    fetchBicepSelection: () =>
      Promise.resolve({
        content: "resource app 'Applications.Core/applications@2023' = {}",
        fromWorkspace: false,
        branch: "feat",
        bicepPath: ""
      }),
    radArtifactsDirForSelection: () =>
      Promise.resolve({ dir: "/tmp/rad", remote: true }),
    buildGraphViaRad: () => Promise.resolve([{ id: "r1", name: "db" }]),
    fetchRecipePack: () => Promise.resolve({ pack: true }),
    resolveRecipeOutputs: (parsed) => Promise.resolve(parsed),
    canvasGraphResources: (values) => values as CanvasGraphResource[],
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  };
}

function request(state: CanvasState = {}) {
  const logs: string[] = [];
  return {
    logs,
    state,
    input: {
      entry: { state },
      repo: "acme/widgets",
      branch: "feat",
      provider: "azure",
      log: (message: string) => logs.push(message)
    }
  };
}

describe("planned graph recovery construction", () => {
  it.each([
    "prepareSourceRefResources",
    "setSourceRefResources",
    "fetchBicepSelection",
    "radArtifactsDirForSelection",
    "buildGraphViaRad",
    "fetchRecipePack",
    "resolveRecipeOutputs",
    "canvasGraphResources",
    "errorMessage"
  ] as const)("refuses to construct without %s", (name) => {
    const incomplete = dependencies();
    delete incomplete[name];
    expect(() => createPlannedGraphRecoveryService(incomplete)).toThrow(
      `createPlannedGraphRecoveryService is missing required dependencies: ${name}`
    );
  });
});

describe("planned graph recovery", () => {
  it("rebuilds the graph, marks every node pending, and commits it to the panel", async () => {
    const { input, logs, state } = request();
    const calls: Record<string, unknown[]> = {
      artifacts: [],
      rad: [],
      recipes: [],
      outputs: []
    };
    const service = createPlannedGraphRecoveryService(
      dependencies({
        fetchBicepSelection: () =>
          Promise.resolve({
            content: "app bicep",
            fromWorkspace: true,
            branch: "feat",
            bicepPath: "infra/app.bicep"
          }),
        radArtifactsDirForSelection: (selection) => {
          calls.artifacts.push(selection);
          return Promise.resolve({ dir: "/work/.rad", remote: false });
        },
        buildGraphViaRad: (content, bicepPath, options) => {
          calls.rad.push([content, bicepPath, options]);
          return Promise.resolve([
            { id: "r1", name: "db", outputResources: [{ id: "o1" }] },
            { id: "r2", name: "api" }
          ]);
        },
        fetchRecipePack: (provider) => {
          calls.recipes.push(provider);
          return Promise.resolve({ recipes: 1 });
        },
        resolveRecipeOutputs: (parsed, recipes, provider) => {
          calls.outputs.push([recipes, provider]);
          return Promise.resolve(parsed);
        }
      })
    );

    const planned = await service.recover(input);

    expect(planned).toEqual([
      {
        id: "r1",
        name: "db",
        deployStatus: "pending",
        outputResources: [{ id: "o1", deployStatus: "pending" }]
      },
      { id: "r2", name: "api", deployStatus: "pending" }
    ]);
    expect(state.plannedRepo).toBe("acme/widgets");
    expect(state.deployingResources).toBe(planned);
    expect(logs).toEqual([
      "Resolving planned application graph for acme/widgets...",
      "Planned 2 resource(s)."
    ]);
    // The workspace bicep path is what the artifacts and the rad build are
    // anchored on, so a worktree deploy graphs the file it is about to deploy.
    expect(calls.artifacts[0]).toMatchObject({
      isLocal: true,
      repo: "acme/widgets",
      branch: "feat",
      bicepRepoPath: "infra/app.bicep"
    });
    expect(calls.rad[0]).toMatchObject({
      1: "infra/app.bicep",
      2: { radArtifactsDir: "/work/.rad", cleanupRadArtifactsDir: false }
    });
    expect(calls.recipes).toEqual(["azure"]);
    expect(calls.outputs).toEqual([[{ recipes: 1 }, "azure"]]);
  });

  it("defaults the bicep path when the selection reports none", async () => {
    const { input } = request();
    const paths: string[] = [];
    const service = createPlannedGraphRecoveryService(
      dependencies({
        radArtifactsDirForSelection: (selection) => {
          paths.push(selection.bicepRepoPath);
          return Promise.resolve({ dir: "/tmp/rad", remote: true });
        },
        buildGraphViaRad: (_content, bicepPath) => {
          paths.push(bicepPath);
          return Promise.resolve([]);
        }
      })
    );

    await service.recover(input);

    expect(paths).toEqual([".radius/app.bicep", ".radius/app.bicep"]);
  });

  it("does not claim the planned repo when the panel moved on mid-build", async () => {
    const { input, state } = request();
    const service = createPlannedGraphRecoveryService(
      dependencies({ setSourceRefResources: () => false })
    );

    const planned = await service.recover(input);

    // The graph is still shown for this deploy, but the stale result must not
    // be adopted as the panel's planned graph.
    expect(planned).not.toBeNull();
    expect(state.plannedRepo).toBeUndefined();
    expect(state.deployingResources).toBe(planned);
  });

  it("passes the token captured before the first await to the commit", async () => {
    const { input } = request();
    const commits: unknown[] = [];
    const service = createPlannedGraphRecoveryService(
      dependencies({
        prepareSourceRefResources: () => ({
          token: "planned|acme/widgets|feat"
        }),
        setSourceRefResources: (_entry, view, resources, context, token) => {
          commits.push([view, resources.length, context, token]);
          return true;
        }
      })
    );

    await service.recover(input);

    expect(commits).toEqual([
      [
        "planned",
        1,
        { repo: "acme/widgets", branch: "feat" },
        "planned|acme/widgets|feat"
      ]
    ]);
  });

  it("reports the missing app.bicep instead of building an empty graph", async () => {
    const { input, logs, state } = request();
    const service = createPlannedGraphRecoveryService(
      dependencies({
        fetchBicepSelection: () =>
          Promise.resolve({
            content: null,
            fromWorkspace: false,
            branch: "feat",
            bicepPath: ""
          }),
        buildGraphViaRad: () => {
          throw new Error("rad must not run without a bicep source");
        }
      })
    );

    expect(await service.recover(input)).toBeNull();
    expect(logs[1]).toContain(".radius/app.bicep not present");
    expect(state.deployingResources).toBeUndefined();
  });

  it.each([
    ["the bicep read", "fetchBicepSelection"],
    ["the rad build", "buildGraphViaRad"],
    ["the recipe pack", "fetchRecipePack"]
  ] as const)("survives a failure in %s", async (_name, seam) => {
    const { input, logs, state } = request();
    const service = createPlannedGraphRecoveryService(
      dependencies({
        [seam]: () => Promise.reject(new Error(`${seam} exploded`))
      })
    );

    expect(await service.recover(input)).toBeNull();
    expect(logs[logs.length - 1]).toBe(
      `⚠ Could not resolve planned graph: ${seam} exploded`
    );
    expect(state.plannedRepo).toBeUndefined();
    expect(state.deployingResources).toBeUndefined();
  });
});
