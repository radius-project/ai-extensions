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
      makeResource("Radius.Security/secrets", "radius-ghcr-registry-creds"),
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result.map((r) => r.type)).toEqual(["Radius.Compute/containers"]);
  });

  it("matches the bare ghcr-registry-creds secret name too", () => {
    const resources = [
      makeResource("Radius.Compute/containerImages", "apiImage"),
      makeResource("Radius.Security/secrets", "ghcr-registry-creds"),
    ];
    expect(filterGraphVisualizationResources(resources)).toHaveLength(0);
  });

  it("keeps a ghcr-registry-creds secret when there is no containerImage in the graph", () => {
    const resources = [
      makeResource("Radius.Compute/containers", "api"),
      makeResource("Radius.Security/secrets", "radius-ghcr-registry-creds"),
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result).toHaveLength(2);
  });

  it("keeps unrelated secrets even when a containerImage is present", () => {
    const resources = [
      makeResource("Radius.Compute/containerImages", "apiImage"),
      makeResource("Radius.Security/secrets", "app-db-credentials"),
    ];
    const result = filterGraphVisualizationResources(resources);
    expect(result.map((r) => r.name)).toEqual(["app-db-credentials"]);
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
});
