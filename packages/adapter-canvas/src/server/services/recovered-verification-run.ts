import { findExactVerificationRun } from "../../verification-run-identity.js";

// Recovering the run identity a dispatch never got to record.
//
// The verify workflow dispatch is journaled before the request leaves and
// confirmed once GitHub accepts it, so a restart in between reloads a record
// that knows a run exists and cannot say which one. Monitoring that record polls
// a null run id until the tracking window closes, which the panel shows as a
// setup that simply never finishes.
//
// The identity is recovered here from the operation-specific marker and nothing
// weaker. A run list narrowed by baseline id and dispatch time can produce a
// plausible candidate, and adopting a plausible candidate is how a customer ends
// up reading another environment's verification result as their own. So a record
// whose workflow never carried a marker, or whose marker matches no run or more
// than one, is handed to the customer immediately rather than left pending.

export interface VerificationRunListResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

export interface RecoveredVerificationIdentity {
  repo: string;
  workflow: string;
  ref: string;
  environment: string;
  operationMarker: string;
  dispatchedAt: number;
  baselineRunId: number | null;
}

export type RecoveredVerificationRunOutcome =
  | { state: "monitor" }
  | { state: "discovered"; runId: string; runUrl: string }
  | { state: "hand_off"; guidance: string };

/** The Actions page a hand-off points the customer at. */
export function verificationActionsUrl(repo: string, workflow: string): string {
  return (
    `https://github.com/${repo}/actions/workflows/` +
    encodeURIComponent(workflow)
  );
}

export function readRecoveredVerificationIdentity(
  operation: {
    repo?: unknown;
    environment?: unknown;
    verification?: Record<string, unknown> | null;
  },
  defaultWorkflow: string
): RecoveredVerificationIdentity {
  const verification = operation.verification || {};
  const baseline = Number(verification.baselineRunId);
  return {
    repo: String(operation.repo || ""),
    workflow: String(verification.workflow || defaultWorkflow),
    ref: String(verification.ref || ""),
    environment: String(
      verification.environment || operation.environment || ""
    ),
    operationMarker:
      typeof verification.operationMarker === "string" ?
        verification.operationMarker
      : "",
    dispatchedAt: Number(verification.dispatchedAt),
    baselineRunId: Number.isFinite(baseline) ? baseline : null
  };
}

/**
 * Decide what a restarted verification should do about its missing run id.
 *
 * `monitor` means the record already names a run. `discovered` carries the one
 * run this operation's marker proves is its own. `hand_off` carries the sentence
 * the customer reads, and is returned for every case where the identity cannot
 * be established — including the legacy workflow that cannot expose a marker at
 * all, which would otherwise wait for an identity it can never obtain.
 */
export async function recoverVerificationRun(input: {
  runId: unknown;
  identity: RecoveredVerificationIdentity;
  listRuns(): Promise<VerificationRunListResult>;
}): Promise<RecoveredVerificationRunOutcome> {
  if (input.runId != null && String(input.runId)) return { state: "monitor" };
  const { identity } = input;
  const actionsUrl = verificationActionsUrl(identity.repo, identity.workflow);
  const handOff = (reason: string): RecoveredVerificationRunOutcome => ({
    state: "hand_off",
    guidance:
      `Radius restarted while credential verification was dispatched, and ${reason} ` +
      `Review the run in ${actionsUrl}; Radius will not adopt one or dispatch another.`
  });
  if (!identity.operationMarker) {
    return handOff(
      "the installed workflow does not expose an operation-specific run marker."
    );
  }
  let listed: VerificationRunListResult;
  try {
    listed = await input.listRuns();
  } catch (error) {
    return handOff(
      `the workflow runs could not be read: ${
        error instanceof Error ? error.message : String(error)
      }.`
    );
  }
  if (listed.code !== 0 && listed.code !== "0") {
    return handOff(
      `the workflow runs could not be read: ${
        (listed.stderr || listed.stdout || "").trim() ||
        "the GitHub CLI request failed"
      }.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout);
  } catch {
    return handOff("GitHub returned an unreadable workflow run list.");
  }
  const exact = findExactVerificationRun(parsed, {
    baselineRunId: identity.baselineRunId,
    dispatchedAt: identity.dispatchedAt,
    ref: identity.ref,
    environment: identity.environment,
    operationMarker: identity.operationMarker
  });
  if (exact.state === "applied") {
    return {
      state: "discovered",
      runId: exact.runId,
      runUrl: `https://github.com/${identity.repo}/actions/runs/${exact.runId}`
    };
  }
  return handOff(
    exact.state === "ambiguous" ?
      "more than one run carries this operation's exact marker."
    : "no run carries this operation's exact marker."
  );
}
