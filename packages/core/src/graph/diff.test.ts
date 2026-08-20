import { describe, it, expect } from "vitest";
import { computeGraphDiff } from "./diff.js";
import { buildResourceID } from "./model.js";

function makeResource(type: string, name: string, extra: any = {}) {
  return {
    id: buildResourceID(type, name),
    name,
    type,
    connections: [],
    ...extra
  };
}

describe("computeGraphDiff", () => {
  it("returns an empty array for two empty inputs", () => {
    expect(computeGraphDiff([], [])).toEqual([]);
  });

  it("marks a resource present only in head as added", () => {
    const head = [makeResource("Radius.Compute/containers", "api")];
    const result = computeGraphDiff([], head);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("added");
    expect(result[0].name).toBe("api");
  });

  it("marks a resource present only in base as removed", () => {
    const base = [makeResource("Radius.Compute/containers", "api")];
    const result = computeGraphDiff(base, []);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("removed");
    expect(result[0].name).toBe("api");
  });

  it("marks a resource with identical id and content as unchanged", () => {
    const base = makeResource("Radius.Compute/containers", "api");
    const head = makeResource("Radius.Compute/containers", "api");
    const result = computeGraphDiff([base], [head]);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("unchanged");
  });

  it("produces removed + added entries when a resource's type changes", () => {
    const mongoDb = makeResource("Radius.Data/mongoDatabases", "db");
    const postgresDb = makeResource("Radius.Data/postgreSQLDatabases", "db");
    const result = computeGraphDiff([mongoDb], [postgresDb]);

    expect(result).toHaveLength(2);
    const removed = result.find((r) => r.type === "Radius.Data/mongoDatabases");
    const added = result.find(
      (r) => r.type === "Radius.Data/postgreSQLDatabases"
    );
    expect(removed?.diffStatus).toBe("removed");
    expect(added?.diffStatus).toBe("added");
  });

  it("marks a container as modified when the db it connects to changes type", () => {
    const mongoId = buildResourceID("Radius.Data/mongoDatabases", "db");
    const postgresId = buildResourceID("Radius.Data/postgreSQLDatabases", "db");

    const baseContainer = makeResource("Radius.Compute/containers", "api", {
      connections: [{ id: mongoId, direction: "Outbound" }]
    });
    const headContainer = makeResource("Radius.Compute/containers", "api", {
      connections: [{ id: postgresId, direction: "Outbound" }]
    });
    const mongoDb = makeResource("Radius.Data/mongoDatabases", "db");
    const postgresDb = makeResource("Radius.Data/postgreSQLDatabases", "db");

    const result = computeGraphDiff(
      [baseContainer, mongoDb],
      [headContainer, postgresDb]
    );

    const container = result.find((r) => r.name === "api");
    const mongo = result.find((r) => r.type === "Radius.Data/mongoDatabases");
    const postgres = result.find(
      (r) => r.type === "Radius.Data/postgreSQLDatabases"
    );

    expect(container?.diffStatus).toBe("modified");
    expect(mongo?.diffStatus).toBe("removed");
    expect(postgres?.diffStatus).toBe("added");
  });

  it("marks a resource as modified when connections change", () => {
    const base = [
      makeResource("Radius.Compute/containers", "api", { connections: [] })
    ];
    const head = [
      makeResource("Radius.Compute/containers", "api", {
        connections: [{ id: "some-id", direction: "Outbound" }]
      })
    ];
    const result = computeGraphDiff(base, head);
    expect(result[0].diffStatus).toBe("modified");
  });

  it("marks a resource as modified when only its diffHash changes", () => {
    // Same id/type/connections but a different diffHash represents a property-only
    // edit (e.g. a container image or database version). The rad app-graph builder
    // encodes such edits in diffHash, so the diff must treat them as modified.
    const base = [
      makeResource("Radius.Compute/containers", "api", { diffHash: "hash-v1" })
    ];
    const head = [
      makeResource("Radius.Compute/containers", "api", { diffHash: "hash-v2" })
    ];
    const result = computeGraphDiff(base, head);
    expect(result[0].diffStatus).toBe("modified");
  });

  it("keeps a resource unchanged when its diffHash is identical", () => {
    const base = [
      makeResource("Radius.Compute/containers", "api", { diffHash: "hash-v1" })
    ];
    const head = [
      makeResource("Radius.Compute/containers", "api", { diffHash: "hash-v1" })
    ];
    const result = computeGraphDiff(base, head);
    expect(result[0].diffStatus).toBe("unchanged");
  });

  it("handles null/undefined inputs gracefully", () => {
    for (const [base, head] of [
      [null, null],
      [undefined, undefined],
      [null, undefined],
      [undefined, null]
    ] as any) {
      expect(() => computeGraphDiff(base, head)).not.toThrow();
      expect(computeGraphDiff(base, head)).toEqual([]);
    }
  });

  it("reports all four statuses together in one diff", () => {
    const type = "Radius.Compute/containers";
    const unchanged = makeResource(type, "unchanged");
    const removed = makeResource(type, "removed");
    const added = makeResource(type, "added");
    const modified = makeResource(type, "modified", { connections: [] });
    const modifiedHead = makeResource(type, "modified", {
      connections: [{ id: "some-id", direction: "Outbound" }]
    });

    const base = [unchanged, removed, modified];
    const head = [unchanged, modifiedHead, added];

    const result = computeGraphDiff(base, head);
    expect(result).toHaveLength(4);
    expect(new Set(result.map((r) => r.name)).size).toBe(4);
    const byName = Object.fromEntries(
      result.map((r) => [r.name, r.diffStatus])
    );

    expect(byName["unchanged"]).toBe("unchanged");
    expect(byName["removed"]).toBe("removed");
    expect(byName["added"]).toBe("added");
    expect(byName["modified"]).toBe("modified");
  });

  it("preserves all resource fields on diffed entries", () => {
    const r = makeResource("Radius.Compute/containers", "api");
    const result = computeGraphDiff([], [r]);
    expect(result[0]).toMatchObject({ id: r.id, name: r.name, type: r.type });
  });
});

