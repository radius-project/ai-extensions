import { describe, expect, it, vi } from "vitest";
import { createEnvironments } from "./environments.js";
import { createActionService } from "./actions.js";
import { createSessionOperationRegistry } from "./operations.js";
import {
  lifecycleError,
  portAbsent,
  portForbidden,
  portSuccess
} from "./errors.js";
import type {
  AuthorizationRequest,
  AuthorizedScope,
  CallerContext,
  EnvironmentAccessPort,
  EnvironmentConfigurationReceipt,
  EnvironmentInspection,
  IdentityPort,
  LifecycleOperation,
  LifecycleRequestFor,
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
  const observation = {
    quality: "current",
    completeness: "complete",
    evidence: "radius",
    observedAt: clock.now()
  } as const;
  const target = { repo: "owner/repo", environment: "dev" };
  const scope: AuthorizedScope<"environment.create"> = {
    authorizationRef: "authority",
    principalRef: caller.principalRef,
    operation: "environment.create",
    target
  };
  const request: LifecycleRequestFor<"environment.create"> = {
    apiVersion: "github-radius/v1",
    requestId: "request",
    operation: "environment.create",
    target,
    input: {
      configuration: {
        provider: "azure",
        identityRef: "azure:profile",
        settings: {
          subscriptionId: "subscription",
          resourceGroup: "group",
          location: "westus"
        },
        recipes: []
      }
    }
  };
  const configured: EnvironmentInspection = {
    target,
    configuration: request.input.configuration,
    protections: { requiredReviewers: true, branchPolicy: "protected" },
    limitations: [],
    observation,
    recipeObservation: observation
  };
  const state = {
    current: null as EnvironmentInspection | null,
    identity: true,
    forbidden: false,
    receipt: undefined as EnvironmentConfigurationReceipt | undefined
  };
  const inspect = vi.fn<EnvironmentAccessPort["inspect"]>(async () =>
    state.current ?
      portSuccess(structuredClone(state.current))
    : portAbsent(observation)
  );
  const configure = vi.fn<EnvironmentAccessPort["configure"]>(
    async (_scope, plan) => {
      state.current = {
        ...configured,
        configuration: structuredClone(plan.configuration)
      };
      return portSuccess(
        state.receipt ?? {
          state: "succeeded",
          inspection: state.current,
          observation,
          phases: ["environment", "workflows", "recipes"].map((phase) => ({
            phase: phase as "environment" | "workflows" | "recipes",
            status: "succeeded" as const,
            reason: "Controlled external completion."
          }))
        }
      );
    }
  );
  const identity: Pick<
    IdentityPort,
    "inspect" | "authorize" | "authorizeResponse"
  > = {
    inspect: async () =>
      portSuccess({
        prerequisites: [
          {
            provider: "azure",
            identityRef: "azure:profile",
            status: state.identity ? "satisfied" : "missing",
            reason: "Controlled identity observation."
          }
        ],
        observation
      }),
    async authorize<O extends LifecycleOperation>(
      input: AuthorizationRequest<O>
    ): Promise<PortResult<AuthorizedScope<O>>> {
      const scope: AuthorizedScope = {
        ...input,
        authorizationRef: "current-authority",
        principalRef: input.caller.principalRef
      };
      return state.forbidden ? portForbidden() : (
          portSuccess(scope as AuthorizedScope<O>)
        );
    },
    authorizeResponse: async (responder, action, response) =>
      portSuccess({
        ...(response.kind === "user.decision" && response.approvalRef ?
          { approvalRef: response.approvalRef }
        : {}),
        authorizationRef: "response",
        principalRef: responder.principalRef,
        operation: "operation.respond",
        target: action.target,
        operationId: action.operationId
      })
  };
  const actions = createActionService({ registry, identity, ids, clock });
  const service = createEnvironments({
    registry,
    identity,
    ids,
    clock,
    actions,
    providers: ["azure"],
    environment: { inspect, configure }
  });
  const start = () => service.create(scope, caller, request, control);
  const respond = async () => {
    const accepted = await start();
    if (accepted.status !== "ok" || accepted.value.state !== "action_required")
      throw new Error("Expected environment action");
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
      invoke: () => actions.respond(responseScope, caller, input, control)
    };
  };
  return {
    service,
    state,
    registry,
    configure,
    inspect,
    cancellation,
    control,
    caller,
    scope,
    request,
    configured,
    identity,
    actions,
    start,
    respond
  };
}

