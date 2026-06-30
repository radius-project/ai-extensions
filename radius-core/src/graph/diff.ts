// computeGraphDiff — the single, shared diff algorithm used by every diff view
// (the /api/diff-branches handler, the graph-diff canvas auto-compare, the
// radius_render_graph_diff action, and the PR-diff markdown generator).
//
// Both inputs must be resource arrays produced by buildGraphFromBicep() so that
// ids/types are constructed identically. Resources are matched by id. A type
// change (e.g. mongo→postgres) produces a "removed" entry for the old resource
// and an "added" entry for the new one; any resource that connected to the old
// resource will show as "modified" because its connections reference a different id.

export function computeGraphDiff(baseResources: any[], headResources: any[]): any[] {
  const base = baseResources || [];
  const head = headResources || [];
  const keyOf = (r: any) => r.id || r.name || "";

  const diffResources: any[] = [];
  const baseMap = new Map(base.map((r) => [keyOf(r), r]));
  const headIds = new Set(head.map((r) => keyOf(r)));

  for (const r of head) {
    if (baseMap.has(keyOf(r))) {
      const b = baseMap.get(keyOf(r));
      const baseComp = JSON.stringify({ name: b.name, type: b.type, connections: b.connections });
      const headComp = JSON.stringify({ name: r.name, type: r.type, connections: r.connections });
      diffResources.push({ ...r, diffStatus: baseComp !== headComp ? "modified" : "unchanged" });
    } else {
      diffResources.push({ ...r, diffStatus: "added" });
    }
  }
  for (const r of base) {
    if (!headIds.has(keyOf(r))) {
      diffResources.push({ ...r, diffStatus: "removed" });
    }
  }
  return diffResources;
}
