import {
  LIFECYCLE_API_VERSION,
  createDeployment,
  createOperationReads,
  lifecycleError,
  registerLifecycleOperation,
  type DeploymentDependencies,
  type LifecycleErrorResponse,
  type LifecycleReadCapability,
  type PortResult,
  type SourceAccessPort,
  type WorkflowExecutionPort
} from "@radius-project/core/lifecycle";
import type { LifecycleBinding } from "./create-lifecycle-binding.js";
import { unavailableCanvasLifecyclePrerequisite } from "./lifecycle-authorization.js";

export interface LifecycleDeploymentDependencies {
  readonly source: Pick<SourceAccessPort, "capture" | "releaseSnapshot">;
  readonly workflow: WorkflowExecutionPort;
}
export function createLifecycleDeploymentRegistrations(
  deps: Pick<
    DeploymentDependencies,
    "identity" | "registry" | "ids" | "clock"
  > & {
    readonly deployment?: LifecycleDeploymentDependencies;
    readonly routing: LifecycleBinding["routing"];
  }
) {
  const deployment =
    deps.deployment ?
      createDeployment({ ...deps, ...deps.deployment })
    : undefined;
  const reads = createOperationReads({
    registry: deps.registry,
    workflow: deps.deployment?.workflow
  });
  const failure = (
    result: PortResult<unknown>,
    requestId: string
  ): LifecycleErrorResponse => ({
    apiVersion: LIFECYCLE_API_VERSION,
    requestId,
    error:
      "error" in result ? result.error : lifecycleError("PRECONDITION_FAILED")
  });
  const capabilities: readonly LifecycleReadCapability[] = [
    ...(["operation.get", "operation.list"] as const).map((operation) => ({
      operation,
      contexts: ["git" as const],
      providers: ["azure" as const, "aws" as const],
      requiresAgent: false,
      limitations: [
        "Read-only session operations; no durable history. Workflow evidence may be unavailable."
      ]
    }))
  ];
  return {
    capabilities,
    registrations: [
      ...(deployment ?
        [
          registerLifecycleOperation(
            "deployment.start",
            { deployment },
            ["deployment"],
            async (request, context) => {
              if (deps.routing.selection("deployment").writer !== "lifecycle")
                return failure(
                  unavailableCanvasLifecyclePrerequisite(),
                  request.requestId
                );
              const result = await deployment.start(
                context.scope,
                context.caller,
                request,
                context.control
              );
              return result.status === "ok" ?
                  {
                    apiVersion: LIFECYCLE_API_VERSION,
                    requestId: request.requestId,
                    operation: "deployment.start",
                    result: result.value
                  }
                : failure(result, request.requestId);
            }
          )
        ]
      : []),
      registerLifecycleOperation(
        "operation.get",
        { reads },
        ["reads"],
        async (request, context) => {
          const result = await reads.get(
            context.scope,
            request.input.operationId,
            context.control
          );
          return result.status === "ok" ?
              {
                apiVersion: LIFECYCLE_API_VERSION,
                requestId: request.requestId,
                operation: "operation.get",
                result: result.value
              }
            : failure(result, request.requestId);
        }
      ),
      registerLifecycleOperation(
        "operation.list",
        { reads },
        ["reads"],
        async (request, context) => {
          const result = await reads.list(
            context.scope,
            request.input,
            context.control
          );
          return result.status === "ok" ?
              {
                apiVersion: LIFECYCLE_API_VERSION,
                requestId: request.requestId,
                operation: "operation.list",
                result: result.value
              }
            : failure(result, request.requestId);
        }
      )
    ]
  };
}