describe("environment orchestration without implicit deployment (RF-06)", () => {
  it.each([2, 3])(
    "rechecks environment authority at continuation fence %s before configuration",
    async (fence) => {
      const f = fixture();
      const response = await f.respond();
      const authorize = f.identity.authorize;
      let checks = 0;
      f.identity.authorize = async (input, control) =>
        input.operation !== "environment.create" || ++checks < fence ?
          authorize(input, control)
        : portForbidden();
      expect(await response.invoke()).toMatchObject({ status: "forbidden" });
      expect(checks).toBe(fence);
      expect(f.configure).not.toHaveBeenCalled();
    }
  );
  it("binds a newly granted approval to the outstanding environment creation", async () => {
    const f = fixture();
    const response = await f.respond();
    expect(
      await f.actions.respond(
        {
          ...f.scope,
          operation: "operation.respond",
          operationId: response.input.operationId
        },
        f.caller,
        {
          ...response.input,
          response: {
            kind: "user.decision",
            choice: "continue",
            approvalRef: "new-reviewed-approval"
          }
        },
        f.control
      )
    ).toMatchObject({ status: "ok", value: { state: "succeeded" } });
    expect(f.configure.mock.calls[0][0]).toMatchObject({
      approvalRef: "new-reviewed-approval"
    });
  });

  it("refuses an occupied environment before creating an operation", async () => {
    const f = fixture();
    f.state.current = f.configured;
    expect(await f.start()).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(f.registry.knownOperations()).toEqual([]);
  });
  it("reports failure to persist an outstanding environment action", async () => {
    const f = fixture();
    vi.spyOn(f.registry, "compareAndSwap").mockResolvedValue(portForbidden());
    expect(await f.start()).toMatchObject({ status: "forbidden" });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it.each(["principal", "target"])(
    "refuses mismatched %s on initial setup",
    async (field) => {
      const f = fixture();
      if (field === "principal") Reflect.set(f.scope, "principalRef", "other");
      else f.request.target = { ...f.request.target, environment: "other" };
      expect(await f.start()).not.toMatchObject({ status: "ok" });
      expect(f.inspect).not.toHaveBeenCalled();
    }
  );
  it.each([
    "environment-authority",
    "identity-authority",
    "environment-read",
    "identity-read",
    "cancelled-identity",
    "registry-closed"
  ])("preserves initial %s failure without configuration", async (phase) => {
    const f = fixture();
    if (phase.endsWith("authority")) {
      const authorize = f.identity.authorize;
      f.identity.authorize = async (request, control) =>
        (
          request.operation ===
          (phase === "environment-authority" ?
            "environment.inspect"
          : "credentials.inspect")
        ) ?
          portForbidden()
        : authorize(request, control);
    }
    if (phase === "environment-read")
      f.inspect.mockResolvedValue(portForbidden());
    if (phase === "identity-read")
      f.identity.inspect = async () => portForbidden();
    if (phase === "cancelled-identity") {
      const inspect = f.identity.inspect;
      f.identity.inspect = async (scope, input, control) => {
        f.cancellation.aborted = true;
        return inspect(scope, input, control);
      };
    }
    if (phase === "registry-closed") await f.registry.close();
    expect(await f.start()).not.toMatchObject({ status: "ok" });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it.each(["environment", "identity", "configure", "late-authority"])(
    "preserves %s failure during one-time continuation",
    async (phase) => {
      const f = fixture();
      const response = await f.respond();
      if (phase === "environment") f.inspect.mockResolvedValue(portForbidden());
      if (phase === "identity")
        f.identity.inspect = async () => portForbidden();
      if (phase === "configure") f.configure.mockResolvedValue(portForbidden());
      if (phase === "late-authority") {
        let grants = 0;
        const authorize = f.identity.authorize;
        f.identity.authorize = async (request, control) =>
          request.operation === "environment.create" && ++grants > 1 ?
            portForbidden()
          : authorize(request, control);
      }
      expect(await response.invoke()).not.toMatchObject({
        status: "ok",
        value: { state: "succeeded" }
      });
      expect(f.configure).toHaveBeenCalledTimes(phase === "configure" ? 1 : 0);
    }
  );
  it.each([
    "missing",
    "foreign-target",
    "wrong-settings",
    "stale-recipes",
    "partial-recipes",
    "configured-not-radius",
    "lost-identity"
  ])(
    "rejects fabricated successful configuration with %s evidence",
    async (scenario) => {
      const f = fixture();
      let proof = structuredClone(f.configured);
      if (scenario === "foreign-target")
        proof = { ...proof, target: { ...proof.target, environment: "other" } };
      if (
        scenario === "wrong-settings" &&
        proof.configuration?.provider === "azure"
      )
        proof = {
          ...proof,
          configuration: {
            ...proof.configuration,
            settings: { ...proof.configuration.settings, location: "other" }
          }
        };
      if (scenario === "stale-recipes")
        proof = {
          ...proof,
          recipeObservation: {
            quality: "stale",
            completeness: "complete",
            evidence: "radius"
          }
        };
      if (scenario === "partial-recipes")
        proof = {
          ...proof,
          recipeObservation: {
            quality: "current",
            completeness: "partial",
            evidence: "radius"
          }
        };
      if (scenario === "configured-not-radius")
        proof = {
          ...proof,
          recipeObservation: {
            quality: "current",
            completeness: "complete",
            evidence: "configuration"
          }
        };
      const response = await f.respond();
      f.configure.mockImplementation(async () => {
        if (scenario === "lost-identity") f.state.identity = false;
        return portSuccess({
          state: "succeeded",
          inspection: scenario === "missing" ? undefined : proof,
          observation: proof.observation,
          phases: ["environment", "workflows", "recipes"].map((phase) => ({
            phase: phase as "environment" | "workflows" | "recipes",
            status: "succeeded",
            reason: "Controlled completion."
          }))
        });
      });
      expect(await response.invoke()).toMatchObject({
        status: "ok",
        value: { state: "failed", error: { code: "EVIDENCE_MISMATCH" } }
      });
    }
  );
  it("rejects a changed patch baseline before writes and permits the original baseline on a later explicit response", async () => {
    const f = fixture();
    f.state.current = structuredClone(f.configured);
    const request: LifecycleRequestFor<"environment.configure"> = {
      ...f.request,
      operation: "environment.configure",
      input: { patch: { provider: "azure", settings: { location: "eastus" } } }
    };
    const accepted = await f.service.configure(
      { ...f.scope, operation: "environment.configure" },
      f.caller,
      request,
      f.control
    );
    if (accepted.status !== "ok" || accepted.value.state !== "action_required")
      throw new Error("Missing patch action");
    const requiredAction = accepted.value.requiredAction;
    const respond = () =>
      f.actions.respond(
        {
          ...f.scope,
          operation: "operation.respond",
          operationId: accepted.value.operationId
        },
        f.caller,
        {
          operationId: accepted.value.operationId,
          actionId: requiredAction.actionId,
          response: {
            kind: "user.decision",
            choice: "continue",
            approvalRef: "fresh-review"
          }
        },
        f.control
      );
    f.state.current = {
      ...f.state.current,
      protections: { requiredReviewers: false }
    };
    expect(await respond()).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(f.configure).not.toHaveBeenCalled();
    f.state.current = structuredClone(f.configured);
    expect(await respond()).toMatchObject({
      status: "ok",
      value: { state: "succeeded" }
    });
  });

  it("requires an explicit scoped user action before writing", async () => {
    const f = fixture();
    expect(await f.start()).toMatchObject({
      status: "ok",
      value: {
        state: "action_required",
        requiredAction: { kind: "user.decision" }
      }
    });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it("creates only the approved environment and records verified configuration phases", async () => {
    const f = fixture();
    const response = await f.respond();
    expect(await response.invoke()).toMatchObject({
      status: "ok",
      value: {
        operation: "environment.create",
        state: "succeeded",
        attempts: [],
        result: { kind: "configuration" }
      }
    });
    expect(f.configure).toHaveBeenCalledTimes(1);
    expect(f.configure.mock.calls[0]?.[1]).toMatchObject({
      change: { operation: "environment.create" },
      configuration: f.request.input.configuration,
      expected: null
    });
    expect(await response.invoke()).toMatchObject({
      status: "failed",
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    expect(f.configure).toHaveBeenCalledTimes(1);
  });
  it("retains a missing-identity action until actual authentication is observed", async () => {
    const f = fixture();
    f.state.identity = false;
    expect(await f.start()).toMatchObject({
      status: "ok",
      value: { requiredAction: { kind: "user.authenticate" } }
    });
    const response = await f.respond();
    expect(await response.invoke()).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(f.configure).not.toHaveBeenCalled();
    f.state.identity = true;
    expect(await response.invoke()).toMatchObject({
      status: "ok",
      value: { state: "succeeded" }
    });
  });
  it("rejects newly occupied environment names on continuation", async () => {
    const f = fixture();
    const response = await f.respond();
    f.state.current = f.configured;
    expect(await response.invoke()).toMatchObject({
      status: "failed",
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it("rechecks current permission before a continuation", async () => {
    const f = fixture();
    const response = await f.respond();
    f.state.forbidden = true;
    expect(await response.invoke()).toMatchObject({ status: "forbidden" });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it("retains completed effects and primary failure after partial external configuration", async () => {
    const f = fixture();
    f.state.receipt = {
      state: "failed",
      inspection: f.configured,
      observation: {
        quality: "current",
        completeness: "partial",
        evidence: "configuration"
      },
      error: lifecycleError("PRECONDITION_FAILED"),
      phases: [
        {
          phase: "environment",
          status: "succeeded",
          reason: "Environment exists."
        },
        {
          phase: "workflows",
          status: "failed",
          reason: "Publishing was rejected."
        },
        {
          phase: "recipes",
          status: "skipped",
          reason: "Publishing prerequisite failed."
        }
      ]
    };
    const response = await f.respond();
    expect(await response.invoke()).toMatchObject({
      status: "ok",
      value: {
        state: "failed",
        error: { code: "PRECONDITION_FAILED" },
        result: {
          kind: "configuration",
          phases: expect.arrayContaining([
            {
              phase: "environment",
              status: "succeeded",
              reason: "Environment exists."
            }
          ])
        }
      }
    });
  });
  it("keeps uncertain completion observable and never repeats the write", async () => {
    const f = fixture();
    f.state.receipt = {
      state: "running",
      observation: {
        quality: "unknown",
        completeness: "partial",
        evidence: "workflow"
      },
      phases: [
        {
          phase: "environment",
          status: "succeeded",
          reason: "Environment exists."
        },
        {
          phase: "workflows",
          status: "unknown",
          reason: "Publishing response unavailable."
        },
        {
          phase: "recipes",
          status: "skipped",
          reason: "Publishing is unconfirmed."
        }
      ]
    };
    const response = await f.respond();
    expect(await response.invoke()).toMatchObject({
      status: "ok",
      value: { state: "running" }
    });
    expect(await response.invoke()).toMatchObject({
      status: "failed",
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    expect(f.configure).toHaveBeenCalledTimes(1);
  });
  it("requests confirmation for a settings patch without changing protected environment settings", async () => {
    const f = fixture();
    f.state.current = structuredClone(f.configured);
    const request: LifecycleRequestFor<"environment.configure"> = {
      ...f.request,
      operation: "environment.configure",
      input: { patch: { provider: "azure", settings: { location: "eastus" } } }
    };
    const scope: AuthorizedScope<"environment.configure"> = {
      ...f.scope,
      operation: "environment.configure"
    };
    const accepted = await f.service.configure(
      scope,
      f.caller,
      request,
      f.control
    );
    expect(accepted).toMatchObject({
      status: "ok",
      value: { state: "action_required" }
    });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it("reports unsupported providers before any environment writes", async () => {
    const f = fixture();
    f.request.input.configuration = {
      provider: "aws",
      identityRef: "aws:profile",
      settings: {
        accountId: "000011112222",
        region: "us-east-1",
        roleName: "role"
      },
      recipes: []
    };
    expect(await f.start()).toMatchObject({
      status: "unavailable",
      error: { code: "CAPABILITY_UNAVAILABLE" }
    });
    expect(f.configure).not.toHaveBeenCalled();
  });
  it("fences cancelled setup before any inspection or mutation", async () => {
    const f = fixture();
    f.cancellation.aborted = true;
    expect(await f.start()).toMatchObject({ status: "cancelled" });
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.configure).not.toHaveBeenCalled();
  });
});
