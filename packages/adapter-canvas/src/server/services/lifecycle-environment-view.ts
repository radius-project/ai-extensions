import type {
  OperationRecord,
  ReadonlyData
} from "@radius-project/core/lifecycle";

export function lifecycleEnvironmentView(
  operation: ReadonlyData<OperationRecord>
) {
  const credential = operation.operation === "credentials.configure";
  const uncertain =
    !["failed", "cancelled", "succeeded", "action_required"].includes(
      operation.state
    ) && operation.observation.completeness !== "complete";
  const partial =
    operation.state === "failed" &&
    operation.observation.completeness === "partial";
  const state =
    uncertain ? "unconfirmed"
    : partial ? "failed_partial"
    : operation.state;
  const subject =
    credential ? "Credential configuration" : "Environment configuration";
  const summary =
    uncertain ?
      `${subject} is unconfirmed. Completed changes may remain; do not repeat the operation.`
    : operation.state === "succeeded" ?
      `${subject} completed and was verified. No application deployment was started.`
    : operation.state === "failed" ?
      `${subject} did not complete. Review the recorded phases before taking further action.`
    : operation.state === "action_required" ?
      "An explicit user action is required. Setup does not authorize application deployment."
    : operation.state === "cancelled" ?
      `${subject} was cancelled. No successful completion is claimed.`
    : `${subject} is in progress. No application deployment is authorized.`;
  const actions = operation.actions
    .filter(
      (action) => action.responder === "user" && action.status === "outstanding"
    )
    .map((action) => ({
      id: action.actionId,
      kind:
        credential && action.kind === "user.authenticate" ?
          "lifecycle.authenticate"
        : "lifecycle.configure",
      label:
        credential && action.kind === "user.authenticate" ?
          "Authenticate and verify"
        : action.kind === "user.authenticate" ?
          "Recheck credentials and continue"
        : "Continue configuration",
      description: action.message,
      path: `/api/operations/${encodeURIComponent(operation.operationId)}/continue`,
      pending: false,
      tone: "primary",
      placement: "row",
      requiresConfirmation: false
    }));
  return {
    operationId: operation.operationId,
    kind: credential ? "lifecycle_credentials" : "lifecycle_environment",
    repo: operation.target.repo,
    environment: operation.target.environment ?? "",
    provider:
      operation.result?.kind === "configuration" ?
        (operation.result.provider ?? "")
      : "",
    state,
    terminalState:
      uncertain ? "action_required"
      : (
        ["succeeded", "failed", "cancelled", "action_required"].includes(
          operation.state
        )
      ) ?
        state
      : null,
    summary,
    headline: {
      code: "lifecycle-configuration",
      title: subject,
      message: summary
    },
    observation: operation.observation,
    stages:
      operation.result?.kind === "configuration" ?
        operation.result.phases.map((phase) => ({
          key: phase.phase,
          label: phase.reason,
          state: phase.status
        }))
      : [],
    steps: [],
    actions,
    ...(operation.error ?
      {
        failure: {
          code: operation.error.code,
          message: operation.error.message
        }
      }
    : {}),
    terminal: {
      reason:
        uncertain ? "configuration-unconfirmed" : "lifecycle-configuration",
      userMessage: summary
    }
  };
}
