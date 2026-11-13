import { deployStatusKeys, lookupDeployStatus } from "./graph/deployed.js";
import type { DeployStatus } from "./graph/index.js";
import type {
  DeployProgress,
  DeployProgressResource
} from "./deploy-artifact-evidence.js";

/**
 * normalizeProvisioningState - map a raw Radius provisioningState onto the
 * canvas status vocabulary.
 *
 * Anything unrecognized — including a state a future Radius release adds — maps
 * to in_progress, never failed. A new provisioning state must not be able to
 * paint the graph red.
 */
export function normalizeProvisioningState(
  value?: string | null
): DeployStatus {
  const v = String(value || "")
    .trim()
    .toLowerCase();
  if (v === "succeeded") return "success";
  if (v === "failed" || v === "canceled" || v === "cancelled") return "failed";
  return "in_progress";
}

/**
 * resolveResourceStatus - the status for one entry: the producer's normalized
 * `status` when present and valid, else its raw `provisioningState` normalized
 * here, else in_progress.
 *
 * Both fields are carried deliberately. `status` keeps the mapping decision with
 * the producer, which knows the Radius version it ran against; `provisioningState`
 * lets this side recover when the producer's mapping is stale.
 */
export function resolveResourceStatus(
  resource: DeployProgressResource
): DeployStatus {
  return (
    resource.status || normalizeProvisioningState(resource.provisioningState)
  );
}

/**
 * buildDeployStatusMap - index a progress payload by every key a modeled
 * resource might be matched on, so lookupDeployStatus can resolve in priority
 * order.
 *
 * The keys come from `deployStatusKeys`, the same function the lookup side uses.
 * That shared derivation is load-bearing: if the two ever computed keys
 * differently, this map would be populated with keys the lookup never queries
 * and every node would silently fall back to pending.
 *
 * A later entry never overwrites an earlier one for the same key. A duplicate
 * key means two resources collide on that (weaker) key, in which case the first
 * wins rather than the last silently taking over.
 */
export function buildDeployStatusMap(
  progress: DeployProgress | null | undefined
): Map<string, DeployStatus> {
  const map = new Map<string, DeployStatus>();
  if (!progress || !Array.isArray(progress.resources)) return map;
  // Reserve authoritative modeled ids before adding output aliases. A concrete
  // output can be shared by multiple parents or equal another parent's id; an
  // alias must never claim that parent's exact key.
  for (const resource of progress.resources) {
    const id = (resource.id || "").trim();
    if (id && !map.has(id)) map.set(id, resolveResourceStatus(resource));
  }
  for (const resource of progress.resources) {
    const status = resolveResourceStatus(resource);
    for (const key of deployStatusKeys(resource)) {
      if (!map.has(key)) map.set(key, status);
    }
  }
  return map;
}

/**
 * buildDeployMessageMap - index the payload's per-resource `message` strings by
 * the same keys as the status map.
 *
 * Kept separate from the status map rather than folded into it because the
 * status merge is a lattice (`failed` is terminal, a miss preserves the current
 * value) while a message is just the most recent explanatory text. Blending the
 * two would make the merge rules apply to prose.
 *
 * Empty messages are skipped: the producer emits `""` for a healthy resource,
 * and an empty string is not a message.
 */
export function buildDeployMessageMap(
  progress: DeployProgress | null | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  if (!progress || !Array.isArray(progress.resources)) return map;
  const directIds = new Set(
    progress.resources
      .map((resource) => (resource.id || "").trim())
      .filter(Boolean)
  );
  for (const resource of progress.resources) {
    const id = (resource.id || "").trim();
    const message = (resource.message || "").trim();
    if (id && message && !map.has(id)) map.set(id, message);
  }
  for (const resource of progress.resources) {
    const resourceId = (resource.id || "").trim();
    const message = (resource.message || "").trim();
    if (!message) continue;
    for (const key of deployStatusKeys(resource)) {
      if (directIds.has(key) && key !== resourceId) continue;
      if (!map.has(key)) map.set(key, message);
    }
  }
  return map;
}

/**
 * applyDeployMessages - attach each resource's status message so the node popup
 * can explain WHY a node is red. Without this the graph reports that something
 * failed but never what went wrong, which is the moment the user most needs
 * detail. Resources with no message are left untouched.
 */
export function applyDeployMessages(
  resources: Array<{
    id?: string;
    name?: string;
    type?: string;
    deployMessage?: string;
  }>,
  messageMap: Map<string, string>
): void {
  if (!Array.isArray(resources) || messageMap.size === 0) return;
  for (const resource of resources) {
    for (const key of deployStatusKeys(resource)) {
      const message = messageMap.get(key);
      if (message) {
        resource.deployMessage = message;
        break;
      }
    }
  }
}

const STATUS_RANK: Record<DeployStatus, number> = {
  pending: 0,
  in_progress: 1,
  success: 2,
  failed: 3
};

/**
 * applyDeployStatusToResources - merge a status map into resources that are
 * already on screen, in place, returning the resources that changed.
 *
 * The merge is deliberately conservative because updates arrive as independent
 * snapshots, not as a stream of transitions:
 *
 *   - `failed` is terminal within a run and is never downgraded by a later tick.
 *   - `success` regresses only on an explicit `failed`.
 *   - A resource missing from the map keeps its current status. A payload that
 *     simply does not mention a resource carries no information about it, and
 *     must never reset a node that has already advanced.
 */
export function applyDeployStatusToResources(
  resources: Array<{
    id?: string;
    name?: string;
    type?: string;
    deployStatus?: DeployStatus;
  }>,
  statusMap: Map<string, DeployStatus>
): Array<{ name?: string; from: DeployStatus; to: DeployStatus }> {
  const changes: Array<{
    name?: string;
    from: DeployStatus;
    to: DeployStatus;
  }> = [];
  if (!Array.isArray(resources) || statusMap.size === 0) return changes;
  for (const resource of resources) {
    const next = lookupDeployStatus(resource, statusMap);
    if (!next) continue;
    const current: DeployStatus = resource.deployStatus || "pending";
    if (current === next) continue;
    if (current === "failed") continue;
    if (STATUS_RANK[next] <= STATUS_RANK[current] && next !== "failed")
      continue;
    resource.deployStatus = next;
    changes.push({ name: resource.name, from: current, to: next });
  }
  return changes;
}
