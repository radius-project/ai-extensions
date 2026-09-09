import { describe, expect, it } from "vitest";
import {
  authorizeRemovedResourceDelete,
  buildDeployedInventory,
  deployedInventoryRevision,
  deployedResourceIdentities,
  ownedDeployedResources,
  type DeployedInventory
} from "./deployed-inventory.js";

const REPO = "octo/todolist";

function modeled(...names: string[]): unknown[] {
  return names.map((name) => ({
    id: `/planes/radius/local/resourceGroups/default/providers/Radius.Compute/containers/${name}`,
    name,
    type: "Radius.Compute/containers"
  }));
}

function deployed(): unknown {
  return {
    resources: [
      {
        id: "/planes/radius/local/resourceGroups/default/providers/Radius.Compute/containers/api",
        name: "api",
        type: "Radius.Compute/containers"
      },
      {
        id: "/planes/radius/local/resourceGroups/default/providers/Radius.Data/redisCaches/cache",
        name: "cache",
        type: "Radius.Data/redisCaches"
      }
    ]
  };
}

function inventory(overrides: Partial<DeployedInventory> = {}) {
  return {
    ...buildDeployedInventory({
      repo: REPO,
      branch: "main",
      environment: "dev",
      application: "todolist",
      modeled: modeled("api"),
      deployed: deployed(),
      now: 1_000
    }),
    ...overrides
  };
}

function request(overrides: Record<string, string> = {}) {
  return {
    repo: REPO,
    environment: "dev",
    application: "todolist",
    resourceName: "cache",
    resourceType: "Radius.Data/redisCaches",
    revision: inventory().revision,
    ...overrides
  };
}

describe("deployedResourceIdentities", () => {
  it("reads a wrapped or bare deployed graph", () => {
    expect(deployedResourceIdentities(deployed())).toHaveLength(2);
    expect(
      deployedResourceIdentities([
        { id: "a", name: "api", type: "Radius.Compute/containers" }
      ])
    ).toEqual([{ id: "a", name: "api", type: "Radius.Compute/containers" }]);
  });

  it("drops entries that cannot be named or typed", () => {
    expect(
      deployedResourceIdentities([
        { id: "a", name: "  ", type: "Radius.Compute/containers" },
        { id: "b", name: "api" },
        { id: "c", name: "cache", type: "Radius.Data/redisCaches" }
      ])
    ).toEqual([{ id: "c", name: "cache", type: "Radius.Data/redisCaches" }]);
  });

  it("collapses duplicates and reports nothing for an unusable payload", () => {
    const duplicate = {
      id: "a",
      name: "api",
      type: "Radius.Compute/containers"
    };
    expect(
      deployedResourceIdentities([duplicate, { ...duplicate }])
    ).toHaveLength(1);
    expect(deployedResourceIdentities(null)).toEqual([]);
    expect(deployedResourceIdentities("nope")).toEqual([]);
    expect(deployedResourceIdentities({ resources: "nope" })).toEqual([]);
  });
});

