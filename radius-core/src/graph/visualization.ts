// Visualization-layer resource filtering.
//
// Some resources are part of the modeled application graph (and stay in the
// raw app-graph.json that `rad app graph` emits) but are implementation detail
// that only adds noise to the visualization. `filterGraphVisualizationResources`
// removes those from the resource array the canvas UI, the diff algorithm, and
// the PR-diff Mermaid generator consume, without touching the persisted
// app-graph.json. Every graph state — modeled, planned, deployed, and diff —
// runs its resources through this before rendering.
//
// Excluded from the visualization:
//   - `Radius.Compute/containerImages` — the source-build image resource
//     (see issue #145). Pure build detail, not application architecture.
//   - the `ghcr-registry-creds` `Radius.Security/secrets` companion that feeds
//     the containerImages registry push (see issue #149). It is only excluded
//     when the graph actually contains a containerImage it is associated with;
//     a similarly named secret in a graph without any containerImage is kept.
//
// Pure: no shell/HTTP/DOM. Operates on both plain resources and diff resources
// (resources carrying an extra `diffStatus`), since it only reads type, name,
// id, and connections.

import { stripAPIVersion } from "./model.js";

const CONTAINER_IMAGE_TYPE = "radius.compute/containerimages";
const SECRET_TYPE = "radius.security/secrets";
// Matches both the issue's `ghcr-registry-creds` and the authored
// `radius-ghcr-registry-creds` (the recipe pack's registry-secret name).
const REGISTRY_CREDS_NAME = "ghcr-registry-creds";

function normalizedType(resource: any): string {
  return stripAPIVersion(String(resource?.type || "")).toLowerCase();
}

function resourceKey(resource: any): string {
  return resource?.id || resource?.name || "";
}

function isContainerImage(resource: any): boolean {
  return normalizedType(resource) === CONTAINER_IMAGE_TYPE;
}

function isRegistryCredsSecret(resource: any): boolean {
  return (
    normalizedType(resource) === SECRET_TYPE &&
    String(resource?.name || "").toLowerCase().includes(REGISTRY_CREDS_NAME)
  );
}

/**
 * filterGraphVisualizationResources - drop containerImage resources and their
 * associated ghcr-registry-creds secret from a canvas resource array, returning
 * a new array with any connections that referenced the dropped resources
 * removed so no dangling/orphaned edges remain. Returns the input array
 * unchanged (same reference) when nothing needs to be removed.
 */
export function filterGraphVisualizationResources(resources: any[]): any[] {
  if (!Array.isArray(resources)) return [];

  const hasContainerImage = resources.some((r) => r && isContainerImage(r));

  const removedIds = new Set<string>();
  for (const resource of resources) {
    if (!resource) continue;
    if (isContainerImage(resource)) {
      removedIds.add(resourceKey(resource));
    } else if (hasContainerImage && isRegistryCredsSecret(resource)) {
      removedIds.add(resourceKey(resource));
    }
  }

  if (removedIds.size === 0) return resources;

  const result: any[] = [];
  for (const resource of resources) {
    if (!resource) continue;
    if (removedIds.has(resourceKey(resource))) continue;

    if (
      Array.isArray(resource.connections) &&
      resource.connections.some((c: any) => c && removedIds.has(c.id))
    ) {
      result.push({
        ...resource,
        connections: resource.connections.filter(
          (c: any) => !(c && removedIds.has(c.id)),
        ),
      });
    } else {
      result.push(resource);
    }
  }
  return result;
}
