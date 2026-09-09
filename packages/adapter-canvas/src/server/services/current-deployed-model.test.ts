import { describe, expect, it } from "vitest";
import {
  loadCurrentDeployedModel,
  readCurrentDeployedModel
} from "./current-deployed-model.js";
import {
  buildDeployedInventory,
  type DeployedResourceIdentity
} from "./deployed-inventory.js";
import type { CanvasState } from "../../shared.js";

const REPO = "octo/todolist";
const INSTANCE = "panel-a";

const MODELED = [
  {
    id: "/planes/radius/local/resourceGroups/default/providers/Applications.Core/applications/todolist/resources/api",
    name: "api",
    type: "Radius.Compute/containers"
  }
];

const DEPLOYED: DeployedResourceIdentity[] = [
  { id: MODELED[0].id, name: "api", type: "Radius.Compute/containers" },
  {
    id: "/planes/radius/local/resourceGroups/default/providers/Applications.Core/applications/todolist/resources/cache",
    name: "cache",
    type: "Radius.Data/redisCaches"
  }
];

function state(overrides: Partial<CanvasState> = {}): CanvasState {
  return {
    graphTargetRepo: REPO,
    graphBranch: "main",
    graphResources: structuredClone(MODELED),
    contextRepo: REPO,
    contextBranch: "main",
    ...overrides
  } as CanvasState;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: INSTANCE,
    repo: REPO,
    environment: "dev",
    application: "todolist",
    deployed: DEPLOYED,
    ...overrides
  };
}

