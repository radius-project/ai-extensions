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
// The registry-push Secret paired with a containerImages build has a fixed,
// reserved name — it must match the recipe pack's `containerImagesRegistrySecretName`.
// `radius-ghcr-registry-creds` is the name the app-bicep skill authors;
// `ghcr-registry-creds` is the shorthand used in the tracking issues. We match
// either exactly (not as a loose substring, so an unrelated secret whose name
// merely contains this text is never hidden), tolerating a namespace prefix such
// as `app/radius-ghcr-registry-creds`.
const REGISTRY_CREDS_NAMES = new Set([
  "radius-ghcr-registry-creds",
  "ghcr-registry-creds",
]);

function normalizedType(resource: any): string {
  return stripAPIVersion(String(resource?.type || "")).toLowerCase();
}

function isContainerImage(resource: any): boolean {
  return normalizedType(resource) === CONTAINER_IMAGE_TYPE;
}

function isRegistryCredsSecret(resource: any): boolean {
  if (normalizedType(resource) !== SECRET_TYPE) return false;
  const name = String(resource?.name || "").toLowerCase();
  if (REGISTRY_CREDS_NAMES.has(name)) return true;
  // Tolerate a namespaced name by matching the final path segment.
  return REGISTRY_CREDS_NAMES.has(name.slice(name.lastIndexOf("/") + 1));
}

/**
 * filterGraphVisualizationResources - drop containerImage resources and their
 * associated ghcr-registry-creds secret from a canvas resource array, returning
 * a new array with any connections that referenced the dropped resources
 * removed so no dangling/orphaned edges remain. Returns the input array
 * unchanged (same reference) when nothing needs to be removed. The input is
 * never mutated.
 *
 * The secret is only removed when the graph actually contains a containerImage
 * it is associated with (they are authored as a pair — the containerImages
 * resource `dependsOn`s this Secret; that dependency is not a graph connection,
 * so presence is the reliable association signal). A similarly typed secret in a
 * graph without any containerImage is kept.
 *
 * Nodes are dropped by predicate (re-evaluated per resource), not by an
 * id/name key set, so a resource can never be removed just because its id
 * happens to equal a removed resource's name. Connection stripping matches a
 * removed resource by either endpoint key (`id` or `name`), because the
 * deployed-graph path synthesizes some connections keyed by name rather than id.
 */
export function filterGraphVisualizationResources(resources: any[]): any[] {
  if (!Array.isArray(resources)) return [];

  const hasContainerImage = resources.some((r) => r && isContainerImage(r));
  const shouldRemove = (r: any): boolean =>
    !!r && (isContainerImage(r) || (hasContainerImage && isRegistryCredsSecret(r)));

  if (!resources.some(shouldRemove)) return resources;

  // Endpoint identifiers (both id and name) of every removed resource, so a
  // connection referencing one by either key can be stripped.
  const removedEndpoints = new Set<string>();
  for (const resource of resources) {
    if (!shouldRemove(resource)) continue;
    if (resource.id) removedEndpoints.add(resource.id);
    if (resource.name) removedEndpoints.add(resource.name);
  }

  const referencesRemoved = (c: any): boolean =>
    !!c &&
    ((c.id != null && removedEndpoints.has(c.id)) ||
      (c.name != null && removedEndpoints.has(c.name)));

  const result: any[] = [];
  for (const resource of resources) {
    if (shouldRemove(resource)) continue;
    if (!resource) continue;

    if (
      Array.isArray(resource.connections) &&
      resource.connections.some(referencesRemoved)
    ) {
      result.push({
        ...resource,
        connections: resource.connections.filter(
          (c: any) => !referencesRemoved(c),
        ),
      });
    } else {
      result.push(resource);
    }
  }
  return result;
}
