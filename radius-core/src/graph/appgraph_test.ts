import { describe, it, expect } from "vitest";
import { applicationGraphToResources } from "./appgraph.js";
import { buildResourceID } from "./model.js";

const frontendId = buildResourceID("Radius.Compute/containers", "frontend");
const cacheId = buildResourceID("Radius.Data/redisCaches", "cache");
const databaseId = buildResourceID("Radius.Data/postgreSQLDatabases", "database");
const frontendHash = `sha256:${"a".repeat(64)}`;
const cacheHash = `sha256:${"b".repeat(64)}`;
const databaseHash = `sha256:${"c".repeat(64)}`;
const alternateHash = `sha256:${"d".repeat(64)}`;

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
        diffHash: frontendHash,
      },
      {
        id: cacheId,
        name: "cache",
        type: "Radius.Data/redisCaches",
        provisioningState: "NotSpecified",
        connections: [],
        outputResources: [],
        diffHash: cacheHash,
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
    expect(frontend.diffHash).toBe(frontendHash);
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
      diffHash: databaseHash,
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
      { id: frontendId, name: "frontend", type: "Radius.Compute/containers", diffHash: frontendHash },
    ]);
    expect(resources).toHaveLength(1);
    expect(resources[0].id).toBe(frontendId);
  });

  it("throws when the input lacks a diffHash", () => {
    expect(() => applicationGraphToResources([
      { id: frontendId, name: "frontend", type: "Radius.Compute/containers", properties: { image: "node:18" } },
    ])).toThrow(/missing a valid diffHash/);
  });

  it.each([
    "sha256:",
    "sha256:abc",
    `sha256:${"g".repeat(64)}`,
    `SHA256:${"a".repeat(64)}`,
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`,
  ])("throws when the input has malformed diffHash %s", (diffHash) => {
    expect(() => applicationGraphToResources([
      { id: frontendId, name: "frontend", type: "Radius.Compute/containers", diffHash },
    ])).toThrow(/missing a valid diffHash/);
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
        diffHash: frontendHash,
      },
      {
        id: databaseId,
        name: "database",
        type: "Radius.Data/postgreSQLDatabases",
        connections: [{ id: cacheId, direction: "Outbound" }],
        diffHash: databaseHash,
      },
      { id: cacheId, name: "cache", type: "Radius.Data/redisCaches", connections: [], diffHash: cacheHash },
    ]);
    const cache = resources.find((r) => r.id === cacheId);
    const sorted = [...cache.connections].sort((a: any, b: any) =>
      String(a.id).localeCompare(String(b.id)),
    );
    expect(cache.connections).toEqual(sorted);
  });

  it("preserves diffHash from input even when dependsOn is present", () => {
    const resources = applicationGraphToResources([
      { id: frontendId, name: "frontend", type: "Radius.Compute/containers", properties: { image: "node:18" }, dependsOn: [cacheId, databaseId], diffHash: alternateHash },
    ]);
    expect(resources[0].diffHash).toBe(alternateHash);
  });

  it("throws when diffHash is missing even with dependsOn present", () => {
    expect(() => applicationGraphToResources([
      { id: frontendId, name: "frontend", type: "Radius.Compute/containers", properties: { image: "node:18" }, dependsOn: [cacheId] },
    ])).toThrow(/missing a valid diffHash/);
  });
});
