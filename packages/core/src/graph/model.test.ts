import { describe, it, expect } from "vitest";
import {
  addInboundConnections,
  buildResourceID,
  stripAPIVersion
} from "./model.js";

describe("stripAPIVersion", () => {
  it("removes the @version suffix", () => {
    expect(
      stripAPIVersion("Radius.Compute/containers@2023-10-01-preview")
    ).toBe("Radius.Compute/containers");
  });

  it("returns the type unchanged when no @version present", () => {
    expect(stripAPIVersion("Radius.Compute/containers")).toBe(
      "Radius.Compute/containers"
    );
  });

  it("handles empty string", () => {
    expect(stripAPIVersion("")).toBe("");
  });
});

describe("buildResourceID", () => {
  it("constructs the expected Radius resource ID", () => {
    const id = buildResourceID("Radius.Compute/containers", "frontend");
    expect(id).toBe(
      "/planes/radius/local/resourcegroups/default/providers/Radius.Compute/containers/frontend"
    );
  });
});

describe("addInboundConnections", () => {
  it("adds inbound connection to target when outbound exists", () => {
    const frontendId = buildResourceID("Radius.Compute/containers", "frontend");
    const dbId = buildResourceID("Radius.Data/mongoDatabases", "mydb");
    const graph = {
      resources: [
        { id: frontendId, connections: [{ id: dbId, direction: "Outbound" }] },
        { id: dbId, connections: [] }
      ]
    };
    addInboundConnections(graph);
    const db = graph.resources[1];
    expect(db.connections).toContainEqual({
      id: frontendId,
      direction: "Inbound"
    });
  });

  it("does nothing when target is not in the graph", () => {
    const frontendId = buildResourceID("Radius.Compute/containers", "frontend");
    const missingId = buildResourceID("Radius.Data/mongoDatabases", "missing");
    const graph = {
      resources: [
        {
          id: frontendId,
          connections: [{ id: missingId, direction: "Outbound" }]
        }
      ]
    };
    addInboundConnections(graph);
    // Should not throw, frontend connections unchanged
    expect(graph.resources[0].connections).toHaveLength(1);
  });

  it("handles multiple resources with cross-connections", () => {
    const aId = buildResourceID("Radius.Compute/containers", "a");
    const bId = buildResourceID("Radius.Data/mongoDatabases", "b");
    const cId = buildResourceID("Radius.Data/redisCaches", "c");
    const graph = {
      resources: [
        {
          id: aId,
          connections: [
            { id: bId, direction: "Outbound" },
            { id: cId, direction: "Outbound" }
          ]
        },
        { id: bId, connections: [] },
        { id: cId, connections: [{ id: bId, direction: "Outbound" }] }
      ]
    };
    addInboundConnections(graph);
    const b = graph.resources[1];
    const inboundToB = b.connections.filter(
      (c: any) => c.direction === "Inbound"
    );
    expect(inboundToB).toHaveLength(2);
    expect(inboundToB.map((c: any) => c.id).sort()).toEqual([aId, cId].sort());
  });

  it("orders a mutual pair of edges by direction when the ids are equal", () => {
    // A and B point at each other, so A ends up with an Outbound and an Inbound
    // edge that share the same target id; only the direction tiebreak makes the
    // ordering deterministic for computeGraphDiff.
    const graph = {
      resources: [
        { id: "a", connections: [{ id: "b", direction: "Outbound" }] },
        { id: "b", connections: [{ id: "a", direction: "Outbound" }] }
      ]
    };

    addInboundConnections(graph);

    expect(graph.resources[0].connections).toEqual([
      { id: "b", direction: "Inbound" },
      { id: "b", direction: "Outbound" }
    ]);
  });

  it("skips resources that are null or carry no id", () => {
    const graph: { resources: any[] } = {
      resources: [
        null,
        { name: "no-id", connections: [{ id: "b", direction: "Outbound" }] },
        { id: "b", connections: [] }
      ]
    };

    expect(() => addInboundConnections(graph)).not.toThrow();
    expect(graph.resources[2].connections).toEqual([]);
  });

  it("ignores connection entries that are null, id-less, or not outbound", () => {
    const graph = {
      resources: [
        {
          id: "a",
          connections: [
            null,
            { direction: "Outbound" },
            { id: "b", direction: "Inbound" }
          ]
        },
        { id: "b", connections: [] }
      ]
    };

    addInboundConnections(graph);

    expect(graph.resources[1].connections).toEqual([]);
    // A null entry must survive the deterministic sort rather than crash it.
    expect(graph.resources[0].connections).toHaveLength(3);
  });

  it("creates the connections array on a target that has none", () => {
    const graph: { resources: any[] } = {
      resources: [
        { id: "a", connections: [{ id: "b", direction: "Outbound" }] },
        { id: "b" }
      ]
    };

    addInboundConnections(graph);

    expect(graph.resources[1].connections).toEqual([
      { id: "a", direction: "Inbound" }
    ]);
  });

  it("leaves a resource whose connections value is not an array untouched", () => {
    const graph = { resources: [{ id: "a", connections: "none" }] };

    expect(() => addInboundConnections(graph)).not.toThrow();
    expect(graph.resources[0].connections).toBe("none");
  });

  it("sorts a resource's own outbound edges by target id", () => {
    const graph = {
      resources: [
        {
          id: "a",
          connections: [
            { id: "z", direction: "Outbound" },
            { id: "m", direction: "Outbound" }
          ]
        }
      ]
    };

    addInboundConnections(graph);

    expect(graph.resources[0].connections.map((c: any) => c.id)).toEqual([
      "m",
      "z"
    ]);
  });

  it("handles an empty resources array", () => {
    const graph = { resources: [] };

    expect(() => addInboundConnections(graph)).not.toThrow();
    expect(graph.resources).toEqual([]);
  });

  it("handles an isolated resource that declares no connections", () => {
    const graph: { resources: any[] } = { resources: [{ id: "solo" }] };

    expect(() => addInboundConnections(graph)).not.toThrow();
    expect(graph.resources[0].connections).toBeUndefined();
  });
});
