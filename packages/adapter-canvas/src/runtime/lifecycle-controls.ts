import {
  createRepair,
  createCancellation,
  registerLifecycleOperation,
  LIFECYCLE_API_VERSION,
  lifecycleError,
  portFailure,
  portUnavailable,
  type LifecycleErrorResponse,
  type LifecycleReadCapability,
  type PortResult,
  type DefinitionAuthoringDependencies,
  type IdentityPort,
  type WorkflowExecutionPort,
  type createDefinitionAuthoring
} from "@radius-project/core/lifecycle";
import type { createLifecycleRouting } from "./lifecycle-routing.js";
import type { LifecycleDefinitionDependencies } from "./lifecycle-definitions.js";

function failure(
  result: PortResult<unknown>,
  requestId: string
): LifecycleErrorResponse {
  return {
    apiVersion: LIFECYCLE_API_VERSION,
    requestId,
    error:
      "error" in result ? result.error : lifecycleError("PRECONDITION_FAILED")
  };
}
export function createLifecycleControlRegistrations(
  deps: Pick<DefinitionAuthoringDependencies, "registry" | "clock"> & {
    readonly identity: Pick<IdentityPort, "authorize">;
    readonly authoring?: Pick<
      ReturnType<typeof createDefinitionAuthoring>,
      "repair" | "cancel"
    >;
    readonly workflow?: WorkflowExecutionPort;
    readonly repairProvider?: NonNullable<
      LifecycleDefinitionDependencies["authoring"]
    >["repairProvider"];
    readonly routing: Pick<
      ReturnType<typeof createLifecycleRouting>,
      "selection"
    >;
  }
) {
  const { authoring, repairProvider } = deps;
  const repair = createRepair({
    ...deps,
    ...(authoring && repairProvider ?
      {
        executor: {
          start: async (scope, caller, plan, control) => {
            const provider = await repairProvider(scope, control);
            return provider.status === "ok" ?
                authoring.repair(scope, caller, plan, control, provider.value)
              : provider;
          }
        }
      }
    : {})
  });
  const cancellation = createCancellation({
    ...deps,
    ...(deps.authoring ? { local: deps.authoring } : {})
  });
  const capabilities: LifecycleReadCapability[] = [
    ...(deps.authoring && repairProvider ?
      [
        {
          operation: "operation.repair" as const,
          contexts: ["workspace" as const],
          providers: ["azure" as const],
          requiresAgent: true,
          limitations: [
            "Explicit source-bound approval and authenticated agent assignment are required; repair never publishes or deploys.",
            "At most five linked repair cycles, shared across the failed operation family."
          ]
        }
      ]
    : []),
    ...(deps.authoring || deps.workflow ?
      [
        {
          operation: "operation.cancel" as const,
          contexts: ["workspace" as const, "git" as const],
          providers: ["azure" as const, "aws" as const],
          requiresAgent: false,
          limitations: [
            "Cancellation requests do not confirm termination or roll back resources; an exact known cancellable execution is required."
          ]
        }
      ]
    : [])
  ];
  return {
    afterResponse: repair.afterResponse,
    close: repair.close,
    capabilities,
    registrations: [
      ...(authoring && repairProvider ?
        [
          registerLifecycleOperation(
            "operation.repair",
            { repair },
            ["repair"],
            async (request, context, ports) => {
              if (deps.routing.selection("definition").writer !== "lifecycle")
                return failure(
                  portUnavailable("CAPABILITY_UNAVAILABLE", {
                    quality: "unknown",
                    completeness: "unavailable",
                    evidence: "session"
                  }),
                  request.requestId
                );
              const result = await ports.repair.repair(
                context.scope,
                context.caller,
                request.input,
                context.control
              );
              if (result.status !== "ok")
                return failure(result, request.requestId);
              const operation = result.value;
              if (operation.source?.kind !== "workspace")
                return failure(
                  portFailure("EVIDENCE_MISMATCH"),
                  request.requestId
                );
              const common = {
                operationId: operation.operationId,
                target: request.target,
                source: operation.source,
                observation: operation.observation
              };
              const action = operation.actions.find(
                (item) => item.status === "outstanding"
              );
              if (operation.state === "action_required" && action)
                return {
                  apiVersion: LIFECYCLE_API_VERSION,
                  requestId: request.requestId,
                  operation: "operation.repair",
                  result: {
                    ...common,
                    state: "action_required",
                    requiredAction: action
                  }
                };
              if (operation.state !== "queued" && operation.state !== "running")
                return failure(
                  portFailure("EVIDENCE_MISMATCH"),
                  request.requestId
                );
              return {
                apiVersion: LIFECYCLE_API_VERSION,
                requestId: request.requestId,
                operation: "operation.repair",
                result: { ...common, state: operation.state }
              };
            }
          )
        ]
      : []),
      ...(deps.authoring || deps.workflow ?
        [
          registerLifecycleOperation(
            "operation.cancel",
            { cancellation },
            ["cancellation"],
            async (request, context, ports) => {
              const result = await ports.cancellation.cancel(
                context.scope,
                context.caller,
                request.input.operationId,
                context.control
              );
              return result.status === "ok" ?
                  {
                    apiVersion: LIFECYCLE_API_VERSION,
                    requestId: request.requestId,
                    operation: "operation.cancel",
                    result: result.value
                  }
                : failure(result, request.requestId);
            }
          )
        ]
      : [])
    ]
  };
}
