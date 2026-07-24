import { describe, it, expect } from "vitest";
import { filterGraphVisualizationResources } from "./visualization.js";
import { buildResourceID } from "./model.js";

const containerId = buildResourceID("Radius.Compute/containers", "api");
const imageId = buildResourceID("Radius.Compute/containerImages", "apiImage");
const secretId = buildResourceID("Radius.Security/secrets", "radius-ghcr-registry-creds");
const dbId = buildResourceID("Radius.Data/postgreSQLDatabases", "db");

function makeResource(type: string, name: string, extra: any = {}) {
  return { id: buildResourceID(type, name), name, type, connections: [], ...extra };
}

describe("filterGraphVisualizationResources", () => {
  it("returns an empty array for non-array input", () => {
    expect(filterGraphVisualizationResources(undefined as any)).toEqual([]);
    expect(filterGraphVisualizationResources(null as any)).toEqual([]);
  });

  it("returns the same array reference when there is nothing to remove", () => {
    const resources = [
      makeResource("Radius.Compute/containers", "api"),
      makeResource("Radius.Data/postgreSQLDatabases", "db"),
    ];
    expect(filterGraphVisualizationResources(resources)).toBe(resources);
  });

  it("removes Radius.Compute/containerImages resources (#145)", () => {
    const resources = [
      makeResource("Radius.Compute/containers", "api"),
      makeResource("Radius.Compute/containerImages", "apiImage"),
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result.map((r) => r.type)).toEqual(["Radius.Compute/containers"]);
  });

  it("removes containerImages even when the type carries an API version", () => {
    const resources = [
      makeResource("Radius.Compute/containers", "api"),
      {
        id: imageId,
        name: "apiImage",
        type: "Radius.Compute/containerImages@2025-08-01-preview",
        connections: [],
      },
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("api");
  });

  it("removes the ghcr-registry-creds secret when a containerImage is present (#149)", () => {
    const resources = [
      makeResource("Radius.Compute/containers", "api"),
      makeResource("Radius.Compute/containerImages", "apiImage"),
      makeResource("Radius.Security/secrets", "radius-ghcr-registry-creds", {
        connections: [{ id: imageId, direction: "Inbound" }],
      }),
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result.map((r) => r.type)).toEqual(["Radius.Compute/containers"]);
  });

  it("matches the bare ghcr-registry-creds secret name too", () => {
    const resources = [
      makeResource("Radius.Compute/containerImages", "apiImage"),
      makeResource("Radius.Security/secrets", "ghcr-registry-creds", {
        connections: [{ id: imageId, direction: "Inbound" }],
      }),
    ];
    expect(filterGraphVisualizationResources(resources)).toHaveLength(0);
  });

  it("keeps a ghcr-registry-creds secret when it is not associated with a containerImage", () => {
    const resources = [
      makeResource("Radius.Compute/containerImages", "apiImage"),
      makeResource("Radius.Security/secrets", "radius-ghcr-registry-creds"),
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result.map((r) => r.name)).toEqual(["radius-ghcr-registry-creds"]);
  });

  it("keeps unrelated secrets even when a containerImage is present", () => {
    const resources = [
      makeResource("Radius.Compute/containerImages", "apiImage"),
      makeResource("Radius.Security/secrets", "app-db-credentials"),
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result.map((r) => r.name)).toEqual(["app-db-credentials"]);
  });

  it("keeps a secret whose name merely contains the creds text (exact match only)", () => {
    // A user-authored secret that is not the reserved registry-creds Secret must
    // not be hidden just because its name contains the substring.
    const resources = [
      makeResource("Radius.Compute/containerImages", "apiImage"),
      makeResource("Radius.Security/secrets", "my-ghcr-registry-creds-backup"),
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result.map((r) => r.name)).toEqual(["my-ghcr-registry-creds-backup"]);
  });

  it("removes the registry-creds secret when its name carries a namespace prefix", () => {
    const resources = [
      makeResource("Radius.Compute/containerImages", "apiImage"),
      makeResource("Radius.Security/secrets", "myapp/radius-ghcr-registry-creds"),
    ];
    expect(filterGraphVisualizationResources(resources)).toHaveLength(0);
  });

  it("strips connections that referenced a removed resource (no dangling edges)", () => {
    const resources = [
      {
        id: containerId,
        name: "api",
        type: "Radius.Compute/containers",
        connections: [
          { id: imageId, direction: "Outbound" },
          { id: dbId, direction: "Outbound" },
        ],
      },
      {
        id: imageId,
        name: "apiImage",
        type: "Radius.Compute/containerImages",
        connections: [{ id: secretId, direction: "Outbound" }],
      },
      {
        id: secretId,
        name: "radius-ghcr-registry-creds",
        type: "Radius.Security/secrets",
        connections: [{ id: imageId, direction: "Inbound" }],
      },
      { id: dbId, name: "db", type: "Radius.Data/postgreSQLDatabases", connections: [] },
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result.map((r) => r.name).sort()).toEqual(["api", "db"]);
    const api = result.find((r) => r.name === "api");
    expect(api.connections).toEqual([{ id: dbId, direction: "Outbound" }]);
  });

  it("does not mutate the input resources when stripping connections", () => {
    const api = {
      id: containerId,
      name: "api",
      type: "Radius.Compute/containers",
      connections: [{ id: imageId, direction: "Outbound" }],
    };
    const resources = [
      api,
      makeResource("Radius.Compute/containerImages", "apiImage"),
    ];
    filterGraphVisualizationResources(resources);
    expect(api.connections).toEqual([{ id: imageId, direction: "Outbound" }]);
  });

  it("preserves diffStatus on diff resources it keeps", () => {
    const resources = [
      makeResource("Radius.Compute/containers", "api", { diffStatus: "modified" }),
      makeResource("Radius.Compute/containerImages", "apiImage", { diffStatus: "added" }),
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("modified");
  });

  it("strips deployed-graph connections keyed by name, not just id", () => {
    // The deployed-graph path (normalizeDeployedGraph / rewireDeployedGraphChain)
    // synthesizes connections whose endpoint value can be a resource name rather
    // than an id, and resources there may lack ids entirely.
    const resources = [
      {
        name: "api",
        type: "Radius.Compute/containers",
        connections: [
          { name: "apiImage", direction: "Outbound" },
          { name: "db", direction: "Outbound" },
        ],
      },
      { name: "apiImage", type: "Radius.Compute/containerImages", connections: [] },
      {
        name: "radius-ghcr-registry-creds",
        type: "Radius.Security/secrets",
        connections: [{ name: "apiImage", direction: "Inbound" }],
      },
      { name: "db", type: "Radius.Data/postgreSQLDatabases", connections: [] },
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result.map((r) => r.name).sort()).toEqual(["api", "db"]);
    const api = result.find((r) => r.name === "api");
    expect(api.connections).toEqual([{ name: "db", direction: "Outbound" }]);
  });

  it("does not remove an unrelated resource whose id equals a removed resource's name", () => {
    // Node removal is by predicate, never by an id/name key set, so this cannot
    // collide even when a nameless containerImage shares text with another id.
    const resources = [
      { name: "apiImage", type: "Radius.Compute/containerImages", connections: [] },
      { id: "apiImage", name: "realService", type: "Radius.Compute/containers", connections: [] },
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result.map((r) => r.name)).toEqual(["realService"]);
  });
});
