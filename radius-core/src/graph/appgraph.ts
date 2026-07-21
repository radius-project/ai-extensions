// app-graph.json → canvas resources.
//
// `rad app graph <app.bicep>` writes an ApplicationGraphResponse
// (`{ resources: [...] }`) with the full graph and diff hashes.
// `applicationGraphToResources` adapts that payload into the resource-node
// array the canvas UI and the diff algorithm expect: it normalizes
// connections, enriches each node with the `definitionFile` (rad does not
// know the repo layout), and preserves the stable `diffHash` rad already
// computed. Pure: no shell/HTTP/DOM.

import { addInboundConnections } from "./model.js";

const DIFF_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * applicationGraphToResources - convert a rad `app-graph.json` payload into the
 * canvas resources array.
 *
 * Accepts either an `ApplicationGraphResponse` (`{ resources: [...] }`) or a
 * bare resources array. Keeps only outbound connections from the input and
 * rebuilds the reciprocal inbound edges via `addInboundConnections`, which also
 * sorts every resource's connections deterministically, so rad edge ordering
 * does not affect diffs.
 */
export function applicationGraphToResources(
  appGraph: any,
  definitionFile = ".radius/app.bicep",
): any[] {
  const icons = !Array.isArray(appGraph) && appGraph && typeof appGraph.icons === "object"
    ? appGraph.icons
    : {};
  const resolveIcon = (resource: any): string =>
    resource?.icon ||
    (resource?.iconHash && typeof icons[resource.iconHash] === "string"
      ? icons[resource.iconHash]
      : "");
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

    // Keep only outbound edges; inbound edges are rebuilt below and the full
    // connection list is sorted deterministically inside addInboundConnections,
    // so the shape is stable regardless of rad's edge ordering.
    const connections: any[] = [];
    for (const c of (Array.isArray(r.connections) ? r.connections : [])) {
      if (!c || !c.id) continue;
      if ((c.direction || "Outbound") !== "Outbound") continue;
      connections.push({ id: c.id, direction: "Outbound" });
    }

    resources.push({
      id,
      name: r.name || "",
      type,
      provisioningState: r.provisioningState || "NotSpecified",
      connections,
      outputResources: Array.isArray(r.outputResources)
        ? r.outputResources.map((output: any) => ({
            ...output,
            icon: resolveIcon(output),
          }))
        : [],
      diffHash: validateDiffHash(r.diffHash, r.name || id),
      definitionFile,
      definitionLine: typeof r.definitionLine === "number" ? r.definitionLine : 0,
      codeReference: r.codeReference || "",
      iconHash: r.iconHash || "",
      icon: resolveIcon(r),
    });
  }

  addInboundConnections({ resources });
  return resources;
}

/**
 * Validate that a diffHash from rad output is present and well-formed.
 * The rad CLI is the single source of truth for diff hashes — if one is
 * missing, the caller is likely using an incompatible rad version or
 * hand-constructing resources without a hash, which would silently break
 * property-change detection in computeGraphDiff.
 */
function validateDiffHash(hash: unknown, resourceName: string): string {
  if (typeof hash === "string" && DIFF_HASH_PATTERN.test(hash)) {
    return hash;
  }
  throw new Error(
    `Resource "${resourceName}" is missing a valid diffHash (expected "sha256:" followed by 64 lowercase hexadecimal characters from rad CLI output). ` +
    `Ensure you are using a compatible version of the rad CLI that includes diff hashes in its graph output.`,
  );
}
