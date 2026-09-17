import { expect, it, vi } from "vitest";
import { createOperationReads } from "./operation-reads.js";
import {
  createOperationRecord,
  createExecutionAttempt,
  createSessionOperationRegistry
} from "./operations.js";
import { portFailure, portSuccess, portUnavailable } from "./errors.js";
import type {
  AuthorizedScope,
  ExecutionIdentity,
  RequestControl,
  WorkflowExecutionPort
} from "./ports.js";

async function fixture() {
  let sequence = 0;
  const deps = {
    ids: { next: () => `id-${++sequence}` },
    clock: { now: () => "2026-09-16T00:00:00Z" }
  };
  const registry = createSessionOperationRegistry(deps);
  const scope: AuthorizedScope<"deployment.start"> = {
    authorizationRef: "authority",
    principalRef: "principal",
    operation: "deployment.start",
    target: {
      repo: "owner/repo",
      environment: "dev",
      application: "app",
      definition: ".radius/app.bicep",
      source: { kind: "git", ref: "feature", expectedCommit: "a".repeat(40) }
    }
  };
  const base = createOperationRecord(deps, {
    operation: scope.operation,
    target: scope.target,
    source: {
      kind: "git",
      repo: scope.target.repo,
      ref: "feature",
      commit: "a".repeat(40),
      fingerprint: `sha256:${"b".repeat(64)}`,
      resolvedAt: deps.clock.now()
    }
  });
  const operation = {
    ...base,
    attempts: [createExecutionAttempt(deps.ids, base)]
  };
  const control: RequestControl = {
    requestId: "request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const created = await registry.create(scope, operation, control);
  if (created.status !== "ok") throw new Error("No operation");
  const identity: ExecutionIdentity = {
    operation: scope.operation,
    operationId: operation.operationId,
    attemptId: operation.attempts[0].attemptId,
    target: { repo: scope.target.repo, environment: "dev", application: "app" },
    expectedCommit: "a".repeat(40),
    run: {
      repo: scope.target.repo,
      workflow: ".github/workflows/run-rad-commands.yml",
      commit: "a".repeat(40),
      runId: "123",
      runAttempt: 1
    }
  };
  const observation = {
    quality: "current" as const,
    completeness: "partial" as const,
    evidence: "workflow" as const,
    observedAt: deps.clock.now()
  };
  const workflow: Pick<WorkflowExecutionPort, "observe" | "reconcile"> = {
    reconcile: vi.fn(async () =>
      portSuccess({ matches: [identity.run], observation })
    ),
    observe: vi.fn(async () =>
      portSuccess({
        identity,
        conclusion: "in_progress" as const,
        observation,
        evidence: portUnavailable("RESULT_UNAVAILABLE", {
          ...observation,
          quality: "unknown"
        })
      })
    )
  };
  const readScope: AuthorizedScope<"operation.get"> = {
    ...scope,
    operation: "operation.get",
    target: identity.target
  };
  return {
    deps,
    registry,
    scope,
    control,
    operation,
    identity,
    observation,
    workflow,
    readScope,
    reads: createOperationReads({ registry, workflow })
  };
}

it("reads cached records without a workflow adapter and never mutates them", async () => {
  const f = await fixture();
  const write = vi.spyOn(f.registry, "compareAndSwap");
  expect(
    await createOperationReads({ registry: f.registry }).get(
      f.readScope,
      f.operation.operationId,
      f.control
    )
  ).toMatchObject({ status: "ok", value: { state: "queued" } });
  expect(write).not.toHaveBeenCalled();
});
it.each(["unavailable", "absent", "ambiguous"] as const)(
  "does not dispatch while reconciliation is %s",
  async (kind) => {
    const f = await fixture();
    vi.mocked(f.workflow.reconcile).mockResolvedValue(
      kind === "unavailable" ?
        portUnavailable("RESULT_UNAVAILABLE", {
          ...f.observation,
          quality: "unknown"
        })
      : portSuccess({
          matches: kind === "absent" ? [] : [f.identity.run, f.identity.run],
          observation: f.observation
        })
    );
    expect(
      await f.reads.get(f.readScope, f.operation.operationId, f.control)
    ).toMatchObject({
      status: "ok",
      value: { state: "queued", observation: { quality: "unknown" } }
    });
    expect(f.workflow.observe).not.toHaveBeenCalled();
  }
);
it("retains stale confirmed state when subsequent observations are unavailable", async () => {
  const f = await fixture();
  expect(
    await f.reads.get(f.readScope, f.operation.operationId, f.control)
  ).toMatchObject({ status: "ok", value: { state: "running" } });
  vi.mocked(f.workflow.observe).mockResolvedValue(
    portUnavailable("RESULT_UNAVAILABLE", {
      ...f.observation,
      quality: "unknown"
    })
  );
  expect(
    await f.reads.get(f.readScope, f.operation.operationId, f.control)
  ).toMatchObject({
    status: "ok",
    value: { state: "running", observation: { quality: "stale" } }
  });
  expect(f.workflow.reconcile).toHaveBeenCalledOnce();
});
it("propagates scope, evidence and storage errors without manufacturing a result", async () => {
  const f = await fixture();
  vi.mocked(f.workflow.observe).mockResolvedValueOnce(
    portSuccess({
      identity: { ...f.identity, operationId: "foreign" },
      conclusion: "success",
      observation: f.observation,
      evidence: portUnavailable("RESULT_UNAVAILABLE", {
        ...f.observation,
        quality: "unknown"
      })
    })
  );
  expect(
    await f.reads.get(f.readScope, f.operation.operationId, f.control)
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  vi.spyOn(f.registry, "compareAndSwap").mockResolvedValueOnce(
    portFailure("EVIDENCE_MISMATCH")
  );
  expect(
    await f.reads.get(f.readScope, f.operation.operationId, f.control)
  ).toMatchObject({ status: "failed" });
  expect(
    await f.reads.list(
      { ...f.readScope, operation: "operation.list" },
      { continuationToken: "foreign" },
      f.control
    )
  ).toMatchObject({ status: "failed" });
});
it("re-reads a competing observation revision rather than replaying a stale update", async () => {
  const f = await fixture();
  vi.spyOn(f.registry, "compareAndSwap").mockResolvedValueOnce(
    portFailure("PRECONDITION_FAILED")
  );
  expect(
    await f.reads.get(f.readScope, f.operation.operationId, f.control)
  ).toMatchObject({ status: "ok", value: { state: "queued" } });
  const original = f.registry.get.bind(f.registry);
  vi.spyOn(f.registry, "get")
    .mockImplementationOnce(original)
    .mockResolvedValueOnce(portFailure("PRECONDITION_FAILED"));
  vi.mocked(f.registry.compareAndSwap).mockResolvedValueOnce(
    portFailure("PRECONDITION_FAILED")
  );
  expect(
    await f.reads.get(f.readScope, f.operation.operationId, f.control)
  ).toMatchObject({ status: "failed" });
});
it("pages only the caller's session records with scope-bound opaque cursors", async () => {
  const f = await fixture();
  const second = createOperationRecord(f.deps, {
    operation: "deployment.start",
    target: f.scope.target
  });
  expect(await f.registry.create(f.scope, second, f.control)).toMatchObject({
    status: "ok"
  });
  const scope: AuthorizedScope<"operation.list"> = {
    ...f.readScope,
    operation: "operation.list"
  };
  const first = await f.reads.list(scope, { pageSize: 1 }, f.control);
  if (first.status !== "ok") throw new Error("No first page");
  expect(first.value.items).toHaveLength(1);
  expect(first.value.continuationToken).toBeTypeOf("string");
  const page = await f.reads.list(
    scope,
    { continuationToken: first.value.continuationToken },
    f.control
  );
  expect(page).toMatchObject({
    status: "ok",
    value: { items: [{ operationId: second.operationId }] }
  });
  expect(
    await f.reads.list(
      { ...scope, principalRef: "other" },
      { continuationToken: first.value.continuationToken },
      f.control
    )
  ).toMatchObject({ status: "failed" });
});
