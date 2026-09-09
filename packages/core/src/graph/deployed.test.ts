import { describe, it, expect } from "vitest";
import {
  deployStatusKeys,
  findRemovedDeployedResources,
  lookupDeployStatus,
  mergeDeployedGraphMetadata,
  projectDeployedGraph,
  selectApplicationOwnedResources
} from "./deployed.js";
import type { DeployStatus } from "./deployed.js";
import { buildResourceID } from "../../test/support/resource-id.js";

function makeResource(type: string, name: string, extra: any = {}) {
  return {
    id: buildResourceID(type, name),
    name,
    type,
    connections: [],
    ...extra
  };
}

describe("deployStatusKeys", () => {
  it("yields id, name|type, then name in priority order", () => {
    const resource = makeResource("Radius.Compute/containers", "Frontend");
    expect(deployStatusKeys(resource)).toEqual([
      resource.id,
      "frontend|radius.compute/containers",
      "frontend"
    ]);
  });

  it("strips the API version from the type key", () => {
    expect(
      deployStatusKeys({
        name: "db",
        type: "Radius.Data/postgreSQLDatabases@2025-08-01-preview"
      })
    ).toEqual(["db|radius.data/postgresqldatabases", "db"]);
  });

  it("omits keys it cannot build", () => {
    expect(deployStatusKeys({ name: "solo" })).toEqual(["solo"]);
    expect(deployStatusKeys({ id: "  " })).toEqual([]);
    expect(deployStatusKeys(null)).toEqual([]);
  });

  it("adds exact output ids before weaker name keys and removes duplicates", () => {
    expect(
      deployStatusKeys({
        id: "parent",
        name: "api",
        type: "Radius.Compute/containers",
        outputResourceIds: ["deployment", "service", "deployment", null],
        outputResources: [{ id: "service" }, { id: "secret" }, {}]
      })
    ).toEqual([
      "parent",
      "deployment",
      "service",
      "secret",
      "api|radius.compute/containers",
      "api"
    ]);
  });
});

describe("lookupDeployStatus", () => {
  const resource = makeResource("Radius.Compute/containers", "frontend");

  it("prefers an id match over name and name|type", () => {
    const map = new Map<string, DeployStatus>([
      [resource.id, "success"],
      ["frontend|radius.compute/containers", "failed"],
      ["frontend", "failed"]
    ]);
    expect(lookupDeployStatus(resource, map)).toBe("success");
  });

  it("falls back to name|type when the id is absent from the map", () => {
    const map = new Map<string, DeployStatus>([
      ["frontend|radius.compute/containers", "in_progress"],
      ["frontend", "failed"]
    ]);
    expect(lookupDeployStatus(resource, map)).toBe("in_progress");
  });

  it("falls back to the bare name last", () => {
    expect(
      lookupDeployStatus(resource, new Map([["frontend", "failed"]]))
    ).toBe("failed");
  });

  it("returns undefined when the resource is absent, so callers can keep the current status", () => {
    expect(lookupDeployStatus(resource, new Map())).toBeUndefined();
  });

  it("accepts a plain object map as well as a Map", () => {
    expect(lookupDeployStatus(resource, { frontend: "success" })).toBe(
      "success"
    );
  });
});

