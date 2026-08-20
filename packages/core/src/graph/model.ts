// Application-graph utilities — shared helpers for normalizing and diffing
// the graph output produced by the `rad` CLI.
//
// The `rad` CLI is the single source of truth for building the application
// graph from Bicep/ARM templates (modeled.go) and computing diff hashes
// (diffhash.go). This module provides only the lightweight utilities that
// the TypeScript layer needs to post-process rad's output: deterministic
// inbound-edge synthesis, resource-ID construction, and API-version stripping.

export const MODELED_GRAPH_DEFAULTS = {
  plane: "local",
  resourceGroup: "default"
};

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
  // Sort every resource's connections deterministically. Inbound edges are
  // appended in resource-iteration order above, so without this the final
  // ordering depends on input order and computeGraphDiff (which stringifies
  // connections) would report spurious "modified" diffs. Entries are read
  // optionally because the synthesis loop above already tolerates null and
  // id-less connections, so sorting must not be the step that throws on them.
  for (const r of graph.resources) {
    if (!r || !Array.isArray(r.connections)) continue;
    r.connections.sort((a: any, b: any) => {
      const byID2 = String(a?.id).localeCompare(String(b?.id));
      if (byID2 !== 0) return byID2;
      return String(a?.direction).localeCompare(String(b?.direction));
    });
  }
}

export function buildResourceID(resourceType: string, name: string): string {
  return `/planes/radius/${MODELED_GRAPH_DEFAULTS.plane}/resourcegroups/${MODELED_GRAPH_DEFAULTS.resourceGroup}/providers/${resourceType}/${name}`;
}
