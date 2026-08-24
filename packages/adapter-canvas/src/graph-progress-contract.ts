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
// The liveness signal is on disk: a modeling run creates
// `.radius/.staging-<runId>/` before it writes anything and updates that
// directory or its staged artifacts as it works (see `app-staging.ts` in
// `@radius-project/core`). The newest modification time separates "still
// working" from an abandoned staging directory left by a cancelled run.

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

// No staging directory was ever seen, so as far as the product can tell modeling
// never began. Named for the message it replaces so the failure the page shows
// keeps one home.
export const GRAPH_APP_BICEP_TIMEOUT_MESSAGE = `No modeling run has started, and .radius/app.bicep has not appeared for ${minutes(GRAPH_APP_BICEP_IDLE_TIMEOUT_MS)}. Copilot may be unable to model this repository — check the Copilot conversation for the reason, then reload to try again.`;

// A run was seen and then stopped without publishing a model. This is the
// cancelled or failed turn, and it is worth saying differently: the answer is in
// the conversation, not in whether the repository can be modeled at all.
export const GRAPH_APP_BICEP_STALLED_MESSAGE = `Modeling started but stopped without producing .radius/app.bicep, and nothing has happened for ${minutes(GRAPH_APP_BICEP_IDLE_TIMEOUT_MS)}. Check the Copilot conversation for the reason, then reload to try again.`;

export const GRAPH_APP_BICEP_MAX_WAIT_MESSAGE = `Modeling has been running for over ${minutes(GRAPH_APP_BICEP_MAX_WAIT_MS)} without producing .radius/app.bicep. Check the Copilot conversation for the reason, then reload to try again.`;

export type AppBicepWaitReason = "never-started" | "stalled" | "ceiling";

export type AppBicepWaitOutcome =
  | { status: "waiting" }
  | { status: "expired"; reason: AppBicepWaitReason; message: string };

export interface AppBicepWaitInput {
  nowMs: number;
  // When this wait began, which is the first graph request that found no model.
  waitStartedAtMs: number;
  // When a modeling run was last observed on disk, or null when one never has
  // been. Null is not "no activity yet" shorthand for the start of the wait — it
  // selects a different failure, so it stays distinct from a real observation.
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
  const idleSince = lastActivityAtMs ?? waitStartedAtMs;
  if (nowMs - idleSince < GRAPH_APP_BICEP_IDLE_TIMEOUT_MS) {
    return { status: "waiting" };
  }
  return lastActivityAtMs === null ?
      {
        status: "expired",
        reason: "never-started",
        message: GRAPH_APP_BICEP_TIMEOUT_MESSAGE
      }
    : {
        status: "expired",
        reason: "stalled",
        message: GRAPH_APP_BICEP_STALLED_MESSAGE
      };
}
