import { expect, it, vi } from "vitest";
import { createDeployment } from "./deployment.js";
import { createOperationReads } from "./operation-reads.js";
import { createSessionOperationRegistry } from "./operations.js";
import {
  lifecycleError,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable
} from "./errors.js";
import type {
  AuthorizationRequest,
  AuthorizedScope,
  CallerContext,
  DeploymentDependencies,
  ExecutionIdentity,
  LifecycleOperation,
  LifecycleRequestFor,
  PortResult,
  RequestControl,
  WorkflowPreparation
} from "./index.js";

function fixture() {
  let sequence = 0;
  const ids = { next: () => `id-${++sequence}` };
  const clock = { now: () => "2026-09-16T00:00:00Z" };
  const registry = createSessionOperationRegistry({ ids, clock });
  const control: RequestControl = {
    requestId: "request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const caller: CallerContext = {
    principalRef: "principal",
    sessionRef: "session",
    identityRef: "identity",
    responder: "user"
  };
  const target = {
    repo: "owner/repo",
    environment: "dev",
    application: "app",
    definition: ".radius/app.bicep",
    source: {
      kind: "git" as const,
      ref: "feature",
      expectedCommit: "a".repeat(40)
    }
  };
  const source = {
    kind: "git" as const,
    repo: target.repo,
    ref: "feature",
    commit: "a".repeat(40),
    fingerprint: `sha256:${"b".repeat(64)}`,
    resolvedAt: clock.now()
  };
  const scope: AuthorizedScope<"deployment.start"> = {
    authorizationRef: "authority",
    principalRef: caller.principalRef,
    operation: "deployment.start",
    target,
    source,
    approvalRef: "approval"
  };
  const request: LifecycleRequestFor<"deployment.start"> = {
    apiVersion: "github-radius/v1",
    requestId: control.requestId,
    operation: "deployment.start",
    target,
    input: {
      approvalRef: "approval",
      repairPolicy: { mode: "manual", maxAttempts: 0 }
    }
  };
  let prepared: WorkflowPreparation | undefined;
  let saveFailed = false;
  function identity(): ExecutionIdentity {
    if (!prepared) throw new Error("No dispatch preparation");
    return {
      ...prepared.correlation,
      run: {
        repo: target.repo,
        workflow: ".github/workflows/run-rad-commands.yml",
        runId: "123",
        runAttempt: 1,
        commit: source.commit
      }
    };
  }
  const deps: DeploymentDependencies = {
    ids,
    clock,
    registry,
    identity: {
      async authorize<O extends LifecycleOperation>(
        request: AuthorizationRequest<O>
      ): Promise<PortResult<AuthorizedScope<O>>> {
        const authorized: AuthorizedScope = {
          ...request,
          authorizationRef: "fresh-authority",
          principalRef: caller.principalRef
        };
        return portSuccess(authorized as AuthorizedScope<O>);
      }
    },
    source: {
      capture: vi.fn(async () =>
        portSuccess({
          status: "captured" as const,
          snapshot: {
            snapshotRef: "snapshot",
            selection: target,
            provenance: source,
            manifest: {
              completeness: "complete" as const,
              fingerprint: source.fingerprint,
              definition: target.definition,
              inputs: [
                {
                  path: target.definition,
                  kind: "definition" as const,
                  existed: true,
                  contentHash: source.fingerprint
                }
              ]
            }
          }
        })
      ),
      releaseSnapshot: vi.fn(async () =>
        portSuccess({ status: "released" as const })
      )
    },
    workflow: {
      prepare: vi.fn(async (input) => {
        prepared = input;
        return portSuccess({
          preparationRef: "prepared",
          preparation: input,
          concurrencyScope: "repository" as const
        });
      }),
      dispatch: vi.fn(async () => ({
        status: "unconfirmed" as const,
        correlation: identity(),
        error: {
          ...lifecycleError("DISPATCH_UNCONFIRMED"),
          code: "DISPATCH_UNCONFIRMED" as const
        }
      })),
      reconcile: vi.fn(async () =>
        portSuccess({
          matches: [identity().run],
          observation: {
            quality: "current" as const,
            completeness: "complete" as const,
            evidence: "workflow" as const
          }
        })
      ),
      observe: vi.fn(async () =>
        portSuccess({
          identity: identity(),
          conclusion: saveFailed ? ("failure" as const) : ("success" as const),
          observation: {
            quality: "current" as const,
            completeness: "complete" as const,
            evidence: "workflow" as const
          },
          evidence: portSuccess({
            identity: identity(),
            executionSchemaVersion: 1 as const,
            actualCommit: source.commit,
            sequence: 5,
            observedAt: clock.now(),
            phases: (
              [
                "dispatch",
                "checkout",
                "restore",
                "command",
                "state-save",
                "cleanup"
              ] as const
            ).map((phase) => ({
              phase,
              status:
                saveFailed && phase === "state-save" ?
                  ("failed" as const)
                : ("succeeded" as const),
              exitCode: saveFailed && phase === "state-save" ? 7 : 0,
              reason: "Observed"
            })),
            additionalFailures: [],
            diagnostics: []
          })
        })
      ),
      cancel: async () => {
        throw new Error("Observation must not cancel");
      }
    }
  };
  const service = createDeployment(deps);
  const reads = createOperationReads(deps);
  const readScope: AuthorizedScope<"operation.get"> = {
    authorizationRef: "read",
    principalRef: caller.principalRef,
    operation: "operation.get",
    target: {
      repo: target.repo,
      environment: target.environment,
      application: target.application
    }
  };
  return {
    deps,
    request,
    scope,
    control,
    caller,
    source,
    service,
    registry,
    reads,
    identity,
    readScope,
    failSave: () => {
      saveFailed = true;
    }
  };
}

