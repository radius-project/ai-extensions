import { describe, expect, it } from "vitest";
import { createActionService, type ActionContinuation } from "./actions.js";
import {
  createOperationRecord,
  createSessionOperationRegistry
} from "./operations.js";
import {
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess
} from "./errors.js";
import type {
  AuthorizedScope,
  CallerContext,
  IdentityPort,
  OperationRegistryPort,
  RequestControl
} from "./ports.js";

const now = "2026-09-15T00:00:00Z";
const target = { repo: "owner/repo", environment: "dev" };
const caller: CallerContext = {
  principalRef: "principal",
  sessionRef: "session",
  identityRef: "identity",
  responder: "user"
};
const owner: AuthorizedScope<"environment.create"> = {
  authorizationRef: "auth",
  principalRef: "principal",
  operation: "environment.create",
  target
};
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Uninitialized promise");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(
  options: {
    continuation?: ActionContinuation;
    identity?: Pick<IdentityPort, "authorizeResponse">;
    expiresAt?: string;
    permittedInput?: ("approvalRef" | "configurationRef" | "identityRef")[];
    wrapRegistry?: (registry: OperationRegistryPort) => OperationRegistryPort;
  } = {}
) {
  let sequence = 0;
  const deps = {
    ids: { next: (kind: string) => `${kind}-${++sequence}` },
    clock: { now: () => now }
  };
  const registry = createSessionOperationRegistry(deps);
  const signal = { aborted: false, onAbort: () => () => {} };
  const control: RequestControl = {
    requestId: "request",
    cancellation: signal
  };
  let calls = 0;
  const identity: Pick<IdentityPort, "authorizeResponse"> =
    options.identity ?? {
      authorizeResponse: async (_caller, action) =>
        portSuccess({
          authorizationRef: "auth",
          principalRef: caller.principalRef,
          operation: "operation.respond",
          operationId: action.operationId,
          target: action.target,
          ...(action.source ? { source: action.source } : {})
        })
    };
  const service = createActionService({
    ...deps,
    registry: options.wrapRegistry?.(registry) ?? registry,
    identity
  });
  const operation = createOperationRecord(deps, {
    operation: "environment.create",
    target
  });
  const created = await registry.create(owner, operation, control);
  if (created.status !== "ok") throw new Error("Fixture create failed");
  const continuation = options.continuation ?? {
    revalidate: async () => portSuccess(undefined),
    continue: async () => {
      calls++;
      return portSuccess({
        kind: "started" as const,
        observation: operation.observation
      });
    }
  };
  const action = await service.create(
    owner,
    created.value,
    {
      kind: "user.decision",
      responder: "user",
      message: "Approve this environment",
      response: {
        kind: "user.decision",
        choices: ["approve", "decline"],
        permittedInput: options.permittedInput ?? []
      },
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {})
    },
    caller,
    continuation,
    control
  );
  if (action.status !== "ok") throw new Error("Fixture action failed");
  const input = {
    operationId: operation.operationId,
    actionId: action.value.operation.actions[0].actionId,
    response: { kind: "user.decision" as const, choice: "approve" }
  };
  const scope: AuthorizedScope<"operation.respond"> = {
    ...owner,
    operation: "operation.respond",
    operationId: operation.operationId
  };
  return {
    service,
    registry,
    control,
    signal,
    operation,
    input,
    scope,
    continuation,
    deps,
    calls: () => calls
  };
}

