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

  it("marks a resource as modified when its type changes", () => {
    const base = [makeResource("applications.datastores/mongoDatabases", "db")];
    const head = [makeResource("applications.datastores/postgreSQLDatabases", "db")];
    const result = computeGraphDiff(base, head);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "db", diffStatus: "modified" });
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
  it("reports all three statuses together in one diff", () => {
    const sharedType = "applications.core/containers";
    const unchanged = makeResource(sharedType, "unchanged");
    const removed = makeResource(sharedType, "removed");
    const added = makeResource(sharedType, "added");
    const modified = makeResource(sharedType, "modified");
    const modifiedHead = makeResource(sharedType, "modified", { type: "applications.core/gateways" });

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
