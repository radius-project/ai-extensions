// Lifecycle outcomes shared by the deploy and delete flows.
//
// A deploy and a delete are the same shape of operation: a dispatched workflow
// run that ends in exactly one terminal outcome, which the canvas has to report
// per resource and per operation. Both sides previously derived that outcome
// inline from a raw GitHub conclusion string, which is how "cancelled" and
// "timed out" ended up indistinguishable from a plain failure.
//
// Pure: no shell/HTTP/DOM.

export type LifecycleOperation = "deployment" | "deletion";

export type LifecycleOutcome =
  "succeeded" | "failed" | "cancelled" | "timed_out" | "unknown";

/**
 * classifyLifecycleConclusion - map a GitHub Actions run conclusion onto the
 * lifecycle outcome vocabulary.
 *
 * An absent conclusion is `unknown`, never `succeeded`: a run whose verdict was
 * never observed must not be reported as a success. Every other non-success
 * conclusion GitHub can emit (`neutral`, `action_required`, `skipped`, `stale`,
 * `startup_failure`) means the operation did not complete, so it maps to
 * `failed` rather than to a silently ignored state.
 */
export function classifyLifecycleConclusion(
  conclusion?: string | null
): LifecycleOutcome {
  const value = String(conclusion ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "unknown";
  if (value === "success" || value === "succeeded") return "succeeded";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  if (value === "timed_out" || value === "timed-out" || value === "timeout") {
    return "timed_out";
  }
  return "failed";
}

const OPERATION_LABELS: Readonly<Record<LifecycleOperation, string>> = {
  deployment: "Deployment",
  deletion: "Deletion"
};

const OUTCOME_SUFFIXES: Readonly<Record<LifecycleOutcome, string>> = {
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  timed_out: "timed out",
  unknown: "outcome unknown"
};

/**
 * lifecycleOutcomeMessage - the exact per-node / per-operation message for an
 * outcome, such as "Deployment cancelled" or "Deployment timed out".
 *
 * These strings are a product contract (exception scenarios 5.1 and Part 8), so
 * they are built here once instead of being spelled out at each call site.
 */
export function lifecycleOutcomeMessage(
  operation: LifecycleOperation,
  outcome: LifecycleOutcome
): string {
  return `${OPERATION_LABELS[operation]} ${OUTCOME_SUFFIXES[outcome]}`;
}

/**
 * unfinishedNodeMessage - the message a node that never reached a terminal
 * status receives when the run settles, or `null` when the run succeeded.
 *
 * A successful run leaves no unfinished node to explain, and an exact
 * per-resource Radius error, when the producer published one, always wins over
 * this fallback — see the callers, which never overwrite an existing message.
 */
export function unfinishedNodeMessage(
  operation: LifecycleOperation,
  outcome: LifecycleOutcome
): string | null {
  if (outcome === "succeeded") return null;
  return lifecycleOutcomeMessage(operation, outcome);
}

/**
 * stateSaveFailureWarning - the operator-facing warning for exception 5.4: the
 * operation itself ran, but `rad shutdown` could not persist the control-plane
 * state after its bounded retries.
 *
 * The consequence (possible orphaned cloud resources) and the recovery path
 * (redeploy to converge, then delete and redeploy if it cannot be reconciled)
 * are both named, because a bare "state not saved" tells the user nothing they
 * can act on.
 */
export function stateSaveFailureWarning(
  operation: LifecycleOperation,
  detail?: string | null
): string {
  const noun = operation === "deletion" ? "deletion" : "deployment";
  const trimmedDetail = String(detail ?? "").trim();
  return (
    `The ${noun} ran, but Radius could not save its state. ` +
    "Orphaned cloud resources may exist. " +
    "To recover, redeploy the application so Radius reconciles the state; " +
    "if it still cannot be reconciled, delete the deployment and redeploy it." +
    (trimmedDetail ? `\n\n${trimmedDetail}` : "")
  );
}