describe("computeGraphDiff — connection-level (edge) diff", () => {
  it("annotates a connection present on both branches as unchanged", () => {
    const dbId = buildResourceID("Radius.Data/mongoDatabases", "db");
    const mk = () => [
      makeResource("Radius.Compute/containers", "api", {
        connections: [{ id: dbId, direction: "Outbound" }]
      }),
      makeResource("Radius.Data/mongoDatabases", "db")
    ];
    const result = computeGraphDiff(mk(), mk());
    const api = result.find((r) => r.name === "api");
    expect(api.diffStatus).toBe("unchanged");
    expect(api.connections).toHaveLength(1);
    expect(api.connections[0].diffStatus).toBe("unchanged");
  });

  it("annotates a connection added on head as added", () => {
    const dbId = buildResourceID("Radius.Data/mongoDatabases", "db");
    const base = [
      makeResource("Radius.Compute/containers", "api"),
      makeResource("Radius.Data/mongoDatabases", "db")
    ];
    const head = [
      makeResource("Radius.Compute/containers", "api", {
        connections: [{ id: dbId, direction: "Outbound" }]
      }),
      makeResource("Radius.Data/mongoDatabases", "db")
    ];
    const result = computeGraphDiff(base, head);
    const api = result.find((r) => r.name === "api");
    const edge = api.connections.find((c: any) => c.id === dbId);
    expect(edge.diffStatus).toBe("added");
  });

  it("re-attaches a removed edge between two still-present nodes as a removed connection", () => {
    // The db stays, but the container drops its link to it. Because the head
    // resource carries only head connections, the removed edge must be injected
    // back onto the (still-present) source so the diff view can render it.
    const dbId = buildResourceID("Radius.Data/mongoDatabases", "db");
    const base = [
      makeResource("Radius.Compute/containers", "api", {
        connections: [{ id: dbId, direction: "Outbound" }]
      }),
      makeResource("Radius.Data/mongoDatabases", "db")
    ];
    const head = [
      makeResource("Radius.Compute/containers", "api"),
      makeResource("Radius.Data/mongoDatabases", "db")
    ];
    const result = computeGraphDiff(base, head);
    const api = result.find((r) => r.name === "api");
    const db = result.find((r) => r.name === "db");
    expect(db.diffStatus).toBe("unchanged");
    expect(api.diffStatus).toBe("modified");
    const removedEdge = api.connections.find((c: any) => c.id === dbId);
    expect(removedEdge).toBeTruthy();
    expect(removedEdge.diffStatus).toBe("removed");
  });

  it("keeps both the added and the removed edge when a connection's target type changes", () => {
    const mongoId = buildResourceID("Radius.Data/mongoDatabases", "db");
    const postgresId = buildResourceID("Radius.Data/postgreSQLDatabases", "db");
    const base = [
      makeResource("Radius.Compute/containers", "api", {
        connections: [{ id: mongoId, direction: "Outbound" }]
      }),
      makeResource("Radius.Data/mongoDatabases", "db")
    ];
    const head = [
      makeResource("Radius.Compute/containers", "api", {
        connections: [{ id: postgresId, direction: "Outbound" }]
      }),
      makeResource("Radius.Data/postgreSQLDatabases", "db")
    ];
    const result = computeGraphDiff(base, head);
    const api = result.find((r) => r.name === "api");
    const added = api.connections.find((c: any) => c.id === postgresId);
    const removed = api.connections.find((c: any) => c.id === mongoId);
    expect(added?.diffStatus).toBe("added");
    expect(removed?.diffStatus).toBe("removed");
  });

  it("marks every edge leaving a removed node as a removed connection", () => {
    const dbId = buildResourceID("Radius.Data/mongoDatabases", "db");
    const base = [
      makeResource("Radius.Compute/containers", "api", {
        connections: [{ id: dbId, direction: "Outbound" }]
      }),
      makeResource("Radius.Data/mongoDatabases", "db")
    ];
    const head = [makeResource("Radius.Data/mongoDatabases", "db")];
    const result = computeGraphDiff(base, head);
    const api = result.find((r) => r.name === "api");
    expect(api.diffStatus).toBe("removed");
    expect(api.connections[0].diffStatus).toBe("removed");
  });

  it("does not mutate the input resource connections", () => {
    const dbId = buildResourceID("Radius.Data/mongoDatabases", "db");
    const headApi = makeResource("Radius.Compute/containers", "api", {
      connections: [{ id: dbId, direction: "Outbound" }]
    });
    computeGraphDiff(
      [],
      [headApi, makeResource("Radius.Data/mongoDatabases", "db")]
    );
    expect(headApi.connections[0]).not.toHaveProperty("diffStatus");
  });

  it("leaves inbound connections untagged (only outbound edges render)", () => {
    const dbId = buildResourceID("Radius.Data/mongoDatabases", "db");
    const mk = () => [
      makeResource("Radius.Compute/containers", "api", {
        connections: [{ id: dbId, direction: "Inbound" }]
      }),
      makeResource("Radius.Data/mongoDatabases", "db")
    ];
    const result = computeGraphDiff(mk(), mk());
    const api = result.find((r) => r.name === "api");
    expect(api.connections[0]).not.toHaveProperty("diffStatus");
  });
});

