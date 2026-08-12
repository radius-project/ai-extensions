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

export interface DeployServerEntry {
  baseUrl?: string;
  state: CanvasState;
}

export interface DeployPayload extends CanvasDeployParams {
  environment: string;
  provider: string;
  targetRepo: string;
  branch: string;
  appFile: string;
  agentInitiated: true;
  // Asks /api/deploy to keep this attempt id rather than minting a new one, so
  // the id the agent was handed still resolves on the next radius_deploy_status.
  attemptId?: string;
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
  status: string;
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

// Pick the canvas instance a deploy tool should act on. A repair loop passes the
// attempt id it was handed, which fails closed: a canvas panel is reused, so
// binding to the panel alone would let a stale repair redeploy whatever the user
// started next. Only unbound (manual) calls fall back to the most recently
// started deploy, then to any open instance.
export function selectDeployEntry(
  servers: ReadonlyMap<unknown, DeployServerEntry>,
  attemptId?: string
): DeployServerEntry | null {
  if (attemptId) {
    for (const entry of servers.values()) {
      if (entry?.baseUrl && entry.state?.deployAttempt?.id === attemptId)
        return entry;
    }
    return null;
  }
  let found = null;
  for (const entry of servers.values()) {
    if (!entry?.baseUrl) continue;
    const state = entry.state || {};
    if (!state.deployParams && !state.deployStatus) continue;
    if (
      !found ||
      (state.deployStartedAt || 0) > (found.state?.deployStartedAt || 0)
    )
      found = entry;
  }
  if (found) return found;
  for (const entry of servers.values()) if (entry?.baseUrl) return entry;
  return null;
}

const ATTEMPT_FIELDS: ReadonlyArray<
  readonly [keyof DeployToolArgs, keyof CanvasDeployAttempt]
> = [
  ["repo", "targetRepo"],
  ["environment", "environment"],
  ["branch", "branch"],
  ["provider", "provider"],
  ["appFile", "appFile"]
];

// A repair-loop call names an attempt and must not retarget it: the snapshot
// taken when that deploy started is the source of truth for what gets redeployed.
export function validateDeployAttempt(
  args: DeployToolArgs = {},
  state: CanvasState = {}
): string | null {
  if (!args.attemptId) return null;
  const snapshot = state.deployAttempt;
  if (!snapshot || snapshot.id !== args.attemptId) {
    return `Deploy attempt "${args.attemptId}" is not the current attempt for this canvas session, so nothing was deployed. A newer deploy has replaced it; ask the user which deploy to repair.`;
  }
  const mismatched = ATTEMPT_FIELDS.filter(
    ([arg, snap]) => args[arg] && args[arg] !== snapshot[snap]
  ).map(
    ([arg, snap]) =>
      `${arg} (asked for "${args[arg]}", attempt used "${snapshot[snap]}")`
  );
  if (mismatched.length) {
    return `Deploy attempt "${args.attemptId}" cannot be retargeted: ${mismatched.join("; ")}. Redeploy the same target, or start a new deploy from the canvas.`;
  }
  return null;
}

// Build the /api/deploy body. A repair-loop call replays the attempt snapshot; an
// unbound call falls back to the session's last deploy parameters.
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
    // validateDeployAttempt has already proved this is the current attempt, so
    // replaying it keeps one repair loop under one id instead of renaming the
    // attempt out from under the caller mid-loop.
    ...(args.attemptId ? { attemptId: args.attemptId } : {})
  };
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
    status: d.status || "pending",
    errorKind: d.errorKind || null,
    deployRunUrl: d.deployRunUrl || null,
    startedAt: d.startedAt || null,
    finishedAt: d.finishedAt || null,
    ...(diagnostic ?
      { diagnosticNote: DEPLOY_DIAGNOSTIC_NOTE, diagnostic }
    : {})
  };
}
