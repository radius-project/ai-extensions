import { describe, it, expect } from "vitest";
import {
  addInboundConnections,
  buildResourceID,
  stripAPIVersion,
} from "./model.js";

describe("stripAPIVersion", () => {
  it("removes the @version suffix", () => {
    expect(stripAPIVersion("Radius.Compute/containers@2023-10-01-preview")).toBe(
      "Radius.Compute/containers",
    );
  });

  it("returns the type unchanged when no @version present", () => {
    expect(stripAPIVersion("Radius.Compute/containers")).toBe("Radius.Compute/containers");
  });

  it("handles empty string", () => {
    expect(stripAPIVersion("")).toBe("");
  });
});

describe("buildResourceID", () => {
  it("constructs the expected Radius resource ID", () => {
    const id = buildResourceID("Radius.Compute/containers", "frontend");
    expect(id).toBe(
      "/planes/radius/local/resourcegroups/default/providers/Radius.Compute/containers/frontend",
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
        { id: dbId, connections: [] },
      ],
    };
    addInboundConnections(graph);
    const db = graph.resources[1];
    expect(db.connections).toContainEqual({ id: frontendId, direction: "Inbound" });
  });

  it("does nothing when target is not in the graph", () => {
    const frontendId = buildResourceID("Radius.Compute/containers", "frontend");
    const missingId = buildResourceID("Radius.Data/mongoDatabases", "missing");
    const graph = {
      resources: [{ id: frontendId, connections: [{ id: missingId, direction: "Outbound" }] }],
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
        { id: aId, connections: [{ id: bId, direction: "Outbound" }, { id: cId, direction: "Outbound" }] },
        { id: bId, connections: [] },
        { id: cId, connections: [{ id: bId, direction: "Outbound" }] },
      ],
    };
    addInboundConnections(graph);
    const b = graph.resources[1];
    const inboundToB = b.connections.filter((c: any) => c.direction === "Inbound");
    expect(inboundToB).toHaveLength(2);
    expect(inboundToB.map((c: any) => c.id).sort()).toEqual([aId, cId].sort());
  });
});
