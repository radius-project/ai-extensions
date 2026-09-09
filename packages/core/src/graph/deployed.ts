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

/**
 * mergeDeployedGraphMetadata - enrich modeled parents with exact deployment
 * metadata without changing their topology. Parent ids are the producer's
 * authoritative linkage; names and types are never used to guess a match.
 */
export function mergeDeployedGraphMetadata(
  modeled: any[],
  deployed: unknown
): any[] {
  if (!Array.isArray(modeled)) return [];
  const deployedById = new Map<string, any>();
  for (const resource of deployedResources(deployed)) {
    const id = typeof resource?.id === "string" ? resource.id.trim() : "";
    if (id && !deployedById.has(id)) deployedById.set(id, resource);
  }
  return modeled.map((resource) => {
    const id = typeof resource?.id === "string" ? resource.id.trim() : "";
    const metadata = id ? deployedById.get(id) : undefined;
    const outputs =
      (
        Array.isArray(metadata?.outputResources) &&
        metadata.outputResources.length > 0
      ) ?
        metadata.outputResources
      : Array.isArray(resource?.outputResources) ? resource.outputResources
      : [];
    return {
      ...resource,
      connections:
        Array.isArray(resource?.connections) ?
          resource.connections.map((connection: any) => ({ ...connection }))
        : [],
      outputResources: outputs.map((output: any) => ({ ...output }))
    };
  });
}

/**
 * A resource the deployed graph still reports but the current application
 * definition no longer declares — exception 7.1. Deployment is incremental, so
 * removing a resource from `app.bicep` never deletes what is already deployed.
 *
 * `type` and `name` are both required and carried verbatim: they are the exact
 * identity a per-resource delete is dispatched with, and a resource that cannot
 * be identified precisely must not be offered for deletion at all.
 */
export interface RemovedDeployedResource {
  id: string;
  name: string;
  type: string;
}

// `properties.application` / `properties.environment` are full UCP resource
// ids; the owning name is the last path segment. A bare name is accepted too,
// because the same field is flattened by the deploy-status producer.
function ownerName(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return text
    .slice(text.lastIndexOf("/") + 1)
    .trim()
    .toLowerCase();
}

// A UCP resource id carries its owner in its own path — an application-scoped
// resource lives under `/applications/<app>/`, an environment-scoped one under
// `/environments/<env>/`. `rad app graph` nodes state ownership this way and no
// other, so without this the graph would yield no verifiable owner at all.
function ownerFromResourceId(id: unknown, segment: string): string {
  const text = typeof id === "string" ? id : "";
  const match = new RegExp(`/${segment}/([^/]+)/`, "i").exec(text);
  return match ? match[1].trim().toLowerCase() : "";
}

function declaredOwner(resource: any, field: "application" | "environment") {
  const declared = ownerName(
    resource?.properties?.[field] ?? resource?.[field]
  );
  if (declared) return declared;
  return ownerFromResourceId(
    resource?.id,
    field === "application" ? "applications" : "environments"
  );
}

export interface ApplicationResourceScope {
  // The application whose resources may be listed. Required: an unscoped
  // ownership check is not an ownership check.
  application: string;
  // The environment, when known. A resource that names a different environment
  // is excluded even if it names the right application.
  environment?: string;
  // True when `deployed` is the output of an application-scoped resource
  // listing (`rad resource list --application <app>`), which is itself the
  // ownership evidence for entries that do not restate their owner. A connected
  // application graph is NOT such a listing: it also contains environment-scoped
  // and external resources the application merely talks to.
  applicationScopedList?: boolean;
}

/**
 * selectApplicationOwnedResources - the deployed records that verifiably belong
 * to one application, carried verbatim.
 *
 * Graph membership is not ownership. `rad app graph` returns everything the
 * application is connected to, including environment-scoped and external
 * resources that a deletion must never touch and a deletion count must never
 * include. An entry is therefore kept only when
 *
 *   * it declares `properties.application` (or a flattened `application`, or an
 *     `/applications/<app>/` segment in its own resource id) that resolves to
 *     this application, and any environment it declares matches, or
 *   * it declares no owner at all AND the caller states that `deployed` is an
 *     application-scoped resource listing, which is the same evidence one step
 *     earlier.
 *
 * Everything else is dropped. Fail-closed is the only safe direction here: this
 * list is what a destructive per-resource delete is derived from.
 */
export function selectApplicationOwnedResources(
  deployed: unknown,
  scope: ApplicationResourceScope
): any[] {
  const application = ownerName(scope.application);
  if (!application) return [];
  const environment = ownerName(scope.environment);
  const owned: any[] = [];
  for (const resource of deployedResources(deployed)) {
    if (resource === null || typeof resource !== "object") continue;
    const owner = declaredOwner(resource, "application");
    if (owner) {
      if (owner !== application) continue;
    } else if (!scope.applicationScopedList) {
      continue;
    }
    const resourceEnvironment = declaredOwner(resource, "environment");
    if (
      environment &&
      resourceEnvironment &&
      resourceEnvironment !== environment
    )
      continue;
    owned.push(resource);
  }
  return owned;
}

/**
 * findRemovedDeployedResources - the deployed resources the modeled application
 * no longer declares.
 *
 * Matching reuses `deployStatusKeys`, so a deployed resource counts as still
 * modeled when it shares ANY identity key with a modeled resource or one of its
 * output resources. That is deliberately generous in the safe direction: this
 * list drives a destructive action, so a resource whose identity is ambiguous
 * is treated as still modeled rather than offered for deletion.
 *
 * Entries without both a name and a type are skipped for the same reason —
 * `rad resource delete` needs both, and guessing either one is not an option.
 */
export function findRemovedDeployedResources(
  modeled: any[],
  deployed: unknown
): RemovedDeployedResource[] {
  const modeledKeys = new Set<string>();
  if (Array.isArray(modeled)) {
    for (const resource of modeled) {
      for (const key of deployStatusKeys(resource)) modeledKeys.add(key);
      if (Array.isArray(resource?.outputResources)) {
        for (const output of resource.outputResources) {
          for (const key of deployStatusKeys(output)) modeledKeys.add(key);
        }
      }
    }
  }
  const removed: RemovedDeployedResource[] = [];
  const seen = new Set<string>();
  for (const resource of deployedResources(deployed)) {
    const keys = deployStatusKeys(resource);
    if (keys.some((key) => modeledKeys.has(key))) continue;
    const name = typeof resource?.name === "string" ? resource.name.trim() : "";
    const type = typeof resource?.type === "string" ? resource.type.trim() : "";
    if (!name || !type) continue;
    const id = typeof resource?.id === "string" ? resource.id.trim() : "";
    const identity = `${id}\n${name}\n${type}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    removed.push({ id, name, type });
  }
  return removed;
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
  const visible = filterGraphVisualizationResources(modeled);
  return visible.map((resource: any) => ({
    ...resource,
    connections:
      Array.isArray(resource?.connections) ?
        resource.connections.map((c: any) => ({ ...c }))
      : [],
    outputResources:
      Array.isArray(resource?.outputResources) ?
        resource.outputResources.map((output: any) => ({ ...output }))
      : [],
    deployStatus:
      lookupDeployStatus(resource, statusByKey) ||
      resource?.deployStatus ||
      "pending"
  }));
}
