// computeGraphDiff — the single, shared diff algorithm used by every diff view
// (the /api/diff-branches handler, the graph-diff canvas auto-compare, the
// radius_render_graph_diff action, and the PR-diff markdown generator).
//
// Both inputs must be resource arrays produced by buildGraphFromBicep() so that
// ids/types are constructed identically. Resources are matched by id first; when
// a head resource has no id match, it falls back to matching the last id segment
// (resource name) in the base set so that a type change (e.g. mysql→postgres) is
// reported as "modified" rather than a spurious add+remove pair.

export function computeGraphDiff(baseResources: any[], headResources: any[]): any[] {
  const base = baseResources || [];
  const head = headResources || [];
  const keyOf = (r: any) => r.id || r.name || "";
  const lastSeg = (r: any) => {
    const s = keyOf(r).split("/");
    return s[s.length - 1];
  };

  const diffResources: any[] = [];
  const baseMap = new Map(base.map((r) => [keyOf(r), r]));
  const headIds = new Set(head.map((r) => keyOf(r)));
  const baseBySymName = new Map(base.map((r) => [lastSeg(r), r]));

  for (const r of head) {
    if (baseMap.has(keyOf(r))) {
      const b = baseMap.get(keyOf(r));
      const baseComp = JSON.stringify({ name: b.name, type: b.type, connections: b.connections });
      const headComp = JSON.stringify({ name: r.name, type: r.type, connections: r.connections });
      diffResources.push({ ...r, diffStatus: baseComp !== headComp ? "modified" : "unchanged" });
    } else {
      const symName = lastSeg(r);
      const baseByName = baseBySymName.get(symName);
      if (baseByName && baseMap.has(keyOf(baseByName)) && !headIds.has(keyOf(baseByName))) {
        // Same name, different type — treat as modified, consume the base entry.
        diffResources.push({ ...r, diffStatus: "modified" });
        baseMap.delete(keyOf(baseByName));
      } else {
        diffResources.push({ ...r, diffStatus: "added" });
      }
    }
  }
  for (const r of base) {
    if (!headIds.has(keyOf(r)) && baseMap.has(keyOf(r))) {
      diffResources.push({ ...r, diffStatus: "removed" });
    }
  }
  return diffResources;
}
