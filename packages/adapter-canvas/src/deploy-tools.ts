// Pure helpers behind the radius_deploy / radius_deploy_status tools, kept out of
// extension.ts so they can be tested without the SDK or a live canvas server.

import {
  fenceDeployDiagnostic,
  DEPLOY_DIAGNOSTIC_NOTE
} from "./deploy-diagnostics.js";
import type {
  CanvasDeployAttempt,
  CanvasDeployParams,
  CanvasState
} from "./shared.js";

export interface DeployToolArgs {
  attemptId?: string;
  repo?: string;
  environment?: string;
  branch?: string;
  provider?: string;
  appFile?: string;
}

export interface DeployPayload extends CanvasDeployParams {
  environment: string;
  provider: string;
  targetRepo: string;
  branch: string;
  appFile: string;
  agentInitiated: true;
  // The shared controller validates repair identity against the owned attempt.
  attemptId: string;
}

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
  status: "pending" | "in_progress" | "success" | "failed";
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

// Build input from an already resolved owned context. Repair replays its
// immutable attempt; manual work may override the selected prior target.
export function buildDeployPayload(
  args: DeployToolArgs = {},
  state: CanvasState = {}
): DeployPayload {
  const snapshot: Partial<CanvasDeployAttempt> =
    (args.attemptId && state.deployAttempt) || {};
  const last = state.deployParams || {};
  return {
    environment:
      args.environment || snapshot.environment || last.environment || "",
    provider: args.provider || snapshot.provider || last.provider || "azure",
    targetRepo:
      args.repo ||
      snapshot.targetRepo ||
      last.targetRepo ||
      state.contextRepo ||
      "",
    branch: args.branch || snapshot.branch || last.branch || "",
    appFile:
      args.appFile || snapshot.appFile || last.appFile || ".radius/app.bicep",
    agentInitiated: true,
    // Forward the attempt so the controller can re-check it atomically. An
    // unbound call carries no attempt: it is an ordinary deploy that must stay
    // eligible to hand its failure off.
    attemptId: args.attemptId || ""
  };
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
    ` Poll the radius_deploy_status tool while it reports pending or in_progress; stop on success or failed. If status is unavailable, report that uncertainty instead of treating it as a confirmed workflow failure.${budget}`
  );
}

// Reject a payload that would deploy something unintended rather than guessing.
export function validateDeployPayload(payload: {
  targetRepo?: unknown;
  environment?: unknown;
}): string | null {
  if (!payload.targetRepo)
    return "No target repository is known for this deploy. Pass `repo` (owner/repo).";
  if (!payload.environment)
    return "No GitHub environment is known for this deploy. Pass `environment`.";
  return null;
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
  const status = d.status === "complete" ? "success" : d.status;
  if (
    status !== "pending" &&
    status !== "in_progress" &&
    status !== "success" &&
    status !== "failed"
  )
    throw new Error(
      "Deployment status is unavailable; no confirmed workflow outcome can be reported."
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
