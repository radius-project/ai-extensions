import { describe, expect, it, vi } from "vitest";
import { createCredentials } from "./credentials.js";
import { createActionService } from "./actions.js";
import { createSessionOperationRegistry } from "./operations.js";
import {
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable
} from "./errors.js";
import type {
  AuthorizationRequest,
  AuthorizedScope,
  CallerContext,
  IdentityPort,
  LifecycleOperation,
  LifecycleRequestFor,
  Observation,
  PortResult,
  RequestControl
} from "./index.js";

function fixture() {
  let sequence = 0;
  const ids = { next: () => `id-${++sequence}` };
  const clock = { now: () => "2026-09-17T15:00:00Z" };
  const registry = createSessionOperationRegistry({ ids, clock });
  const cancellation = { aborted: false, onAbort: () => () => {} };
  const control: RequestControl = { requestId: "request", cancellation };
  const caller: CallerContext = {
    principalRef: "principal",
    sessionRef: "session",
    identityRef: "github:fixture",
    responder: "user"
  };
  const observation: Observation = {
    quality: "current",
    completeness: "complete",
    evidence: "configuration",
    observedAt: clock.now()
  };
  const scope: AuthorizedScope<"credentials.configure"> = {
    authorizationRef: "authority",
    principalRef: caller.principalRef,
    operation: "credentials.configure",
    target: { repo: "owner/repo", environment: "dev" }
  };
  const request: LifecycleRequestFor<"credentials.configure"> = {
    apiVersion: "github-radius/v1",
    requestId: "request",
    operation: "credentials.configure",
    target: scope.target,
    input: { provider: "azure", intent: "authenticate" }
  };
  const state = {
    authenticated: false,
    verified: true,
    forbidden: false,
    observation,
    identityRef: "azure:profile"
  };
  const inspect = vi.fn<IdentityPort["inspect"]>(async () =>
    portSuccess({
      prerequisites: [
        {
          provider: "azure",
          ...(state.authenticated ? { identityRef: state.identityRef } : {}),
          status:
            state.authenticated && state.verified ? "satisfied" : "missing",
          reason: "Controlled identity observation."
        }
      ],
      observation: state.observation
    })
  );
  const configure = vi.fn<IdentityPort["configure"]>(async () => {
    state.authenticated = true;
    return portSuccess({ identityRef: "azure:profile", observation });
  });
  const identity: Pick<
    IdentityPort,
    "inspect" | "configure" | "authorize" | "authorizeResponse"
  > = {
    inspect,
    configure,
    async authorize<O extends LifecycleOperation>(
      input: AuthorizationRequest<O>
    ): Promise<PortResult<AuthorizedScope<O>>> {
      if (state.forbidden) return portForbidden();
      const scope: AuthorizedScope = {
        ...input,
        authorizationRef: "current-authority",
        principalRef: input.caller.principalRef
      };
      return portSuccess(scope as AuthorizedScope<O>);
    },
    authorizeResponse: async (responder, action) =>
      portSuccess({
        authorizationRef: "response",
        principalRef: responder.principalRef,
        operation: "operation.respond",
        target: action.target,
        operationId: action.operationId
      })
  };
  const actions = createActionService({ registry, identity, ids, clock });
  const service = createCredentials({
    registry,
    identity,
    ids,
    clock,
    actions,
    providers: ["azure"]
  });
  const start = () => service.configure(scope, caller, request, control);
  const respond = async (responder = caller) => {
    const accepted = await start();
    if (accepted.status !== "ok" || accepted.value.state !== "action_required")
      throw new Error("Expected credential action");
    const input = {
      operationId: accepted.value.operationId,
      actionId: accepted.value.requiredAction.actionId,
      response: { kind: "user.decision" as const, choice: "continue" }
    };
    const responseScope: AuthorizedScope<"operation.respond"> = {
      ...scope,
      operation: "operation.respond",
      operationId: input.operationId
    };
    return {
      input,
      responseScope,
      invoke: () => actions.respond(responseScope, responder, input, control)
    };
  };
  return {
    service,
    actions,
    registry,
    cancellation,
    control,
    caller,
    scope,
    request,
    state,
    identity,
    inspect,
    configure,
    start,
    respond
  };
}

