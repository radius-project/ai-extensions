import {
  LIFECYCLE_OPERATIONS,
  type LifecycleError
} from "./contracts/common.js";
import type {
  LifecycleOperation,
  LifecycleRequest,
  LifecycleRequestFor,
  LifecycleResponse,
  LifecycleResponseFor,
  LifecycleErrorResponse
} from "./contracts/catalog.js";
import { lifecycleError, type PortResult } from "./errors.js";
import type {
  AuthorizedScope,
  CallerContext,
  RequestControl,
  ReadonlyData
} from "./ports.js";

export type LifecycleValidation<T> =
  | { readonly valid: true; readonly value: T }
  | { readonly valid: false; readonly error: LifecycleError };
export interface LifecycleValidationPort {
  validateRequest(value: unknown): LifecycleValidation<LifecycleRequest>;
  validateResponse(value: unknown): LifecycleValidation<LifecycleResponse>;
}
export interface LifecycleHandlerContext<
  O extends LifecycleOperation = LifecycleOperation
> {
  readonly caller: CallerContext;
  readonly scope: AuthorizedScope<O>;
  readonly control: RequestControl;
}
export interface RegisteredLifecycleOperation {
  readonly operation: LifecycleOperation;
  execute(
    request: LifecycleRequest,
    context: LifecycleHandlerContext
  ): Promise<ReadonlyData<LifecycleResponse>>;
}

export function registerLifecycleOperation<
  O extends LifecycleOperation,
  D extends object
>(
  operation: O,
  dependencies: D,
  required: readonly (keyof D)[],
  handler: (
    request: LifecycleRequestFor<O>,
    context: LifecycleHandlerContext<O>,
    dependencies: D
  ) => Promise<ReadonlyData<LifecycleResponseFor<O> | LifecycleErrorResponse>>
): RegisteredLifecycleOperation {
  if (
    typeof handler !== "function" ||
    !dependencies ||
    required.some(
      (key) => dependencies[key] === undefined || dependencies[key] === null
    )
  )
    throw new Error(`Lifecycle ${operation} is missing required dependencies.`);
  return {
    operation,
    async execute(request, context) {
      if (
        request.operation !== operation ||
        context.scope.operation !== operation
      )
        throw new Error("Lifecycle handler operation mismatch.");
      // The discriminant check above establishes the generic request variant.
      return handler(
        request as LifecycleRequestFor<O>,
        {
          ...context,
          scope: context.scope as AuthorizedScope<O>
        },
        dependencies
      );
    }
  };
}

export function createLifecycleService(deps: {
  readonly validators: LifecycleValidationPort;
  readonly registrations: readonly RegisteredLifecycleOperation[];
}) {
  if (
    typeof deps?.validators?.validateRequest !== "function" ||
    typeof deps.validators.validateResponse !== "function"
  )
    throw new Error(
      "Lifecycle service requires request and response validators."
    );
  const handlers = new Map<LifecycleOperation, RegisteredLifecycleOperation>();
  for (const registration of deps.registrations) {
    if (
      !LIFECYCLE_OPERATIONS.includes(registration.operation) ||
      typeof registration.execute !== "function" ||
      handlers.has(registration.operation)
    )
      throw new Error("Invalid or duplicate lifecycle registration.");
    handlers.set(registration.operation, registration);
  }
  const capabilities = LIFECYCLE_OPERATIONS.map((operation) => ({
    operation,
    available: handlers.has(operation),
    ...(handlers.has(operation) ?
      {}
    : { limitation: "Not implemented by this lifecycle context." })
  }));
  async function execute(
    value: unknown,
    context: {
      readonly caller: CallerContext;
      readonly control: RequestControl;
      authorize(
        request: LifecycleRequest
      ): Promise<PortResult<AuthorizedScope>>;
    }
  ): Promise<LifecycleResponse> {
    const failure = (error: LifecycleError): LifecycleResponse => ({
      apiVersion: "github-radius/v1",
      requestId: context.control.requestId,
      error
    });
    const validated = deps.validators.validateRequest(value);
    if (!validated.valid) return failure(validated.error);
    const request = structuredClone(validated.value);
    if (request.requestId !== context.control.requestId)
      return failure(lifecycleError("INVALID_REQUEST"));
    if (context.control.cancellation.aborted)
      return failure(lifecycleError("PRECONDITION_FAILED"));
    const handler = handlers.get(request.operation);
    if (!handler) return failure(lifecycleError("CAPABILITY_UNAVAILABLE"));
    try {
      const authorized = await context.authorize(request);
      if (authorized.status !== "ok")
        return failure(
          "error" in authorized ?
            authorized.error
          : lifecycleError("PRECONDITION_FAILED")
        );
      if (context.control.cancellation.aborted)
        return failure(lifecycleError("PRECONDITION_FAILED"));
      const result = await handler.execute(request, {
        caller: context.caller,
        scope: authorized.value,
        control: context.control
      });
      if (context.control.cancellation.aborted)
        return failure(lifecycleError("PRECONDITION_FAILED"));
      const checked = deps.validators.validateResponse(result);
      if (
        !checked.valid ||
        checked.value.requestId !== request.requestId ||
        ("operation" in checked.value &&
          checked.value.operation !== request.operation)
      )
        return failure(lifecycleError("RESULT_UNAVAILABLE"));
      return checked.value;
    } catch {
      return failure(lifecycleError("RESULT_UNAVAILABLE"));
    }
  }
  return { execute, capabilities: () => structuredClone(capabilities) };
}