describe("guarded outstanding actions", () => {
  it("verifies declared approval handles and permitted identity input independently", async () => {
    const f = await fixture({
      permittedInput: ["approvalRef", "identityRef"],
      identity: {
        authorizeResponse: async (_caller, action) =>
          portSuccess({
            authorizationRef: "auth",
            principalRef: caller.principalRef,
            operation: "operation.respond",
            operationId: action.operationId,
            target: action.target,
            approvalRef: "verified-approval"
          })
      }
    });
    expect(
      await f.service.respond(
        f.scope,
        caller,
        {
          ...f.input,
          response: {
            ...f.input.response,
            approvalRef: "fabricated",
            input: { identityRef: "verified-identity" }
          }
        },
        f.control
      )
    ).toMatchObject({ status: "forbidden" });
    expect(
      await f.service.respond(
        f.scope,
        caller,
        {
          ...f.input,
          response: {
            ...f.input.response,
            approvalRef: "verified-approval",
            input: { identityRef: "verified-identity" }
          }
        },
        f.control
      )
    ).toMatchObject({ status: "ok" });
    expect(f.calls()).toBe(1);
  });
  it.each(["initial", "claim", "recheck", "lease"] as const)(
    "fences session shutdown at the %s continuation boundary",
    async (boundary) => {
      let checks = 0;
      let swaps = 0;
      let f: Awaited<ReturnType<typeof fixture>>;
      f = await fixture({
        wrapRegistry: (registry) => ({
          ...registry,
          compareAndSwap: async (scope, update, control) => {
            const result = await registry.compareAndSwap(
              scope,
              update,
              control
            );
            swaps++;
            if (
              (boundary === "claim" && swaps === 2) ||
              (boundary === "lease" && swaps === 3)
            )
              f.service.close();
            return result;
          }
        }),
        continuation: {
          revalidate: async () => {
            checks++;
            if (
              (boundary === "initial" && checks === 1) ||
              (boundary === "recheck" && checks === 2)
            )
              f.service.close();
            return portSuccess(undefined);
          },
          continue: async () => {
            throw new Error("Must not run");
          }
        }
      });
      expect(
        await f.service.respond(f.scope, caller, f.input, f.control)
      ).toMatchObject({ status: "cancelled", reason: "session_shutdown" });
    }
  );
  it("fences request cancellation immediately after the atomic action claim", async () => {
    let swaps = 0;
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({
      wrapRegistry: (registry) => ({
        ...registry,
        compareAndSwap: async (scope, update, control) => {
          const result = await registry.compareAndSwap(scope, update, control);
          if (++swaps === 2) f.signal.aborted = true;
          return result;
        }
      })
    });
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ status: "cancelled" });
    expect(f.calls()).toBe(0);
  });
  it("expires only the addressed action atomically", async () => {
    const f = await fixture({ expiresAt: now });
    const record = await f.registry.get(
      f.scope,
      f.operation.operationId,
      f.control
    );
    if (record.status !== "ok") throw new Error("Missing operation");
    await f.service.create(
      owner,
      record.value,
      {
        kind: "user.decision",
        responder: "user",
        message: "Other decision",
        response: {
          kind: "user.decision",
          choices: ["approve"],
          permittedInput: []
        }
      },
      caller,
      f.continuation,
      f.control
    );
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ error: { code: "ACTION_NOT_OUTSTANDING" } });
    expect(
      f.registry.knownOperations()[0].actions.map((action) => action.status)
    ).toEqual(["expired", "outstanding"]);
  });
  it("rejects absent dependencies and unavailable continuations at creation", async () => {
    expect(() => Reflect.apply(createActionService, undefined, [{}])).toThrow(
      "registry"
    );
    const f = await fixture();
    const record = await f.registry.get(
      f.scope,
      f.operation.operationId,
      f.control
    );
    if (record.status !== "ok") throw new Error("Missing operation");
    const details = {
      kind: "user.decision" as const,
      responder: "user" as const,
      message: "Approval",
      response: {
        kind: "user.decision" as const,
        choices: ["approve"],
        permittedInput: []
      }
    };
    expect(
      await Reflect.apply(f.service.create, undefined, [
        owner,
        record.value,
        details,
        caller,
        undefined,
        f.control
      ])
    ).toMatchObject({ status: "unavailable" });
    for (const responder of [
      { ...caller, principalRef: "" },
      { ...caller, sessionRef: "" }
    ]) {
      expect(
        await f.service.create(
          owner,
          record.value,
          details,
          responder,
          f.continuation,
          f.control
        )
      ).toMatchObject({ status: "failed" });
    }
    const terminal = {
      ...record.value,
      operation: { ...record.value.operation, state: "failed" as const }
    };
    expect(
      await f.service.create(
        owner,
        terminal,
        details,
        caller,
        f.continuation,
        f.control
      )
    ).toMatchObject({ status: "failed" });
    f.service.close();
    expect(
      await f.service.create(
        owner,
        record.value,
        details,
        caller,
        f.continuation,
        f.control
      )
    ).toMatchObject({ status: "cancelled" });
  });
  it("retains other outstanding actions and guards creation against stale revisions", async () => {
    const f = await fixture();
    const record = await f.registry.get(
      f.scope,
      f.operation.operationId,
      f.control
    );
    if (record.status !== "ok") throw new Error("Missing operation");
    const details = {
      kind: "user.decision" as const,
      responder: "user" as const,
      message: "Second approval",
      response: {
        kind: "user.decision" as const,
        choices: ["approve"],
        permittedInput: []
      }
    };
    expect(
      await f.service.create(
        owner,
        record.value,
        details,
        caller,
        f.continuation,
        f.control
      )
    ).toMatchObject({ status: "ok" });
    expect(
      await f.service.create(
        owner,
        record.value,
        details,
        caller,
        f.continuation,
        f.control
      )
    ).toMatchObject({ status: "failed" });
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({
      value: {
        state: "action_required",
        actions: [{ status: "accepted" }, { status: "outstanding" }]
      }
    });
  });
  it("does not reconstruct missing continuation bindings or leak another owner's operation", async () => {
    const f = await fixture();
    expect(
      await f.service.respond(
        { ...f.scope, principalRef: "other" },
        caller,
        f.input,
        f.control
      )
    ).toMatchObject({ status: "forbidden" });
    const other = createActionService({
      ...f.deps,
      registry: f.registry,
      identity: {
        authorizeResponse: async () => {
          throw new Error("Must not authenticate");
        }
      }
    });
    expect(
      await other.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ status: "unavailable" });
  });
  it.each([
    { principalRef: "other" },
    { operationId: "other" },
    { authorizationRef: "" },
    { target: { repo: "other/repo", environment: "dev" } }
  ])("rejects scope returned by the wrong response authority %j", (patch) => {
    return fixture({
      identity: {
        authorizeResponse: async (_caller, action) =>
          portSuccess({
            authorizationRef: "auth",
            principalRef: caller.principalRef,
            operation: "operation.respond",
            operationId: action.operationId,
            target: action.target,
            ...patch
          })
      }
    }).then(async (f) => {
      expect(
        await f.service.respond(f.scope, caller, f.input, f.control)
      ).toMatchObject({ status: "forbidden" });
      expect(f.calls()).toBe(0);
    });
  });
  it("keeps the action outstanding if precondition verification throws", async () => {
    const f = await fixture({
      continuation: {
        revalidate: async () => {
          throw new Error("source offline");
        },
        continue: async () => {
          throw new Error("Must not run");
        }
      }
    });
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ status: "unavailable" });
    expect(f.registry.knownOperations()[0].actions[0].status).toBe(
      "outstanding"
    );
  });
  it.each(["initial", "claimed", "leased", "finished"] as const)(
    "fences request cancellation at the %s boundary",
    async (boundary) => {
      let checks = 0;
      let f: Awaited<ReturnType<typeof fixture>>;
      f = await fixture({
        continuation: {
          revalidate: async () => {
            checks++;
            if (
              (boundary === "initial" && checks === 1) ||
              (boundary === "claimed" && checks === 2)
            )
              f.signal.aborted = true;
            return portSuccess(undefined);
          },
          continue: async (context) => {
            f.signal.aborted = true;
            return portSuccess({
              kind: "started",
              observation: context.operation.observation
            });
          }
        },
        wrapRegistry: (registry) => {
          let swaps = 0;
          return {
            ...registry,
            compareAndSwap: async (scope, update, control) => {
              const result = await registry.compareAndSwap(
                scope,
                update,
                control
              );
              swaps++;
              if (boundary === "leased" && swaps === 3) f.signal.aborted = true;
              return result;
            }
          };
        }
      });
      expect(
        await f.service.respond(f.scope, caller, f.input, f.control)
      ).toMatchObject({ status: "cancelled" });
      expect(f.registry.knownOperations()[0].state).not.toBe("running");
    }
  );
  it.each([2, 3, 4])(
    "propagates cancellation/refusal from registry boundary %s without rerunning work",
    async (stopAt) => {
      let swaps = 0;
      const f = await fixture({
        wrapRegistry: (registry) => ({
          ...registry,
          compareAndSwap: async (scope, update, control) => {
            swaps++;
            if (swaps === stopAt) return portCancelled("request_cancelled");
            return registry.compareAndSwap(scope, update, control);
          }
        })
      });
      expect(
        await f.service.respond(f.scope, caller, f.input, f.control)
      ).toMatchObject({ status: "cancelled" });
      expect(f.calls()).toBe(stopAt === 4 ? 1 : 0);
    }
  );
  it("rejects a cancellation update racing the final precondition check without invoking continuation", async () => {
    let checks = 0;
    let f: Awaited<ReturnType<typeof fixture>>;
    f = await fixture({
      continuation: {
        revalidate: async () => {
          if (++checks === 2) {
            const current = await f.registry.get(
              f.scope,
              f.operation.operationId,
              f.control
            );
            if (current.status !== "ok") throw new Error("Missing operation");
            await f.registry.compareAndSwap(
              f.scope,
              {
                operationId: f.operation.operationId,
                expectedRevision: current.value.revision,
                replacement: {
                  ...current.value.operation,
                  cancellationRequestedAt: now
                }
              },
              f.control
            );
          }
          return portSuccess(undefined);
        },
        continue: async () => {
          throw new Error("Must not run");
        }
      }
    });
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
    expect(f.registry.knownOperations()[0].cancellationRequestedAt).toBe(now);
  });
  it("preserves uncertainty when continuation reports cancellation without evidence", async () => {
    const f = await fixture({
      continuation: {
        revalidate: async () => portSuccess(undefined),
        continue: async () => portCancelled("request_cancelled")
      }
    });
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ status: "cancelled" });
    expect(f.registry.knownOperations()[0]).toMatchObject({
      state: "queued",
      observation: { quality: "unknown" }
    });
  });
  it("accepts only the assigned agent outcome and never treats it as a user approval", async () => {
    let sequence = 0;
    const deps = {
      ids: { next: (kind: string) => `${kind}-${++sequence}` },
      clock: { now: () => now }
    };
    const registry = createSessionOperationRegistry(deps);
    const agent: CallerContext = {
      ...caller,
      responder: "agent",
      agentBindingRef: "assigned-agent"
    };
    const source = {
      kind: "workspace" as const,
      repo: "owner/repo",
      workspaceRef: "workspace",
      branch: "feature",
      fingerprint: `sha256:${"a".repeat(64)}`,
      resolvedAt: now
    };
    const target = {
      repo: source.repo,
      definition: ".radius/app.bicep",
      source: {
        kind: "workspace" as const,
        workspaceRef: source.workspaceRef,
        branch: source.branch,
        expectedFingerprint: source.fingerprint
      }
    };
    const scope: AuthorizedScope<"definition.author"> = {
      authorizationRef: "auth",
      principalRef: agent.principalRef,
      operation: "definition.author",
      target,
      source
    };
    const control: RequestControl = {
      requestId: "request",
      cancellation: { aborted: false, onAbort: () => () => {} }
    };
    const operation = createOperationRecord(deps, {
      operation: "definition.author",
      target,
      source
    });
    const created = await registry.create(scope, operation, control);
    if (created.status !== "ok") throw new Error("Missing operation");
    const service = createActionService({
      ...deps,
      registry,
      identity: {
        authorizeResponse: async (responder, action) =>
          portSuccess({
            authorizationRef: "auth",
            principalRef: responder.principalRef,
            operation: "operation.respond",
            operationId: action.operationId,
            target: action.target,
            source: action.source
          })
      }
    });
    let continuations = 0;
    const continuation: ActionContinuation = {
      revalidate: async () => portSuccess(undefined),
      continue: async (context) => {
        continuations++;
        expect(context.response).toMatchObject({
          kind: "agent.outcome",
          status: "completed",
          stagedOutputRefs: ["staging/app.bicep"]
        });
        return portSuccess({
          kind: "started",
          observation: operation.observation
        });
      }
    };
    const details = {
      kind: "agent.author_definition" as const,
      responder: "agent" as const,
      message: "Author the definition",
      response: { kind: "agent.outcome" as const }
    };
    expect(
      await service.create(
        scope,
        created.value,
        details,
        caller,
        continuation,
        control
      )
    ).toMatchObject({ status: "failed" });
    const action = await service.create(
      scope,
      created.value,
      details,
      agent,
      continuation,
      control
    );
    if (action.status !== "ok") throw new Error("Missing action");
    const respondScope: AuthorizedScope<"operation.respond"> = {
      ...scope,
      operation: "operation.respond",
      operationId: operation.operationId
    };
    const input = {
      operationId: operation.operationId,
      actionId: action.value.operation.actions[0].actionId,
      response: {
        kind: "agent.outcome" as const,
        status: "completed" as const,
        stagedOutputRefs: ["staging/app.bicep"]
      }
    };
    expect(
      await service.respond(respondScope, caller, input, control)
    ).toMatchObject({ error: { code: "ACTION_RESPONSE_INVALID" } });
    expect(
      await service.respond(
        respondScope,
        agent,
        { ...input, response: { kind: "user.decision", choice: "approve" } },
        control
      )
    ).toMatchObject({ error: { code: "ACTION_RESPONSE_INVALID" } });
    expect(
      await service.respond(
        respondScope,
        { ...agent, agentBindingRef: "other" },
        input,
        control
      )
    ).toMatchObject({ status: "forbidden" });
    expect(
      await service.respond(respondScope, agent, input, control)
    ).toMatchObject({ value: { state: "running" } });
    expect(continuations).toBe(1);
  });
  it("consumes approval once without declaring the parent successful", async () => {
    const f = await fixture();
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({
      status: "ok",
      value: { state: "running", actions: [{ status: "accepted" }] }
    });
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({
      status: "failed",
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    expect(f.calls()).toBe(1);
  });
  it("serializes simultaneous responses with a revision claim before side effects", async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.service.respond(f.scope, caller, f.input, f.control),
      f.service.respond(f.scope, caller, f.input, f.control)
    ]);
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(f.calls()).toBe(1);
  });
  it.each([
    { principalRef: "other" },
    { sessionRef: "other" },
    { agentBindingRef: "unexpected" },
    { responder: "agent" as const }
  ])("rejects a mismatched trusted responder %j", async (change) => {
    const f = await fixture();
    expect(
      await f.service.respond(
        f.scope,
        { ...caller, ...change },
        f.input,
        f.control
      )
    ).not.toMatchObject({ status: "ok" });
    expect(f.calls()).toBe(0);
  });
  it("rejects wrong kinds, undeclared choices/inputs and expired responses", async () => {
    const f = await fixture();
    for (const response of [
      {
        kind: "agent.outcome" as const,
        status: "completed" as const,
        stagedOutputRefs: ["staging/app.bicep"]
      },
      { kind: "user.decision" as const, choice: "invented" },
      { ...f.input.response, approvalRef: "unapproved" },
      { ...f.input.response, input: { identityRef: "unapproved" } }
    ]) {
      expect(
        await f.service.respond(
          f.scope,
          caller,
          { ...f.input, response },
          f.control
        )
      ).toMatchObject({ error: { code: "ACTION_RESPONSE_INVALID" } });
    }
    const expired = await fixture({ expiresAt: now });
    expect(
      await expired.service.respond(
        expired.scope,
        caller,
        expired.input,
        expired.control
      )
    ).toMatchObject({ error: { code: "ACTION_NOT_OUTSTANDING" } });
    expect(f.calls()).toBe(0);
  });
  it("keeps actions outstanding when authority or initial preconditions fail", async () => {
    for (const identity of [
      { authorizeResponse: async () => portForbidden() },
      {
        authorizeResponse: async () => {
          throw new Error("offline");
        }
      }
    ]) {
      const f = await fixture({ identity });
      expect(
        await f.service.respond(f.scope, caller, f.input, f.control)
      ).not.toMatchObject({ status: "ok" });
      expect(f.registry.knownOperations()[0].actions[0].status).toBe(
        "outstanding"
      );
      expect(f.calls()).toBe(0);
    }
    const f = await fixture({
      continuation: {
        revalidate: async () => portFailure("SOURCE_CHANGED"),
        continue: async () => {
          throw new Error("Must not run");
        }
      }
    });
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ error: { code: "SOURCE_CHANGED" } });
    expect(f.registry.knownOperations()[0].actions[0].status).toBe(
      "outstanding"
    );
  });
  it("never retries a consumed response after ambiguous continuation failure", async () => {
    let calls = 0;
    const f = await fixture({
      continuation: {
        revalidate: async () => portSuccess(undefined),
        continue: async () => {
          calls++;
          throw new Error("receipt lost");
        }
      }
    });
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ status: "unavailable" });
    expect(f.registry.knownOperations()[0]).toMatchObject({
      state: "queued",
      actions: [{ status: "accepted" }],
      observation: { quality: "unknown" }
    });
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ error: { code: "ACTION_NOT_OUTSTANDING" } });
    expect(calls).toBe(1);
  });
  it("rechecks preconditions after the claim and before continuation", async () => {
    let checks = 0;
    const f = await fixture({
      continuation: {
        revalidate: async () =>
          ++checks === 1 ?
            portSuccess(undefined)
          : portFailure("SOURCE_CHANGED"),
        continue: async () => {
          throw new Error("Must not run");
        }
      }
    });
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ error: { code: "SOURCE_CHANGED" } });
    expect(checks).toBe(2);
    expect(f.registry.knownOperations()[0].actions[0].status).toBe("accepted");
  });
  it("fences shutdown and late continuation completion", async () => {
    const entered = deferred<void>();
    const finished = deferred<void>();
    const f = await fixture({
      continuation: {
        revalidate: async () => portSuccess(undefined),
        continue: async (context) => {
          entered.resolve();
          await finished.promise;
          return portSuccess({
            kind: "started",
            observation: context.operation.observation
          });
        }
      }
    });
    const response = f.service.respond(f.scope, caller, f.input, f.control);
    await entered.promise;
    f.service.close();
    finished.resolve();
    expect(await response).toMatchObject({
      status: "cancelled",
      reason: "session_shutdown"
    });
    expect(f.registry.knownOperations()[0].state).toBe("queued");
    expect(
      await f.service.respond(f.scope, caller, f.input, f.control)
    ).toMatchObject({ status: "cancelled" });
  });
  it("returns unavailable for missing operations rather than constructing new work", async () => {
    const f = await fixture();
    expect(
      await f.service.respond(
        { ...f.scope, operationId: "missing" },
        caller,
        { ...f.input, operationId: "missing" },
        f.control
      )
    ).toMatchObject({ error: { code: "OPERATION_UNAVAILABLE" } });
    expect(f.calls()).toBe(0);
  });
});
