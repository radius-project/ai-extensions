// Canvas adapter — the deployed-resource inventory and the authorization gate
// for deleting one resource the application definition no longer declares
// (exception 7.1).
//
// Two problems live together here on purpose:
//
//   1. A delete confirmation has to name what it will actually remove. The
//      modeled graph is not that list: deployment is incremental, so what is
//      deployed is a superset of what the definition currently declares.
//   2. A per-resource delete is destructive, so the identity it acts on must be
//      one the SERVER derived, from a deployed graph, for exactly this
//      repository, branch, environment and application — and it must still be
//      derivable at the moment of dispatch, not merely when the page rendered.
//
// The snapshot therefore carries a deterministic `revision` over the exact
// modeled and deployed identities it was built from. The client echoes that
// revision back, and the authorization below re-derives the removal from the
// CURRENT modeled graph before anything is dispatched. A resource the user put
// back into `app.bicep`, a branch switch, a redeploy, or a stale page all fail
// closed.
//
// Pure: no HTTP, no state mutation, no clock of its own.

import {
  findRemovedDeployedResources,
  selectApplicationOwnedResources,
  type RemovedDeployedResource
} from "@radius-project/core";

// One deployed resource, reduced to the identity fields the confirmation and
// the delete need. Kept verbatim from the deployed graph.
export interface DeployedResourceIdentity {
  id: string;
  name: string;
  type: string;
}

export interface DeployedInventory {
  repo: string;
  branch: string;
  environment: string;
  application: string;
  revision: string;
  // The authoritative deployed resources this application owns, empty when
  // `complete` is false.
  resources: DeployedResourceIdentity[];
  // The subset the current definition no longer declares.
  removed: RemovedDeployedResource[];
  // False when no ownership-verified deployed record set was available. An
  // incomplete inventory is reported as incomplete rather than presented as an
  // exact count, and it can never authorize a delete.
  complete: boolean;
  updatedAt: number;
}

export interface OwnedDeployedResourcesInput {
  application: string;
  environment: string;
  // The producer's application-scoped `rad resource list` output for this
  // selection, or null when the run published none. Authoritative: it is the
  // control plane's own answer to "what does this application own", so when it
  // is present nothing else is consulted — in particular a stale connected
  // graph can never put a just-deleted resource back.
  resourceList: readonly unknown[] | null;
  // The connected application graph. Only records that name this application
  // as their owner are taken from it, because a graph also contains the
  // environment-scoped and external resources the application merely uses.
  graph: unknown;
}

/**
 * ownedDeployedResources - the deployed records this application verifiably
 * owns, or null when no ownership-verified source was available.
 *
 * Null is not "nothing is deployed": it is "the server does not know", which
 * `buildDeployedInventory` records as an incomplete inventory that can never
 * authorize a delete.
 */
export function ownedDeployedResources(
  input: OwnedDeployedResourcesInput
): unknown[] | null {
  // Without an application there is nothing to verify ownership against, so the
  // answer is "unknown", never "nothing is owned".
  if (!input.application.trim()) return null;
  const scope = {
    application: input.application,
    environment: input.environment
  };
  if (input.resourceList) {
    return selectApplicationOwnedResources(input.resourceList, {
      ...scope,
      applicationScopedList: true
    });
  }
  if (input.graph === null || input.graph === undefined) return null;
  return selectApplicationOwnedResources(input.graph, scope);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function deployedList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") {
    const resources = (value as { resources?: unknown }).resources;
    if (Array.isArray(resources)) return resources;
  }
  return [];
}

/**
 * deployedResourceIdentities - the deployed graph reduced to identities.
 *
 * Entries without both a name and a type are dropped: they cannot be named in a
 * confirmation and cannot be deleted, so counting them would overstate what the
 * user is about to confirm.
 */
