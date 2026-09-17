import type {
  LifecycleOperation,
  LifecycleRequestFor
} from "./contracts/catalog.js";
import type {
  AuthorizationRequest,
  AuthorizedScope,
  CallerContext,
  ConfigurationAuthorizationIntent,
  IdentityPort,
  ReadonlyData,
  RequestControl
} from "./ports.js";
import { portCancelled, portForbidden, type PortResult } from "./errors.js";
import { sameLifecycleData } from "./operations.js";

export function configurationAuthorizationIntent(
  request: ReadonlyData<LifecycleRequestFor<LifecycleOperation>>
): ConfigurationAuthorizationIntent | undefined {
  if (request.operation === "credentials.configure")
    return { operation: request.operation, input: request.input };
  if (request.operation === "environment.create")
    return {
      operation: request.operation,
      configuration: request.input.configuration
    };
  if (request.operation === "environment.configure")
    return { operation: request.operation, patch: request.input.patch };
  return undefined;
}

export async function authorizeConfiguration<
  O extends Extract<
    LifecycleOperation,
    | "credentials.configure"
    | "environment.create"
    | "environment.configure"
    | "credentials.inspect"
    | "environment.inspect"
  >
>(
  identity: Pick<IdentityPort, "authorize">,
  caller: CallerContext,
  request: ReadonlyData<LifecycleRequestFor<O>>,
  operationId: string,
  control: RequestControl
): Promise<PortResult<AuthorizedScope<O>>> {
  if (control.cancellation.aborted) return portCancelled("request_cancelled");
  const configuration = configurationAuthorizationIntent(request);
  const authorization = {
    caller,
    operation: request.operation,
    target: request.target,
    operationId,
    ...(configuration ? { configuration } : {}),
    ...("approvalRef" in request.input && request.input.approvalRef ?
      { approvalRef: request.input.approvalRef }
    : {})
  } as AuthorizationRequest<O>;
  const result = await identity.authorize(authorization, control);
  if (control.cancellation.aborted) return portCancelled("request_cancelled");
  if (result.status !== "ok") return result;
  return (
      result.value.authorizationRef &&
        result.value.principalRef === caller.principalRef &&
        result.value.operation === request.operation &&
        result.value.operationId === operationId &&
        (authorization.approvalRef === undefined ||
          result.value.approvalRef === authorization.approvalRef) &&
        sameLifecycleData(result.value.target, request.target) &&
        sameLifecycleData(
          result.value.configuration,
          authorization.configuration
        )
    ) ?
      result
    : portForbidden();
}
