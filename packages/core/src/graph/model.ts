// Application-graph utilities — shared helpers for normalizing and diffing
// the graph output produced by the `rad` CLI.
//
// The `rad` CLI is the single source of truth for building the application
// graph from Bicep/ARM templates (modeled.go) and computing diff hashes
// (diffhash.go). This module provides only the lightweight utilities that
// the TypeScript layer needs to post-process rad's output: deterministic
// inbound-edge synthesis and API-version stripping.

export function stripAPIVersion(t: string): string {
  const i = t.indexOf("@");
  return i >= 0 ? t.slice(0, i) : t;
}

export function addInboundConnections(graph: any): void {
  const byID: any = {};
  for (const r of graph.resources) {
    if (r && r.id) byID[r.id] = r;
  }
  for (const src of graph.resources) {
    if (!src || !src.id) continue;
    for (const conn of src.connections || []) {
      if (!conn || !conn.id || conn.direction !== "Outbound") continue;
      const dest = byID[conn.id];
      if (!dest) continue;
      dest.connections = dest.connections || [];
      dest.connections.push({ id: src.id, direction: "Inbound" });
    }
  }
  // Normalize every resource's connection list deterministically. Inbound edges
  // are appended in resource-iteration order above, so without a sort the final
  // ordering depends on input order and computeGraphDiff (which stringifies
  // connections) would report spurious "modified" diffs.
  //
  // Null and id-less entries are dropped rather than sorted: the synthesis loop
  // above already skips them, and comparing them via String(a?.id) would order
  // them among real ids as the literal "undefined" and carry them into what
  // computeGraphDiff stringifies. The sole production caller (appgraph.ts) has
  // already filtered them out, so this only keeps the contract coherent for a
  // caller that has not.
  for (const r of graph.resources) {
    if (!r || !Array.isArray(r.connections)) continue;
    r.connections = r.connections
      .filter((c: any) => c && c.id)
      .sort((a: any, b: any) => {
        const byTarget = String(a.id).localeCompare(String(b.id));
        if (byTarget !== 0) return byTarget;
        return String(a.direction).localeCompare(String(b.direction));
      });
  }
}
