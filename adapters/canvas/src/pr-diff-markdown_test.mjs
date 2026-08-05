import { describe, it, expect } from "vitest";
import { computeGraphDiff } from "@radius-project/core";
import {
  renderPrDiffMarkdown,
  renderDiffMermaid
} from "./pr-diff-markdown.mjs";

// Resource/connection fixture helpers. Ids are full resource paths (the Mermaid
// node id is derived from the last "/" segment), matching what the graph builder
// emits.
const container = (id, connTargets = []) => ({
  id,
  name: id.split("/").pop(),
  type: "Applications.Core/containers@2023-10-01-preview",
  connections: connTargets.map((t) => ({
    id: t,
    name: t.split("/").pop(),
    direction: "Outbound"
  }))
});
const datastore = (id, kind) => ({
  id,
  name: id.split("/").pop(),
  type: `Applications.Datastores/${kind}@2023-10-01-preview`,
  connections: []
});

describe("renderPrDiffMarkdown", () => {
  it("summarizes counts and reports no changes for identical graphs", () => {
    const base = [
      container("/app/api", ["/app/db"]),
      datastore("/app/db", "redisCaches")
    ];
    const md = renderPrDiffMarkdown(
      computeGraphDiff(base, base),
      "main",
      "feature"
    );
    expect(md).toContain("## 📊 Application Graph Diff");
    expect(md).toContain("Comparing `main` → `feature`");
    expect(md).toContain("No application graph changes detected");
  });

  it("draws an added edge as a solid green link", () => {
    const base = [
      container("/app/api"),
      datastore("/app/cache", "redisCaches")
    ];
    const head = [
      container("/app/api", ["/app/cache"]),
      datastore("/app/cache", "redisCaches")
    ];
    const md = renderPrDiffMarkdown(
      computeGraphDiff(base, head),
      "main",
      "feature"
    );
    // Solid arrow, and it is styled with the "added" (green) palette.
    expect(md).toMatch(/^ {4}api --> cache$/m);
    expect(md).not.toContain("api -.-> cache");
    expect(md).toContain("linkStyle 0 stroke:#1a7f37");
  });

  it("draws a removed edge between two still-present nodes as a dotted red link", () => {
    // api drops its connection to cache, but both nodes remain present. This is
    // the case computeGraphDiff must re-inject as a synthetic "removed" edge —
    // without it the removed edge would never render at all.
    const base = [
      container("/app/api", ["/app/cache"]),
      datastore("/app/cache", "redisCaches")
    ];
    const head = [
      container("/app/api"),
      datastore("/app/cache", "redisCaches")
    ];
    const md = renderPrDiffMarkdown(
      computeGraphDiff(base, head),
      "main",
      "feature"
    );
    expect(md).toContain("api -.-> cache");
    expect(md).toMatch(/^ {4}linkStyle 0 stroke:#cf222e/m);
    expect(md).toContain("| 🟡 Modified | 1 |");
  });

  it("keeps both edges distinct on a type change that reuses the resource name", () => {
    // mongo `db` → postgres `db`: two DIFFERENT resource ids that share the
    // last path segment ("db"). The Mermaid node ids must be disambiguated so
    // the added and removed edges pointing at them don't collapse into one.
    const base = [
      container("/app/api", ["/app/providers/mongoDatabases/db"]),
      datastore("/app/providers/mongoDatabases/db", "mongoDatabases")
    ];
    const head = [
      container("/app/api", ["/app/providers/sqlDatabases/db"]),
      datastore("/app/providers/sqlDatabases/db", "sqlDatabases")
    ];
    const md = renderPrDiffMarkdown(
      computeGraphDiff(base, head),
      "main",
      "feature"
    );

    // Two distinct db nodes exist (collision disambiguated with a suffix).
    expect(md).toMatch(/^ {4}db\[/m);
    expect(md).toMatch(/^ {4}db_2\[/m);

    // The added edge (solid) and the removed edge (dotted) both survive and
    // point at different nodes — the removed edge is not deduped away.
    const solid = md.match(/^ {4}api --> (\w+)$/m);
    const dotted = md.match(/^ {4}api -\.-> (\w+)$/m);
    expect(solid).not.toBeNull();
    expect(dotted).not.toBeNull();
    expect(solid[1]).not.toBe(dotted[1]);

    // Distinct link styles: one green (added), one red (removed).
    expect(md).toContain("stroke:#1a7f37"); // added, green
    expect(md).toContain("stroke:#cf222e"); // removed, red
    expect(md).toContain("| 🟢 Added | 1 |");
    expect(md).toContain("| 🔴 Removed | 1 |");
  });
});

describe("renderDiffMermaid", () => {
  it("assigns a unique node id to every resource even when names collide", () => {
    const diff = [
      {
        id: "/a/db",
        name: "db",
        type: "T",
        diffStatus: "removed",
        connections: []
      },
      {
        id: "/b/db",
        name: "db",
        type: "T",
        diffStatus: "added",
        connections: []
      },
      {
        id: "/c/db",
        name: "db",
        type: "T",
        diffStatus: "unchanged",
        connections: []
      }
    ];
    const mermaid = renderDiffMermaid(diff);
    const nodeIds = [...mermaid.matchAll(/^ {4}(\w+)\[/gm)].map((m) => m[1]);
    expect(new Set(nodeIds).size).toBe(nodeIds.length); // all unique
    expect(nodeIds).toContain("db");
    expect(nodeIds).toContain("db_2");
    expect(nodeIds).toContain("db_3");
  });
});