export function deployedResourceIdentities(
  deployed: unknown
): DeployedResourceIdentity[] {
  const identities: DeployedResourceIdentity[] = [];
  const seen = new Set<string>();
  for (const entry of deployedList(deployed)) {
    const record = entry as Record<string, unknown> | null;
    const name = text(record?.name);
    const type = text(record?.type);
    if (!name || !type) continue;
    const id = text(record?.id);
    const key = `${id}\n${name}\n${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    identities.push({ id, name, type });
  }
  return identities;
}

// FNV-1a over the canonical identity string. A hash, not a random token: two
// servers (or the same server before and after a poll) must agree on the
// revision of an unchanged selection, and any change to the modeled or deployed
// identity set must change it.
function digest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function modeledIdentities(modeled: readonly unknown[]): string[] {
  const identities: string[] = [];
  for (const entry of modeled) {
    const record = entry as Record<string, unknown> | null;
    identities.push(
      [text(record?.id), text(record?.name), text(record?.type)].join("\u0001")
    );
  }
  return identities.sort();
}

export interface DeployedInventoryInput {
  repo: string;
  branch: string;
  environment: string;
  application: string;
  // The current application definition's resources.
  modeled: readonly unknown[];
  // The ownership-verified deployed records — see `ownedDeployedResources` —
  // or null when none could be read.
  deployed: unknown;
  now: number;
}

export interface DeployedInventoryRevisionInput {
  repo: string;
  branch: string;
  environment: string;
  application: string;
  complete: boolean;
  modeled: readonly unknown[];
  resources: readonly DeployedResourceIdentity[];
}

/**
 * deployedInventoryRevision - the deterministic revision of one selection.
 *
 * A hash over the selection plus the exact modeled and deployed identity sets,
 * so the same inputs always produce the same revision and any change to either
 * set produces a different one. That is what lets the delete route re-derive
 * the revision from a freshly reloaded definition and compare it with the one
 * the client confirmed, instead of trusting a cached snapshot.
 */
export function deployedInventoryRevision(
  input: DeployedInventoryRevisionInput
): string {
  return digest(
    [
      input.repo,
      input.branch,
      input.environment.toLowerCase(),
      input.application.toLowerCase(),
      input.complete ? "complete" : "partial",
      modeledIdentities(input.modeled).join("\u0002"),
      input.resources
        .map(
          (resource) =>
            `${resource.id}\u0001${resource.name}\u0001${resource.type}`
        )
        .sort()
        .join("\u0002")
    ].join("\u0003")
  );
}

/**
 * buildDeployedInventory - the inventory and removal set for one selection,
 * plus the revision that binds them to it.
 *
 * With no ownership-verified deployed records the inventory is
 * `complete: false` with no resources and no removals: absence of evidence is
 * not evidence that nothing is deployed, and it must never authorize a delete.
 */
export function buildDeployedInventory(
  input: DeployedInventoryInput
): DeployedInventory {
  const complete = input.deployed !== null && input.deployed !== undefined;
  const resources = complete ? deployedResourceIdentities(input.deployed) : [];
  const removed =
    complete ?
      findRemovedDeployedResources(input.modeled as unknown[], resources)
    : [];
  const revision = deployedInventoryRevision({
    repo: input.repo,
    branch: input.branch,
    environment: input.environment,
    application: input.application,
    complete,
    modeled: input.modeled,
    resources
  });
  return {
    repo: input.repo,
    branch: input.branch,
    environment: input.environment,
    application: input.application,
    revision,
    resources,
    removed,
    complete,
    updatedAt: input.now
  };
}

export type RemovedResourceAuthorization =
  | { ok: true; resource: RemovedDeployedResource }
  | { ok: false; status: number; error: string };

export interface RemovedResourceAuthorizationInput {
  inventory: DeployedInventory | null | undefined;
  // The branch the canvas currently resolves this repository's definition
  // against. A snapshot taken on another branch describes another definition.
  currentBranch: string;
  // The modeled resources of that current branch, or null when the server no
  // longer holds a modeled graph for it.
  currentModeled: readonly unknown[] | null;
  // The revision the CURRENT definition produces for this selection — see
  // `deployedInventoryRevision` — or null when there is no definition to derive
  // one from. Any change to the modeled identity set (a resource added, renamed
  // or retyped) changes it, so comparing it with the revision the client
  // confirmed catches a definition that moved under the confirmation even when
  // the resource being deleted is still absent from it.
  currentRevision: string | null;
  request: {
    repo: string;
    environment: string;
    application: string;
    resourceName: string;
    resourceType: string;
    revision: string;
  };
}

const RELOAD_HINT = "Reload the deployed graph and try again.";

function sameName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * authorizeRemovedResourceDelete - decide whether one per-resource delete may be
 * dispatched, right now.
 *
 * Every refusal is a 409 the page recovers from by reloading, because every one
 * of them means the client's view of what is orphaned is no longer the server's.
 * The last two checks are the important ones: the revision is RE-DERIVED from
 * the modeled graph handed in, and so is the removal, so a resource that was put
 * back into the definition — or any other change to the definition's identity
 * set — is rejected even though the snapshot still lists it.
 *
 * Called twice per delete: once on the cached snapshot, to refuse a stale
 * confirmation before anything is reserved, and once more against a freshly
 * reloaded definition immediately before the workflow is dispatched.
 */
export function authorizeRemovedResourceDelete(
  input: RemovedResourceAuthorizationInput
): RemovedResourceAuthorization {
  const { inventory, request } = input;
  const scope = `${request.application} in environment ${request.environment}`;
  if (
    !inventory ||
    inventory.repo !== request.repo ||
    !sameName(inventory.environment, request.environment) ||
    !sameName(inventory.application, request.application)
  ) {
    return {
      ok: false,
      status: 409,
      error: `The deployed graph for ${scope} has not been read on this canvas. ${RELOAD_HINT}`
    };
  }
  if (!inventory.complete) {
    return {
      ok: false,
      status: 409,
      error: `The deployed resources of ${scope} could not be read, so no resource can be confirmed as removed. ${RELOAD_HINT}`
    };
  }
  if (inventory.branch !== input.currentBranch) {
    return {
      ok: false,
      status: 409,
      error: `This confirmation was made against branch "${inventory.branch}", but the canvas is now on "${input.currentBranch}". ${RELOAD_HINT}`
    };
  }
  if (!request.revision || request.revision !== inventory.revision) {
    return {
      ok: false,
      status: 409,
      error: `The deployed graph for ${scope} changed after this delete was confirmed. ${RELOAD_HINT}`
    };
  }
  const matches = (candidate: { name: string; type: string }): boolean =>
    candidate.name === request.resourceName &&
    candidate.type === request.resourceType;
  if (!inventory.removed.some(matches)) {
    return {
      ok: false,
      status: 409,
      error: `This resource is not in the list of removed resources for ${scope}. ${RELOAD_HINT}`
    };
  }
  // Re-derive from the definition as it stands now, not as it stood when the
  // page rendered.
  if (!input.currentModeled || !input.currentRevision) {
    return {
      ok: false,
      status: 409,
      error: `The application definition for ${scope} is no longer loaded, so this resource cannot be re-confirmed as removed. ${RELOAD_HINT}`
    };
  }
  const stillRemoved = findRemovedDeployedResources(
    input.currentModeled as unknown[],
    inventory.resources
  );
  const resource = stillRemoved.find(matches);
  if (!resource) {
    return {
      ok: false,
      status: 409,
      error: `${request.resourceName} is declared by the current application definition again, so it is no longer a removed resource. ${RELOAD_HINT}`
    };
  }
  if (request.revision !== input.currentRevision) {
    return {
      ok: false,
      status: 409,
      error: `The application definition for ${scope} changed after this delete was confirmed. ${RELOAD_HINT}`
    };
  }
  return { ok: true, resource };
}