it.each([false, true])(
  "dispatches once and observes 100 times with save failure=%s",
  async (saveFailed) => {
    const f = fixture();
    if (saveFailed) f.failSave();
    const result = await f.service.start(
      f.scope,
      f.caller,
      f.request,
      f.control
    );
    expect(result).toMatchObject({
      status: "ok",
      value: { state: "queued", observation: { quality: "unknown" } }
    });

    if (result.status !== "ok") throw new Error("Start failed");
    for (let read = 0; read < 100; read++) {
      expect(
        await f.reads.get(f.readScope, result.value.operationId, f.control)
      ).toMatchObject({
        status: "ok",
        value: { state: saveFailed ? "failed" : "succeeded" }
      });
    }
    expect(f.deps.workflow.dispatch).toHaveBeenCalledTimes(1);
    expect(f.deps.workflow.prepare).toHaveBeenCalledTimes(1);
    expect(f.deps.source.capture).toHaveBeenCalledTimes(1);
    expect(f.deps.source.releaseSnapshot).toHaveBeenCalledTimes(1);
  }
);

it("does not claim a complete source from an incomplete capture", async () => {
  const f = fixture();
  vi.mocked(f.deps.source.capture).mockResolvedValue(
    portSuccess({
      status: "incomplete",
      manifest: {
        completeness: "incomplete",
        definition: f.request.target.definition,
        inputs: [],
        diagnostics: []
      }
    })
  );
  expect(
    await f.service.start(f.scope, f.caller, f.request, f.control)
  ).toMatchObject({ status: "unavailable" });
  expect(f.deps.source.releaseSnapshot).not.toHaveBeenCalled();
  expect(f.deps.workflow.dispatch).not.toHaveBeenCalled();
});

