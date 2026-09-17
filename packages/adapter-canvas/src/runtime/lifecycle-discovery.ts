import {
  LIFECYCLE_API_VERSION,
  createApplicationDiscovery,
  createEnvironmentDiscovery,
  getLifecycleCapabilities,
  lifecycleError,
  registerLifecycleOperation,
  type ApplicationReadPort,
  type EnvironmentReadPort,
  type LifecycleReadCapability,
  type ClockPort,
  type IdPort,
  type ReadResult,
  type LifecycleErrorResponse
} from "@radius-project/core/lifecycle";

export interface LifecycleDiscoveryDependencies {
  applications: ApplicationReadPort;
  environments: EnvironmentReadPort;
  capabilities: readonly LifecycleReadCapability[];
  close(): Promise<void>;
}
function failure(
  result: ReadResult<unknown>,
  requestId: string
): LifecycleErrorResponse {
  return {
    apiVersion: LIFECYCLE_API_VERSION,
    requestId,
    error:
      "error" in result ?
        result.error
      : lifecycleError(
          result.status === "absent" ?
            "DEFINITION_NOT_FOUND"
          : "PRECONDITION_FAILED"
        )
  };
}
export function createLifecycleDiscoveryRegistrations(deps: {
  discovery?: LifecycleDiscoveryDependencies;
  clock: Pick<ClockPort, "now">;
  ids: IdPort;
  capabilities?: readonly LifecycleReadCapability[];
}) {
  const applications =
    deps.discovery ?
      createApplicationDiscovery({ ...deps, read: deps.discovery.applications })
    : undefined;
  const environments =
    deps.discovery ?
      createEnvironmentDiscovery({ ...deps, read: deps.discovery.environments })
    : undefined;
  if (deps.discovery && typeof deps.discovery.close !== "function")
    throw new Error("Discovery requires context cleanup.");
  const capabilities = registerLifecycleOperation(
    "capabilities.get",
    {},
    [],
    async (request) => ({
      apiVersion: LIFECYCLE_API_VERSION,
      requestId: request.requestId,
      operation: "capabilities.get",
      result: getLifecycleCapabilities(request.target, [
        ...(deps.discovery?.capabilities ?? []),
        ...(deps.capabilities ?? [])
      ])
    })
  );
  return {
    registrations: [
      capabilities,
      ...(applications && environments ?
        [
          registerLifecycleOperation(
            "application.list",
            { applications },
            ["applications"],
            async (request, context, ports) => {
              const result = await ports.applications.list(
                context.scope,
                request.input,
                context.caller,
                context.control
              );
              return result.status === "ok" ?
                  {
                    apiVersion: LIFECYCLE_API_VERSION,
                    requestId: request.requestId,
                    operation: "application.list",
                    result: result.value
                  }
                : failure(result, request.requestId);
            }
          ),
          registerLifecycleOperation(
            "application.inspect",
            { applications },
            ["applications"],
            async (request, context, ports) => {
              const result = await ports.applications.inspect(
                context.scope,
                context.control
              );
              return result.status === "ok" ?
                  {
                    apiVersion: LIFECYCLE_API_VERSION,
                    requestId: request.requestId,
                    operation: "application.inspect",
                    result: result.value
                  }
                : failure(result, request.requestId);
            }
          ),
          registerLifecycleOperation(
            "environment.list",
            { environments },
            ["environments"],
            async (request, context, ports) => {
              const result = await ports.environments.list(
                context.scope,
                request.input,
                context.caller,
                context.control
              );
              return result.status === "ok" ?
                  {
                    apiVersion: LIFECYCLE_API_VERSION,
                    requestId: request.requestId,
                    operation: "environment.list",
                    result: result.value
                  }
                : failure(result, request.requestId);
            }
          ),
          registerLifecycleOperation(
            "environment.inspect",
            { environments },
            ["environments"],
            async (request, context, ports) => {
              const result = await ports.environments.inspect(
                context.scope,
                context.control
              );
              return result.status === "ok" ?
                  {
                    apiVersion: LIFECYCLE_API_VERSION,
                    requestId: request.requestId,
                    operation: "environment.inspect",
                    result: result.value
                  }
                : failure(result, request.requestId);
            }
          )
        ]
      : [])
    ],
    async close() {
      applications?.close();
      environments?.close();
      await deps.discovery?.close();
    }
  };
}
