// app-graph.json → canvas resources.
//
// `rad app graph <app.bicep>` writes an ApplicationGraphResponse
// (`{ resources: [...] }`) that is the serialized output of the same
// modeled-graph builder ported in model.ts. `applicationGraphToResources`
// adapts that payload into the resource-node array the canvas UI and the diff
// algorithm expect: it normalizes connections, enriches each node with the
// `definitionFile` (rad does not know the repo layout), and preserves the
// stable `diffHash` rad already computed. Pure: no shell/HTTP/DOM.

import { addInboundConnections, computeDiffHash } from "./model.js";

/**
 * applicationGraphToResources - convert a rad `app-graph.json` payload into the
 * canvas resources array.
 *
 * Accepts either an `ApplicationGraphResponse` (`{ resources: [...] }`) or a
 * bare resources array. Keeps only outbound connections from the input and
 * rebuilds the reciprocal inbound edges via `addInboundConnections`, so the
 * result is byte-for-byte consistent with the modeled-graph builder regardless
 * of how rad ordered its edges.
 */
export function applicationGraphToResources(
  appGraph: any,
  definitionFile = ".radius/app.bicep",
): any[] {
  const raw = Array.isArray(appGraph)
    ? appGraph
    : appGraph && Array.isArray(appGraph.resources)
      ? appGraph.resources
      : [];

  const resources: any[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const id = r.id || "";
    const type = r.type || "";
    if (!id || !type) continue;

    // Keep only outbound edges; inbound edges are rebuilt deterministically
    // below so the shape matches the modeled-graph builder exactly.
    const connections: any[] = [];
    for (const c of r.connections || []) {
      if (!c || !c.id) continue;
      if ((c.direction || "Outbound") !== "Outbound") continue;
      connections.push({ id: c.id, direction: "Outbound" });
    }
    connections.sort((a, b) => String(a.id).localeCompare(String(b.id)));

    resources.push({
      id,
      name: r.name || "",
      type,
      provisioningState: r.provisioningState || "NotSpecified",
      connections,
      outputResources: Array.isArray(r.outputResources) ? r.outputResources : [],
      diffHash: r.diffHash || computeDiffHash(r.properties || {}, []),
      definitionFile,
      definitionLine: typeof r.definitionLine === "number" ? r.definitionLine : 0,
      codeReference: r.codeReference || "",
    });
  }

  addInboundConnections({ resources });
  return resources;
}
