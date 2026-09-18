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
import {
  projectGraphConnectionMetadata,
  projectGraphOutputMetadata,
  projectGraphResourceMetadata
} from "./appgraph.js";
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
 * The middle tier exists because modeled resource ids are synthesized by the
 * modeling side and are not guaranteed to equal the UCP ids the control plane
 * reports. Without it, an id mismatch would silently degrade every node to
 * bare-name matching, which collides across types.
 */
export function deployStatusKeys(resource: any): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const addKey = (value: unknown): void => {
    const key = typeof value === "string" ? value.trim() : "";
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  const id = typeof resource?.id === "string" ? resource.id.trim() : "";
  addKey(id);
  if (Array.isArray(resource?.outputResourceIds)) {
    for (const outputId of resource.outputResourceIds) addKey(outputId);
  }
  if (Array.isArray(resource?.outputResources)) {
    for (const output of resource.outputResources) addKey(output?.id);
  }
  const name =
    typeof resource?.name === "string" ?
      resource.name.trim().toLowerCase()
    : "";
  const type =
    typeof resource?.type === "string" ?
      stripAPIVersion(resource.type.trim()).toLowerCase()
    : "";
  if (name && type) addKey(`${name}|${type}`);
  addKey(name);
  return keys;
}

function deployedResources(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { resources?: unknown }).resources)
  ) {
    return (value as { resources: any[] }).resources;
  }
  return [];
}

function outputIdentity(output: Record<string, unknown>): {
  id: string;
  type: string;
} {
  return {
    id: typeof output.id === "string" ? output.id.trim() : "",
    type:
      typeof output.type === "string" ?
        stripAPIVersion(output.type.trim()).toLowerCase()
      : ""
  };
}

function outputDisplayType(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  const displayType = (value as { displayType?: unknown }).displayType;
  return typeof displayType === "string" ? displayType.trim() : "";
}

function mergeOutputResources(
  previousOutputs: Record<string, unknown>[],
  deployed: Record<string, unknown>[]
): any[] {
  const previousById = new Map<string, unknown>();
  const previousByType = new Map<string, unknown>();
  for (const output of previousOutputs) {
    const identity = outputIdentity(output);
    if (identity.id && !previousById.has(identity.id)) {
      previousById.set(identity.id, output);
    }
    if (
      identity.type &&
      outputDisplayType(output) &&
      !previousByType.has(identity.type)
    ) {
      previousByType.set(identity.type, output);
    }
  }

  return deployed.map((output) => {
    const identity = outputIdentity(output);
    const displayType =
      outputDisplayType(output) ||
      (identity.id ? outputDisplayType(previousById.get(identity.id)) : "") ||
      (identity.type ?
        outputDisplayType(previousByType.get(identity.type))
      : "");
    return {
      ...output,
      ...(displayType ? { displayType } : {})
    };
  });
}

function projectOutputDisplayMetadata(
  value: Record<string, unknown>
): Record<string, string> {
  const type =
    (
      value !== null &&
      typeof value === "object" &&
      typeof (value as { type?: unknown }).type === "string"
    ) ?
      (value as { type: string }).type.trim()
    : "";
  const displayType = outputDisplayType(value);
  return {
    ...(type ? { type } : {}),
    ...(displayType ? { displayType } : {})
  };
}

/**
 * mergeDeployedGraphMetadata - enrich modeled parents with exact deployment
 * metadata without changing their topology. Parent resources match only by
 * exact id. Once a parent matches, nested outputs prefer exact output id and
 * may fall back to normalized concrete type to retain a missing displayType.
 */