describe("explicit credential operations (RF-02)", () => {
  it.each([2, 3])(
    "rechecks credential authority at continuation fence %s before configuration",
    async (fence) => {
      const f = fixture();
      const response = await f.respond();
      const authorize = f.identity.authorize;
      let checks = 0;
      f.identity.authorize = async (input, control) =>
        ++checks < fence ? authorize(input, control) : portForbidden();
      expect(await response.invoke()).toMatchObject({ status: "forbidden" });
      expect(checks).toBe(fence);
      expect(f.configure).not.toHaveBeenCalled();
    }
  );
  it("reports failure to persist an outstanding credential action", async () => {
    const f = fixture();
    vi.spyOn(f.registry, "compareAndSwap").mockResolvedValue(
      portFailure("PRECONDITION_FAILED")
    );
    expect(await f.start()).toMatchObject({ status: "failed" });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it("enumerates every supported provider without authenticating", async () => {
    const f = fixture();
    expect(
      await f.service.inspect(
        { ...f.scope, operation: "credentials.inspect" },
        {},
        f.control
      )
    ).toMatchObject({
      status: "ok",
      value: { prerequisites: [{ provider: "azure" }] }
    });
  });
  it.each(["missing", "duplicate", "wrong-provider", "missing-reference"])(
    "rejects %s provider evidence",
    async (scenario) => {
      const f = fixture();
      const entry = {
        provider: "azure" as const,
        status: "satisfied" as const,
        identityRef: "profile",
        reason: "Observed."
      };
      f.inspect.mockResolvedValue(
        portSuccess({
          prerequisites:
            scenario === "missing" ? []
            : scenario === "duplicate" ? [entry, entry]
            : scenario === "wrong-provider" ? [{ ...entry, provider: "aws" }]
            : [{ ...entry, identityRef: undefined }],
          observation: f.state.observation
        })
      );
      expect(
        await f.service.inspect(
          { ...f.scope, operation: "credentials.inspect" },
          {},
          f.control
        )
      ).toMatchObject({
        status: "failed",
        error: { code: "EVIDENCE_MISMATCH" }
      });
    }
  );
  it("discards an inspection that settles after cancellation", async () => {
    const f = fixture();
    f.inspect.mockImplementation(async () => {
      f.cancellation.aborted = true;
      return portSuccess({
        prerequisites: [],
        observation: f.state.observation
      });
    });
    expect(
      await f.service.inspect(
        { ...f.scope, operation: "credentials.inspect" },
        {},
        f.control
      )
    ).toMatchObject({ status: "cancelled" });
  });
  it.each(["principal", "target"])(
    "rejects mismatched initial %s authority",
    async (mismatch) => {
      const f = fixture();
      if (mismatch === "principal")
        Reflect.set(f.scope, "principalRef", "other");
      else f.request.target = { repo: "other/repo" };
      expect(await f.start()).toMatchObject({
        status: "failed",
        error: { code: "PRECONDITION_FAILED" }
      });
      expect(f.configure).not.toHaveBeenCalled();
    }
  );
  it("reports a missing configuration binding rather than manufacturing completion", async () => {
    const f = fixture();
    const service = createCredentials({
      registry: f.registry,
      actions: f.actions,
      identity: {
        inspect: f.identity.inspect,
        authorize: f.identity.authorize
      },
      providers: ["azure"],
      ids: { next: () => "id" },
      clock: { now: () => "2026-09-17T15:00:00Z" }
    });
    expect(
      await service.configure(f.scope, f.caller, f.request, f.control)
    ).toMatchObject({ status: "unavailable" });
  });
  it("preserves registry closure without creating an action", async () => {
    const f = fixture();
    await f.registry.close();
    expect(await f.start()).not.toMatchObject({ status: "ok" });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it.each(["configuration", "inspection", "cancellation"])(
    "preserves %s failure during continuation",
    async (phase) => {
      const f = fixture();
      const response = await f.respond();
      if (phase === "configuration")
        f.configure.mockResolvedValue(portFailure("PRECONDITION_FAILED"));
      if (phase === "inspection")
        f.inspect.mockResolvedValue(portFailure("EVIDENCE_MISMATCH"));
      if (phase === "cancellation")
        f.configure.mockImplementation(async () => {
          f.cancellation.aborted = true;
          return portSuccess({
            identityRef: "profile",
            observation: f.state.observation
          });
        });
      expect(await response.invoke()).not.toMatchObject({
        status: "ok",
        value: { state: "succeeded" }
      });
      expect(f.configure).toHaveBeenCalledOnce();
    }
  );
  it("rejects configuration when authority changes between validation and effect", async () => {
    const f = fixture();
    const response = await f.respond();
    let grants = 0;
    const original = f.identity.authorize;
    f.identity.authorize = async (request, control) =>
      ++grants === 1 ? original(request, control) : portForbidden();
    expect(await response.invoke()).not.toMatchObject({
      status: "ok",
      value: { state: "succeeded" }
    });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it("inspects missing credentials without authenticating or creating an operation", async () => {
    const f = fixture();
    expect(
      await f.service.inspect(
        { ...f.scope, operation: "credentials.inspect" },
        { provider: "azure" },
        f.control
      )
    ).toMatchObject({
      status: "ok",
      value: { prerequisites: [{ status: "missing" }], actions: [] }
    });
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.registry.knownOperations()).toEqual([]);
  });
  it("requests an authenticated user action before configuration", async () => {
    const f = fixture();
    expect(await f.start()).toMatchObject({
      status: "ok",
      value: {
        state: "action_required",
        requiredAction: { kind: "user.authenticate", responder: "user" }
      }
    });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it("verifies actual identity after an explicit response and consumes it once", async () => {
    const f = fixture();
    const response = await f.respond();
    expect(await response.invoke()).toMatchObject({
      status: "ok",
      value: {
        state: "succeeded",
        result: { kind: "configuration", identityRef: "azure:profile" }
      }
    });
    expect(f.configure).toHaveBeenCalledTimes(1);
    expect(f.inspect).toHaveBeenCalled();
    expect(await response.invoke()).toMatchObject({
      status: "failed",
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    expect(f.configure).toHaveBeenCalledTimes(1);
  });
  it.each(["unverified", "different-identity", "stale", "partial"] as const)(
    "does not trust a completed authentication with %s evidence",
    async (scenario) => {
      const f = fixture();
      const response = await f.respond();
      if (scenario === "unverified") f.state.verified = false;
      if (scenario === "different-identity")
        f.state.identityRef = "azure:other";
      if (scenario === "stale") f.state.observation.quality = "stale";
      if (scenario === "partial") f.state.observation.completeness = "partial";
      const result = await response.invoke();
      expect(result).not.toMatchObject({
        status: "ok",
        value: { state: "succeeded" }
      });
      expect(f.configure).toHaveBeenCalledTimes(1);
    }
  );
  it("rejects a changed authority without consuming the action or configuring", async () => {
    const f = fixture();
    const response = await f.respond();
    f.state.forbidden = true;
    expect(await response.invoke()).toMatchObject({ status: "forbidden" });
    expect(f.configure).not.toHaveBeenCalled();
    f.state.forbidden = false;
    expect(await response.invoke()).toMatchObject({
      status: "ok",
      value: { state: "succeeded" }
    });
  });
  it("rejects the wrong responder before any authentication", async () => {
    const f = fixture();
    const response = await f.respond({ ...f.caller, principalRef: "other" });
    expect(await response.invoke()).toMatchObject({ status: "forbidden" });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it.each(["inspect", "configure"] as const)(
    "reports unsupported providers for %s",
    async (operation) => {
      const f = fixture();
      f.request.input.provider = "aws";
      const result =
        operation === "configure" ?
          await f.start()
        : await f.service.inspect(
            { ...f.scope, operation: "credentials.inspect" },
            { provider: "aws" },
            f.control
          );
      expect(result).toMatchObject({
        status: "unavailable",
        error: { code: "CAPABILITY_UNAVAILABLE" }
      });
      expect(f.inspect).not.toHaveBeenCalled();
      expect(f.configure).not.toHaveBeenCalled();
    }
  );
  it("requires an identity reference for explicit profile selection", async () => {
    const f = fixture();
    f.request.input.intent = "select_identity";
    expect(await f.start()).toMatchObject({
      status: "failed",
      error: { code: "INVALID_REQUEST" }
    });
  });
  it("selects only the requested verified identity", async () => {
    const f = fixture();
    f.request.input = {
      provider: "azure",
      intent: "select_identity",
      identityRef: "azure:profile"
    };
    const response = await f.respond();
    expect(await response.invoke()).toMatchObject({
      status: "ok",
      value: { state: "succeeded" }
    });
    expect(f.configure.mock.calls[0]?.[1]).toEqual(f.request.input);
  });
  it.each([
    portFailure("PRECONDITION_FAILED"),
    portUnavailable("CAPABILITY_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "configuration"
    })
  ])(
    "preserves an unavailable or failed identity observation",
    async (result) => {
      const f = fixture();
      f.inspect.mockResolvedValue(result);
      expect(
        await f.service.inspect(
          { ...f.scope, operation: "credentials.inspect" },
          {},
          f.control
        )
      ).toEqual(result);
      expect(f.configure).not.toHaveBeenCalled();
    }
  );
  it("fences cancelled inspection and configuration", async () => {
    const f = fixture();
    f.cancellation.aborted = true;
    expect(await f.start()).toMatchObject({ status: "cancelled" });
    expect(
      await f.service.inspect(
        { ...f.scope, operation: "credentials.inspect" },
        {},
        f.control
      )
    ).toMatchObject({ status: "cancelled" });
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.inspect).not.toHaveBeenCalled();
  });
});