it("releases rejected captured selections before refusing their evidence", async () => {
  const f = fixture();
  const captured = await f.deps.source.capture(
    f.scope,
    f.request.target,
    f.control
  );
  if (captured.status !== "ok" || captured.value.status !== "captured")
    throw new Error("No capture");
  vi.mocked(f.deps.source.capture).mockResolvedValue(
    portSuccess({
      ...captured.value,
      snapshot: {
        ...captured.value.snapshot,
        selection: {
          ...captured.value.snapshot.selection,
          definition: "different.bicep"
        }
      }
    })
  );
  expect(
    await f.service.start(f.scope, f.caller, f.request, f.control)
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  expect(f.deps.source.releaseSnapshot).toHaveBeenCalledOnce();
  expect(f.deps.workflow.dispatch).not.toHaveBeenCalled();
});

it.each([
  "store",
  "save",
  "prepared-identity",
  "missing-approval",
  "cancel-before-dispatch"
] as const)(
  "rejects %s without silently switching execution",
  async (stage) => {
    const f = fixture();
    if (stage === "store")
      vi.spyOn(f.registry, "create").mockResolvedValue(
        portFailure("PRECONDITION_FAILED")
      );
    if (stage === "save")
      vi.spyOn(f.registry, "compareAndSwap").mockResolvedValue(
        portFailure("PRECONDITION_FAILED")
      );
    if (stage === "prepared-identity")
      vi.mocked(f.deps.workflow.prepare).mockImplementation(
        async (preparation) =>
          portSuccess({
            preparationRef: "foreign",
            concurrencyScope: "repository",
            preparation: {
              ...preparation,
              correlation: { ...preparation.correlation, attemptId: "foreign" }
            }
          })
      );
    let aborted = false;
    const control = {
      ...f.control,
      cancellation: {
        ...f.control.cancellation,
        get aborted() {
          return aborted;
        }
      }
    };
    if (stage === "cancel-before-dispatch") {
      const prepare = f.deps.workflow.prepare;
      vi.mocked(prepare).mockImplementation(async (preparation) => {
        aborted = true;
        return portSuccess({
          preparationRef: "prepared",
          concurrencyScope: "repository",
          preparation
        });
      });
    }
    const request =
      stage === "missing-approval" ?
        { ...f.request, input: { repairPolicy: f.request.input.repairPolicy } }
      : f.request;
    const result = await f.service.start(f.scope, f.caller, request, control);
    expect(result.status).not.toBe("ok");
    expect(f.deps.workflow.dispatch).toHaveBeenCalledTimes(
      stage === "save" ? 1 : 0
    );
  }
);

it("finishes local dispatch bookkeeping after caller cancellation without relaying cancellation to it", async () => {
  const f = fixture();
  let aborted = false;
  const control = {
    ...f.control,
    cancellation: {
      ...f.control.cancellation,
      get aborted() {
        return aborted;
      }
    }
  };
  vi.mocked(f.deps.workflow.dispatch).mockImplementation(async () => {
    aborted = true;
    return { status: "dispatched", identity: f.identity() };
  });
  const original = f.registry.compareAndSwap.bind(f.registry);
  vi.spyOn(f.registry, "compareAndSwap").mockImplementation(
    async (scope, update, localControl) => {
      const cancelled = vi.fn();
      expect(localControl.cancellation.aborted).toBe(false);
      const dispose = localControl.cancellation.onAbort(cancelled);
      dispose();
      expect(cancelled).not.toHaveBeenCalled();
      return original(scope, update, localControl);
    }
  );
  expect(
    await f.service.start(f.scope, f.caller, f.request, control)
  ).toMatchObject({ status: "ok", value: { state: "queued" } });
  expect(f.registry.knownOperations()[0].attempts[0].run?.runId).toBe("123");
  expect(f.deps.workflow.dispatch).toHaveBeenCalledOnce();
});

it("records a cancelled dispatch admission without inventing execution failure details", async () => {
  const f = fixture();
  vi.mocked(f.deps.workflow.dispatch).mockResolvedValue(
    portCancelled("request_cancelled")
  );
  expect(
    await f.service.start(f.scope, f.caller, f.request, f.control)
  ).toMatchObject({ status: "failed" });
  expect(f.deps.workflow.dispatch).toHaveBeenCalledOnce();
  expect(f.registry.knownOperations()[0].attempts[0].run).toBeUndefined();
});

it("rejects confirmed absence and non-published captures rather than dispatching guessed source", async () => {
  const f = fixture();
  const original = await f.deps.source.capture(
    f.scope,
    f.request.target,
    f.control
  );
  if (original.status !== "ok" || original.value.status !== "captured")
    throw new Error("No capture");
  vi.mocked(f.deps.source.capture)
    .mockResolvedValueOnce({
      status: "absent",
      reason: "not_found",
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "source",
        observedAt: f.source.resolvedAt
      }
    })
    .mockResolvedValueOnce(
      portSuccess({
        status: "captured",
        snapshot: {
          ...original.value.snapshot,
          provenance: {
            kind: "workspace",
            repo: f.source.repo,
            branch: "feature",
            workspaceRef: "workspace",
            fingerprint: f.source.fingerprint,
            resolvedAt: f.source.resolvedAt
          }
        }
      })
    );
  expect(
    await f.service.start(f.scope, f.caller, f.request, f.control)
  ).toMatchObject({
    status: "failed",
    error: { code: "DEFINITION_NOT_FOUND" }
  });
  expect(
    await f.service.start(f.scope, f.caller, f.request, f.control)
  ).toMatchObject({ status: "failed", error: { code: "SOURCE_CHANGED" } });
  expect(f.deps.workflow.dispatch).not.toHaveBeenCalled();
});

