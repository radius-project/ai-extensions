import { describe, expect, it } from "vitest";
import {
  createLifecycleValidators,
  type ContractValidation,
  type LifecycleValidators
} from "@radius-project/adapter-shared";
import {
  LIFECYCLE_API_VERSION,
  type LifecycleRequest
} from "@radius-project/core/lifecycle";

const request = {
  apiVersion: LIFECYCLE_API_VERSION,
  requestId: "public-entry",
  operation: "capabilities.get",
  target: { repo: "fixture/app" },
  input: {}
} satisfies LifecycleRequest;

describe("shared lifecycle public entry", () => {
  it("constructs and executes validators through the package export", () => {
    const validators: LifecycleValidators = createLifecycleValidators();
    const result: ContractValidation<LifecycleRequest> =
      validators.validateRequest(request);

    expect(result).toEqual({ valid: true, value: request });
    if (result.valid) expect(result.value).toBe(request);
  });

  it("preserves explicit failures across independently created contexts", () => {
    const first = createLifecycleValidators();
    const second = createLifecycleValidators();
    const rejected = first.validateRequest({ ...request, approved: true });

    expect(rejected).toMatchObject({
      valid: false,
      error: { code: "INVALID_REQUEST" }
    });
    expect(second.validateRequest(request)).toEqual({
      valid: true,
      value: request
    });
    expect(
      second.validateRequest({ ...request, apiVersion: "unknown/v2" })
    ).toMatchObject({
      valid: false,
      error: { code: "VERSION_UNSUPPORTED" }
    });
    expect(rejected).toMatchObject({
      valid: false,
      error: { code: "INVALID_REQUEST" }
    });
  });
});
