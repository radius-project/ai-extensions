import {
  LIFECYCLE_API_VERSION,
  createCredentials,
  createEnvironments,
  lifecycleError,
  portFailure,
  registerLifecycleOperation,
  type CredentialDependencies,
  type EnvironmentDependencies,
  type LifecycleErrorResponse,
  type LifecycleReadCapability,
  type PortResult
} from "@radius-project/core/lifecycle";
import type { LifecycleBinding } from "./create-lifecycle-binding.js";
import type { LifecycleCredentialDependencies } from "./lifecycle-credentials.js";
import { unavailableCanvasLifecyclePrerequisite } from "./lifecycle-authorization.js";

export type LifecycleEnvironmentDependencies = Pick<
  EnvironmentDependencies,
  "providers" | "environment"
>;

export function createLifecycleEnvironmentRegistrations(
  deps: Pick<
    CredentialDependencies,
    "registry" | "actions" | "ids" | "clock"
  > & {
    readonly identity: Pick<CredentialDependencies["identity"], "authorize">;
    readonly credentials?: LifecycleCredentialDependencies;
    readonly environmentConfiguration?: LifecycleEnvironmentDependencies;
    readonly routing: LifecycleBinding["routing"];
    hasLegacySetupInProgress(): boolean;
  }
) {
  if (deps.environmentConfiguration && !deps.credentials)
    throw new Error(
      "Environment configuration requires qualified credential inspection."
    );
  const identity =
    deps.credentials ? { ...deps.identity, ...deps.credentials } : undefined;
  const credentials =
    identity && deps.credentials ?
      createCredentials({
        ...deps,
        identity,
        providers: deps.credentials.providers
      })
    : undefined;
  const environments =
    identity && deps.environmentConfiguration ?
      createEnvironments({
        ...deps,
        ...deps.environmentConfiguration,
        identity
      })
    : undefined;
  const failure = (
    result: PortResult<unknown>,
    requestId: string
  ): LifecycleErrorResponse => ({
    apiVersion: LIFECYCLE_API_VERSION,
    requestId,
    error:
      "error" in result ? result.error : lifecycleError("PRECONDITION_FAILED")
  });
  const capabilities: readonly LifecycleReadCapability[] =
    deps.credentials ?
      [
        {
          operation: "credentials.inspect",
          contexts: ["session", "environment"],
          providers: [...deps.credentials.providers],
          requiresAgent: false,
          limitations: [
            "Inspection never authenticates, selects an account, configures an environment or deploys. Missing provider commands are reported explicitly."
          ]
        }
      ]
    : [];
  return {
    capabilities,
    registrations: [
      ...(credentials ?
        [
          registerLifecycleOperation(
            "credentials.inspect",
            { credentials },
            ["credentials"],
            async (request, context) => {
              const result = await credentials.inspect(
                context.scope,
                request.input,
                context.control
              );
              return result.status === "ok" ?
                  {
                    apiVersion: LIFECYCLE_API_VERSION,
                    requestId: request.requestId,
                    operation: "credentials.inspect",
                    result: result.value
                  }
                : failure(result, request.requestId);
            }
          ),
          ...(deps.credentials?.configure ?
            [
              registerLifecycleOperation(
                "credentials.configure",
                { credentials },
                ["credentials"],
                async (request, context) => {
                  const result = await credentials.configure(
                    context.scope,
                    context.caller,
                    request,
                    context.control
                  );
                  return result.status === "ok" ?
                      {
                        apiVersion: LIFECYCLE_API_VERSION,
                        requestId: request.requestId,
                        operation: "credentials.configure",
                        result: result.value
                      }
                    : failure(result, request.requestId);
                }
              )
            ]
          : [])
        ]
      : []),
      ...(environments ?
        [
          registerLifecycleOperation(
            "environment.create",
            { environments },
            ["environments"],
            async (request, context) => {
              if (deps.routing.selection("environment").writer !== "lifecycle")
                return failure(
                  unavailableCanvasLifecyclePrerequisite(),
                  request.requestId
                );
              if (deps.hasLegacySetupInProgress())
                return failure(
                  portFailure("PRECONDITION_FAILED"),
                  request.requestId
                );
              const result = await environments.create(
                context.scope,
                context.caller,
                request,
                context.control
              );
              return result.status === "ok" ?
                  {
                    apiVersion: LIFECYCLE_API_VERSION,
                    requestId: request.requestId,
                    operation: "environment.create",
                    result: result.value
                  }
                : failure(result, request.requestId);
            }
          ),
          registerLifecycleOperation(
            "environment.configure",
            { environments },
            ["environments"],
            async (request, context) => {
              if (deps.routing.selection("environment").writer !== "lifecycle")
                return failure(
                  unavailableCanvasLifecyclePrerequisite(),
                  request.requestId
                );
              if (deps.hasLegacySetupInProgress())
                return failure(
                  portFailure("PRECONDITION_FAILED"),
                  request.requestId
                );
              const result = await environments.configure(
                context.scope,
                context.caller,
                request,
                context.control
              );
              return result.status === "ok" ?
                  {
                    apiVersion: LIFECYCLE_API_VERSION,
                    requestId: request.requestId,
                    operation: "environment.configure",
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
