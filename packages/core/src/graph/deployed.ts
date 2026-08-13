// Deployed-graph projection.
//
// The canvas "Deployed" tab renders a projection, not a distinct graph: a fixed
// topology (the modeled application) painted with a per-resource deploy status
// that arrives separately. Keeping the two independent means the graph can be
// drawn before any status is known and never changes shape when a deploy starts
// or finishes, so React Flow keeps its viewport across every state transition.
//
// Original design and UI concept by Nithya Subramanian (@nithyatsu), from
// radius-project/ai-extensions PR #200 ("live graph support"). That PR's
// transport (reading the GitHub Actions job log) does not work — GitHub does not
// expose a running job's log output — so only the projection and rendering ideas
// are carried forward here; the status signal comes from workflow artifacts
// instead.
//
// Pure: no shell/HTTP/DOM.

import { stripAPIVersion } from "./model.js";
import { filterGraphVisualizationResources } from "./visualization.js";

export type DeployStatus = "pending" | "in_progress" | "success" | "failed";

/**
 * deployStatusKeys - the lookup keys a resource can be matched by, in the order
 * they should be tried.
 *
 *   1. `id` exact — authoritative when the producer and the modeled graph agree.
 *   2. `name|type` lowercased, with the API version stripped.
 *   3. `name` lowercased.
 *
 * The middle tier exists because modeled resource ids are synthesized locally by
 * `buildResourceID` and are not guaranteed to equal the UCP ids the control
 * plane reports. Without it, an id mismatch would silently degrade every node to
 * bare-name matching, which collides across types.
 */
export function deployStatusKeys(resource: any): string[] {
  const keys: string[] = [];
  const id = typeof resource?.id === "string" ? resource.id.trim() : "";
  if (id) keys.push(id);
  const name =
    typeof resource?.name === "string" ?
      resource.name.trim().toLowerCase()
    : "";
  const type =
    typeof resource?.type === "string" ?
      stripAPIVersion(resource.type.trim()).toLowerCase()
    : "";
  if (name && type) keys.push(`${name}|${type}`);
  if (name) keys.push(name);
  return keys;
}

/**
 * lookupDeployStatus - resolve a resource's status from a multi-key status map,
 * trying each key from `deployStatusKeys` in priority order. Returns undefined
 * when the resource is absent from the map, which callers must treat as "no new
 * information" rather than as `pending` — a status already assigned to a node
 * must never be reset by a payload that simply does not mention it.
 */
export function lookupDeployStatus(
  resource: any,
  statusByKey: Map<string, DeployStatus> | Record<string, DeployStatus>
): DeployStatus | undefined {
  const get =
    statusByKey instanceof Map ?
      (k: string) => statusByKey.get(k)
    : (k: string) => statusByKey[k];
  for (const key of deployStatusKeys(resource)) {
    const status = get(key);
    if (status) return status;
  }
  return undefined;
}

/**
 * projectDeployedGraph - build the Deployed view's resources from the modeled
 * ones: drop visualization-only noise (containerImages and their registry-creds
 * secret), strip output resources, and stamp each node with its deploy status.
 *
 * Output resources are removed because the Deployed view renders one node per
 * Radius resource; the concrete cloud resources a recipe expands to are detail
 * that would make the topology shift between "before deploy" and "after
 * deploy". They stay untouched in the underlying graph JSON.
 *
 * A resource absent from `statusByKey` keeps whatever `deployStatus` it already
 * carries, falling back to `pending` only when it has none. A status map that
 * does not mention a resource says nothing about it, so it must never repaint an
 * already-known status — projecting a just-deployed application against an empty
 * map has to leave it deployed, not reset it to pending.
 *
 * Never mutates its input.
 */
export function projectDeployedGraph(
  modeled: any[],
  statusByKey:
    Map<string, DeployStatus> | Record<string, DeployStatus> = new Map()
): any[] {
  if (!Array.isArray(modeled)) return [];
  const visible = filterGraphVisualizationResources(modeled);
  return visible.map((resource: any) => ({
    ...resource,
    connections:
      Array.isArray(resource?.connections) ?
        resource.connections.map((c: any) => ({ ...c }))
      : [],
    outputResources: [],
    deployStatus:
      lookupDeployStatus(resource, statusByKey) ||
      resource?.deployStatus ||
      "pending"
  }));
}
