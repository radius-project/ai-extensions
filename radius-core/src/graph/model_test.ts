import { describe, it, expect } from "vitest";
import {
  computeDiffHash,
  buildModeledGraph,
  stripAPIVersion,
  addInboundConnections,
  buildResourceID,
  MODELED_GRAPH_DEFAULTS,
} from "./model.js";

describe("stripAPIVersion", () => {
  it("strips @version suffix", () => {
    expect(stripAPIVersion("Radius.Compute/containers@2024-01-01")).toBe("Radius.Compute/containers");
  });

  it("returns unchanged if no version suffix", () => {
    expect(stripAPIVersion("Radius.Compute/containers")).toBe("Radius.Compute/containers");
  });

  it("handles empty string", () => {
    expect(stripAPIVersion("")).toBe("");
  });
});

describe("buildResourceID", () => {
  it("constructs the correct resource ID path", () => {
    const id = buildResourceID("Radius.Compute/containers", "myapp");
    expect(id).toBe(
      `/planes/radius/${MODELED_GRAPH_DEFAULTS.plane}/resourcegroups/${MODELED_GRAPH_DEFAULTS.resourceGroup}/providers/Radius.Compute/containers/myapp`,
    );
  });
});

describe("computeDiffHash", () => {
  it("returns a sha256:<hex> string", () => {
    const hash = computeDiffHash({ foo: "bar" });
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("excludes provisioningState and status from hash", () => {
    const hash1 = computeDiffHash({ foo: "bar", provisioningState: "Succeeded", status: "Ready" });
    const hash2 = computeDiffHash({ foo: "bar" });
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different properties", () => {
    const hash1 = computeDiffHash({ foo: "bar" });
    const hash2 = computeDiffHash({ foo: "baz" });
    expect(hash1).not.toBe(hash2);
  });

  it("includes dependsOn in hash (sorted)", () => {
    const hash1 = computeDiffHash({}, ["a", "b"]);
    const hash2 = computeDiffHash({}, ["b", "a"]);
    // Same deps in different order → same hash
    expect(hash1).toBe(hash2);
  });

  it("different dependsOn produces different hash", () => {
    const hash1 = computeDiffHash({}, ["a"]);
    const hash2 = computeDiffHash({}, ["b"]);
    expect(hash1).not.toBe(hash2);
  });

  it("handles null/undefined properties", () => {
    const hash = computeDiffHash(null);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("addInboundConnections", () => {
  it("adds inbound connections to target resources", () => {
    const graph = {
      resources: [
        { id: "/res/a", connections: [{ id: "/res/b", direction: "Outbound" }] },
        { id: "/res/b", connections: [] },
      ],
    };
    addInboundConnections(graph);
    expect(graph.resources[1].connections).toContainEqual({ id: "/res/a", direction: "Inbound" });
  });

  it("does not add inbound for non-Outbound connections", () => {
    const graph = {
      resources: [
        { id: "/res/a", connections: [{ id: "/res/b", direction: "Inbound" }] },
        { id: "/res/b", connections: [] },
      ],
    };
    addInboundConnections(graph);
    expect(graph.resources[1].connections).toHaveLength(0);
  });

  it("skips connections to non-existent resources", () => {
    const graph = {
      resources: [
        { id: "/res/a", connections: [{ id: "/res/missing", direction: "Outbound" }] },
      ],
    };
    // Should not throw
    addInboundConnections(graph);
  });

  it("handles resources with no connections array", () => {
    const graph = {
      resources: [
        { id: "/res/a", connections: [{ id: "/res/b", direction: "Outbound" }] },
        { id: "/res/b" },
      ],
    };
    addInboundConnections(graph);
    expect((graph.resources[1] as any).connections).toContainEqual({ id: "/res/a", direction: "Inbound" });
  });
});

describe("buildModeledGraph", () => {
  it("returns empty resources for empty template", () => {
    expect(buildModeledGraph({ resources: [] })).toEqual({ resources: [] });
    expect(buildModeledGraph({ resources: null })).toEqual({ resources: [] });
    expect(buildModeledGraph({})).toEqual({ resources: [] });
  });

  it("skips applications.core/applications resource type", () => {
    const template = {
      resources: [
        { type: "Applications.Core/applications", name: "myapp", properties: { name: "myapp", properties: {} }, dependsOn: [] },
      ],
    };
    const result = buildModeledGraph(template);
    expect(result.resources).toHaveLength(0);
  });

  it("builds graph from classic array format (languageVersion 1.x)", () => {
    const template = {
      resources: [
        { type: "Radius.Compute/containers", name: "frontend", properties: { name: "frontend", properties: {} }, dependsOn: [] },
        { type: "Radius.Data/mySqlDatabases", name: "db", properties: { name: "db", properties: {} }, dependsOn: [] },
      ],
    };
    const result = buildModeledGraph(template);
    expect(result.resources).toHaveLength(2);
    expect(result.resources[0].name).toBe("frontend");
    expect(result.resources[0].type).toBe("Radius.Compute/containers");
    expect(result.resources[0].id).toContain("Radius.Compute/containers/frontend");
    expect(result.resources[1].name).toBe("db");
  });

  it("builds graph from symbolic-name object format (languageVersion 2.0)", () => {
    const template = {
      resources: {
        container: {
          type: "Radius.Compute/containers@2024-01-01",
          properties: {
            name: "frontend",
            properties: {
              connections: {
                db: { source: "[reference('dbSym').id]" },
              },
            },
          },
          dependsOn: ["dbSym"],
        },
        dbSym: {
          type: "Radius.Data/mySqlDatabases@2024-01-01",
          properties: { name: "mydb", properties: {} },
          dependsOn: [],
        },
      },
    };
    const result = buildModeledGraph(template);
    expect(result.resources.length).toBeGreaterThanOrEqual(1);
    // The container should have a rewritten connection from symbolic reference
    const container = result.resources.find((r: any) => r.name === "frontend");
    expect(container).toBeDefined();
    expect(container.type).toBe("Radius.Compute/containers");
  });

  it("resolves outbound connections from resourceId expressions", () => {
    // Classic array format: entry = { type, name, properties: { connections: {...} }, dependsOn }
    // Note: collectARMResources returns array entries unchanged; in this format `properties` is already the inner properties object.
    const template = {
      resources: [
        {
          type: "Radius.Compute/containers",
          name: "frontend",
          properties: {
            connections: {
              db: { source: "[resourceId('Radius.Data/mySqlDatabases', 'mydb')]" },
            },
          },
          dependsOn: [],
        },
        {
          type: "Radius.Data/mySqlDatabases",
          name: "mydb",
          properties: {},
          dependsOn: [],
        },
      ],
    };
    const result = buildModeledGraph(template);
    const frontend = result.resources.find((r: any) => r.name === "frontend");
    expect(frontend.connections.some((c: any) => c.direction === "Outbound" && c.id.includes("mySqlDatabases/mydb"))).toBe(true);

    // Inbound should be added to mydb
    const db = result.resources.find((r: any) => r.name === "mydb");
    expect(db.connections.some((c: any) => c.direction === "Inbound")).toBe(true);
  });

  it("includes diffHash on each resource", () => {
    const template = {
      resources: [
        { type: "Radius.Compute/containers", name: "svc", properties: { name: "svc", properties: { image: "nginx" } }, dependsOn: [] },
      ],
    };
    const result = buildModeledGraph(template);
    expect(result.resources[0].diffHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("skips resources without type or name", () => {
    const template = {
      resources: [
        { type: "", name: "x", properties: { name: "x", properties: {} }, dependsOn: [] },
        { type: "Radius.Compute/containers", name: "", properties: { name: "", properties: {} }, dependsOn: [] },
      ],
    };
    const result = buildModeledGraph(template);
    expect(result.resources).toHaveLength(0);
  });
});
