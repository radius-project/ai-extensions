import { describe, it, expect } from "vitest";
import { computeGraphDiff } from "./diff.js";

describe("computeGraphDiff", () => {
  it("returns empty array for empty inputs", () => {
    expect(computeGraphDiff([], [])).toEqual([]);
  });

  it("handles null/undefined inputs gracefully", () => {
    expect(computeGraphDiff(null as any, null as any)).toEqual([]);
    expect(computeGraphDiff(undefined as any, [])).toEqual([]);
    expect(computeGraphDiff([], undefined as any)).toEqual([]);
  });

  it("marks all head resources as added when base is empty", () => {
    const head = [
      { id: "/res/a", name: "a", type: "TypeA", connections: [] },
      { id: "/res/b", name: "b", type: "TypeB", connections: [] },
    ];
    const result = computeGraphDiff([], head);
    expect(result).toHaveLength(2);
    expect(result[0].diffStatus).toBe("added");
    expect(result[1].diffStatus).toBe("added");
  });

  it("marks all base resources as removed when head is empty", () => {
    const base = [
      { id: "/res/a", name: "a", type: "TypeA", connections: [] },
      { id: "/res/b", name: "b", type: "TypeB", connections: [] },
    ];
    const result = computeGraphDiff(base, []);
    expect(result).toHaveLength(2);
    expect(result[0].diffStatus).toBe("removed");
    expect(result[1].diffStatus).toBe("removed");
  });

  it("marks identical resources as unchanged", () => {
    const resources = [
      { id: "/res/a", name: "a", type: "TypeA", connections: [] },
    ];
    const result = computeGraphDiff(resources, resources);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("unchanged");
  });

  it("detects modified resources by type change", () => {
    const base = [{ id: "/res/a", name: "a", type: "TypeA", connections: [] }];
    const head = [{ id: "/res/a", name: "a", type: "TypeB", connections: [] }];
    const result = computeGraphDiff(base, head);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("modified");
  });

  it("detects modified resources by connection change", () => {
    const base = [{ id: "/res/a", name: "a", type: "TypeA", connections: [] }];
    const head = [{ id: "/res/a", name: "a", type: "TypeA", connections: [{ id: "/res/b" }] }];
    const result = computeGraphDiff(base, head);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("modified");
  });

  it("handles mixed add/remove/unchanged/modified", () => {
    const base = [
      { id: "/res/a", name: "a", type: "TypeA", connections: [] },
      { id: "/res/b", name: "b", type: "TypeB", connections: [] },
      { id: "/res/c", name: "c", type: "TypeC", connections: [] },
    ];
    const head = [
      { id: "/res/a", name: "a", type: "TypeA", connections: [] }, // unchanged
      { id: "/res/b", name: "b", type: "TypeB-v2", connections: [] }, // modified
      { id: "/res/d", name: "d", type: "TypeD", connections: [] }, // added
    ];
    const result = computeGraphDiff(base, head);
    const byId = (id: string) => result.find((r: any) => r.id === id);
    expect(byId("/res/a")?.diffStatus).toBe("unchanged");
    expect(byId("/res/b")?.diffStatus).toBe("modified");
    expect(byId("/res/c")?.diffStatus).toBe("removed");
    expect(byId("/res/d")?.diffStatus).toBe("added");
  });

  it("falls back to name matching when id changes but name segment is same", () => {
    // Simulates a type change (mysql→postgres) where the id changes but the last segment (name) is the same
    const base = [{ id: "/providers/Radius.Data/mySqlDatabases/mydb", name: "mydb", type: "Radius.Data/mySqlDatabases", connections: [] }];
    const head = [{ id: "/providers/Radius.Data/postgresDatabases/mydb", name: "mydb", type: "Radius.Data/postgresDatabases", connections: [] }];
    const result = computeGraphDiff(base, head);
    // Should be treated as modified (same last segment "mydb"), not add+remove
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("modified");
    expect(result[0].type).toBe("Radius.Data/postgresDatabases");
  });

  it("does not use name fallback when multiple base resources share the same last segment", () => {
    const base = [
      { id: "/type1/svc", name: "svc", type: "Type1", connections: [] },
      { id: "/type2/svc", name: "svc", type: "Type2", connections: [] },
    ];
    const head = [
      { id: "/type3/svc", name: "svc", type: "Type3", connections: [] },
    ];
    const result = computeGraphDiff(base, head);
    // Name "svc" is ambiguous (count > 1), so no fallback — the head resource is "added"
    const added = result.filter((r: any) => r.diffStatus === "added");
    const removed = result.filter((r: any) => r.diffStatus === "removed");
    expect(added.length).toBe(1);
    expect(removed.length).toBe(2);
  });

  it("uses name as key when id is missing", () => {
    const base = [{ name: "svc", type: "TypeA", connections: [] }];
    const head = [{ name: "svc", type: "TypeA", connections: [] }];
    const result = computeGraphDiff(base, head);
    expect(result).toHaveLength(1);
    expect(result[0].diffStatus).toBe("unchanged");
  });
});
