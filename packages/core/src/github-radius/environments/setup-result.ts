import type { EnvironmentSetupResult } from "./execution-ports.js";

/** Preserve the legacy payload while exposing a transport-independent verdict. */
export function environmentSetupResult(
  status: number,
  body: Record<string, unknown>
): EnvironmentSetupResult {
  const outcome: EnvironmentSetupResult["outcome"] =
    body.reconciling === true ? "reconciling"
    : body.cancelled === true ? "cancelled"
    : body.inputRequired === true ? "input_required"
    : body.actionRequired === true || body.verifySkipped === true ?
      "action_required"
    : body.success === true && status >= 200 && status < 300 ? "completed"
    : "failed";
  return { outcome, status, body };
}
