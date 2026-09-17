import { expect, it, vi } from "vitest";
import { createCancellation } from "./cancellation.js";
import {
  createSessionOperationRegistry,
  createOperationRecord
} from "./operations.js";
import { portFailure, portSuccess, portUnavailable } from "./errors.js";
import type {
  AuthorizedScope,
  RequestControl,
  WorkflowExecutionPort
} from "./ports.js";

async function fixture() {
  let sequence = 0;
  const ids = { next: () => `id-${++sequence}` };
  const clock = { now: () => "2026-09-17T19:00:00Z" };
  const control: RequestControl = {
    requestId: "request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const caller = {
    principalRef: "principal",
    sessionRef: "session",
    identityRef: "identity",
    responder: "user" as const
  };
  const target = { repo: "owner/repo", environment: "dev", application: "app" };
  const scope: AuthorizedScope<"operation.cancel"> = {
    operation: "operation.cancel",
    authorizationRef: "authority",
    principalRef: "principal",
    target
  };
  const source = {
    kind: "git" as const,
    repo: target.repo,
    ref: "feature",
    commit: "a".repeat(40),
    fingerprint: `sha256:${"b".repeat(64)}`,
    resolvedAt: clock.now()
  };
  const deploymentTarget = {
    ...target,
    definition: ".radius/app.bicep",
    source: {
      kind: "git" as const,
      ref: source.ref,
      expectedCommit: source.commit
    }
  };
  const base = createOperationRecord(
    { ids, clock },
    { operation: "deployment.start", target: deploymentTarget, source }
  );
  const registry = createSessionOperationRegistry({ ids, clock });
  const created = await registry.create(
    { ...scope, operation: "deployment.start", target: deploymentTarget },
    {
      ...base,
      attempts: [
        {
          operationId: base.operationId,
          attemptId: "attempt",
          expectedCommit: source.commit,
          phases: [
            {
              phase: "state-save",
              status: "failed",
              exitCode: 1,
              reason: "State save failed."
            }
          ],
          observation: base.observation,
          run: {
            repo: target.repo,
            workflow: ".github/workflows/run.yml",
            runId: "42",
            runAttempt: 2,
            commit: source.commit,
            conclusion: "in_progress"
          }
        }
      ]
    },
    control
  );
  if (created.status !== "ok") throw new Error(JSON.stringify(created));
  const identity: Parameters<typeof createCancellation>[0]["identity"] = {
    authorize: async (request) =>
      portSuccess({
        ...request,
        principalRef: request.caller.principalRef,
        authorizationRef: "current"
      })
  };
  const cancel = vi.fn<WorkflowExecutionPort["cancel"]>(async () =>
    portSuccess({
      status: "requested",
      requestedAt: clock.now(),
      observation: base.observation
    })
  );
  const observe = vi.fn<WorkflowExecutionPort["observe"]>(async () =>
    portUnavailable("RESULT_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "workflow"
    })
  );
  const service = createCancellation({
    registry,
    identity,
    clock,
    workflow: { cancel, observe }
  });
  const request = () =>
    service.cancel(scope, caller, base.operationId, control);
  return {
    scope,
    caller,
    control,
    registry,
    service,
    request,
    cancel,
    observe,
    identity,
    clock,
    created: created.value
  };
}

