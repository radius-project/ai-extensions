// pr-diff-markdown — renders the application graph diff (from computeGraphDiff)
// as GitHub-flavored Markdown with an embedded Mermaid diagram, for embedding in
// a pull-request description. Kept as a pure function (no I/O) so the radius
// extension entry point can stay a thin SDK shim and this can be unit-tested.
//
// Input is the array returned by computeGraphDiff: each resource carries a
// diffStatus, and every rendered (Outbound) connection carries its own
// diffStatus so added/removed edges — including a removed edge between two
// still-present nodes — are drawn and colored distinctly.

import type { CanvasGraphResource } from "./shared.js";

export const PR_GRAPH_DIFF_MARKDOWN_HEADING = "## 📊 Application Graph Diff";

const STATUS_STYLE: Readonly<Record<string, string>> = {
  added: ":::added",
  removed: ":::removed",
  modified: ":::modified",
  unchanged: ":::unchanged"
};
const STATUS_ICON: Readonly<Record<string, string>> = {
  added: "🟢",
  removed: "🔴",
  modified: "🟡",
  unchanged: ""
};

// Map every diff resource's full id to a unique, Mermaid-safe node id. Distinct
// resources can share a short name — most notably a type change (mongo→postgres)
// keeps the name "db" for both the removed and the added resource — so a naive
// last-path-segment id would collide, merging the two nodes and deduping one of
// the (added/removed) edges pointing at them out of existence. Disambiguate any
// collision with a numeric suffix.
function buildIdMap(
  diffResources: readonly CanvasGraphResource[]
): Map<string, string> {
  const idMap = new Map<string, string>();
  const usedIds = new Set<string>();
  for (let i = 0; i < diffResources.length; i++) {
    const r = diffResources[i];
    const fullId = r.id || r.name || `node${i}`;
    const segments = fullId.split("/");
    const shortId = segments[segments.length - 1] || `node${i}`;
    let safeId = shortId.replace(/[^a-zA-Z0-9]/g, "_") || `node${i}`;
    if (usedIds.has(safeId)) {
      let n = 2;
      while (usedIds.has(`${safeId}_${n}`)) n++;
      safeId = `${safeId}_${n}`;
    }
    usedIds.add(safeId);
    idMap.set(fullId, safeId);
  }
  return idMap;
}

export function renderDiffMermaid(
  diffResources: readonly CanvasGraphResource[]
): string {
  const idMap = buildIdMap(diffResources);

  let mermaid = "graph TD\n";
  mermaid +=
    "    classDef added fill:#dafbe1,stroke:#1a7f37,stroke-width:2px,color:#1a7f37\n";
  mermaid +=
    "    classDef removed fill:#ffebe9,stroke:#cf222e,stroke-width:2px,color:#cf222e\n";
  mermaid +=
    "    classDef modified fill:#fff8c5,stroke:#bf8700,stroke-width:2px,color:#9a6700\n";
  mermaid +=
    "    classDef unchanged fill:#f6f8fa,stroke:#d1d9e0,stroke-width:1px,color:#656d76\n";

  for (const r of diffResources) {
    const fullId = r.id || r.name || "node";
    const safeId = idMap.get(fullId) || fullId.replace(/[^a-zA-Z0-9]/g, "_");
    const status = r.diffStatus || "";
    const icon = STATUS_ICON[status] || "";
    const typeLabel = ((r.type || "").split("/").pop() || "").split("@")[0];
    const label = `${icon} ${r.name || r.id}\\n${typeLabel}`.trim();
    mermaid += `    ${safeId}["${label}"]${STATUS_STYLE[status] || ""}\n`;
  }

  // Add edges from connections (match by conn.id which is the full resource
  // path). Each rendered connection carries its own diff status, so new and
  // removed edges are colored the way the canvas draws them; a removed edge
  // between two still-present nodes is carried as a synthetic "removed"
  // connection by computeGraphDiff, so it appears here too.
  const edgeSeen = new Set<string>();
  const edgeStatuses: string[] = [];
  for (const r of diffResources) {
    if (!r.connections || r.connections.length === 0) continue;
    const srcFullId = r.id || r.name || "";
    const srcSafeId = idMap.get(srcFullId);
    if (!srcSafeId) continue;
    for (const conn of r.connections) {
      const dir = conn.direction || "Outbound";
      if (dir !== "Outbound") continue;
      const tgtFullId = conn.id || conn.name || "";
      const tgtSafeId = idMap.get(tgtFullId);
      if (!tgtSafeId) continue;
      const edgeId = `${srcSafeId}-->${tgtSafeId}`;
      if (edgeSeen.has(edgeId)) continue;
      edgeSeen.add(edgeId);
      const st = conn.diffStatus || "";
      const arrow = st === "removed" ? "-.->" : "-->";
      mermaid += `    ${srcSafeId} ${arrow} ${tgtSafeId}\n`;
      edgeStatuses.push(st);
    }
  }
  // Color added/removed links to match the node status palette (GitHub diff
  // colors). linkStyle indexes links in declaration order, matching edgeStatuses.
  edgeStatuses.forEach((st, i) => {
    if (st === "added")
      mermaid += `    linkStyle ${i} stroke:#1a7f37,stroke-width:2px\n`;
    else if (st === "removed")
      mermaid += `    linkStyle ${i} stroke:#cf222e,stroke-width:2px\n`;
  });

  return mermaid;
}

export function renderPrDiffMarkdown(
  diffResources: readonly CanvasGraphResource[] | null | undefined,
  baseBranch: string,
  headBranch: string
): string {
  const resources = diffResources || [];
  const added = resources.filter((r) => r.diffStatus === "added").length;
  const removed = resources.filter((r) => r.diffStatus === "removed").length;
  const modified = resources.filter((r) => r.diffStatus === "modified").length;
  const unchanged = resources.filter(
    (r) => r.diffStatus === "unchanged"
  ).length;

  let md = `${PR_GRAPH_DIFF_MARKDOWN_HEADING}\n\n`;
  md += `Comparing \`${baseBranch}\` → \`${headBranch}\`\n\n`;

  if (added === 0 && removed === 0 && modified === 0) {
    md += `✅ No application graph changes detected. The application model is identical between \`${baseBranch}\` and \`${headBranch}\`.\n`;
  } else {
    md += `| Status | Count |\n|--------|-------|\n`;
    if (added > 0) md += `| 🟢 Added | ${added} |\n`;
    if (removed > 0) md += `| 🔴 Removed | ${removed} |\n`;
    if (modified > 0) md += `| 🟡 Modified | ${modified} |\n`;
    if (unchanged > 0) md += `| ⚪ Unchanged | ${unchanged} |\n`;
    md += `\n`;
  }

  md += "```mermaid\n" + renderDiffMermaid(resources) + "```\n";

  return md;
}
