import { describe, expect, it } from "vitest";
import {
  createExecutionAttempt,
  createOperationRecord,
  createSessionOperationRegistry,
  matchesOperationTarget,
  reduceOperation,
  sameLifecycleData
} from "./operations.js";
import type { AuthorizedScope, RequestControl } from "./ports.js";
import type { ExecutionAttempt, RequiredAction } from "./contracts/common.js";
import { lifecycleError } from "./errors.js";

const control: RequestControl = {
  requestId: "request",
  cancellation: { aborted: false, onAbort: () => () => {} }
};
const scope: AuthorizedScope<"deployment.start"> = {
  authorizationRef: "authorization",
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
const observation = {
  quality: "current" as const,
  completeness: "complete" as const,
  evidence: "workflow" as const,
  observedAt: "2026-09-15T00:00:00Z"
};
function fixture() {
  let sequence = 0;
  const deps = {
    ids: { next: (kind: string) => `${kind}-${++sequence}` },
    clock: { now: () => observation.observedAt }
  };
  const record = createOperationRecord(deps, {
    operation: "deployment.start",
    target: scope.target,
    source: {
      kind: "git",
      repo: scope.target.repo,
      ref: "feature",
      commit: "a".repeat(40),
      fingerprint: `sha256:${"b".repeat(64)}`,
      resolvedAt: observation.observedAt
    }
  });
  const attempt = createExecutionAttempt(deps.ids, record);
  const operation = { ...record, attempts: [attempt] };
  const completed: ExecutionAttempt = {
    ...attempt,
    run: {
      repo: "owner/repo",
      workflow: ".github/workflows/deploy.yml",
      runId: "run-1",
      runAttempt: 1,
      commit: "a".repeat(40),
      conclusion: "success"
    },
    phases: [
      "dispatch",
      "checkout",
      "restore",
      "command",
      "state-save",
      "cleanup"
    ].map((phase) => ({
      phase: phase as ExecutionAttempt["phases"][number]["phase"],
      status: "succeeded",
      reason: "confirmed"
    })),
    observation
  };
  return {
    deps,
    operation,
    completed,
    registry: createSessionOperationRegistry(deps)
  };
}

describe("session operation registry", () => {
  it("never clears a known cancellation request through a later revision", async () => {
    const { registry, operation } = fixture();
    const pending = {
      ...operation,
      cancellationRequestedAt: observation.observedAt
    };
    const stored = await registry.create(scope, pending, control);
    if (stored.status !== "ok") throw new Error("Missing operation");
    expect(
      await registry.compareAndSwap(
        scope,
        {
          operationId: pending.operationId,
          expectedRevision: stored.value.revision,
          replacement: operation
        },
        control
      )
    ).toMatchObject({ status: "failed" });
    expect(
      await registry.compareAndSwap(
        scope,
        {
          operationId: pending.operationId,
          expectedRevision: stored.value.revision,
          replacement: pending
        },
        control
      )
    ).toMatchObject({ status: "ok" });
  });
  it("requires real ID/clock dependencies and rejects cancelled/unauthorized writes", async () => {
    for (const deps of [undefined, {}, { ids: { next() {} } }]) {
      expect(() =>
        Reflect.apply(createSessionOperationRegistry, undefined, [deps])
      ).toThrow("IDs and clock");
    }
    const { registry, operation } = fixture();
    const cancelled = {
      ...control,
      cancellation: { ...control.cancellation, aborted: true }
    };
    expect(await registry.create(scope, operation, cancelled)).toMatchObject({
      status: "cancelled"
    });
    expect(
      await registry.create(
        { ...scope, operation: "operation.get" },
        operation,
        control
      )
    ).toMatchObject({ status: "forbidden" });
    expect(
      await registry.create(
        scope,
        { ...operation, state: "succeeded" },
        control
      )
    ).toMatchObject({ status: "failed" });
    expect(
      await registry.create(
        { ...scope, target: { ...scope.target, repo: "wrong/repo" } },
        operation,
        control
      )
    ).toMatchObject({ status: "forbidden" });
    expect(
      await registry.list(
        { ...scope, operation: "operation.list" },
        {},
        cancelled
      )
    ).toMatchObject({ status: "cancelled" });
    const update = {
      operationId: operation.operationId,
      expectedRevision: "missing",
      replacement: operation
    };
    expect(
      await registry.compareAndSwap(scope, update, cancelled)
    ).toMatchObject({ status: "cancelled" });
    expect(await registry.compareAndSwap(scope, update, control)).toMatchObject(
      { status: "failed" }
    );
    await registry.create(scope, operation, control);
    expect(
      await registry.compareAndSwap(
        { ...scope, principalRef: "other" },
        update,
        control
      )
    ).toMatchObject({ status: "forbidden" });
    expect(
      await registry.get(
        { ...scope, operationId: "other" },
        operation.operationId,
        control
      )
    ).toMatchObject({ status: "forbidden" });
  });
  it("preserves immutable target, source, attempt identity and consumed action state", async () => {
    const { registry, operation, completed } = fixture();
    const accepted: RequiredAction = {
      actionId: "accepted",
      operationId: operation.operationId,
      target: operation.target,
      kind: "user.decision",
      responder: "user",
      status: "accepted",
      message: "Decision",
      response: {
        kind: "user.decision",
        choices: ["approve"],
        permittedInput: []
      }
    };
    const initial = {
      ...operation,
      attempts: [completed],
      actions: [accepted]
    };
    const created = await registry.create(scope, initial, control);
    if (created.status !== "ok" || !completed.run)
      throw new Error("Missing fixture");
    const run = completed.run;
    const updates = [
      { ...initial, operationId: "other" },
      { ...initial, operation: "environment.create" as const },
      { ...initial, target: { ...initial.target, repo: "other/repo" } },
      { ...initial, source: undefined },
      { ...initial, repairsOperationId: "other" },
      { ...initial, repairsAttemptId: "other" },
      { ...initial, attempts: [] },
      {
        ...initial,
        attempts: [{ ...completed, expectedCommit: "b".repeat(40) }]
      },
      { ...initial, attempts: [{ ...completed, run: undefined }] },
      {
        ...initial,
        attempts: [{ ...completed, run: { ...run, runId: "other" } }]
      },
      { ...initial, attempts: [completed, completed] },
      { ...initial, actions: [] },
      { ...initial, actions: [{ ...accepted, status: "outstanding" as const }] }
    ];
    for (const replacement of updates) {
      expect(
        await registry.compareAndSwap(
          scope,
          {
            operationId: operation.operationId,
            expectedRevision: created.value.revision,
            replacement
          },
          control
        )
      ).toMatchObject({ status: "failed" });
    }
    expect(
      await registry.compareAndSwap(
        scope,
        {
          operationId: operation.operationId,
          expectedRevision: created.value.revision,
          replacement: {
            ...initial,
            observation: { ...initial.observation, quality: "stale" }
          }
        },
        control
      )
    ).toMatchObject({ status: "ok" });
  });
  it("requires completion evidence in CAS and supports confirmed local cancellation without remote work", async () => {
    const { registry, operation, completed, deps } = fixture();
    const created = await registry.create(scope, operation, control);
    if (created.status !== "ok") throw new Error("Missing fixture");
    for (const replacement of [
      { ...operation, state: "succeeded" as const },
      { ...operation, state: "failed" as const },
      { ...operation, state: "cancelled" as const }
    ]) {
      expect(
        await registry.compareAndSwap(
          scope,
          {
            operationId: operation.operationId,
            expectedRevision: created.value.revision,
            replacement
          },
          control
        )
      ).toMatchObject({ status: "failed" });
    }
    const reduced = reduceOperation(operation, {
      kind: "completed",
      state: "succeeded",
      attempt: completed
    });
    if (reduced.status !== "ok") throw new Error("Missing evidence");
    expect(
      await registry.compareAndSwap(
        scope,
        {
          operationId: operation.operationId,
          expectedRevision: created.value.revision,
          replacement: reduced.value
        },
        control
      )
    ).toMatchObject({ status: "ok" });
    const local = createOperationRecord(deps, {
      operation: "deployment.start",
      target: scope.target
    });
    expect(createExecutionAttempt(deps.ids, local)).not.toHaveProperty(
      "expectedCommit"
    );
    const saved = await registry.create(scope, local, control);
    if (saved.status !== "ok") throw new Error("Missing local");
    expect(
      await registry.compareAndSwap(
        scope,
        {
          operationId: local.operationId,
          expectedRevision: saved.value.revision,
          replacement: {
            ...local,
            state: "cancelled",
            cancellationRequestedAt: observation.observedAt
          }
        },
        control
      )
    ).toMatchObject({ status: "ok" });
  });
  it("assigns stable distinct operation/attempt/revision identities and owns isolated copies", async () => {
    const { registry, operation } = fixture();
    const created = await registry.create(scope, operation, control);
    expect(created).toMatchObject({
      status: "ok",
      value: {
        revision: "revision-3",
        operation: {
          operationId: "operation-1",
          attempts: [{ attemptId: "attempt-2" }]
        }
      }
    });
    expect(registry.hasActiveOperations()).toBe(true);
    const other = fixture().registry;
    expect(
      await other.get(scope, operation.operationId, control)
    ).toMatchObject({ status: "absent" });
    expect(await registry.create(scope, operation, control)).toMatchObject({
      status: "failed"
    });
    expect(
      await registry.get(
        { ...scope, principalRef: "other" },
        operation.operationId,
        control
      )
    ).toMatchObject({ status: "forbidden" });
    expect(registry.knownOperations()).toEqual([operation]);
  });
  it("atomically rejects competing revisions and terminal rewrites", async () => {
    const { registry, operation } = fixture();
    const created = await registry.create(scope, operation, control);
    if (created.status !== "ok") throw new Error("create failed");
    const update = {
      operationId: operation.operationId,
      expectedRevision: created.value.revision,
      replacement: {
        ...operation,
        state: "failed" as const,
        error: lifecycleError("PRECONDITION_FAILED")
      }
    };
    const results = await Promise.all([
      registry.compareAndSwap(scope, update, control),
      registry.compareAndSwap(scope, update, control)
    ]);
    expect(results.map((result) => result.status)).toEqual(["ok", "failed"]);
    const stored = await registry.get(scope, operation.operationId, control);
    if (stored.status !== "ok") throw new Error("get failed");
    expect(
      await registry.compareAndSwap(
        scope,
        {
          ...update,
          expectedRevision: stored.value.revision,
          replacement: operation
        },
        control
      )
    ).toMatchObject({ status: "failed" });
    expect(registry.hasActiveOperations()).toBe(false);
  });
  it("fences close and request cancellation without claiming remote cancellation", async () => {
    const { registry, operation } = fixture();
    await registry.create(scope, operation, control);
    const cancelled = {
      ...control,
      cancellation: { ...control.cancellation, aborted: true }
    };
    expect(
      await registry.get(scope, operation.operationId, cancelled)
    ).toMatchObject({ status: "cancelled", reason: "request_cancelled" });
    expect(await registry.close()).toMatchObject({
      value: { status: "released" }
    });
    expect(await registry.close()).toMatchObject({
      value: { status: "already_released" }
    });
    expect(
      await registry.get(scope, operation.operationId, control)
    ).toMatchObject({ status: "cancelled", reason: "session_shutdown" });
    expect(registry.knownOperations()[0].state).toBe("queued");
    expect(registry.hasActiveOperations()).toBe(false);
  });
  it("lists only authorized records and reports partial or unsupported pagination", async () => {
    const { registry, operation } = fixture();
    await registry.create(scope, operation, control);
    await registry.create(
      scope,
      { ...operation, operationId: "other-operation" },
      control
    );
    const listing: AuthorizedScope<"operation.list"> = {
      ...scope,
      operation: "operation.list"
    };
    expect(await registry.list(listing, {}, control)).toMatchObject({
      status: "ok",
      value: { items: [expect.anything(), expect.anything()] }
    });
    expect(
      await registry.list(listing, { pageSize: 1 }, control)
    ).toMatchObject({ value: { observation: { completeness: "partial" } } });
    expect(
      await registry.list(listing, { pageSize: 0 }, control)
    ).toMatchObject({ status: "failed" });
    expect(
      await registry.list(listing, { continuationToken: "cursor" }, control)
    ).toMatchObject({ status: "unavailable" });
  });
});

describe("operation observations", () => {
  it("preserves attempt identities when a known run is observed and supersedes outstanding actions", () => {
    const { operation, completed } = fixture();
    const action: RequiredAction = {
      actionId: "action",
      operationId: operation.operationId,
      target: operation.target,
      kind: "user.decision",
      responder: "user",
      status: "outstanding",
      message: "Decision",
      response: {
        kind: "user.decision",
        choices: ["approve"],
        permittedInput: []
      }
    };
    const pending = {
      ...operation,
      actions: [
        action,
        { ...action, actionId: "accepted", status: "accepted" as const }
      ]
    };
    expect(
      reduceOperation(pending, { kind: "started", observation })
    ).toMatchObject({ value: { state: "action_required" } });
    const known = {
      ...pending,
      attempts: [completed, { ...completed, attemptId: "other-attempt" }]
    };
    expect(
      reduceOperation(known, {
        kind: "completed",
        state: "succeeded",
        attempt: completed
      })
    ).toMatchObject({
      value: {
        state: "succeeded",
        actions: [{ status: "superseded" }, { status: "accepted" }],
        attempts: [expect.anything(), { attemptId: "other-attempt" }]
      }
    });
    if (!completed.run) throw new Error("Missing run");
    for (const run of [
      { ...completed.run, runId: "other" },
      { ...completed.run, runAttempt: 2 },
      { ...completed.run, workflow: "other.yml" },
      { ...completed.run, commit: "b".repeat(40) }
    ]) {
      expect(
        reduceOperation(known, {
          kind: "completed",
          state: "succeeded",
          attempt: { ...completed, run }
        })
      ).toMatchObject({ error: { code: "EVIDENCE_MISMATCH" } });
    }
  });
  it.each([
    { operationId: "other" },
    { expectedCommit: undefined },
    { provider: "azure" as const },
    { repairsOperationId: "other" },
    { repairsAttemptId: "other" },
    { run: undefined }
  ])("rejects mismatched completion metadata %j", (patch) => {
    const { operation, completed } = fixture();
    expect(
      reduceOperation(operation, {
        kind: "completed",
        state: "succeeded",
        attempt: { ...completed, ...patch }
      })
    ).toMatchObject({ error: { code: "EVIDENCE_MISMATCH" } });
  });
  it("keeps cancellation requests stable and rejects starts after requested cancellation", () => {
    const { operation } = fixture();
    const pending = {
      ...operation,
      cancellationRequestedAt: observation.observedAt
    };
    expect(
      reduceOperation(pending, {
        kind: "cancel_requested",
        requestedAt: "2026-09-16T00:00:00Z"
      })
    ).toMatchObject({ value: pending });
    expect(
      reduceOperation(pending, { kind: "started", observation })
    ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
  });
  it("permits evidence-based fast completion without inventing intermediate progress", () => {
    const { operation, completed } = fixture();
    expect(
      reduceOperation(operation, {
        kind: "completed",
        state: "succeeded",
        attempt: completed
      })
    ).toMatchObject({
      status: "ok",
      value: { state: "succeeded", attempts: [{ run: { runId: "run-1" } }] }
    });
  });
  it.each(["failed", "cancelled"] as const)("accepts confirmed %s", (state) => {
    const { operation, completed } = fixture();
    if (!completed.run) throw new Error("Missing fixture run");
    const attempt = {
      ...completed,
      run: {
        ...completed.run,
        conclusion:
          state === "failed" ? ("failure" as const) : ("cancelled" as const)
      }
    };
    expect(
      reduceOperation(operation, { kind: "completed", state, attempt })
    ).toMatchObject({ value: { state } });
  });
  it("retains the last evidenced state on missing phases and contradictory terminal evidence", () => {
    const { operation, completed } = fixture();
    expect(
      reduceOperation(operation, {
        kind: "completed",
        state: "succeeded",
        attempt: { ...completed, phases: [] }
      })
    ).toMatchObject({
      value: { state: "queued", observation: { quality: "unknown" } }
    });
    const terminal = { ...operation, state: "failed" as const };
    expect(
      reduceOperation(terminal, {
        kind: "completed",
        state: "succeeded",
        attempt: completed
      })
    ).toMatchObject({
      value: { state: "failed", observation: { quality: "unknown" } }
    });
    expect(
      reduceOperation(terminal, {
        kind: "completed",
        state: "failed",
        attempt: completed
      })
    ).toMatchObject({ value: terminal });
  });
  it("rejects mismatched attempt identity and late starts", () => {
    const { operation, completed } = fixture();
    expect(
      reduceOperation(operation, {
        kind: "completed",
        state: "succeeded",
        attempt: { ...completed, attemptId: "other" }
      })
    ).toMatchObject({ status: "failed" });
    expect(
      reduceOperation(
        { ...operation, state: "cancelled" },
        { kind: "started", observation }
      )
    ).toMatchObject({ status: "failed" });
    expect(
      reduceOperation(operation, { kind: "started", observation })
    ).toMatchObject({ value: { state: "running" } });
  });
  it("separates cancellation requests and observations from terminal state", () => {
    const { operation } = fixture();
    expect(
      reduceOperation(operation, {
        kind: "cancel_requested",
        requestedAt: observation.observedAt
      })
    ).toMatchObject({
      value: {
        state: "queued",
        cancellationRequestedAt: observation.observedAt
      }
    });
    expect(
      reduceOperation(
        { ...operation, state: "succeeded" },
        { kind: "cancel_requested", requestedAt: observation.observedAt }
      )
    ).toMatchObject({ value: { state: "succeeded" } });
    expect(
      reduceOperation(operation, {
        kind: "observed",
        observation: { ...observation, quality: "stale" }
      })
    ).toMatchObject({
      value: { state: "queued", observation: { quality: "stale" } }
    });
  });
  it("compares structured scopes independently of property ordering", () => {
    expect(sameLifecycleData({ a: 1, b: [] }, { b: [], a: 1 })).toBe(true);
    expect(sameLifecycleData(null, {})).toBe(false);
    expect(sameLifecycleData([], {})).toBe(false);
    expect(sameLifecycleData({ a: 1 }, { a: 2 })).toBe(false);
    expect(
      matchesOperationTarget({ repo: "OWNER/REPO" }, { repo: "owner/repo" })
    ).toBe(true);
  });
});
