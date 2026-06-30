import { describe, it, expect } from "vitest";
import { computeGraphDiff } from "./diff.js";
import { buildResourceID } from "./model.js";

function makeResource(type: string, name: string, extra: any = {}) {
  return { id: buildResourceID(type, name), name, type, connections: [], ...extra };
}

describe("computeGraphDiff", () => {
  it("returns an empty array for two empty inputs", () => {
    expect(computeGraphDiff([], [])).toEqual([]);
  });

  it("marks a resource present only in head as added", () => {
    const head = [makeResource("applications.core/containers", "api")];
    const result = computeGraphDiff([], head);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("added");
    expect(result[0].name).toBe("api");
  });

  it("marks a resource present only in base as removed", () => {
    const base = [makeResource("applications.core/containers", "api")];
    const result = computeGraphDiff(base, []);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("removed");
    expect(result[0].name).toBe("api");
  });

  it("marks a resource with identical id and content as unchanged", () => {
    const base = makeResource("applications.core/containers", "api");
    const head = makeResource("applications.core/containers", "api");
    const result = computeGraphDiff([base], [head]);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("unchanged");
  });

  it("produces removed + added entries when a resource's type changes", () => {
    const mongoDb = makeResource("applications.datastores/mongoDatabases", "db");
    const postgresDb = makeResource("applications.datastores/postgreSQLDatabases", "db");
    const result = computeGraphDiff([mongoDb], [postgresDb]);

    expect(result).toHaveLength(2);
    const removed = result.find((r) => r.type === "applications.datastores/mongoDatabases");
    const added = result.find((r) => r.type === "applications.datastores/postgreSQLDatabases");
    expect(removed?.diffStatus).toBe("removed");
    expect(added?.diffStatus).toBe("added");
  });

  it("marks a container as modified when the db it connects to changes type", () => {
    const mongoId = buildResourceID("applications.datastores/mongoDatabases", "db");
    const postgresId = buildResourceID("applications.datastores/postgreSQLDatabases", "db");

    const baseContainer = makeResource("applications.core/containers", "api", {
      connections: [{ id: mongoId, direction: "Outbound" }],
    });
    const headContainer = makeResource("applications.core/containers", "api", {
      connections: [{ id: postgresId, direction: "Outbound" }],
    });
    const mongoDb = makeResource("applications.datastores/mongoDatabases", "db");
    const postgresDb = makeResource("applications.datastores/postgreSQLDatabases", "db");

    const result = computeGraphDiff([baseContainer, mongoDb], [headContainer, postgresDb]);

    const container = result.find((r) => r.name === "api");
    const mongo = result.find((r) => r.type === "applications.datastores/mongoDatabases");
    const postgres = result.find((r) => r.type === "applications.datastores/postgreSQLDatabases");

    expect(container?.diffStatus).toBe("modified");
    expect(mongo?.diffStatus).toBe("removed");
    expect(postgres?.diffStatus).toBe("added");
  });

  it("marks a resource as modified when connections change", () => {
    const base = [makeResource("applications.core/containers", "api", { connections: [] })];
    const head = [
      makeResource("applications.core/containers", "api", {
        connections: [{ id: "some-id", direction: "Outbound" }],
      }),
    ];
    const result = computeGraphDiff(base, head);
    expect(result[0].diffStatus).toBe("modified");
  });

  it("handles null/undefined inputs gracefully", () => {
    for (const [base, head] of [
      [null, null],
      [undefined, undefined],
      [null, undefined],
      [undefined, null],
    ] as any) {
      expect(() => computeGraphDiff(base, head)).not.toThrow();
      expect(computeGraphDiff(base, head)).toEqual([]);
    }
  });

  it("reports all four statuses together in one diff", () => {
    const type = "applications.core/containers";
    const unchanged = makeResource(type, "unchanged");
    const removed = makeResource(type, "removed");
    const added = makeResource(type, "added");
    const modified = makeResource(type, "modified", { connections: [] });
    const modifiedHead = makeResource(type, "modified", {
      connections: [{ id: "some-id", direction: "Outbound" }],
    });

    const base = [unchanged, removed, modified];
    const head = [unchanged, modifiedHead, added];

    const result = computeGraphDiff(base, head);
    expect(result).toHaveLength(4);
    expect(new Set(result.map((r) => r.name)).size).toBe(4);
    const byName = Object.fromEntries(result.map((r) => [r.name, r.diffStatus]));

    expect(byName["unchanged"]).toBe("unchanged");
    expect(byName["removed"]).toBe("removed");
    expect(byName["added"]).toBe("added");
    expect(byName["modified"]).toBe("modified");
  });

  it("preserves all resource fields on diffed entries", () => {
    const r = makeResource("applications.core/containers", "api");
    const result = computeGraphDiff([], [r]);
    expect(result[0]).toMatchObject({ id: r.id, name: r.name, type: r.type });
  });
});
