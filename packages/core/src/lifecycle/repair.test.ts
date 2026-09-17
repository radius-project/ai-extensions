import { expect, it, vi } from "vitest";
import { createRepair } from "./repair.js";
import {
  createOperationRecord,
  createSessionOperationRegistry
} from "./operations.js";
import { portSuccess, portForbidden } from "./errors.js";
import type { AuthorizedScope, RequestControl } from "./ports.js";

it("requires complete construction ports rather than installing an empty success service", () => {
  // @ts-expect-error JavaScript callers must supply the required ports.
  expect(() => createRepair({})).toThrow("Repair requires");
});
async function fixture() {
  let sequence = 0;
  const ids = { next: () => `id-${++sequence}` };
  const clock = { now: () => "2026-09-17T19:00:00Z" };
  const registry = createSessionOperationRegistry({ ids, clock });
  const caller = {
    principalRef: "principal",
    sessionRef: "session",
    identityRef: "identity",
    responder: "user" as const,
    approvedHostActionRef: "approval",
    agentBindingRef: "agent"
  };
  const target = { repo: "owner/repo" };
  const source = {
    kind: "workspace" as const,
    workspaceRef: "workspace",
    branch: "feature",
    expectedFingerprint: `sha256:${"a".repeat(64)}`
  };
  const control: RequestControl = {
    requestId: "request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const scope: AuthorizedScope<"operation.repair"> = {
    operation: "operation.repair",
    principalRef: "principal",
    authorizationRef: "authority",
    approvalRef: "approval",
    target
  };
  const original = createOperationRecord(
    { ids, clock },
    {
      operation: "definition.author",
      target: { ...target, source, definition: ".radius/app.bicep" }
    }
  );
  const created = await registry.create(
    {
      ...scope,
      operation: "definition.author",
      target: original.target as AuthorizedScope<"definition.author">["target"]
    },
    original,
    control
  );
  if (created.status !== "ok") throw new Error(JSON.stringify(created));
  const failed = await registry.compareAndSwap(
    scope,
    {
      operationId: original.operationId,
      expectedRevision: created.value.revision,
      replacement: {
        ...original,
        state: "failed",
        error: {
          code: "VALIDATION_FAILED",
          message: "Validation failed.",
          retryable: false
        }
      }
    },
    control
  );
  if (failed.status !== "ok") throw new Error(JSON.stringify(failed));
  const identity: Parameters<typeof createRepair>[0]["identity"] = {
    authorize: async (request) =>
      portSuccess({
        ...request,
        principalRef: caller.principalRef,
        authorizationRef: "renewed"
      })
  };
  const start = vi.fn<
    NonNullable<Parameters<typeof createRepair>[0]["executor"]>["start"]
  >(async (_scope, _caller, plan) => {
    const operation = {
      ...createOperationRecord(
        { ids, clock },
        {
          operation: "operation.repair",
          target: plan.target,
          source: {
            kind: "workspace" as const,
            ...target,
            workspaceRef: source.workspaceRef,
            branch: source.branch,
            fingerprint: source.expectedFingerprint,
            resolvedAt: clock.now()
          }
        }
      ),
      repairsOperationId: plan.failed.operationId,
      repairPolicy: plan.policy
    };
    const record = await registry.create(
      { ...scope, target: plan.target },
      operation,
      control
    );
    return record.status === "ok" ?
        portSuccess(record.value.operation)
      : record;
  });
  const service = createRepair({ registry, identity, executor: { start } });
  const request = (maxAttempts = 5) =>
    service.repair(
      scope,
      caller,
      {
        operationId: original.operationId,
        source,
        repairPolicy: { mode: "manual", maxAttempts },
        approvalRef: "approval"
      },
      control
    );
  return {
    service,
    request,
    registry,
    original,
    start,
    scope,
    caller,
    source,
    control,
    identity
  };
}