describe("projectDeployedGraph", () => {
  it("retains cloned output metadata without expanding the topology", () => {
    const resources = [
      makeResource("Radius.Compute/containers", "api", {
        outputResources: [
          { id: "/subscriptions/x", type: "Microsoft.Web/sites" }
        ]
      })
    ];
    const projected = projectDeployedGraph(resources);
    expect(projected[0].outputResources).toEqual([
      { id: "/subscriptions/x", type: "Microsoft.Web/sites" }
    ]);
    projected[0].outputResources[0].type = "changed";
    // The input is never mutated, including its nested metadata.
    expect(resources[0].outputResources[0].type).toBe("Microsoft.Web/sites");
    expect(resources[0].outputResources).toHaveLength(1);
  });

  it("defaults every unknown resource to pending", () => {
    const projected = projectDeployedGraph([
      makeResource("Radius.Compute/containers", "api")
    ]);
    expect(projected[0].deployStatus).toBe("pending");
  });

  it("copies statuses in by id, by name|type, and by name", () => {
    const api = makeResource("Radius.Compute/containers", "api");
    const db = makeResource("Radius.Data/postgreSQLDatabases", "db");
    const cache = makeResource("Radius.Data/redisCaches", "cache");
    const projected = projectDeployedGraph([api, db, cache], {
      [api.id]: "success",
      "db|radius.data/postgresqldatabases": "in_progress",
      cache: "failed"
    });
    expect(projected.map((r) => r.deployStatus)).toEqual([
      "success",
      "in_progress",
      "failed"
    ]);
  });

  it("keeps a status a resource already carries when the map does not mention it", () => {
    // Projecting a just-deployed application against an empty map (an artifact
    // read that came back empty) must not repaint it as pending.
    const projected = projectDeployedGraph(
      [
        makeResource("Radius.Compute/containers", "api", {
          deployStatus: "success"
        }),
        makeResource("Radius.Data/redisCaches", "cache", {
          deployStatus: "failed"
        })
      ],
      new Map()
    );
    expect(projected.map((r) => r.deployStatus)).toEqual(["success", "failed"]);
  });

  it("lets the status map override a status the resource already carries", () => {
    const api = makeResource("Radius.Compute/containers", "api", {
      deployStatus: "in_progress"
    });
    const projected = projectDeployedGraph([api], { api: "success" });
    expect(projected[0].deployStatus).toBe("success");
  });

  it("applies the visualization filter before projecting (#145, #149)", () => {
    const api = makeResource("Radius.Compute/containers", "api");
    const image = makeResource("Radius.Compute/containerImages", "apiImage");
    const secret = makeResource(
      "Radius.Security/secrets",
      "radius-ghcr-registry-creds",
      { connections: [{ id: image.id, direction: "Outbound" }] }
    );
    const projected = projectDeployedGraph([api, image, secret]);
    expect(projected.map((r) => r.name)).toEqual(["api"]);
  });

  it("clones connections so the projection cannot mutate the modeled graph", () => {
    const api = makeResource("Radius.Compute/containers", "api", {
      connections: [{ id: "db", direction: "Outbound" }]
    });
    const projected = projectDeployedGraph([api]);
    projected[0].connections[0].direction = "Inbound";
    expect(api.connections[0].direction).toBe("Outbound");
  });

  it("normalizes a missing connections array to an empty one", () => {
    const projected = projectDeployedGraph([
      { id: "a", name: "a", type: "Radius.Compute/containers" }
    ]);
    expect(projected[0].connections).toEqual([]);
  });

  it("returns an empty array for non-array input", () => {
    expect(projectDeployedGraph(undefined as any)).toEqual([]);
    expect(projectDeployedGraph(null as any)).toEqual([]);
  });
});

describe("mergeDeployedGraphMetadata", () => {
  const modeled = [
    makeResource("Radius.Compute/containers", "api", {
      outputResources: [{ id: "planned", type: "apps/Deployment" }],
      connections: [{ id: "db", direction: "Outbound" }]
    }),
    makeResource("Radius.Data/mySqlDatabases", "db")
  ];

  it.each([
    [
      "array",
      [
        {
          ...modeled[0],
          outputResources: [
            {
              id: "deployed",
              type: "apps/Deployment",
              portalUrl: "https://k8s"
            }
          ]
        }
      ]
    ],
    [
      "wrapped object",
      {
        resources: [
          {
            ...modeled[0],
            outputResources: [
              {
                id: "deployed",
                type: "apps/Deployment",
                portalUrl: "https://k8s"
              }
            ]
          }
        ]
      }
    ]
  ])(
    "merges explicit output metadata from a deployed %s",
    (_name, deployed) => {
      const merged = mergeDeployedGraphMetadata(modeled, deployed);
      expect(merged[0].outputResources).toEqual([
        {
          id: "deployed",
          type: "apps/Deployment",
          portalUrl: "https://k8s"
        }
      ]);
      expect(merged.map((resource) => resource.id)).toEqual(
        modeled.map((resource) => resource.id)
      );
      expect(merged[0].connections).toEqual(modeled[0].connections);
    }
  );

  it("matches parents only by exact id and preserves legacy metadata on misses", () => {
    const merged = mergeDeployedGraphMetadata(modeled, {
      resources: [
        {
          id: "different-id",
          name: "api",
          type: "Radius.Compute/containers",
          outputResources: [{ id: "wrong", type: "Microsoft.Web/sites" }]
        }
      ]
    });
    expect(merged[0].outputResources).toEqual(modeled[0].outputResources);
  });

  it("preserves provider-resolved outputs when deployment metadata is empty", () => {
    const merged = mergeDeployedGraphMetadata(modeled, [
      { ...modeled[0], outputResources: [] }
    ]);
    expect(merged[0].outputResources).toEqual(modeled[0].outputResources);
  });

  it("keeps the first duplicate parent and never mutates either input", () => {
    const first = {
      ...modeled[0],
      outputResources: [{ id: "first", type: "apps/Deployment" }]
    };
    const second = {
      ...modeled[0],
      outputResources: [{ id: "second", type: "core/Service" }]
    };
    const merged = mergeDeployedGraphMetadata(modeled, [first, second]);
    merged[0].outputResources[0].type = "changed";
    merged[0].connections[0].direction = "Inbound";
    expect(first.outputResources[0].type).toBe("apps/Deployment");
    expect(modeled[0].connections[0].direction).toBe("Outbound");
  });

  it("handles malformed inputs without guessing", () => {
    expect(mergeDeployedGraphMetadata(undefined as any, [])).toEqual([]);
    const merged = mergeDeployedGraphMetadata(modeled, {
      resources: "invalid"
    });
    expect(merged[0].outputResources).toEqual(modeled[0].outputResources);
    expect(merged[1].outputResources).toEqual([]);
    expect(mergeDeployedGraphMetadata([{ name: "no-id" }], null)).toEqual([
      { name: "no-id", connections: [], outputResources: [] }
    ]);
  });

  it("ignores malformed deployed parents and output collections", () => {
    const merged = mergeDeployedGraphMetadata(modeled, [
      { name: "missing-id", outputResources: [{ id: "ignored" }] },
      { id: modeled[0].id, outputResources: "invalid" }
    ]);
    expect(merged[0].outputResources).toEqual(modeled[0].outputResources);
  });
});

