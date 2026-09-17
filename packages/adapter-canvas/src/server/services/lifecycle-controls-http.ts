import {
  lifecycleError,
  type LifecycleError,
  type OperationRecord,
  type ReadonlyData
} from "@radius-project/core/lifecycle";
import { readObject } from "@radius-project/adapter-shared";
import type { LifecycleBinding } from "../../runtime/create-lifecycle-binding.js";
import { lifecycleEnvironmentView } from "./lifecycle-environment-view.js";

type ControlBinding = Pick<
  LifecycleBinding,
  "execute" | "resolveWorkspaceSource"
> & {
  registry: Pick<LifecycleBinding["registry"], "knownOperations">;
  routing: Pick<LifecycleBinding["routing"], "address">;
};
export function lifecycleControlledOperation(
  binding: ControlBinding,
  operationId: string
) {
  return binding.registry
    .knownOperations()
    .find(
      (record) =>
        record.operationId === operationId &&
        ["definition.author", "deployment.start", "operation.repair"].includes(
          record.operation
        )
    );
}
const targetOf = (record: ReadonlyData<OperationRecord>) => ({
  repo: record.target.repo,
  ...(record.target.environment ?
    { environment: record.target.environment }
  : {}),
  ...(record.target.application ?
    { application: record.target.application }
  : {})
});
export function lifecycleControlView(operation: ReadonlyData<OperationRecord>) {
  const base = lifecycleEnvironmentView(operation);
  const subject =
    operation.operation === "deployment.start" ? "Deployment"
    : operation.operation === "definition.author" ? "Definition authoring"
    : "Definition repair";
  const summary =
    (
      operation.cancellationRequestedAt &&
      !["succeeded", "failed", "cancelled"].includes(operation.state)
    ) ?
      "Cancellation requested; termination, state persistence and cleanup remain independently observed. No rollback was requested."
    : operation.state === "succeeded" ?
      operation.operation === "deployment.start" ?
        "Deployment completion is supported by the recorded execution evidence."
      : "The staged definition was validated and promoted. Publication and deployment require separate authorization."
    : operation.state === "action_required" ?
      "An authenticated response is required for the outstanding action."
    : `${subject} is ${operation.state}. Review the recorded evidence before taking action.`;
  const path = `/api/operations/${encodeURIComponent(operation.operationId)}`;
  const actions = [
    ...(operation.state === "failed" ?
      [
        {
          id: `repair-${operation.operationId}`,
          kind: "lifecycle.repair",
          label: "Request bounded repair",
          description:
            "Repair only the approved definition; do not publish or redeploy.",
          path: `${path}/retry/repair`
        }
      ]
    : []),
    ...((
      !["succeeded", "failed", "cancelled"].includes(operation.state) &&
      !operation.cancellationRequestedAt
    ) ?
      [
        {
          id: `cancel-${operation.operationId}`,
          kind: "lifecycle.cancel",
          label: "Request cancellation",
          description:
            "Request termination of this execution only. This does not roll back infrastructure.",
          path: `${path}/cancel-workflow`
        }
      ]
    : [])
  ].map((action) => ({
    ...action,
    pending: false,
    tone: "secondary",
    placement: "row",
    requiresConfirmation: false
  }));
  return {
    ...base,
    kind: "lifecycle_operation",
    summary,
    headline: { code: "lifecycle-control", title: subject, message: summary },
    terminal: { reason: "lifecycle-control", userMessage: summary },
    actions,
    stages: operation.attempts.flatMap((attempt) =>
      attempt.phases.map((phase) => ({
        key: `${attempt.attemptId}-${phase.phase}`,
        label: phase.reason,
        state: phase.status
      }))
    )
  };
}
function failure(error: LifecycleError) {
  return {
    status:
      error.code === "FORBIDDEN" ? 403
      : error.code === "CAPABILITY_UNAVAILABLE" ? 503
      : error.code === "INVALID_REQUEST" ? 400
      : 409,
    body: { error: error.message, code: error.code }
  };
}
export function createLifecycleControlsHttp(binding: ControlBinding) {
  return {
    async status(operationId: string) {
      const record = lifecycleControlledOperation(binding, operationId);
      if (!record)
        return { status: 404, body: { error: "Unknown operation." } };
      binding.routing.address(operationId);
      const result = await binding.execute({
        operation: "operation.get",
        target: targetOf(record),
        input: { operationId }
      });
      if ("error" in result) return failure(result.error);
      if (result.operation !== "operation.get")
        throw new Error("Unexpected operation observation.");
      return {
        status: 200,
        body: { operation: lifecycleControlView(result.result) }
      };
    },
    async control(operationId: string, command: string, input: unknown) {
      const record = lifecycleControlledOperation(binding, operationId);
      if (!record)
        return { status: 404, body: { error: "Unknown operation." } };
      binding.routing.address(operationId, true);
      if (!readObject(input)) return failure(lifecycleError("INVALID_REQUEST"));
      const target = targetOf(record);
      let operation:
        "operation.cancel" | "operation.repair" | "operation.respond";
      let payload: unknown;
      if (command === "cancel-workflow" && Object.keys(input).length === 0) {
        operation = "operation.cancel";
        payload = { operationId };
      } else if (
        command === "retry/repair" &&
        Object.keys(input).every((key) =>
          ["source", "repairPolicy", "approvalRef"].includes(key)
        )
      ) {
        const observed = await binding.execute({
          operation: "operation.get",
          target,
          input: { operationId }
        });
        if ("error" in observed) return failure(observed.error);
        if (!record.target.definition)
          return failure(lifecycleError("PRECONDITION_FAILED"));
        const source =
          input.source === undefined ?
            await binding.resolveWorkspaceSource({
              repo: target.repo,
              definition: record.target.definition
            })
          : undefined;
        if (source && source.status !== "ok")
          return failure(
            "error" in source ?
              source.error
            : lifecycleError("PRECONDITION_FAILED")
          );
        operation = "operation.repair";
        payload = {
          ...input,
          operationId,
          source: source?.status === "ok" ? source.value : input.source
        };
      } else if (
        command === "continue" &&
        Object.keys(input).every((key) =>
          ["actionId", "response", "choice", "approvalRef"].includes(key)
        )
      ) {
        if (
          input.response !== undefined &&
          (input.choice !== undefined || input.approvalRef !== undefined)
        )
          return failure(lifecycleError("INVALID_REQUEST"));
        operation = "operation.respond";
        payload = {
          operationId,
          actionId: input.actionId,
          response: input.response ?? {
            kind: "user.decision",
            choice: input.choice,
            ...(input.approvalRef !== undefined ?
              { approvalRef: input.approvalRef }
            : {})
          }
        };
      } else {
        return failure(
          lifecycleError("PRECONDITION_FAILED", {
            diagnostics: [
              {
                message:
                  "This control has no equivalent for the selected canonical operation. No stop, exit or rollback was inferred.",
                truncated: false
              }
            ]
          })
        );
      }
      const result = await binding.execute({
        operation,
        target,
        input: payload
      });
      if ("error" in result) return failure(result.error);
      const acceptedId =
        result.operation === "operation.repair" ?
          result.result.operationId
        : operationId;
      return {
        status: 202,
        body: {
          operationId: acceptedId,
          statusUrl: `/api/operations/${encodeURIComponent(acceptedId)}`,
          ...(result.operation === "operation.cancel" ?
            {
              cancellation: result.result.cancellation,
              operation: lifecycleControlView(result.result.operation)
            }
          : result.operation === "operation.respond" ?
            { operation: lifecycleControlView(result.result) }
          : {})
        }
      };
    }
  };
}