it("reports unavailable records and a closed registry without starting work", async () => {
  const f = await fixture();
  expect(
    await f.service.repair(
      f.scope,
      f.caller,
      {
        operationId: "missing",
        source: f.source,
        repairPolicy: { mode: "manual", maxAttempts: 5 }
      },
      f.control
    )
  ).toMatchObject({ status: "unavailable" });
  await f.registry.close();
  expect(await f.request()).toMatchObject({ status: "cancelled" });
  expect(f.start).not.toHaveBeenCalled();
});
it("rejects nonterminal repair targets", async () => {
  const f = await fixture();
  const record = createOperationRecord(
    {
      ids: { next: () => "pending" },
      clock: { now: () => "2026-09-17T19:00:00Z" }
    },
    {
      operation: "definition.author",
      target: f.original.target
    }
  );
  expect(
    await f.registry.create(
      {
        ...f.scope,
        operation: "definition.author",
        target: {
          ...f.original.target,
          definition: ".radius/app.bicep",
          source: f.source
        }
      },
      record,
      f.control
    )
  ).toMatchObject({ status: "ok" });
  expect(
    await f.service.repair(
      f.scope,
      f.caller,
      {
        operationId: "pending",
        source: f.source,
        repairPolicy: { mode: "manual", maxAttempts: 5 }
      },
      f.control
    )
  ).toMatchObject({ status: "failed", error: { code: "PRECONDITION_FAILED" } });
  expect(f.start).not.toHaveBeenCalled();
});
it.each(["principal", "approval", "policy", "source"] as const)(
  "rejects changed %s authority at repair admission",
  async (field) => {
    const f = await fixture();
    f.identity.authorize = async (request) =>
      portSuccess({
        ...request,
        authorizationRef: "renewed",
        principalRef: field === "principal" ? "other" : f.caller.principalRef,
        approvalRef: field === "approval" ? "other" : "approval",
        ...(field === "policy" ?
          { repairPolicy: { mode: "manual" as const, maxAttempts: 1 } }
        : {}),
        ...(field === "source" ?
          {
            target: {
              ...request.target,
              source: { ...f.source, branch: "other" }
            }
          }
        : {})
      });
    expect(await f.request()).toMatchObject({ status: "forbidden" });
    expect(f.start).not.toHaveBeenCalled();
  }
);
it("fences admission when cancellation wins the authorization await", async () => {
  const f = await fixture();
  let aborted = false;
  f.identity.authorize = async (request) => {
    aborted = true;
    return portSuccess({
      ...request,
      principalRef: f.caller.principalRef,
      authorizationRef: "current"
    });
  };
  expect(
    await f.service.repair(
      f.scope,
      f.caller,
      {
        operationId: f.original.operationId,
        source: f.source,
        repairPolicy: { mode: "manual", maxAttempts: 5 }
      },
      {
        ...f.control,
        cancellation: {
          get aborted() {
            return aborted;
          },
          onAbort: () => () => {}
        }
      }
    )
  ).toMatchObject({ status: "cancelled" });
  expect(f.start).not.toHaveBeenCalled();
});
it("does not treat an incomplete automatic response as a new repair cycle", async () => {
  const f = await fixture();
  const accepted = await f.service.repair(
    f.scope,
    f.caller,
    {
      operationId: f.original.operationId,
      source: f.source,
      repairPolicy: { mode: "automatic", maxAttempts: 5 }
    },
    f.control
  );
  if (accepted.status !== "ok") throw new Error(JSON.stringify(accepted));
  expect(
    await f.service.afterResponse(accepted.value.operationId, f.control)
  ).toBeUndefined();
  expect(f.start).toHaveBeenCalledOnce();
});