export function mergeDeployedGraphMetadata(
  modeled: any[],
  deployed: unknown
): any[] {
  if (!Array.isArray(modeled)) return [];
  const deployedById = new Map<string, any>();
  for (const resource of deployedResources(deployed)) {
    const projected = projectGraphResourceMetadata(resource);
    const id = typeof projected?.id === "string" ? projected.id.trim() : "";
    if (id && !deployedById.has(id)) deployedById.set(id, projected);
  }
  return modeled.flatMap((resource) => {
    const projected = projectGraphResourceMetadata(resource);
    if (!projected) return [];
    const id = typeof resource?.id === "string" ? resource.id.trim() : "";
    const metadata = id ? deployedById.get(id) : undefined;
    const outputs =
      (
        Array.isArray(metadata?.outputResources) &&
        metadata.outputResources.length > 0
      ) ?
        mergeOutputResources(
          projected.outputResources as Record<string, unknown>[],
          metadata.outputResources as Record<string, unknown>[]
        )
      : Array.isArray(resource?.outputResources) ? resource.outputResources
      : [];
    return [
      {
        ...projected,
        connections:
          Array.isArray(resource?.connections) ?
            resource.connections
              .map(projectGraphConnectionMetadata)
              .filter(
                (
                  connection: Record<string, unknown> | null
                ): connection is Record<string, unknown> => connection !== null
              )
          : [],
        outputResources: outputs
          .map(projectGraphOutputMetadata)
          .filter(
            (
              output: Record<string, unknown> | null
            ): output is Record<string, unknown> => output !== null
          )
      }
    ];
  });
}

/**
 * mergeDeployedGraphDisplayMetadata - carry safe recipe presentation metadata
 * from the exact deployment attempt onto the displayed graph. Parent resources
 * match only by exact id. The merge copies only type and displayType, never
 * planned ids, portal URLs, or other metadata for resources that may not exist.
 */
export function mergeDeployedGraphDisplayMetadata(
  modeled: any[],
  displaySource: unknown
): any[] {
  if (!Array.isArray(modeled)) return [];
  const displayById = new Map<string, Record<string, unknown>>();
  for (const resource of deployedResources(displaySource)) {
    const projected = projectGraphResourceMetadata(resource);
    const id = typeof projected?.id === "string" ? projected.id.trim() : "";
    if (id && projected && !displayById.has(id)) {
      displayById.set(id, projected);
    }
  }

  return modeled.flatMap((resource) => {
    const projected = projectGraphResourceMetadata(resource);
    if (!projected) return [];
    const id = typeof projected.id === "string" ? projected.id.trim() : "";
    const display = id ? displayById.get(id) : undefined;
    const existingOutputs = projected.outputResources as Record<
      string,
      unknown
    >[];
    const displayOutputs =
      (display?.outputResources as Record<string, unknown>[] | undefined) ?? [];
    const existingIdentities = existingOutputs.map(outputIdentity);
    const unmatchedDisplayOutputs = displayOutputs.filter((output) => {
      const identity = outputIdentity(output);
      return !existingIdentities.some(
        (existing) =>
          (identity.id && identity.id === existing.id) ||
          (identity.type && identity.type === existing.type)
      );
    });
    const outputResources = [
      ...mergeOutputResources(displayOutputs, existingOutputs),
      ...unmatchedDisplayOutputs
        .map(projectOutputDisplayMetadata)
        .filter((output) => output.type || output.displayType)
    ];

    return [{ ...projected, outputResources }];
  });
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
 * secret), retain resolved metadata for the parent card, and stamp each node
 * with its deploy status.
 *
 * Output resources remain nested metadata. Deploy mode never expands them into
 * child nodes, so retaining them lets the parent show its concrete resolved type
 * without changing the one-node-per-Radius-resource topology.
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
  const projected: Record<string, unknown>[] = [];
  for (const resource of modeled) {
    const safeResource = projectGraphResourceMetadata(resource);
    if (!safeResource) continue;
    projected.push({
      ...safeResource,
      deployStatus:
        lookupDeployStatus(resource, statusByKey) ||
        safeResource.deployStatus ||
        "pending"
    });
  }
  return filterGraphVisualizationResources(projected);
}
