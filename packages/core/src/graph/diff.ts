// computeGraphDiff — the single, shared diff algorithm used by every diff view
// (the /api/diff-branches handler, the graph-diff canvas auto-compare, the
// radius_render_graph_diff action, and the PR-diff markdown generator).
//
// Both inputs must be resource arrays produced by the same graph builder and
// converter so ids, types, and diff hashes are constructed identically.
// Resources are matched by id. A type change (e.g. mongo→postgres) produces a
// "removed" entry for the old resource and an "added" entry for the new one;
// any resource that connected to the old resource will show as "modified"
// because its connections reference a different id. Property-only edits (e.g. a
// container image or database version) keep the same id/type/connections but
// change the resource's diffHash, so diffHash is part of the comparison below.
//
// Besides the per-resource diffStatus, every rendered (Outbound) connection is
// annotated with its OWN diffStatus ("added" | "removed" | "unchanged") so a
// diff view can color the EDGE by whether that connection changed between base
// and head — not merely by its endpoints' statuses (an edge can be added or
// removed between two nodes that both remain present). Because a present node's
// entry otherwise carries only its head connections, an edge that existed on
// base and is gone on head would never appear at all; such base-only edges are
// re-attached to the (still-present) source as synthetic "removed" connections
// so the diff view can draw them.

export function computeGraphDiff(
  baseResources: any[],
  headResources: any[]
): any[] {
  const base = baseResources || [];
  const head = headResources || [];
  const keyOf = (r: any) => r.id || r.name || "";
  const isOutbound = (c: any) => (c?.direction || "Outbound") === "Outbound";
  // Directed edge identity: (source node key, target key). A NUL separator keeps
  // ids that themselves contain "/" from colliding.
  const connKey = (src: string, c: any) =>
    src + "\u0000" + (c?.id || c?.name || "");

  // Outbound edge sets for each side; only Outbound connections render as edges,
  // so only they take part in the connection-level diff.
  const baseEdges = new Set<string>();
  const headEdges = new Set<string>();
  for (const r of base) {
    const src = keyOf(r);
    for (const c of r.connections || [])
      if (isOutbound(c)) baseEdges.add(connKey(src, c));
  }
  for (const r of head) {
    const src = keyOf(r);
    for (const c of r.connections || [])
      if (isOutbound(c)) headEdges.add(connKey(src, c));
  }

  // Return a fresh connections array with each Outbound connection tagged by its
  // own diff status. `forRemovedNode` short-circuits to "removed" because every
  // edge leaving a node that no longer exists on head is, by definition, removed.
  // Non-Outbound connections are cloned through untouched (they never render).
  const annotateConnections = (
    conns: any[],
    src: string,
    forRemovedNode: boolean
  ) =>
    (conns || []).map((c) => {
      if (!isOutbound(c)) return { ...c };
      const status =
        forRemovedNode ? "removed"
        : baseEdges.has(connKey(src, c)) ? "unchanged"
        : "added";
      return { ...c, diffStatus: status };
    });

  const diffResources: any[] = [];
  const baseMap = new Map(base.map((r) => [keyOf(r), r]));
  const headIds = new Set(head.map((r) => keyOf(r)));
  // Source key → its diff entry, for re-attaching base-only edges below.
  const headEntryByKey = new Map<string, any>();

  for (const r of head) {
    const src = keyOf(r);
    const connections = annotateConnections(r.connections, src, false);
    let entry: any;
    if (baseMap.has(src)) {
      const b = baseMap.get(src);
      const baseComp = JSON.stringify({
        name: b.name,
        type: b.type,
        connections: b.connections,
        diffHash: b.diffHash
      });
      const headComp = JSON.stringify({
        name: r.name,
        type: r.type,
        connections: r.connections,
        diffHash: r.diffHash
      });
      entry = {
        ...r,
        connections,
        diffStatus: baseComp !== headComp ? "modified" : "unchanged"
      };
    } else {
      entry = { ...r, connections, diffStatus: "added" };
    }
    diffResources.push(entry);
    headEntryByKey.set(src, entry);
  }
  for (const r of base) {
    const src = keyOf(r);
    if (!headIds.has(src)) {
      diffResources.push({
        ...r,
        connections: annotateConnections(r.connections, src, true),
        diffStatus: "removed"
      });
    }
  }

  // Re-attach base-only edges whose SOURCE still exists on head as synthetic
  // "removed" connections. When the source itself was removed its edges are
  // already carried (above), so we only patch present sources here. The target
  // normally still exists as a node (present on head, or emitted as a "removed"
  // node), so the injected edge resolves; a diff view that can't resolve the
  // target (a dangling base connection) simply skips drawing that edge.
  for (const r of base) {
    const src = keyOf(r);
    const entry = headEntryByKey.get(src);
    if (!entry) continue;
    for (const c of r.connections || []) {
      if (!isOutbound(c)) continue;
      if (headEdges.has(connKey(src, c))) continue;
      entry.connections.push({ ...c, diffStatus: "removed" });
    }
  }

  return diffResources;
}