it("links a new repair without rewriting the failed parent", async () => {
  const f = await fixture();
  const result = await f.request();
  expect(result).toMatchObject({
    status: "ok",
    value: {
      operation: "operation.repair",
      repairsOperationId: f.original.operationId
    }
  });

  expect(
    await f.registry.get(f.scope, f.original.operationId, f.control)
  ).toMatchObject({ status: "ok", value: { operation: { state: "failed" } } });
  expect(f.start).toHaveBeenCalledOnce();
});

it.each(["manual", "automatic"] as const)(
  "runs %s follow-up only from a completed response, never reads",
  async (mode) => {
    const f = await fixture();
    const first = await f.service.repair(
      f.scope,
      f.caller,
      {
        operationId: f.original.operationId,
        source: f.source,
        repairPolicy: { mode, maxAttempts: 2 }
      },
      f.control
    );
    if (first.status !== "ok") throw new Error(JSON.stringify(first));
    const fail = async (operationId: string) => {
      const stored = await f.registry.get(f.scope, operationId, f.control);
      if (stored.status !== "ok") throw new Error(JSON.stringify(stored));
      expect(
        await f.registry.compareAndSwap(
          f.scope,
          {
            operationId,
            expectedRevision: stored.value.revision,
            replacement: {
              ...stored.value.operation,
              state: "failed",
              error: {
                code: "VALIDATION_FAILED",
                message: "Repair failed.",
                retryable: false
              }
            }
          },
          f.control
        )
      ).toMatchObject({ status: "ok" });
    };
    await fail(first.value.operationId);
    for (let index = 0; index < 100; index++)
      await f.registry.get(f.scope, first.value.operationId, f.control);
    expect(f.start).toHaveBeenCalledOnce();
    const second = await f.service.afterResponse(
      first.value.operationId,
      f.control
    );
    expect(
      await f.service.afterResponse(first.value.operationId, f.control)
    ).toBeUndefined();
    if (mode === "manual") {
      expect(second).toBeUndefined();
      expect(f.start).toHaveBeenCalledOnce();
      return;
    }
    if (second?.status !== "ok") throw new Error(JSON.stringify(second));
    await fail(second.value.operationId);
    expect(
      await f.service.afterResponse(second.value.operationId, f.control)
    ).toMatchObject({
      status: "failed",
      error: { code: "REPAIR_LIMIT_REACHED" }
    });
    expect(f.start).toHaveBeenCalledTimes(3);
  }
);

it("fences an admitted automatic policy on shutdown", async () => {
  const f = await fixture();
  const accepted = await f.service.repair(
    f.scope,
    f.caller,
    {
      operationId: f.original.operationId,
      source: f.source,
      repairPolicy: { mode: "automatic", maxAttempts: 5 }
    },
    f.control
  );
  if (accepted.status !== "ok") throw new Error(JSON.stringify(accepted));
  f.service.close();
  expect(
    await f.service.afterResponse(accepted.value.operationId, f.control)
  ).toBeUndefined();
  expect(await f.request()).toMatchObject({ status: "cancelled" });
  expect(f.start).toHaveBeenCalledOnce();
});

