import {
  LIFECYCLE_API_VERSION,
  createLifecycleGraphs,
  lifecycleError,
  registerLifecycleOperation,
  type LifecycleGraphDependencies,
  type LifecycleReadCapability,
  type LifecycleErrorResponse,
  type PortResult
} from "@radius-project/core/lifecycle";

export const graphCapabilities: readonly LifecycleReadCapability[] = [
  ...(["graph.get", "graph.diff"] as const).map(
    (operation): LifecycleReadCapability => ({
      operation,
      contexts: ["workspace", "git", "environment"],
      providers: ["azure", "aws"],
      requiresAgent: false,
      limitations: [
        "Authored graphs require a complete supported source snapshot and locally available compiler extensions; registry restoration is unavailable.",
        "Planned graphs require actual selected-environment recipe registrations and describe expected outputs, not an authoritative deployment plan.",
        "Deployed graphs require a recorded deployed observation; authored graphs are never substituted.",
        "The Canvas production host does not provide actual recipe-registration or canonical deployed-observation channels; planned and deployed reads return RESULT_UNAVAILABLE.",
        "Graph compilation uses isolated credentials and owned storage, not an operating-system network or filesystem sandbox."
      ]
    })
  )
];

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

export function createLifecycleGraphRegistrations(
  deps: LifecycleGraphDependencies
) {
  const graphs = createLifecycleGraphs(deps);
  return {
    registrations: [
      registerLifecycleOperation(
        "graph.get",
        { graphs },
        ["graphs"],
        async (request, context, ports) => {
          const result = await ports.graphs.get(
            context.scope,
            request.input,
            context.control
          );
          return result.status === "ok" ?
              {
                apiVersion: LIFECYCLE_API_VERSION,
                requestId: request.requestId,
                operation: "graph.get",
                result: result.value
              }
            : failure(result, request.requestId);
        }
      ),
      registerLifecycleOperation(
        "graph.diff",
        { graphs },
        ["graphs"],
        async (request, context, ports) => {
          const result = await ports.graphs.diff(
            context.scope,
            request.input,
            context.caller,
            context.control
          );
          return result.status === "ok" ?
              {
                apiVersion: LIFECYCLE_API_VERSION,
                requestId: request.requestId,
                operation: "graph.diff",
                result: result.value
              }
            : failure(result, request.requestId);
        }
      )
    ],
    close: () => graphs.close()
  };
}
