import { deployStatusKeys } from "./graph/deployed.js";
import type { DeployStatus } from "./graph/index.js";
import type { RadDeployResourceError } from "./workflow-diagnostics.js";

export const DEPLOY_CANCELLED_MESSAGE = "Deployment cancelled";
export const DEPLOY_TIMED_OUT_MESSAGE = "Deployment timed out";
export const DEPLOY_MONITOR_TIMED_OUT_MESSAGE =
  "Deployment monitoring timed out; the workflow may still be running.";
export const DEPLOY_FAILED_MESSAGE = "Deployment failed";
export const MAX_DEPLOY_MESSAGE_LENGTH = 500;

export interface SettleableResource {
  id?: string;
  name?: string;
  type?: string;
  deployStatus?: DeployStatus;
  deployMessage?: string;
}

export function unfinishedDeployMessage(
  conclusion?: string | null,
  radiusError?: string
): string {
  if (conclusion === "cancelled") return DEPLOY_CANCELLED_MESSAGE;
  if (conclusion === "timed_out") return DEPLOY_TIMED_OUT_MESSAGE;
  if (conclusion === "monitor_timed_out")
    return DEPLOY_MONITOR_TIMED_OUT_MESSAGE;
  const detail = typeof radiusError === "string" ? radiusError.trim() : "";
  return boundedDeployMessage(detail) || DEPLOY_FAILED_MESSAGE;
}

function boundedDeployMessage(detail: string): string {
  if (detail.length > MAX_DEPLOY_MESSAGE_LENGTH)
    return detail.slice(0, MAX_DEPLOY_MESSAGE_LENGTH - 3) + "...";
  return detail;
}

function resourceErrorKeys(target: string): string[] {
  const id = target.toLowerCase();
  const match = /\/providers\/([^/]+\/[^/]+)\/([^/]+)$/.exec(id);
  return match ? [id, match[2] + "|" + match[1]] : [id];
}

function buildResourceErrorMap(
  resourceErrors: readonly RadDeployResourceError[] | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  for (const { target, message } of resourceErrors ?? []) {
    const bounded = boundedDeployMessage(message.trim());
    if (!bounded) continue;
    for (const key of resourceErrorKeys(target.trim())) {
      if (!map.has(key)) map.set(key, bounded);
    }
  }
  return map;
}

function ownResourceError(
  resource: SettleableResource,
  errors: Map<string, string>
): string {
  if (errors.size === 0) return "";
  for (const key of deployStatusKeys(resource)) {
    const message = errors.get(key.toLowerCase());
    if (message) return message;
  }
  return "";
}

/**
 * Run success is authoritative, even over producer-reported resource failures.
 * Other conclusions settle unfinished resources without replacing already
 * terminal producer evidence. The caller separately propagates output status.
 */
export function settleDeployStatuses(
  resources: SettleableResource[],
  conclusion?: string | null,
  radiusError?: string,
  resourceErrors?: readonly RadDeployResourceError[]
): void {
  if (!Array.isArray(resources)) return;
  const succeeded = conclusion === "success";
  const message =
    succeeded ? "" : unfinishedDeployMessage(conclusion, radiusError);
  const ownErrors =
    succeeded ?
      new Map<string, string>()
    : buildResourceErrorMap(resourceErrors);
  for (const resource of resources) {
    if (succeeded) {
      resource.deployStatus = "success";
      delete resource.deployMessage;
      continue;
    }
    const current = resource.deployStatus || "pending";
    const unfinished = current === "pending" || current === "in_progress";
    if (unfinished) resource.deployStatus = "failed";
    if (resource.deployStatus !== "failed") continue;
    if (unfinished || !(resource.deployMessage ?? "").trim())
      resource.deployMessage = ownResourceError(resource, ownErrors) || message;
  }
}
