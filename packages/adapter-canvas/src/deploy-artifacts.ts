import { cliExec } from "./gh.js";
import { deployStatusKeys, lookupDeployStatus } from "@radius-project/core";
import type {
  DeployStatus,
  DeployProgress,
  DeployProgressResource
} from "@radius-project/core";
import {
  createWorkflowArtifactReader,
  createWorkflowArtifactReads
} from "@radius-project/adapter-shared";
import type {
  WorkflowRunner,
  WorkflowArtifactReaderOptions
} from "@radius-project/adapter-shared";
export {
  DEPLOY_STATUS_FILES,
  DEPLOY_STATUS_ARTIFACT_PREFIX,
  DEPLOY_PROGRESS_SCHEMA_VERSION,
  MAX_ARTIFACT_CANDIDATES,
  ARTIFACT_PAGE_SIZE,
  MAX_ARTIFACT_PAGES,
  isLiveSlotArtifactName,
  sanitizeArtifactSegment,
  deployStatusArtifactPrefix,
  selectDeployStatusArtifacts,
  parseDeployProgressArtifact,
  parseDeployGraphArtifact,
  confirmArtifactIdentity
} from "@radius-project/core";
export type {
  DeployProgress,
  DeployProgressResource,
  WorkflowArtifact,
  ArtifactFiles,
  ListArtifacts,
  DownloadArtifact,
  ReaderStatus
} from "@radius-project/core";
export type { WorkflowArtifactReaderOptions as DeployStatusReaderOptions } from "@radius-project/adapter-shared";

const run: WorkflowRunner = (args, options) =>
  new Promise((resolve) => {
    cliExec("gh", args, options, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code ?? 1) : 0,
        stdout,
        stderr: stderr || error?.message || ""
      });
    });
  });
export const { listWorkflowArtifacts, downloadWorkflowArtifact } =
  createWorkflowArtifactReads(run);
export function createDeployStatusReader(
  options: WorkflowArtifactReaderOptions
) {
  return createWorkflowArtifactReader(
    {
      ...options,
      allowApplicationFallback: options.allowApplicationFallback ?? true
    },
    run
  );
}

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

/**
 * The messages a node carries when the run's conclusion — not the producer —
 * decided its outcome (Exception 5.1). A cancelled or timed-out run publishes no
 * per-resource failure, so without these the graph turns red and says nothing.
 */
export const DEPLOY_CANCELLED_MESSAGE = "Deployment cancelled";
export const DEPLOY_TIMED_OUT_MESSAGE = "Deployment timed out";
export const DEPLOY_MONITOR_TIMED_OUT_MESSAGE =
  "Deployment monitoring timed out; the workflow may still be running.";
export { DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE } from "./deploy-messages.js";
export const DEPLOY_FAILED_MESSAGE = "Deployment failed";
export const MAX_DEPLOY_MESSAGE_LENGTH = 500;

/**
 * unfinishedDeployMessage - the message for a node the run's conclusion failed.
 *
 * Cancellation and workflow timeout describe the run; `monitor_timed_out` only
 * means monitoring stopped before its outcome was confirmed. Other non-success
 * conclusions prefer a bounded copy of the extracted Radius error. The caller
 * retains the full diagnostics; only text copied onto graph nodes is shortened.
 */
export function unfinishedDeployMessage(
  conclusion?: string | null,
  radiusError?: string
): string {
  if (conclusion === "cancelled") return DEPLOY_CANCELLED_MESSAGE;
  if (conclusion === "timed_out") return DEPLOY_TIMED_OUT_MESSAGE;
  if (conclusion === "monitor_timed_out")
    return DEPLOY_MONITOR_TIMED_OUT_MESSAGE;
  const detail = typeof radiusError === "string" ? radiusError.trim() : "";
  if (detail.length > MAX_DEPLOY_MESSAGE_LENGTH)
    return detail.slice(0, MAX_DEPLOY_MESSAGE_LENGTH - 3) + "...";
  return detail || DEPLOY_FAILED_MESSAGE;
}

export interface SettleableResource {
  deployStatus?: DeployStatus;
  deployMessage?: string;
}

/**
 * settleDeployStatuses - apply a workflow conclusion or `monitor_timed_out`
 * to the graph without claiming an unconfirmed workflow has stopped.
 *
 * On success every node is forced green: the run concluded successfully, so
 * every resource provisioned, whatever the last snapshot happened to say. This
 * deliberately overrides a resource the producer positively reported as
 * `failed` (and discards its deployMessage): the run conclusion is authoritative
 * for the overall outcome, so a partially-failed-yet-succeeded run shows all
 * green rather than a stale per-resource failure.
 * On any other conclusion, nodes still pending or in progress become failed,
 * while nodes already terminal keep the status the producer reported — the run
 * conclusion decides the overall label, not an individual resource's outcome
 * that was already observed.
 *
 * Every node this leaves red also gets a message, because a red node with no
 * explanation is the one state the user most needs detail in (Exception 5.1).
 * Which message depends on who decided the outcome. A node the producer already
 * reported `failed` keeps its own message: it names that resource's own failure,
 * which is more specific than anything derived from the run's conclusion. A node
 * this function flips from pending or in progress had its outcome decided by the
 * run, so it takes the conclusion's message even if it already carried one — the
 * message it carried describes work in flight ("creating…"), and leaving that on
 * a red node would report progress on a resource that never finished.
 *
 * Output resources are not walked here: they take their status from their parent
 * through the caller's own propagation.
 */
export function settleDeployStatuses(
  resources: SettleableResource[],
  conclusion?: string | null,
  radiusError?: string
): void {
  if (!Array.isArray(resources)) return;
  const succeeded = conclusion === "success";
  const message =
    succeeded ? "" : unfinishedDeployMessage(conclusion, radiusError);
  for (const resource of resources) {
    if (succeeded) {
      resource.deployStatus = "success";
      // Documented above: a green node must not carry a stale failure message
      // from an earlier snapshot of this same run.
      delete resource.deployMessage;
      continue;
    }
    const current = resource.deployStatus || "pending";
    const unfinished = current === "pending" || current === "in_progress";
    if (unfinished) resource.deployStatus = "failed";
    if (resource.deployStatus !== "failed") continue;
    // A node the run just failed takes the run's message, replacing any
    // in-flight progress text. A node the producer already reported failed keeps
    // its own message, and one it reported failed without a message — incomplete
    // artifact reporting — finally gets an explanation instead of being red and
    // silent.
    if (unfinished || !(resource.deployMessage ?? "").trim())
      resource.deployMessage = message;
  }
}
