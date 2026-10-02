import type { WorkflowResponseMetadata } from "./workflow-read-metadata.js";
import type { WorkflowReadDecision } from "./workflow-read-policy.js";

export interface WorkflowPendingEnvironment {
  id: number;
  name: string;
  waitTimerMinutes: number;
  reviewersConfigured: boolean;
  currentAccountCanApprove: boolean;
}

export type WorkflowProtectionEvidence = (
  | { state: "observed"; environments: WorkflowPendingEnvironment[] }
  | {
      state: "unavailable";
      reason:
        | "read-failed"
        | "authorization"
        | "invalid-data"
        | "primary-incomplete"
        | "timeout"
        | "output-limit"
        | "cancelled"
        | "deferred";
    }
) & {
  response?: WorkflowResponseMetadata;
  decision?: WorkflowReadDecision;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function parseWorkflowProtection(
  value: unknown
): WorkflowProtectionEvidence {
  const invalid: WorkflowProtectionEvidence = {
    state: "unavailable",
    reason: "invalid-data"
  };
  if (!Array.isArray(value)) return invalid;
  const environments: WorkflowPendingEnvironment[] = [];
  const ids = new Set<number>();
  for (const item of value) {
    if (!record(item) || !record(item.environment)) return invalid;
    const environment = item.environment;
    if (
      !positiveId(environment.id) ||
      ids.has(environment.id) ||
      typeof environment.name !== "string" ||
      !environment.name.trim() ||
      typeof item.wait_timer !== "number" ||
      !Number.isSafeInteger(item.wait_timer) ||
      item.wait_timer < 0 ||
      item.wait_timer > 43200 ||
      (item.wait_timer_started_at !== null &&
        (typeof item.wait_timer_started_at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(
            item.wait_timer_started_at
          ) ||
          !Number.isFinite(Date.parse(item.wait_timer_started_at)) ||
          new Date(item.wait_timer_started_at).toISOString().slice(0, 19) !==
            item.wait_timer_started_at.slice(0, 19))) ||
      typeof item.current_user_can_approve !== "boolean" ||
      !Array.isArray(item.reviewers)
    )
      return invalid;
    for (const reviewer of item.reviewers) {
      if (
        !record(reviewer) ||
        (reviewer.type !== "User" && reviewer.type !== "Team") ||
        !record(reviewer.reviewer) ||
        !positiveId(reviewer.reviewer.id)
      )
        return invalid;
    }
    ids.add(environment.id);
    environments.push({
      id: environment.id,
      name: environment.name,
      waitTimerMinutes: item.wait_timer,
      reviewersConfigured: item.reviewers.length > 0,
      currentAccountCanApprove: item.current_user_can_approve
    });
  }
  return {
    state: "observed",
    environments: environments.sort((left, right) => left.id - right.id)
  };
}

export function describeWorkflowProtection(
  evidence: WorkflowProtectionEvidence
): string {
  if (evidence.state === "unavailable")
    return `Observation: environment protection details are unavailable (${evidence.reason}); approval status is unknown.`;
  if (evidence.environments.length === 0)
    return "Observation: GitHub returned no pending environments; this does not establish approval or deployment success.";
  return evidence.environments
    .map((environment) => {
      let message = `Observation: environment ${JSON.stringify(environment.name)} is waiting on protection rules.`;
      if (environment.reviewersConfigured)
        message += " Required reviewers are configured.";
      if (environment.waitTimerMinutes > 0)
        message += ` A ${environment.waitTimerMinutes}-minute wait timer is configured.`;
      if (environment.currentAccountCanApprove)
        message += " The GitHub account used for this read can approve.";
      return message;
    })
    .join("\n");
}
