// Pure helpers behind the radius_deploy / radius_deploy_status tools, kept out of
// extension.ts so they can be tested without the SDK or a live canvas server.

import {
  fenceDeployDiagnostic,
  DEPLOY_DIAGNOSTIC_NOTE
} from "./deploy-diagnostics.js";

export interface DeployStatusInput {
  status?: string;
  errorKind?: string | null;
  deployRunUrl?: string | null;
  startedAt?: string | number | null;
  finishedAt?: string | number | null;
  error?: unknown;
  logs?: unknown;
}

export interface DeployStatusSummary {
  status: "in_progress" | "success" | "failed";
  errorKind: string | null;
  deployRunUrl: string | null;
  startedAt: string | number | null;
  finishedAt: string | number | null;
  diagnosticNote?: string;
  diagnostic?: string;
  error?: never;
  logTail?: never;
  resources?: never;
}

// Describe a started deploy back to the agent. A redeploy inside a repair loop
// also reports where it sits in that loop: the cap is stated once in the
// handoff prompt, which is easy to lose track of several repairs later, so it
// is repeated on every attempt alongside the server-side enforcement.
export function describeDeployStarted(
  payload: { targetRepo?: string; branch?: string; environment?: string } = {},
  result: { repairAttempt?: unknown; repairAttemptCap?: unknown } = {}
): string {
  const attempt = Number(result.repairAttempt) || 0;
  const cap = Number(result.repairAttemptCap) || 0;
  let budget = "";
  if (attempt > 0 && cap > 0) {
    budget =
      ` This is automatic repair attempt ${attempt} of ${cap}.` +
      (attempt >= cap ?
        " It is the last one: if it fails, report the failure to the user instead of redeploying again."
      : "");
  }
  return (
    `Deploy of ${payload.targetRepo}${payload.branch ? ` (branch ${payload.branch})` : ""} to environment "${payload.environment}" started.` +
    ` It deploys ${payload.branch || "that branch"} as it exists on GitHub, so confirm any repair was pushed.` +
    ` Poll the radius_deploy_status tool until it reports success or failed.${budget}`
  );
}

export const DEPLOY_LOG_TAIL_DEFAULT = 40;
export const DEPLOY_LOG_TAIL_MAX = 200;

// Compact the status payload: the raw response carries the full resource graph and
// up to 4000 log lines, which would swamp the agent's context. The error and log
// tail are workflow output, so they are returned as one fenced diagnostic block
// rather than raw strings, matching the repair handoff.
export function summarizeDeployStatus(
  d: DeployStatusInput = {},
  logLines?: number
): DeployStatusSummary {
  const status =
    d.status === "pending" || d.status === "in_progress" ? "in_progress"
    : d.status === "complete" ? "success"
    : d.status === "failed" ? "failed"
    : null;
  if (!status)
    throw new Error(
      "The deployment service returned a missing or invalid status."
    );
  const requested = Number(logLines) || DEPLOY_LOG_TAIL_DEFAULT;
  const cap = Math.min(Math.max(requested, 1), DEPLOY_LOG_TAIL_MAX);
  const logs = Array.isArray(d.logs) ? d.logs : [];
  const sections: string[] = [];
  if (d.error) sections.push(`error: ${d.error}`);
  const tail = logs.slice(-cap);
  if (tail.length)
    sections.push(`last ${tail.length} log line(s):\n${tail.join("\n")}`);
  const diagnostic = fenceDeployDiagnostic(sections.join("\n\n"));
  return {
    status,
    errorKind: d.errorKind || null,
    deployRunUrl: d.deployRunUrl || null,
    startedAt: d.startedAt || null,
    finishedAt: d.finishedAt || null,
    ...(diagnostic ?
      { diagnosticNote: DEPLOY_DIAGNOSTIC_NOTE, diagnostic }
    : {})
  };
}
