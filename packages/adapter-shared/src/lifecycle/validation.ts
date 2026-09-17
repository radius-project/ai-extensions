import Ajv, { type AnySchema, type ValidateFunction } from "ajv";
import {
  LIFECYCLE_API_VERSION,
  LIFECYCLE_OPERATIONS,
  lifecycleErrorResponseSchema,
  operationSchemas,
  type LifecycleError,
  type LifecycleRequest,
  type LifecycleOperation,
  type LifecycleResponse
} from "@radius-project/core/lifecycle";

export type ContractValidation<T> =
  { valid: true; value: T } | { valid: false; error: LifecycleError };

export interface LifecycleValidators {
  validateRequest(value: unknown): ContractValidation<LifecycleRequest>;
  validateResponse(value: unknown): ContractValidation<LifecycleResponse>;
}

function failure(
  code: "INVALID_REQUEST" | "VERSION_UNSUPPORTED",
  message: string
) {
  return { valid: false, error: { code, message, retryable: false } } as const;
}

function isJsonData(
  value: unknown,
  ancestors: Set<object>,
  depth: number
): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || depth > 100 || ancestors.has(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (!array && prototype !== Object.prototype && prototype !== null)
    return false;
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  let valid = !array || keys.length === value.length + 1;
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || (array && !/^(0|[1-9]\d*)$/.test(key))) {
      valid = false;
      break;
    }
    const descriptor = descriptors[key];
    if (
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      !isJsonData(descriptor.value, ancestors, depth + 1)
    ) {
      valid = false;
      break;
    }
  }
  ancestors.delete(value);
  return valid;
}

function validate<T>(
  schema: () => ValidateFunction<T>,
  value: unknown
): ContractValidation<T> {
  if (!isJsonData(value, new Set(), 0)) {
    return failure("INVALID_REQUEST", "Message must contain only JSON data.");
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "apiVersion" in value &&
    typeof value.apiVersion === "string" &&
    value.apiVersion !== LIFECYCLE_API_VERSION
  ) {
    return failure("VERSION_UNSUPPORTED", "Unsupported lifecycle API version.");
  }
  const check = schema();
  if (!check(value)) {
    // Do not copy untrusted values, property names, or Ajv's mutable errors into
    // public diagnostics. Schema failures are not evidence of a remote failure.
    return failure(
      "INVALID_REQUEST",
      "Message does not match the lifecycle contract."
    );
  }
  return { valid: true, value };
}

export function createLifecycleValidators(): LifecycleValidators {
  const ajv = new Ajv({
    strict: true,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    ownProperties: true,
    validateFormats: true
  });
  const requests = new Map<
    LifecycleOperation | undefined,
    ValidateFunction<LifecycleRequest>
  >();
  const responses = new Map<
    LifecycleOperation | undefined,
    ValidateFunction<LifecycleResponse>
  >();
  function operation(value: unknown): LifecycleOperation | undefined {
    return typeof value === "object" && value !== null && "operation" in value ?
        LIFECYCLE_OPERATIONS.find((name) => name === value.operation)
      : undefined;
  }
  function compiled<T>(
    cache: Map<LifecycleOperation | undefined, ValidateFunction<T>>,
    key: LifecycleOperation | undefined,
    schema: AnySchema
  ): ValidateFunction<T> {
    let result = cache.get(key);
    if (!result) {
      result = ajv.compile<T>(schema);
      cache.set(key, result);
    }
    return result;
  }
  return {
    validateRequest(value) {
      const result = validate(() => {
        const key = operation(value);
        return compiled(
          requests,
          key,
          key ? operationSchemas[key].request : false
        );
      }, value);
      if (
        result.valid &&
        result.value.operation === "graph.diff" &&
        result.value.target.repo.toLowerCase() !==
          result.value.input.head.repo.toLowerCase()
      ) {
        return failure(
          "INVALID_REQUEST",
          "Graph comparison head repository must match the target repository."
        );
      }
      return result;
    },
    validateResponse(value) {
      return validate(() => {
        const key = operation(value);
        return compiled(
          responses,
          key,
          key ? operationSchemas[key].response : lifecycleErrorResponseSchema
        );
      }, value);
    }
  };
}