it("rejects a trusted authorization result bound to another principal", async () => {
  const f = fixture();
  vi.spyOn(f.deps.ids, "next").mockReturnValue("operation-id");
  vi.spyOn(f.deps.identity, "authorize").mockResolvedValue(
    portSuccess({
      ...f.scope,
      source: f.source,
      operationId: "operation-id",
      principalRef: "other"
    })
  );
  expect(
    await f.service.start(f.scope, f.caller, f.request, f.control)
  ).toMatchObject({ status: "failed" });
  expect(f.deps.workflow.prepare).not.toHaveBeenCalled();
});

it("rejects cancellation, wrong scope and unsupported automatic repair before source access", async () => {
  const f = fixture();
  expect(
    await f.service.start(f.scope, f.caller, f.request, {
      ...f.control,
      cancellation: { ...f.control.cancellation, aborted: true }
    })
  ).toMatchObject({ status: "cancelled" });
  expect(
    await f.service.start(
      { ...f.scope, target: { ...f.scope.target, application: "other" } },
      f.caller,
      f.request,
      f.control
    )
  ).toMatchObject({ status: "failed" });
  expect(
    await f.service.start(
      f.scope,
      f.caller,
      {
        ...f.request,
        input: { repairPolicy: { mode: "automatic", maxAttempts: 1 } }
      },
      f.control
    )
  ).toMatchObject({ status: "unavailable" });
  expect(f.deps.source.capture).not.toHaveBeenCalled();
});

it("refuses revoked approval and never prepares or dispatches", async () => {
  const f = fixture();
  vi.spyOn(f.deps.identity, "authorize").mockResolvedValue(portForbidden());
  expect(
    await f.service.start(f.scope, f.caller, f.request, f.control)
  ).toMatchObject({ status: "forbidden" });
  expect(f.deps.workflow.prepare).not.toHaveBeenCalled();
  expect(f.deps.workflow.dispatch).not.toHaveBeenCalled();
});

it.each(["source", "release", "prepare", "dispatch"] as const)(
  "propagates %s failure without repeating dispatch",
  async (phase) => {
    const f = fixture();
    if (phase === "source")
      vi.mocked(f.deps.source.capture).mockResolvedValue(
        portFailure("PRECONDITION_FAILED")
      );
    if (phase === "release")
      vi.mocked(f.deps.source.releaseSnapshot).mockResolvedValue(
        portFailure("PRECONDITION_FAILED")
      );
    if (phase === "prepare")
      vi.mocked(f.deps.workflow.prepare).mockResolvedValue(
        portFailure("PRECONDITION_FAILED")
      );
    if (phase === "dispatch")
      vi.mocked(f.deps.workflow.dispatch).mockResolvedValue(
        portFailure("PRECONDITION_FAILED")
      );
    expect(
      await f.service.start(f.scope, f.caller, f.request, f.control)
    ).toMatchObject({ status: "failed" });
    expect(f.deps.workflow.dispatch).toHaveBeenCalledTimes(
      phase === "dispatch" ? 1 : 0
    );
  }
);

it("reports session coverage, inaccessible identities and unavailable observations truthfully", async () => {
  const f = fixture();
  expect(await f.reads.get(f.readScope, "unknown", f.control)).toMatchObject({
    status: "unavailable",
    error: { code: "OPERATION_UNAVAILABLE" }
  });
  const accepted = await f.service.start(
    f.scope,
    f.caller,
    f.request,
    f.control
  );
  if (accepted.status !== "ok") throw new Error("No operation");
  expect(
    await f.reads.get(
      { ...f.readScope, principalRef: "other" },
      accepted.value.operationId,
      f.control
    )
  ).toMatchObject({ status: "forbidden" });
  vi.mocked(f.deps.workflow.observe).mockResolvedValue(
    portUnavailable("RESULT_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "workflow"
    })
  );
  expect(
    await f.reads.get(f.readScope, accepted.value.operationId, f.control)
  ).toMatchObject({
    status: "ok",
    value: { state: "queued", observation: { quality: "unknown" } }
  });
  expect(
    await f.reads.list(
      { ...f.readScope, operation: "operation.list" },
      { pageSize: 1 },
      f.control
    )
  ).toMatchObject({
    status: "ok",
    value: {
      items: [{ operationId: accepted.value.operationId }],
      observation: { limitation: expect.stringContaining("Session-owned") }
    }
  });
});
