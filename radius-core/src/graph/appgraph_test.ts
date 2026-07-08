import { describe, it, expect } from "vitest";
import { applicationGraphToResources } from "./appgraph.js";
import { buildResourceID, computeDiffHash } from "./model.js";

const frontendId = buildResourceID("Radius.Compute/containers", "frontend");
const cacheId = buildResourceID("Radius.Data/redisCaches", "cache");
const databaseId = buildResourceID("Radius.Data/postgreSQLDatabases", "database");

function sampleAppGraph() {
  return {
    resources: [
      {
        id: frontendId,
        name: "frontend",
        type: "Radius.Compute/containers",
        provisioningState: "NotSpecified",
        connections: [{ id: cacheId, direction: "Outbound" }],
        outputResources: [],
        diffHash: "sha256:abc",
      },
      {
        id: cacheId,
        name: "cache",
        type: "Radius.Data/redisCaches",
        provisioningState: "NotSpecified",
        connections: [],
        outputResources: [],
        diffHash: "sha256:def",
      },
    ],
  };
}

describe("applicationGraphToResources", () => {
  it("converts an ApplicationGraphResponse into the canvas resource array", () => {
    const resources = applicationGraphToResources(sampleAppGraph(), ".radius/app.bicep");
    expect(resources).toHaveLength(2);
    const frontend = resources.find((r) => r.id === frontendId);
    expect(frontend.name).toBe("frontend");
    expect(frontend.type).toBe("Radius.Compute/containers");
    expect(frontend.definitionFile).toBe(".radius/app.bicep");
    expect(frontend.diffHash).toBe("sha256:abc");
  });

  it("preserves outbound edges and rebuilds inbound edges", () => {
    const resources = applicationGraphToResources(sampleAppGraph());
    const frontend = resources.find((r) => r.id === frontendId);
    const cache = resources.find((r) => r.id === cacheId);
    expect(frontend.connections).toContainEqual({ id: cacheId, direction: "Outbound" });
    // cache had no connections in the input; inbound edge is synthesized.
    expect(cache.connections).toContainEqual({ id: frontendId, direction: "Inbound" });
  });

  it("does not duplicate inbound edges already present in the input", () => {
    const graph = sampleAppGraph();
    // rad emits both directions; the converter must drop the incoming inbound
    // edge and rebuild it, not keep both.
    graph.resources[1].connections.push({ id: frontendId, direction: "Inbound" });
    const resources = applicationGraphToResources(graph);
    const cache = resources.find((r) => r.id === cacheId);
    const inbound = cache.connections.filter((c: any) => c.direction === "Inbound");
    expect(inbound).toHaveLength(1);
  });

  it("sorts outbound edges by id", () => {
    const graph = sampleAppGraph();
    graph.resources[0].connections = [
      { id: cacheId, direction: "Outbound" },
      { id: databaseId, direction: "Outbound" },
    ];
    graph.resources.push({
      id: databaseId,
      name: "database",
      type: "Radius.Data/postgreSQLDatabases",
      provisioningState: "NotSpecified",
      connections: [],
      outputResources: [],
      diffHash: "sha256:ghi",
    });

    const resources = applicationGraphToResources(graph);
    const frontend = resources.find((r) => r.id === frontendId);
    expect(frontend.connections).toEqual([
      { id: databaseId, direction: "Outbound" },
      { id: cacheId, direction: "Outbound" },
    ]);
  });

  it("accepts a bare resources array", () => {
    const resources = applicationGraphToResources(sampleAppGraph().resources);
    expect(resources).toHaveLength(2);
  });

  it("returns an empty array for empty or malformed input", () => {
    expect(applicationGraphToResources({ resources: [] })).toEqual([]);
    expect(applicationGraphToResources([])).toEqual([]);
    expect(applicationGraphToResources(null)).toEqual([]);
    expect(applicationGraphToResources({})).toEqual([]);
  });

  it("skips entries missing an id or type", () => {
    const resources = applicationGraphToResources([
      { name: "no-id", type: "Radius.Compute/containers" },
      { id: "x", name: "no-type" },
      { id: frontendId, name: "frontend", type: "Radius.Compute/containers" },
    ]);
    expect(resources).toHaveLength(1);
    expect(resources[0].id).toBe(frontendId);
  });

  it("computes a diffHash when the input lacks one", () => {
    const resources = applicationGraphToResources([
      { id: frontendId, name: "frontend", type: "Radius.Compute/containers", properties: { image: "node:18" } },
    ]);
    expect(resources[0].diffHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("orders synthesized inbound edges deterministically regardless of input order", () => {
    // cache is targeted by two sources listed in reverse-sorted order; the
    // inbound edges must come out sorted by id so computeGraphDiff is stable.
    const resources = applicationGraphToResources([
      {
        id: frontendId,
        name: "frontend",
        type: "Radius.Compute/containers",
        connections: [{ id: cacheId, direction: "Outbound" }],
      },
      {
        id: databaseId,
        name: "database",
        type: "Radius.Data/postgreSQLDatabases",
        connections: [{ id: cacheId, direction: "Outbound" }],
      },
      { id: cacheId, name: "cache", type: "Radius.Data/redisCaches", connections: [] },
    ]);
    const cache = resources.find((r) => r.id === cacheId);
    const sorted = [...cache.connections].sort((a: any, b: any) =>
      String(a.id).localeCompare(String(b.id)),
    );
    expect(cache.connections).toEqual(sorted);
  });

  it("passes the resource's dependsOn into the fallback diffHash", () => {
    const properties = { image: "node:18" };
    const dependsOn = [cacheId, databaseId];
    const resources = applicationGraphToResources([
      { id: frontendId, name: "frontend", type: "Radius.Compute/containers", properties, dependsOn },
    ]);
    expect(resources[0].diffHash).toBe(computeDiffHash(properties, dependsOn));
  });

  it("treats a non-array dependsOn as empty when computing fallback diffHash", () => {
    const properties = { image: "node:18" };
    const resources = applicationGraphToResources([
      { id: frontendId, name: "frontend", type: "Radius.Compute/containers", properties, dependsOn: "oops" },
    ]);
    expect(resources[0].diffHash).toBe(computeDiffHash(properties, []));
  });
});