describe("findRemovedDeployedResources", () => {
  const frontend = makeResource("Radius.Compute/containers", "frontend");
  const cache = makeResource("Radius.Data/redisCaches", "cache");

  it("reports a deployed resource the definition no longer declares", () => {
    expect(findRemovedDeployedResources([frontend], [frontend, cache])).toEqual(
      [{ id: cache.id, name: cache.name, type: cache.type }]
    );
  });

  it("accepts the wrapped { resources } graph shape", () => {
    expect(
      findRemovedDeployedResources([frontend], { resources: [cache] })
    ).toEqual([{ id: cache.id, name: cache.name, type: cache.type }]);
  });

  it("treats a resource still modeled under any identity key as retained", () => {
    const renamedId = { ...cache, id: "/planes/radius/local/other" };
    expect(findRemovedDeployedResources([cache], [renamedId])).toEqual([]);
  });

  it("treats a modeled output resource as retained", () => {
    const modeled = [
      { ...frontend, outputResources: [{ id: "/subscriptions/x/deployment" }] }
    ];
    const deployed = [
      { id: "/subscriptions/x/deployment", name: "deployment", type: "K8s" }
    ];
    expect(findRemovedDeployedResources(modeled, deployed)).toEqual([]);
  });

  it("skips deployed entries that cannot be identified precisely", () => {
    expect(
      findRemovedDeployedResources(
        [],
        [
          { id: "no-name", type: "Radius.Data/redisCaches" },
          { id: "no-type", name: "cache" },
          { id: "blank", name: "   ", type: "   " },
          null
        ]
      )
    ).toEqual([]);
  });

  it("collapses duplicate deployed entries with the same identity", () => {
    expect(
      findRemovedDeployedResources([], [cache, { ...cache }])
    ).toHaveLength(1);
  });

  it("reports an entry whose id is not a string with an empty id", () => {
    expect(
      findRemovedDeployedResources(
        [],
        [{ id: 7, name: "cache", type: "Radius.Data/redisCaches" }]
      )
    ).toEqual([{ id: "", name: "cache", type: "Radius.Data/redisCaches" }]);
  });

  it("reports nothing for an absent or empty deployed graph", () => {
    expect(findRemovedDeployedResources([frontend], null)).toEqual([]);
    expect(findRemovedDeployedResources([frontend], [])).toEqual([]);
  });

  it("reports every deployed resource when the definition is unusable", () => {
    expect(findRemovedDeployedResources(undefined as any, [cache])).toEqual([
      { id: cache.id, name: cache.name, type: cache.type }
    ]);
  });
});