describe("computeGraphDiff — degenerate resource and connection shapes", () => {
  it("falls back to the name when a resource carries no id", () => {
    const base = [{ name: "api", type: "Radius.Compute/containers" }];
    const head = [
      { name: "api", type: "Radius.Compute/containers", diffHash: "h2" }
    ];

    const result = computeGraphDiff(base, head);

    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("modified");
  });

  it("matches keyless resources on both sides under the empty key", () => {
    // Neither id nor name is present, so both sides collapse to the "" key and
    // the pair is compared rather than reported as one added and one removed.
    const result = computeGraphDiff(
      [{ type: "Radius.Compute/containers" }],
      [{ type: "Radius.Compute/containers" }]
    );

    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("unchanged");
  });

  it("treats resources with no connections array as having no edges", () => {
    const base = [{ id: "a", name: "a", type: "T" }];
    const head = [{ id: "a", name: "a", type: "T" }];

    const result = computeGraphDiff(base, head);

    expect(result[0].connections).toEqual([]);
  });

  it("carries no edges for a removed node that never declared connections", () => {
    const result = computeGraphDiff([{ id: "a", name: "a", type: "T" }], []);

    expect(result[0].diffStatus).toBe("removed");
    expect(result[0].connections).toEqual([]);
  });

  it("ignores null entries inside a connections array", () => {
    const base = [{ id: "a", name: "a", type: "T", connections: [null] }];
    const head = [{ id: "a", name: "a", type: "T", connections: [null] }];

    const result = computeGraphDiff(base, head);

    // A null connection defaults to Outbound with an empty target key, so it is
    // annotated rather than dropped, and matches across branches.
    expect(result[0].connections[0].diffStatus).toBe("unchanged");
  });

  it("keys an edge by the connection name when it carries no id", () => {
    const base = [
      { id: "a", name: "a", type: "T", connections: [{ name: "cache" }] }
    ];
    const head = [
      { id: "a", name: "a", type: "T", connections: [{ name: "cache" }] }
    ];

    const result = computeGraphDiff(base, head);

    expect(result[0].connections[0].diffStatus).toBe("unchanged");
  });

  it("distinguishes an added edge from a base edge on the same source", () => {
    const base = [
      { id: "a", name: "a", type: "T", connections: [{ name: "cache" }] }
    ];
    const head = [
      { id: "a", name: "a", type: "T", connections: [{ name: "queue" }] }
    ];

    const result = computeGraphDiff(base, head);
    const statuses = result[0].connections.map((c: any) => [
      c.name,
      c.diffStatus
    ]);

    expect(statuses).toEqual([
      ["queue", "added"],
      ["cache", "removed"]
    ]);
  });

  it("does not re-attach base edges to a source that head does not contain", () => {
    const base = [
      { id: "a", name: "a", type: "T", connections: [{ id: "b" }] },
      { id: "b", name: "b", type: "T" }
    ];
    const head = [{ id: "b", name: "b", type: "T" }];

    const result = computeGraphDiff(base, head);
    const removedNode = result.find((r) => r.id === "a");
    const survivor = result.find((r) => r.id === "b");

    expect(removedNode.connections).toHaveLength(1);
    expect(removedNode.connections[0].diffStatus).toBe("removed");
    expect(survivor.connections).toEqual([]);
  });

  it("never re-attaches a non-outbound base connection as a removed edge", () => {
    const base = [
      {
        id: "a",
        name: "a",
        type: "T",
        connections: [{ id: "b", direction: "Inbound" }]
      }
    ];
    const head = [{ id: "a", name: "a", type: "T", connections: [] }];

    const result = computeGraphDiff(base, head);

    expect(result[0].connections).toEqual([]);
  });
});
