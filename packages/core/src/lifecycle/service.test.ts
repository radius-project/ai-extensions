import { describe, expect, it } from "vitest";
import {
  createLifecycleService,
  registerLifecycleOperation,
  type LifecycleValidationPort
} from "./service.js";
import {
  lifecycleError,
  portCancelled,
  portForbidden,
  portSuccess
} from "./errors.js";
import type {
  AuthorizedScope,
  CallerContext,
  RequestControl
} from "./ports.js";
import type {
  LifecycleRequestFor,
  LifecycleResponseFor
} from "./contracts/catalog.js";

const caller: CallerContext = {
  principalRef: "principal",
  identityRef: "identity",
  sessionRef: "session",
  responder: "service"
};
const control: RequestControl = {
  requestId: "request",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
const request: LifecycleRequestFor<"operation.respond"> = {
  apiVersion: "github-radius/v1",
  requestId: "request",
  operation: "operation.respond",
  target: { repo: "owner/repo" },
  input: {
    operationId: "operation",
    actionId: "action",
    response: { kind: "user.decision", choice: "approve" }
  }
};
const response: LifecycleResponseFor<"operation.respond"> = {
  apiVersion: request.apiVersion,
  requestId: request.requestId,
  operation: request.operation,
  result: {
    operationId: "operation",
    operation: "definition.author",
    target: request.target,
    state: "running",
    attempts: [],
    actions: [],
    observation: {
      quality: "current",
      completeness: "complete",
      evidence: "session"
    }
  }
};
const scope: AuthorizedScope<"operation.respond"> = {
  authorizationRef: "auth",
  principalRef: caller.principalRef,
  operation: request.operation,
  target: request.target
};
const validators: LifecycleValidationPort = {
  validateRequest: (value) =>
    value === request ?
      { valid: true, value: request }
    : { valid: false, error: lifecycleError("INVALID_REQUEST") },
  validateResponse: (value) =>
    value === response ?
      { valid: true, value: response }
    : { valid: false, error: lifecycleError("INVALID_REQUEST") }
};
const context = { caller, control, authorize: async () => portSuccess(scope) };
describe("typed lifecycle dispatcher", () => {
  it("advertises only explicitly registered handlers and executes the typed dependency", async () => {
    let calls = 0;
    const service = createLifecycleService({
      validators,
      registrations: [
        registerLifecycleOperation(
          "operation.respond",
          {
            respond: () => {
              calls++;
              return response;
            }
          },
          ["respond"],
          async (_request, _context, deps) => deps.respond()
        )
      ]
    });
    expect(
      service
        .capabilities()
        .filter((item) => item.available)
        .map((item) => item.operation)
    ).toEqual(["operation.respond"]);
    expect(await service.execute(request, context)).toBe(response);
    expect(calls).toBe(1);
  });
  it("reports unsupported capabilities without running authorization or mutation", async () => {
    const service = createLifecycleService({ validators, registrations: [] });
    expect(
      await service.execute(request, {
        ...context,
        authorize: async () => {
          throw new Error("Must not authorize");
        }
      })
    ).toMatchObject({ error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect(service.capabilities()).toHaveLength(21);
  });
  it("fails construction for missing dependencies and duplicate handlers", () => {
    expect(() =>
      registerLifecycleOperation(
        "operation.respond",
        { respond: undefined },
        ["respond"],
        async () => response
      )
    ).toThrow("dependencies");
    const registration = registerLifecycleOperation(
      "operation.respond",
      {},
      [],
      async () => response
    );
    expect(() =>
      createLifecycleService({
        validators,
        registrations: [registration, registration]
      })
    ).toThrow("duplicate");
    expect(() =>
      Reflect.apply(createLifecycleService, undefined, [{}])
    ).toThrow("validators");
  });
  it("validates untrusted requests before invoking handlers", async () => {
    const service = createLifecycleService({ validators, registrations: [] });
    expect(
      await service.execute({ ...request, approved: true }, context)
    ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(
      await service.execute(request, {
        ...context,
        control: { ...control, requestId: "other" }
      })
    ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
  });
  it("propagates denial and refuses malformed or thrown adapter results", async () => {
    const registration = registerLifecycleOperation(
      "operation.respond",
      {},
      [],
      async () => response
    );
    const service = createLifecycleService({
      validators,
      registrations: [registration]
    });
    expect(
      await service.execute(request, {
        ...context,
        authorize: async () => portForbidden()
      })
    ).toMatchObject({ error: { code: "FORBIDDEN" } });
    const invalid = createLifecycleService({
      validators: {
        ...validators,
        validateResponse: () => ({
          valid: false,
          error: lifecycleError("INVALID_REQUEST")
        })
      },
      registrations: [registration]
    });
    expect(await invalid.execute(request, context)).toMatchObject({
      error: { code: "RESULT_UNAVAILABLE" }
    });
    const thrown = createLifecycleService({
      validators,
      registrations: [
        registerLifecycleOperation("operation.respond", {}, [], async () => {
          throw new Error("private details");
        })
      ]
    });
    expect(await thrown.execute(request, context)).toMatchObject({
      error: { code: "RESULT_UNAVAILABLE" }
    });
  });
  it("fences cancelled requests and refuses a mismatched handler invocation", async () => {
    const registration = registerLifecycleOperation(
      "operation.respond",
      {},
      [],
      async () => response
    );
    const service = createLifecycleService({
      validators,
      registrations: [registration]
    });
    expect(
      await service.execute(request, {
        ...context,
        control: {
          ...control,
          cancellation: { ...control.cancellation, aborted: true }
        }
      })
    ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
    await expect(
      registration.execute(
        {
          ...request,
          operation: "operation.get",
          input: { operationId: "operation" }
        },
        { ...context, scope }
      )
    ).rejects.toThrow("mismatch");
  });
  it("fences cancellation during authorization and handler execution", async () => {
    const signal = { aborted: false, onAbort: () => () => {} };
    const local = { ...context, control: { ...control, cancellation: signal } };
    const registration = registerLifecycleOperation(
      "operation.respond",
      {},
      [],
      async () => {
        signal.aborted = true;
        return response;
      }
    );
    const service = createLifecycleService({
      validators,
      registrations: [registration]
    });
    expect(
      await service.execute(request, {
        ...local,
        authorize: async () => portCancelled("request_cancelled")
      })
    ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
    expect(
      await service.execute(request, {
        ...local,
        authorize: async () => {
          signal.aborted = true;
          return portSuccess(scope);
        }
      })
    ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
    signal.aborted = false;
    expect(await service.execute(request, local)).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
  });
  it("rejects a response envelope with the wrong request identity", async () => {
    const service = createLifecycleService({
      validators: {
        ...validators,
        validateResponse: () => ({
          valid: true,
          value: { ...response, requestId: "other" }
        })
      },
      registrations: [
        registerLifecycleOperation(
          "operation.respond",
          {},
          [],
          async () => response
        )
      ]
    });
    expect(await service.execute(request, context)).toMatchObject({
      error: { code: "RESULT_UNAVAILABLE" }
    });
  });
});
