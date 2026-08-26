// Waiting for Copilot to author `.radius/app.bicep`.
//
// A graph request that finds no application model does not fail: the page keeps
// asking while Copilot writes one. That wait needs a bound, because nothing
// reports back when the modeling skill finishes or refuses — the page only ever
// learns by asking again — so an unbounded wait would spin forever on a run that
// was never going to produce anything.
//
// The bound is not a flat wall clock. Modeling a real multi-service repository
// routinely takes longer than any budget short enough to be useful against a run
// that never started, and cutting a live run off to report "unable to model this
// repository" is both untrue and unrecoverable without a reload. So the budget
// is spent only while nothing is happening.
//
// The start signal is on disk: a modeling run creates
// `.radius/.staging-<runId>/` before it writes anything (see `app-staging.ts` in
// `@radius-project/core`). A later mtime is useful evidence too, but the absence
// of one is not proof of abandonment because source analysis and recipe
// publishing may run for minutes without touching staging files.

// How long the wait tolerates seeing no modeling run at all.
export const GRAPH_APP_BICEP_IDLE_TIMEOUT_MS = 300_000;

// Hard ceiling on the whole wait, spent whether or not a run looks alive. A run
// that keeps producing activity without finishing would otherwise renew the
// idle budget indefinitely, which is the unbounded wait this contract exists to
// prevent.
export const GRAPH_APP_BICEP_MAX_WAIT_MS = 1_800_000;

// Both budgets above are multi-minute by construction, so the count never needs
// singular agreement.
function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} minutes`;
}

// No run activity can be observed for the selected target. This deliberately
// avoids claiming that modeling never began: a non-workspace branch cannot be
// monitored through the local staging directory.
export const GRAPH_APP_BICEP_TIMEOUT_MESSAGE = `.radius/app.bicep has not appeared after ${minutes(GRAPH_APP_BICEP_IDLE_TIMEOUT_MS)}. Check the Copilot conversation for the modeling status, then reload to try again.`;

export const GRAPH_APP_BICEP_MAX_WAIT_MESSAGE = `Modeling has been running for over ${minutes(GRAPH_APP_BICEP_MAX_WAIT_MS)} without producing .radius/app.bicep. Check the Copilot conversation for the reason, then reload to try again.`;

export type AppBicepWaitReason = "not-observed" | "ceiling";

export type AppBicepWaitOutcome =
  | { status: "waiting" }
  | { status: "expired"; reason: AppBicepWaitReason; message: string };

export interface AppBicepWaitInput {
  nowMs: number;
  // When this wait began, which is the first graph request that found no model.
  waitStartedAtMs: number;
  // When a modeling run was observed on disk, or null when the selected target
  // cannot be observed. Once seen, mtime is not used as an idle clock: a valid
  // modeling phase may spend minutes reading source or publishing a recipe
  // without touching staging files.
  lastActivityAtMs: number | null;
}

// Whether the page should keep waiting for the model, and what to say when it
// should not. Pure so the same decision serves the graph workflow that answers
// the request and the progress record that narrates it.
export function evaluateAppBicepWait(
  input: AppBicepWaitInput
): AppBicepWaitOutcome {
  const { nowMs, waitStartedAtMs, lastActivityAtMs } = input;
  if (nowMs - waitStartedAtMs >= GRAPH_APP_BICEP_MAX_WAIT_MS) {
    return {
      status: "expired",
      reason: "ceiling",
      message: GRAPH_APP_BICEP_MAX_WAIT_MESSAGE
    };
  }
  if (
    lastActivityAtMs !== null ||
    nowMs - waitStartedAtMs < GRAPH_APP_BICEP_IDLE_TIMEOUT_MS
  ) {
    return { status: "waiting" };
  }
  return {
    status: "expired",
    reason: "not-observed",
    message: GRAPH_APP_BICEP_TIMEOUT_MESSAGE
  };
}

export const GRAPH_MODELING_FAILURE_MESSAGE =
  "Radius could not build the application graph from .radius/app.bicep. Ask Copilot to review the application model, then try again.";