// Graph membership is not ownership: `rad app graph` also returns the
// environment-scoped and external resources the application is connected to,
// and a per-resource delete derived from those would destroy something the
// application does not own.
describe("selectApplicationOwnedResources", () => {
  const owned = makeResource("Radius.Data/redisCaches", "cache", {
    properties: {
      application: "/planes/radius/local/resourceGroups/rg/applications/todo",
      environment: "/planes/radius/local/resourceGroups/rg/environments/dev"
    }
  });
  const connectedButUnowned = makeResource(
    "Radius.Data/postgreSQLDatabases",
    "shared-db",
    {
      properties: {
        application:
          "/planes/radius/local/resourceGroups/rg/applications/billing",
        environment: "/planes/radius/local/resourceGroups/rg/environments/dev"
      }
    }
  );
  const environmentScoped = makeResource("Radius.Core/gateways", "gateway", {
    properties: {
      environment: "/planes/radius/local/resourceGroups/rg/environments/dev"
    }
  });

  it("keeps only the records the application owns", () => {
    expect(
      selectApplicationOwnedResources(
        { resources: [owned, connectedButUnowned, environmentScoped] },
        { application: "todo", environment: "dev" }
      )
    ).toEqual([owned]);
  });

  it("matches the owner id's last segment case-insensitively", () => {
    expect(
      selectApplicationOwnedResources([owned], {
        application: "/planes/radius/local/resourceGroups/rg/applications/ToDo",
        environment: "DEV"
      })
    ).toEqual([owned]);
  });

  it("accepts a flattened owner published by the deploy-status producer", () => {
    const flattened = makeResource("Radius.Data/redisCaches", "cache", {
      application: "todo",
      environment: "dev"
    });
    expect(
      selectApplicationOwnedResources([flattened], { application: "todo" })
    ).toEqual([flattened]);
  });

  it("excludes a record owned by the app but deployed to another environment", () => {
    const otherEnvironment = makeResource("Radius.Data/redisCaches", "cache", {
      properties: { application: "todo", environment: "staging" }
    });
    expect(
      selectApplicationOwnedResources([otherEnvironment], {
        application: "todo",
        environment: "dev"
      })
    ).toEqual([]);
  });

  it("keeps an unowned-looking record only from an application-scoped listing", () => {
    const listed = makeResource("Radius.Data/redisCaches", "cache");
    // An id that is not a string states no ownership either, so it depends on
    // the listing's own scope exactly as a missing owner does.
    const idless = { name: "worker", type: "Radius.Compute/containers", id: 7 };
    expect(
      selectApplicationOwnedResources([listed, idless], {
        application: "todo"
      })
    ).toEqual([]);
    expect(
      selectApplicationOwnedResources([listed, idless], {
        application: "todo",
        applicationScopedList: true
      })
    ).toEqual([listed, idless]);
  });

  it("still excludes a foreign owner inside an application-scoped listing", () => {
    expect(
      selectApplicationOwnedResources([connectedButUnowned], {
        application: "todo",
        applicationScopedList: true
      })
    ).toEqual([]);
  });

  // `rad app graph` states ownership only through the node's own id, so a graph
  // read that ignored the id path would find no owned resource at all.
  it("derives ownership from an application-scoped resource id", () => {
    const graphNode = {
      id: "/planes/radius/local/resourcegroups/default/providers/Applications.Core/applications/ToDo/resources/web",
      name: "web",
      type: "Radius.Compute/containers"
    };
    const otherApplication = {
      id: "/planes/radius/local/resourcegroups/default/providers/Applications.Core/applications/billing/resources/db",
      name: "db",
      type: "Radius.Data/redisCaches"
    };
    const environmentScopedId = {
      id: "/planes/radius/local/resourcegroups/default/providers/Applications.Core/environments/dev/resources/gateway",
      name: "gateway",
      type: "Radius.Core/gateways"
    };
    expect(
      selectApplicationOwnedResources(
        [graphNode, otherApplication, environmentScopedId],
        { application: "todo", environment: "dev" }
      )
    ).toEqual([graphNode]);
  });

  it("owns nothing without an application scope or a usable payload", () => {
    expect(
      selectApplicationOwnedResources([owned], { application: "   " })
    ).toEqual([]);
    expect(
      selectApplicationOwnedResources(null, { application: "todo" })
    ).toEqual([]);
    expect(
      selectApplicationOwnedResources([null, "text", 7], {
        application: "todo",
        applicationScopedList: true
      })
    ).toEqual([]);
  });
});
