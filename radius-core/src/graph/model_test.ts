import { describe, it, expect } from "vitest";
import {
  computeDiffHash,
  buildModeledGraph,
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

describe("computeDiffHash", () => {
  it("returns a sha256 prefixed hash", () => {
    const hash = computeDiffHash({ image: "node:18" });
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("excludes provisioningState from the hash", () => {
    const hash1 = computeDiffHash({ image: "node:18", provisioningState: "Succeeded" });
    const hash2 = computeDiffHash({ image: "node:18" });
    expect(hash1).toBe(hash2);
  });

  it("excludes status from the hash", () => {
    const hash1 = computeDiffHash({ image: "node:18", status: "Running" });
    const hash2 = computeDiffHash({ image: "node:18" });
    expect(hash1).toBe(hash2);
  });

  it("includes other properties in the hash", () => {
    const hash1 = computeDiffHash({ image: "node:18" });
    const hash2 = computeDiffHash({ image: "node:20" });
    expect(hash1).not.toBe(hash2);
  });

  it("sorts dependsOn for deterministic hashing", () => {
    const hash1 = computeDiffHash({}, ["a", "b", "c"]);
    const hash2 = computeDiffHash({}, ["c", "a", "b"]);
    expect(hash1).toBe(hash2);
  });

  it("handles null/undefined properties", () => {
    const hash = computeDiffHash(null);
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("handles empty dependsOn", () => {
    const hash1 = computeDiffHash({ foo: "bar" }, []);
    const hash2 = computeDiffHash({ foo: "bar" });
    expect(hash1).toBe(hash2);
  });

  it("produces the same hash regardless of property insertion order", () => {
    const hash1 = computeDiffHash({ alpha: "1", beta: "2", gamma: "3" });
    const hash2 = computeDiffHash({ gamma: "3", alpha: "1", beta: "2" });
    expect(hash1).toBe(hash2);
  });

  it("sorts nested object keys for deterministic hashing", () => {
    const hash1 = computeDiffHash({ container: { image: "node:18", port: 3000 } });
    const hash2 = computeDiffHash({ container: { port: 3000, image: "node:18" } });
    expect(hash1).toBe(hash2);
  });
});

describe("buildModeledGraph", () => {
  describe("empty/invalid inputs", () => {
    it("returns empty resources for undefined resources", () => {
      const graph = buildModeledGraph({ resources: undefined });
      expect(graph.resources).toEqual([]);
    });

    it("returns empty resources for empty array", () => {
      const graph = buildModeledGraph({ resources: [] });
      expect(graph.resources).toEqual([]);
    });

    it("returns empty resources for null resources", () => {
      const graph = buildModeledGraph({ resources: null });
      expect(graph.resources).toEqual([]);
    });
  });

  describe("classic array format (languageVersion 1.x)", () => {
    it("builds a graph from a single resource", () => {
      const template = {
        resources: [
          {
            type: "Radius.Compute/containers",
            name: "frontend",
            properties: { image: "node:18" },
            dependsOn: [],
          },
        ],
      };
      const graph = buildModeledGraph(template);
      expect(graph.resources).toHaveLength(1);
      expect(graph.resources[0].name).toBe("frontend");
      expect(graph.resources[0].type).toBe("Radius.Compute/containers");
      expect(graph.resources[0].id).toBe(
        buildResourceID("Radius.Compute/containers", "frontend"),
      );
      expect(graph.resources[0].diffHash).toMatch(/^sha256:/);
    });

    it("skips applications.core/applications resources", () => {
      const template = {
        resources: [
          {
            type: "Applications.Core/applications",
            name: "myapp",
            properties: {},
            dependsOn: [],
          },
          {
            type: "Radius.Compute/containers",
            name: "frontend",
            properties: {},
            dependsOn: [],
          },
        ],
      };
      const graph = buildModeledGraph(template);
      expect(graph.resources).toHaveLength(1);
      expect(graph.resources[0].name).toBe("frontend");
    });

    it("skips applications.core/environments resources", () => {
      const template = {
        resources: [
          {
            type: "Applications.Core/environments",
            name: "dev",
            properties: {},
            dependsOn: [],
          },
        ],
      };
      const graph = buildModeledGraph(template);
      expect(graph.resources).toHaveLength(0);
    });

    it("skips radius.core/recipepacks resources", () => {
      const template = {
        resources: [
          {
            type: "Radius.Core/recipePacks",
            name: "default",
            properties: {},
            dependsOn: [],
          },
        ],
      };
      const graph = buildModeledGraph(template);
      expect(graph.resources).toHaveLength(0);
    });

    it("skips resources with missing type or name", () => {
      const template = {
        resources: [
          { type: "", name: "noType", properties: {}, dependsOn: [] },
          { type: "Radius.Compute/containers", name: "", properties: {}, dependsOn: [] },
        ],
      };
      const graph = buildModeledGraph(template);
      expect(graph.resources).toHaveLength(0);
    });

    it("resolves outbound connections from properties.connections", () => {
      const template = {
        resources: [
          {
            type: "Radius.Compute/containers",
            name: "frontend",
            properties: {
              connections: {
                db: { source: "[resourceId('Radius.Data/mongoDatabases', 'mydb')]" },
              },
            },
            dependsOn: [],
          },
          {
            type: "Radius.Data/mongoDatabases",
            name: "mydb",
            properties: {},
            dependsOn: [],
          },
        ],
      };
      const graph = buildModeledGraph(template);
      const frontend = graph.resources.find((r: any) => r.name === "frontend");
      const outbound = frontend.connections.filter((c: any) => c.direction === "Outbound");
      expect(outbound).toHaveLength(1);
      expect(outbound[0].id).toBe(buildResourceID("Radius.Data/mongoDatabases", "mydb"));
    });

    it("adds inbound connections to referenced resources", () => {
      const template = {
        resources: [
          {
            type: "Radius.Compute/containers",
            name: "frontend",
            properties: {
              connections: {
                db: { source: "[resourceId('Radius.Data/mongoDatabases', 'mydb')]" },
              },
            },
            dependsOn: [],
          },
          {
            type: "Radius.Data/mongoDatabases",
            name: "mydb",
            properties: {},
            dependsOn: [],
          },
        ],
      };
      const graph = buildModeledGraph(template);
      const db = graph.resources.find((r: any) => r.name === "mydb");
      const inbound = db.connections.filter((c: any) => c.direction === "Inbound");
      expect(inbound).toHaveLength(1);
      expect(inbound[0].id).toBe(buildResourceID("Radius.Compute/containers", "frontend"));
    });

    it("resolves dependsOn into the diffHash", () => {
      const template = {
        resources: [
          {
            type: "Radius.Compute/containers",
            name: "frontend",
            properties: { image: "node:18" },
            dependsOn: ["[resourceId('Radius.Data/mongoDatabases', 'mydb')]"],
          },
        ],
      };
      const graph = buildModeledGraph(template);
      const frontend = graph.resources[0];

      // Hash with dependsOn should differ from hash without
      const hashWithout = computeDiffHash({ image: "node:18" }, []);
      expect(frontend.diffHash).not.toBe(hashWithout);
    });
  });

  describe("symbolic-name format (languageVersion 2.0)", () => {
    it("builds a graph from symbolic-name object resources", () => {
      const template = {
        resources: {
          frontend: {
            type: "Radius.Compute/containers@2023-10-01-preview",
            properties: {
              name: "frontend",
              properties: { image: "node:18" },
            },
            dependsOn: [],
          },
        },
      };
      const graph = buildModeledGraph(template);
      expect(graph.resources).toHaveLength(1);
      expect(graph.resources[0].name).toBe("frontend");
      expect(graph.resources[0].type).toBe("Radius.Compute/containers");
    });

    it("rewrites symbolic dependsOn to resourceId expressions", () => {
      const template = {
        resources: {
          frontend: {
            type: "Radius.Compute/containers@2023-10-01-preview",
            properties: {
              name: "frontend",
              properties: {},
            },
            dependsOn: ["db"],
          },
          db: {
            type: "Radius.Data/mongoDatabases@2023-10-01-preview",
            properties: {
              name: "mydb",
              properties: {},
            },
            dependsOn: [],
          },
        },
      };
      const graph = buildModeledGraph(template);
      const frontend = graph.resources.find((r: any) => r.name === "frontend");
      expect(frontend).toBeDefined();

      const dbId = buildResourceID("Radius.Data/mongoDatabases", "mydb");
      expect(frontend!.diffHash).toBe(computeDiffHash({}, [dbId]));
    });

    it("rewrites symbolic connection sources to resourceId expressions", () => {
        resources: {
          frontend: {
            type: "Radius.Compute/containers@2023-10-01-preview",
            properties: {
              name: "frontend",
              properties: {
                connections: {
                  db: { source: "[reference('db').id]" },
                },
              },
            },
            dependsOn: [],
          },
          db: {
            type: "Radius.Data/mongoDatabases@2023-10-01-preview",
            properties: {
              name: "mydb",
              properties: {},
            },
            dependsOn: [],
          },
        },
      };
      const graph = buildModeledGraph(template);
      const frontend = graph.resources.find((r: any) => r.name === "frontend");
      const outbound = frontend.connections.filter((c: any) => c.direction === "Outbound");
      expect(outbound).toHaveLength(1);
      expect(outbound[0].id).toBe(buildResourceID("Radius.Data/mongoDatabases", "mydb"));
    });

    it("strips API version from symbolic-name types", () => {
      const template = {
        resources: {
          svc: {
            type: "Radius.Compute/containers@2023-10-01-preview",
            properties: {
              name: "svc",
              properties: {},
            },
            dependsOn: [],
          },
        },
      };
      const graph = buildModeledGraph(template);
      expect(graph.resources[0].type).toBe("Radius.Compute/containers");
    });
  });

  describe("resource structure", () => {
    it("sets provisioningState to NotSpecified", () => {
      const template = {
        resources: [
          {
            type: "Radius.Compute/containers",
            name: "frontend",
            properties: {},
            dependsOn: [],
          },
        ],
      };
      const graph = buildModeledGraph(template);
      expect(graph.resources[0].provisioningState).toBe("NotSpecified");
    });

    it("sets outputResources to empty array", () => {
      const template = {
        resources: [
          {
            type: "Radius.Compute/containers",
            name: "frontend",
            properties: {},
            dependsOn: [],
          },
        ],
      };
      const graph = buildModeledGraph(template);
      expect(graph.resources[0].outputResources).toEqual([]);
    });

    it("returns empty connections when none exist", () => {
      const template = {
        resources: [
          {
            type: "Radius.Compute/containers",
            name: "frontend",
            properties: {},
            dependsOn: [],
          },
        ],
      };
      const graph = buildModeledGraph(template);
      expect(graph.resources[0].connections).toEqual([]);
    });
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
