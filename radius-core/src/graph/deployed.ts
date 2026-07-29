// Deployed-view projection: reduce a Modeled resource array to the shape the
// canvas Deployed tab renders. The Deployed tab shows one node per Radius
// resource (no output resources) and drives per-node badge state from a
// separate status map, so the projection is:
//
//   1. Run the modeled resources through filterGraphVisualizationResources so
//      containerImages + the ghcr-registry-creds secret are dropped consistently
//      with every other graph state (modeled, planned, diff).
//   2. Deep-copy each remaining resource, clear its outputResources array (the
//      Deployed view never renders concrete outputs as their own nodes), and
//      copy statusById[id || name] onto deployStatus, defaulting to "pending".
//
// Pure: no shell/HTTP/DOM. Never mutates the input.

import { filterGraphVisualizationResources } from "./visualization.js";

export type DeployStatus = "pending" | "in_progress" | "success" | "failed";

/**
 * projectDeployedGraph — reduce a Modeled resource array to the Deployed view.
 *
 * `statusById` maps a resource key (`id` if present, otherwise `name`) to a
 * DeployStatus. Any key not in the map (including the empty-map case) defaults
 * to `"pending"`, which is what powers the greyed initial state.
 */
export function projectDeployedGraph(
  modeled: any[],
  statusById: Record<string, DeployStatus> = {},
): any[] {
  const filtered = filterGraphVisualizationResources(modeled);
  const out: any[] = [];
  for (const r of filtered) {
    if (!r) continue;
    const key = r.id || r.name || "";
    const status: DeployStatus = statusById[key] || "pending";
    out.push({
      ...r,
      outputResources: [],
      deployStatus: status,
    });
  }
  return out;
}