describe("loadCurrentDeployedModel", () => {
  it("reloads the definition for the active branch and reports its revision", async () => {
    const reloads: Array<[string, string, string]> = [];
    const current = state();

    const model = await loadCurrentDeployedModel(
      {
        readInstanceEntry: () => ({ state: current }),
        repoMatchesWorkspace: () => false,
        reloadModeledGraph: (instanceId, repo, branch) => {
          reloads.push([instanceId, repo, branch]);
          return Promise.resolve({ status: 200 });
        }
      },
      request()
    );

    expect(reloads).toEqual([[INSTANCE, REPO, "main"]]);
    expect(model).toEqual({
      ok: true,
      model: {
        branch: "main",
        modeled: current.graphResources,
        // The same revision `/api/deployed-graph` published for this selection,
        // which is what makes the client's echoed revision comparable.
        revision: buildDeployedInventory({
          repo: REPO,
          branch: "main",
          environment: "dev",
          application: "todolist",
          modeled: MODELED,
          deployed: DEPLOYED,
          now: 0
        }).revision
      }
    });
  });

  it("reports a different revision once the definition changes", async () => {
    const current = state();
    const dependencies = {
      readInstanceEntry: () => ({ state: current }),
      repoMatchesWorkspace: () => false,
      reloadModeledGraph: () => {
        // The reload is what brings the removed resource back into the modeled
        // definition, exactly as re-running the modeling workflow would.
        current.graphResources = [
          ...structuredClone(MODELED),
          {
            id: DEPLOYED[1].id,
            name: DEPLOYED[1].name,
            type: DEPLOYED[1].type
          }
        ];
        return Promise.resolve({ status: 200 });
      }
    };

    const before = await loadCurrentDeployedModel(
      {
        ...dependencies,
        reloadModeledGraph: () => Promise.resolve({ status: 200 })
      },
      request()
    );
    const after = await loadCurrentDeployedModel(dependencies, request());

    expect(before.ok && after.ok).toBe(true);
    expect(before.ok && before.model.revision).not.toBe(
      after.ok && after.model.revision
    );
  });

  it("fails closed when the modeled graph reload reports an error", async () => {
    const model = await loadCurrentDeployedModel(
      {
        readInstanceEntry: () => ({ state: state() }),
        repoMatchesWorkspace: () => false,
        reloadModeledGraph: () =>
          Promise.resolve({ status: 400, error: "app.bicep is missing" })
      },
      request()
    );

    expect(model).toEqual({
      ok: false,
      status: 503,
      error:
        'The application definition of octo/todolist on "main" could not be re-read: app.bicep is missing'
    });
  });

  it("fails closed on a failing status with no error message", async () => {
    const model = await loadCurrentDeployedModel(
      {
        readInstanceEntry: () => ({ state: state() }),
        repoMatchesWorkspace: () => false,
        reloadModeledGraph: () => Promise.resolve({ status: 503 })
      },
      request()
    );

    expect(model.ok).toBe(false);
    expect(!model.ok && model.error).toContain(
      "modeled graph load failed with status 503"
    );
  });

  it.each([
    ["an Error", new Error("rad exploded"), "rad exploded"],
    ["a non-Error rejection", "rad vanished", "rad vanished"]
  ])("fails closed when the loader throws %s", async (_label, thrown, text) => {
    const model = await loadCurrentDeployedModel(
      {
        readInstanceEntry: () => ({ state: state() }),
        repoMatchesWorkspace: () => false,
        reloadModeledGraph: () => Promise.reject(thrown)
      },
      request()
    );

    expect(model.ok).toBe(false);
    expect(!model.ok && model.error).toContain(text);
  });

  it("fails closed when the branch moves while the definition is re-read", async () => {
    const current = state();

    const model = await loadCurrentDeployedModel(
      {
        readInstanceEntry: () => ({ state: current }),
        repoMatchesWorkspace: () => false,
        reloadModeledGraph: () => {
          current.contextBranch = "feature/remove-cache";
          return Promise.resolve({ status: 200 });
        }
      },
      request()
    );

    expect(model).toEqual({
      ok: false,
      status: 409,
      error:
        'The canvas moved from branch "main" to "feature/remove-cache" while the application definition was being re-read.'
    });
  });

  it("reports no definition when the reload leaves none for the branch", async () => {
    const current = state();

    const model = await loadCurrentDeployedModel(
      {
        readInstanceEntry: () => ({ state: current }),
        repoMatchesWorkspace: () => false,
        reloadModeledGraph: () => {
          current.graphResources = null;
          return Promise.resolve({ status: 200 });
        }
      },
      request()
    );

    // Not a load failure: the reload ran. The definition simply is not there,
    // which the authorization refuses on its own terms.
    expect(model).toEqual({
      ok: true,
      model: { branch: "main", modeled: null, revision: null }
    });
  });

  it.each([
    ["before the reload", true],
    ["after the reload", false]
  ])("fails closed with no instance state %s", async (_label, immediately) => {
    let reads = 0;
    const current = state();

    const model = await loadCurrentDeployedModel(
      {
        readInstanceEntry: () => {
          reads += 1;
          if (immediately || reads > 1) return undefined;
          return { state: current };
        },
        repoMatchesWorkspace: () => false,
        reloadModeledGraph: () => Promise.resolve({ status: 200 })
      },
      request()
    );

    expect(model).toEqual({
      ok: false,
      status: 503,
      error: "Canvas server state is unavailable."
    });
  });
});

// The same answer without the reload, which is what the delete route uses for
// its cheap first pass before it reserves anything.
describe("readCurrentDeployedModel", () => {
  const read = (overrides: Partial<CanvasState> = {}) =>
    readCurrentDeployedModel({
      state: state(overrides),
      repo: REPO,
      environment: "dev",
      application: "todolist",
      deployed: DEPLOYED,
      repoMatchesWorkspace: () => false
    });

  it("reports the active branch, its definition and the revision", () => {
    const model = read();

    expect(model.branch).toBe("main");
    expect(model.modeled).toEqual(MODELED);
    expect(model.revision).toMatch(/^[0-9a-f]{8}$/);
  });

  it("follows the branch the canvas moved to", () => {
    const moved = read({
      contextBranch: "feature/x",
      graphBranch: "feature/x"
    });

    expect(moved.branch).toBe("feature/x");
    // A different branch is a different definition, so the revision differs
    // even when the resources happen to be identical.
    expect(moved.revision).not.toBe(read().revision);
  });

  it("reports no definition, and no revision, for a branch it does not hold", () => {
    expect(read({ graphResources: null })).toEqual({
      branch: "main",
      modeled: null,
      revision: null
    });
  });
});