it("requires actual cancellation ports", () => {
  // @ts-expect-error JavaScript callers must provide the required ports.
  expect(() => createCancellation({})).toThrow("Cancellation requires");
});
it.each(["refused", "changed"] as const)(
  "revalidates %s cancellation authority",
  async (mode) => {
    const f = await fixture();
    f.identity.authorize = async (request) =>
      mode === "refused" ?
        portFailure("PRECONDITION_FAILED")
      : portSuccess({
          ...request,
          authorizationRef: "current",
          principalRef: "different-principal"
        });
    expect(await f.request()).toMatchObject({
      status: mode === "refused" ? "failed" : "forbidden"
    });
    expect(f.cancel).not.toHaveBeenCalled();
  }
);
it.each(["before", "after"] as const)(
  "fences request cancellation %s transport work",
  async (when) => {
    const f = await fixture();
    let aborted = when === "before";
    f.cancel.mockImplementation(async () => {
      aborted = true;
      return portSuccess({
        status: "requested",
        requestedAt: f.clock.now(),
        observation: f.created.operation.observation
      });
    });
    expect(
      await f.service.cancel(
        f.scope,
        f.caller,
        f.created.operation.operationId,
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
    expect(f.cancel).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
  }
);
it("does not invent a final outcome after registry shutdown during cancellation", async () => {
  const f = await fixture();
  f.cancel.mockImplementation(async () => {
    await f.registry.close();
    return portSuccess({
      status: "requested",
      requestedAt: f.clock.now(),
      observation: f.created.operation.observation
    });
  });
  expect(await f.request()).toMatchObject({ status: "cancelled" });
});
it.each(["confirmed", "mismatched", "revision-race"] as const)(
  "reduces %s workflow evidence without discarding state-save failure",
  async (mode) => {
    const f = await fixture();
    f.observe.mockImplementation(async (_scope, identity) => {
      if (mode === "revision-race") {
        const current = await f.registry.get(
          f.scope,
          f.created.operation.operationId,
          f.control
        );
        if (current.status !== "ok") throw new Error(JSON.stringify(current));
        expect(
          await f.registry.compareAndSwap(
            f.scope,
            {
              operationId: current.value.operation.operationId,
              expectedRevision: current.value.revision,
              replacement: {
                ...current.value.operation,
                state: "failed",
                error: {
                  code: "PRECONDITION_FAILED",
                  message: "Execution failed before cancellation.",
                  retryable: false
                }
              }
            },
            f.control
          )
        ).toMatchObject({ status: "ok" });
      }
      return portSuccess({
        identity:
          mode === "mismatched" ?
            { ...identity, attemptId: "other" }
          : identity,
        conclusion: "cancelled",
        evidence: portUnavailable("RESULT_UNAVAILABLE", {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "workflow"
        }),
        observation: f.created.operation.observation
      });
    });
    const result = await f.request();
    expect(result).toMatchObject(
      mode === "confirmed" ?
        {
          status: "ok",
          value: {
            operation: {
              state: "cancelled",
              attempts: [
                { phases: [{ phase: "state-save", status: "failed" }] }
              ]
            }
          }
        }
      : { status: "failed" }
    );
  }
);

it("requests the known run once while preserving phase evidence and original state", async () => {
  const f = await fixture();
  const result = await f.request();
  expect(result).toMatchObject({
    status: "ok",
    value: {
      cancellation: { status: "requested" },
      operation: {
        state: "queued",
        cancellationRequestedAt: expect.any(String),
        attempts: [{ phases: [{ phase: "state-save", status: "failed" }] }]
      }
    }
  });

  expect(f.cancel.mock.calls[0]?.[1]).toMatchObject({
    attemptId: "attempt",
    run: { runId: "42", runAttempt: 2 }
  });
  expect(await f.request()).toMatchObject({
    status: "ok",
    value: { cancellation: { status: "already_requested" } }
  });
  expect(f.cancel).toHaveBeenCalledOnce();
});

it("keeps a terminal completion race instead of manufacturing cancellation", async () => {
  const f = await fixture();
  f.cancel.mockImplementation(async () => {
    const current = await f.registry.get(
      f.scope,
      f.created.operation.operationId,
      f.control
    );
    if (current.status !== "ok") throw new Error(JSON.stringify(current));
    expect(
      await f.registry.compareAndSwap(
        f.scope,
        {
          operationId: current.value.operation.operationId,
          expectedRevision: current.value.revision,
          replacement: {
            ...current.value.operation,
            state: "failed",
            error: {
              code: "PRECONDITION_FAILED",
              message: "State persistence failed.",
              retryable: false
            }
          }
        },
        f.control
      )
    ).toMatchObject({ status: "ok" });
    return portSuccess({
      status: "confirmed",
      requestedAt: f.clock.now(),
      observation: f.created.operation.observation
    });
  });
  expect(await f.request()).toMatchObject({
    status: "ok",
    value: {
      operation: {
        state: "failed",
        attempts: [{ phases: [{ phase: "state-save", status: "failed" }] }]
      }
    }
  });
  expect(f.observe).not.toHaveBeenCalled();
  expect(await f.request()).toMatchObject({
    status: "ok",
    value: { cancellation: { status: "not_cancellable" } }
  });
});
it("reports absent and unsupported executions rather than guessing a run", async () => {
  const f = await fixture();
  expect(
    await f.service.cancel(f.scope, f.caller, "missing", f.control)
  ).toMatchObject({ status: "unavailable" });
  const service = createCancellation({
    registry: f.registry,
    identity: f.identity,
    clock: f.clock
  });
  expect(
    await service.cancel(
      f.scope,
      f.caller,
      f.created.operation.operationId,
      f.control
    )
  ).toMatchObject({
    status: "ok",
    value: { cancellation: { status: "unavailable" } }
  });
  expect(f.cancel).not.toHaveBeenCalled();
});
it.each(["requested", "confirmed"] as const)(
  "only terminalizes a local operation after %s cancellation evidence",
  async (status) => {
    const f = await fixture();
    const target = {
      repo: "owner/repo",
      definition: ".radius/app.bicep",
      source: {
        kind: "workspace" as const,
        workspaceRef: "workspace",
        branch: "feature",
        expectedFingerprint: `sha256:${"a".repeat(64)}`
      }
    };
    const scope = { ...f.scope, target };
    const record = createOperationRecord(
      { ids: { next: () => "author" }, clock: f.clock },
      { operation: "definition.author", target }
    );
    expect(
      await f.registry.create(
        { ...scope, operation: "definition.author" },
        record,
        f.control
      )
    ).toMatchObject({ status: "ok" });
    const cancel = vi.fn(async () =>
      portSuccess({
        status,
        requestedAt: f.clock.now(),
        observation: record.observation
      })
    );
    const service = createCancellation({
      registry: f.registry,
      identity: f.identity,
      clock: f.clock,
      local: { cancel }
    });
    expect(
      await service.cancel(scope, f.caller, record.operationId, f.control)
    ).toMatchObject({
      status: "ok",
      value: {
        operation: { state: status === "confirmed" ? "cancelled" : "queued" }
      }
    });
    expect(cancel).toHaveBeenCalledOnce();
  }
);
it("records an uncertain thrown cancellation without leaking transport details", async () => {
  const f = await fixture();
  f.cancel.mockRejectedValue(new Error("private transport context"));
  const result = await f.request();
  expect(result).toMatchObject({
    status: "ok",
    value: { cancellation: { status: "unavailable" } }
  });
  expect(JSON.stringify(result)).not.toContain("private transport context");
});
it("reserves a cancellation before awaiting the remote request", async () => {
  const f = await fixture();
  await Promise.all([f.request(), f.request()]);
  expect(f.cancel).toHaveBeenCalledOnce();
});

it("does not reinterpret a transport failure as confirmed cancellation", async () => {
  const f = await fixture();
  f.cancel.mockResolvedValue(portFailure("PRECONDITION_FAILED"));
  expect(await f.request()).toMatchObject({
    status: "ok",
    value: {
      cancellation: { status: "unavailable" },
      operation: { state: "queued" }
    }
  });
  expect(await f.request()).toMatchObject({
    status: "ok",
    value: { cancellation: { status: "already_requested" } }
  });
});

it("rejects unauthorized targets before remote cancellation", async () => {
  const f = await fixture();
  expect(
    await f.service.cancel(
      { ...f.scope, target: { ...f.scope.target, environment: "other" } },
      f.caller,
      f.created.operation.operationId,
      f.control
    )
  ).toMatchObject({ status: "forbidden" });
  expect(f.cancel).not.toHaveBeenCalled();
});