describe("buildDeployedInventory", () => {
  it("reports the deployed resources and the ones the definition dropped", () => {
    const result = inventory();

    expect(result.complete).toBe(true);
    expect(result.resources.map((entry) => entry.name)).toEqual([
      "api",
      "cache"
    ]);
    expect(result.removed).toEqual([
      {
        id: "/planes/radius/local/resourceGroups/default/providers/Radius.Data/redisCaches/cache",
        name: "cache",
        type: "Radius.Data/redisCaches"
      }
    ]);
    expect(result.updatedAt).toBe(1_000);
  });

  it("is incomplete, and removes nothing, without a deployed graph", () => {
    const result = buildDeployedInventory({
      repo: REPO,
      branch: "main",
      environment: "dev",
      application: "todolist",
      modeled: modeled("api"),
      deployed: null,
      now: 5
    });

    expect(result.complete).toBe(false);
    expect(result.resources).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it("gives the same revision to the same selection and contents", () => {
    expect(inventory().revision).toBe(inventory().revision);
  });

  it.each([
    ["the branch", { branch: "feature" }],
    ["the environment", { environment: "prod" }],
    ["the application", { application: "other" }],
    ["the repository", { repo: "octo/other" }]
  ])("changes the revision when %s changes", (_label, overrides) => {
    const changed = buildDeployedInventory({
      repo: REPO,
      branch: "main",
      environment: "dev",
      application: "todolist",
      modeled: modeled("api"),
      deployed: deployed(),
      now: 1_000,
      ...overrides
    });

    expect(changed.revision).not.toBe(inventory().revision);
  });

  it("changes the revision when the definition or the deployment changes", () => {
    const modelChanged = buildDeployedInventory({
      repo: REPO,
      branch: "main",
      environment: "dev",
      application: "todolist",
      modeled: modeled("api", "cache"),
      deployed: deployed(),
      now: 1_000
    });
    const deploymentChanged = buildDeployedInventory({
      repo: REPO,
      branch: "main",
      environment: "dev",
      application: "todolist",
      modeled: modeled("api"),
      deployed: { resources: [] },
      now: 1_000
    });

    expect(modelChanged.revision).not.toBe(inventory().revision);
    expect(deploymentChanged.revision).not.toBe(inventory().revision);
  });

  it("ignores deployed ordering, which is not part of the identity", () => {
    const reversed = buildDeployedInventory({
      repo: REPO,
      branch: "main",
      environment: "dev",
      application: "todolist",
      modeled: modeled("api"),
      deployed: {
        resources: [...deployedResourceIdentities(deployed())].reverse()
      },
      now: 1_000
    });

    expect(reversed.revision).toBe(inventory().revision);
  });

  it("matches the environment and application case-insensitively", () => {
    const upper = buildDeployedInventory({
      repo: REPO,
      branch: "main",
      environment: "DEV",
      application: "ToDoList",
      modeled: modeled("api"),
      deployed: deployed(),
      now: 1_000
    });

    expect(upper.revision).toBe(inventory().revision);
  });
});

describe("authorizeRemovedResourceDelete", () => {
  it("authorizes a resource the current definition still does not declare", () => {
    const result = authorizeRemovedResourceDelete({
      inventory: inventory(),
      currentBranch: "main",
      currentRevision: inventory().revision,
      currentModeled: modeled("api"),
      request: request()
    });

    expect(result).toEqual({
      ok: true,
      resource: {
        id: "/planes/radius/local/resourceGroups/default/providers/Radius.Data/redisCaches/cache",
        name: "cache",
        type: "Radius.Data/redisCaches"
      }
    });
  });

  // The fail-closed case this guard exists for: the user put the resource back
  // into app.bicep after opening the confirmation.
  it("refuses a resource the definition declares again", () => {
    const result = authorizeRemovedResourceDelete({
      inventory: inventory(),
      currentBranch: "main",
      currentRevision: inventory().revision,
      currentModeled: [
        ...modeled("api"),
        {
          id: "/planes/radius/local/resourceGroups/default/providers/Radius.Data/redisCaches/cache",
          name: "cache",
          type: "Radius.Data/redisCaches"
        }
      ],
      request: request()
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: expect.stringContaining("no longer a removed resource")
    });
  });

  it("refuses a confirmation taken on another branch", () => {
    const result = authorizeRemovedResourceDelete({
      inventory: inventory(),
      currentBranch: "feature",
      currentRevision: inventory().revision,
      currentModeled: modeled("api"),
      request: request()
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: expect.stringContaining('but the canvas is now on "feature"')
    });
  });

  it.each([
    ["a stale revision", { revision: "deadbeef" }],
    ["no revision at all", { revision: "" }]
  ])("refuses %s", (_label, overrides) => {
    const result = authorizeRemovedResourceDelete({
      inventory: inventory(),
      currentBranch: "main",
      currentRevision: inventory().revision,
      currentModeled: modeled("api"),
      request: request(overrides)
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: expect.stringContaining("changed after this delete was confirmed")
    });
  });

  it.each([
    ["another repository", { repo: "octo/other" }],
    ["another environment", { environment: "prod" }],
    ["another application", { application: "other" }]
  ])("refuses a request for %s", (_label, overrides) => {
    const result = authorizeRemovedResourceDelete({
      inventory: inventory(),
      currentBranch: "main",
      currentRevision: inventory().revision,
      currentModeled: modeled("api"),
      request: request(overrides)
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: expect.stringContaining("has not been read on this canvas")
    });
  });

  it("matches the environment and application case-insensitively", () => {
    const result = authorizeRemovedResourceDelete({
      inventory: inventory(),
      currentBranch: "main",
      currentRevision: inventory().revision,
      currentModeled: modeled("api"),
      request: request({ environment: "DEV", application: "ToDoList" })
    });

    expect(result.ok).toBe(true);
  });

  it("refuses when no inventory has been derived at all", () => {
    const result = authorizeRemovedResourceDelete({
      inventory: null,
      currentBranch: "main",
      currentRevision: inventory().revision,
      currentModeled: modeled("api"),
      request: request()
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: expect.stringContaining("has not been read on this canvas")
    });
  });

  it("refuses when the deployed inventory could not be completed", () => {
    const incomplete = buildDeployedInventory({
      repo: REPO,
      branch: "main",
      environment: "dev",
      application: "todolist",
      modeled: modeled("api"),
      deployed: null,
      now: 1_000
    });

    const result = authorizeRemovedResourceDelete({
      inventory: incomplete,
      currentBranch: "main",
      currentRevision: inventory().revision,
      currentModeled: modeled("api"),
      request: request({ revision: incomplete.revision })
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: expect.stringContaining("could not be read")
    });
  });

  it("refuses a resource that was never in the removed set", () => {
    const result = authorizeRemovedResourceDelete({
      inventory: inventory(),
      currentBranch: "main",
      currentRevision: inventory().revision,
      currentModeled: modeled("api"),
      request: request({
        resourceName: "api",
        resourceType: "Radius.Compute/containers"
      })
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: expect.stringContaining("not in the list of removed resources")
    });
  });

  it.each([
    ["no modeled definition", { currentModeled: null }],
    ["no derivable revision", { currentRevision: null }]
  ])("refuses with %s to re-check against", (_label, overrides) => {
    const result = authorizeRemovedResourceDelete({
      inventory: inventory(),
      currentBranch: "main",
      currentRevision: inventory().revision,
      currentModeled: modeled("api"),
      request: request(),
      ...overrides
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: expect.stringContaining("no longer loaded")
    });
  });

  // The snapshot's own revision still matches, and the resource is still absent
  // from the definition — but the definition itself has moved on, so the client
  // confirmed against something that no longer exists.
  it("refuses when the current definition no longer produces the revision", () => {
    const result = authorizeRemovedResourceDelete({
      inventory: inventory(),
      currentBranch: "main",
      currentRevision: deployedInventoryRevision({
        repo: REPO,
        branch: "main",
        environment: "dev",
        application: "todolist",
        complete: true,
        modeled: modeled("api", "worker"),
        resources: inventory().resources
      }),
      currentModeled: modeled("api", "worker"),
      request: request()
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: expect.stringContaining(
        "The application definition for todolist in environment dev changed after this delete was confirmed."
      )
    });
  });
});

// Graph membership is not ownership — see selectApplicationOwnedResources. The
// inventory a delete is derived from must contain only records the application
// owns, so an environment-scoped or connected resource can neither be counted
// nor offered for deletion.
describe("ownedDeployedResources", () => {
  const listed = {
    id: "/planes/radius/local/resourcegroups/default/providers/Applications.Core/applications/todolist/resources/cache",
    name: "cache",
    type: "Radius.Data/redisCaches"
  };
  const foreign = {
    id: "/planes/radius/local/resourcegroups/default/providers/Applications.Core/applications/billing/resources/ledger",
    name: "ledger",
    type: "Radius.Data/postgreSQLDatabases"
  };
  const environmentScoped = {
    id: "/planes/radius/local/resourcegroups/default/providers/Applications.Core/environments/dev/resources/gateway",
    name: "gateway",
    type: "Radius.Core/gateways"
  };

  it("prefers the producer's application-scoped resource list", () => {
    expect(
      ownedDeployedResources({
        application: "todolist",
        environment: "dev",
        resourceList: [listed, foreign],
        // A stale graph never adds to an authoritative listing, which is what
        // keeps a just-deleted resource from reappearing.
        graph: { resources: [listed, environmentScoped] }
      })
    ).toEqual([listed]);
  });

  it("falls back to the graph records the application owns", () => {
    expect(
      ownedDeployedResources({
        application: "todolist",
        environment: "dev",
        resourceList: null,
        graph: { resources: [listed, foreign, environmentScoped] }
      })
    ).toEqual([listed]);
  });

  it("reports an empty listing as empty rather than as unknown", () => {
    expect(
      ownedDeployedResources({
        application: "todolist",
        environment: "dev",
        resourceList: [],
        graph: { resources: [listed] }
      })
    ).toEqual([]);
  });

  it("reports nothing readable as unknown", () => {
    expect(
      ownedDeployedResources({
        application: "todolist",
        environment: "dev",
        resourceList: null,
        graph: null
      })
    ).toBeNull();
  });

  it("reports an unknown application as unknown rather than as unowned", () => {
    expect(
      ownedDeployedResources({
        application: "  ",
        environment: "dev",
        resourceList: [listed],
        graph: { resources: [listed] }
      })
    ).toBeNull();
  });

  it("builds an incomplete inventory from an unknown source", () => {
    const result = buildDeployedInventory({
      repo: REPO,
      branch: "main",
      environment: "dev",
      application: "todolist",
      modeled: modeled("api"),
      deployed: ownedDeployedResources({
        application: "todolist",
        environment: "dev",
        resourceList: null,
        graph: null
      }),
      now: 1_000
    });

    expect(result.complete).toBe(false);
    expect(result.removed).toEqual([]);
  });

  it("keeps a connected but unowned resource out of the removal set", () => {
    const result = buildDeployedInventory({
      repo: REPO,
      branch: "main",
      environment: "dev",
      application: "todolist",
      modeled: modeled("api"),
      deployed: ownedDeployedResources({
        application: "todolist",
        environment: "dev",
        resourceList: null,
        graph: { resources: [listed, foreign, environmentScoped] }
      }),
      now: 1_000
    });

    expect(result.complete).toBe(true);
    expect(result.resources.map((entry) => entry.name)).toEqual(["cache"]);
    expect(result.removed).toEqual([
      { id: listed.id, name: "cache", type: "Radius.Data/redisCaches" }
    ]);
  });
});