it("does not convert authority refusal into an automatic retry", async () => {
  const f = await fixture();
  f.identity.authorize = async () => portForbidden();
  expect(await f.request()).toMatchObject({ status: "forbidden" });
  expect(f.start).not.toHaveBeenCalled();
});
it.each([0, -1, 6, 1.5])(
  "rejects unavailable or invalid repair budget %s before agent work",
  async (max) => {
    const f = await fixture();
    expect(await f.request(max)).toMatchObject({
      status: "failed",
      error: { code: max === 0 ? "REPAIR_LIMIT_REACHED" : "INVALID_REQUEST" }
    });
    expect(f.start).not.toHaveBeenCalled();
  }
);
it("does not admit concurrent repairs of the same failed operation", async () => {
  const f = await fixture();
  const results = await Promise.all([f.request(), f.request()]);
  expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
});
it("keeps a shared five-cycle ceiling when repairs branch from the original failure", async () => {
  const f = await fixture();
  for (let cycle = 0; cycle < 5; cycle++) {
    const accepted = await f.request();
    if (accepted.status !== "ok") throw new Error(JSON.stringify(accepted));
    const read = await f.registry.get(
      f.scope,
      accepted.value.operationId,
      f.control
    );
    if (read.status !== "ok") throw new Error(JSON.stringify(read));
    const failed = await f.registry.compareAndSwap(
      f.scope,
      {
        operationId: read.value.operation.operationId,
        expectedRevision: read.value.revision,
        replacement: {
          ...read.value.operation,
          state: "failed",
          error: {
            code: "VALIDATION_FAILED",
            message: "The approved repair failed.",
            retryable: false
          }
        }
      },
      f.control
    );
    expect(failed.status).toBe("ok");
  }
  expect(await f.request()).toMatchObject({
    status: "failed",
    error: { code: "REPAIR_LIMIT_REACHED" }
  });
  expect(f.start).toHaveBeenCalledTimes(6);
  const records = await f.registry.list(
    { ...f.scope, operation: "operation.list" },
    {},
    f.control
  );
  if (records.status !== "ok") throw new Error(JSON.stringify(records));
  expect(records.value.items).toHaveLength(6);
});
it("retains a stricter family budget across linked failed repairs", async () => {
  const f = await fixture();
  const accepted = await f.request(1);
  if (accepted.status !== "ok") throw new Error(JSON.stringify(accepted));
  const read = await f.registry.get(
    f.scope,
    accepted.value.operationId,
    f.control
  );
  if (read.status !== "ok") throw new Error(JSON.stringify(read));
  expect(
    await f.registry.compareAndSwap(
      f.scope,
      {
        operationId: accepted.value.operationId,
        expectedRevision: read.value.revision,
        replacement: {
          ...accepted.value,
          state: "failed",
          error: {
            code: "VALIDATION_FAILED",
            message: "Repair failed.",
            retryable: false
          }
        }
      },
      f.control
    )
  ).toMatchObject({ status: "ok" });
  expect(
    await f.service.repair(
      f.scope,
      f.caller,
      {
        operationId: accepted.value.operationId,
        source: f.source,
        repairPolicy: { mode: "manual", maxAttempts: 5 }
      },
      f.control
    )
  ).toMatchObject({
    status: "failed",
    error: { code: "REPAIR_LIMIT_REACHED" }
  });
});
it("does not treat an automatic policy as authority to publish or redeploy", async () => {
  const f = await fixture();
  expect(
    await f.service.repair(
      f.scope,
      f.caller,
      {
        operationId: f.original.operationId,
        source: f.source,
        repairPolicy: { mode: "automatic", maxAttempts: 2 }
      },
      f.control
    )
  ).toMatchObject({
    status: "ok",
    value: { repairPolicy: { mode: "automatic", maxAttempts: 2 } }
  });
  expect(f.start.mock.calls[0]?.[2].policy).toEqual({
    mode: "automatic",
    maxAttempts: 2
  });
});
it.each(["approval", "caller", "agent", "executor"] as const)(
  "fails closed without trusted %s capability",
  async (missing) => {
    const f = await fixture();
    const service =
      missing === "executor" ?
        createRepair({ registry: f.registry, identity: f.identity })
      : f.service;
    const result = await service.repair(
      missing === "approval" ? { ...f.scope, approvalRef: undefined } : f.scope,
      missing === "caller" ? { ...f.caller, approvedHostActionRef: "other" }
      : missing === "agent" ? { ...f.caller, agentBindingRef: undefined }
      : f.caller,
      {
        operationId: f.original.operationId,
        source: f.source,
        repairPolicy: { mode: "manual", maxAttempts: 5 }
      },
      f.control
    );
    expect(result.status).toBe(
      missing === "agent" || missing === "executor" ?
        "unavailable"
      : "forbidden"
    );
    expect(f.start).not.toHaveBeenCalled();
  }
);
