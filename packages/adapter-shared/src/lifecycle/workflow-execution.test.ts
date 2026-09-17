import { expect, it, vi } from "vitest";
import {
  portCancelled,
  portAbsent,
  portFailure,
  portSuccess,
  portUnavailable,
  type ExecutionIdentity,
  type RequestControl,
  type WorkflowPreparation
} from "@radius-project/core/lifecycle";
import {
  createWorkflowExecution,
  type WorkflowExecutionDependencies
} from "./workflow-execution.js";

function fixture() {
  const commit = "a".repeat(40);
  const source = {
    kind: "git" as const,
    repo: "owner/repo",
    ref: "feature",
    commit,
    fingerprint: `sha256:${"b".repeat(64)}`,
    resolvedAt: "2026-09-16T00:00:00Z"
  };
  const target = {
    repo: source.repo,
    environment: "dev",
    application: "app",
    definition: ".radius/app.bicep",
    source: { kind: "git" as const, ref: source.ref, expectedCommit: commit }
  };
  const input: WorkflowPreparation = {
    source,
    scope: {
      authorizationRef: "scope",
      principalRef: "principal",
      operation: "deployment.start",
      operationId: "operation",
      approvalRef: "approval",
      source,
      target
    },
    correlation: {
      operationId: "operation",
      attemptId: "attempt",
      operation: "deployment.start",
      target: { repo: source.repo, environment: "dev", application: "app" },
      expectedCommit: commit
    },
    intent: { operation: "deployment.start", target }
  };
  const identity: ExecutionIdentity = {
    ...input.correlation,
    run: {
      repo: source.repo,
      workflow: ".github/workflows/run-rad-commands.yml",
      runId: "123",
      runAttempt: 1,
      commit
    }
  };
  const text = `actions/lifecycle-evidence@${commit}\nactions/publish-lifecycle-result@${commit}`;
  const files = {
    "run-rad-commands.yml": "dispatcher",
    "run-rad-commands-azure.yml": text,
    "run-rad-commands-aws.yml": text
  };
  const qualification = {
    repo: source.repo,
    environment: "dev",
    application: "app",
    definition: target.definition,
    workflow: identity.run.workflow,
    commit,
    producerRef: commit,
    executionVersion: 1 as const,
    selectedFiles: files,
    reviewedFiles: files,
    producerFiles: Object.fromEntries(
      [
        "lifecycle-evidence/action.yml",
        "lifecycle-evidence/evidence.sh",
        "run-rad-commands/action.yml",
        "restore-state/action.yml",
        "teardown/action.yml",
        "publish-lifecycle-result/action.yml",
        "deploy-progress/progress.sh"
      ].map((file) => [file, "reviewed immutable producer bytes"])
    ),
    reviewedProducerFiles: Object.fromEntries(
      [
        "lifecycle-evidence/action.yml",
        "lifecycle-evidence/evidence.sh",
        "run-rad-commands/action.yml",
        "restore-state/action.yml",
        "teardown/action.yml",
        "publish-lifecycle-result/action.yml",
        "deploy-progress/progress.sh"
      ].map((file) => [file, "reviewed immutable producer bytes"])
    ),
    protections: "verified" as const
  };
  let preparationSequence = 0;
  const deps: WorkflowExecutionDependencies = {
    ids: { next: () => `prepared-${++preparationSequence}` },
    clock: {
      now: () => source.resolvedAt,
      wait: vi.fn(async () => portSuccess(undefined))
    },
    qualify: vi.fn(async () => portSuccess(qualification)),
    revalidate: vi.fn(async () => portSuccess(qualification)),
    dispatch: vi.fn(async () => ({ code: 0 })),
    runs: vi.fn(async () => portSuccess([identity])),
    observation: vi.fn(async () =>
      portSuccess({ identity, conclusion: "failure" as const })
    )
  };
  const control: RequestControl = {
    requestId: "request",
    cancellation: { aborted: false, onAbort: () => () => {} }
  };
  const scope = {
    authorizationRef: "read",
    principalRef: "principal",
    operation: "operation.get" as const,
    target: input.correlation.target
  };
  return {
    deps,
    input,
    identity,
    qualification,
    control,
    scope,
    adapter: createWorkflowExecution(deps)
  };
}
it.each([
  "already-aborted",
  "absent-observation",
  "failed-observation",
  "abort-observation",
  "abort-command",
  "failed-command"
] as const)(
  "retains %s cancellation uncertainty without another command",
  async (mode) => {
    const f = fixture();
    const signal = {
      aborted: mode === "already-aborted",
      onAbort: () => () => {}
    };
    const control = { ...f.control, cancellation: signal };
    vi.mocked(f.deps.observation).mockImplementation(async () => {
      if (mode === "absent-observation")
        return portAbsent({
          quality: "current",
          completeness: "complete",
          evidence: "workflow",
          observedAt: f.deps.clock.now()
        });
      if (mode === "failed-observation")
        return portFailure("PRECONDITION_FAILED");
      if (mode === "abort-observation") signal.aborted = true;
      return portSuccess({ identity: f.identity, conclusion: "in_progress" });
    });
    const cancelRun = vi.fn(async () => {
      if (mode === "abort-command") signal.aborted = true;
      return mode === "failed-command" ?
          portFailure("PRECONDITION_FAILED")
        : portSuccess(undefined);
    });
    const adapter = createWorkflowExecution({ ...f.deps, cancelRun });
    const result = await adapter.cancel(
      { ...f.scope, operation: "operation.cancel", operationId: "operation" },
      f.identity,
      control
    );
    expect(result.status).toBe(
      mode.includes("abort") ? "cancelled"
      : mode === "absent-observation" ? "unavailable"
      : "failed"
    );
    expect(cancelRun).toHaveBeenCalledTimes(mode.endsWith("command") ? 1 : 0);
    expect(f.deps.dispatch).not.toHaveBeenCalled();
  }
);
it("requests cancellation of the exact authorized run without claiming confirmation", async () => {
  const f = fixture();
  vi.mocked(f.deps.observation).mockResolvedValue(
    portSuccess({ identity: f.identity, conclusion: "in_progress" })
  );
  const cancelRun = vi.fn(async () => portSuccess(undefined));
  const adapter = createWorkflowExecution({ ...f.deps, cancelRun });
  const result = await adapter.cancel(
    { ...f.scope, operation: "operation.cancel", operationId: "operation" },
    f.identity,
    f.control
  );
  expect(result).toMatchObject({
    status: "ok",
    value: { status: "requested" }
  });

  expect(cancelRun).toHaveBeenCalledWith(
    ["run", "cancel", "123", "--repo", "owner/repo"],
    f.control
  );
  expect(f.deps.dispatch).not.toHaveBeenCalled();
});

it("fences cancellation arriving between completed observation and the cancel command", async () => {
  const f = fixture();
  const signal = { aborted: false, onAbort: () => () => {} };
  type Observed = Awaited<
    ReturnType<WorkflowExecutionDependencies["observation"]>
  >;
  let resolve: ((value: Observed) => void) | undefined;
  const observed = new Promise<Observed>((done) => {
    resolve = done;
  });
  if (!resolve) throw new Error("Missing observation gate");
  vi.mocked(f.deps.observation).mockImplementation(() => observed);
  const cancelRun = vi.fn(async () => portSuccess(undefined));
  const adapter = createWorkflowExecution({ ...f.deps, cancelRun });
  const pending = adapter.cancel(
    { ...f.scope, operation: "operation.cancel", operationId: "operation" },
    f.identity,
    { ...f.control, cancellation: signal }
  );
  const cancelAfterRead = observed.then(() => {
    signal.aborted = true;
  });
  resolve(portSuccess({ identity: f.identity, conclusion: "in_progress" }));
  await cancelAfterRead;
  expect(await pending).toMatchObject({ status: "cancelled" });
  expect(cancelRun).not.toHaveBeenCalled();
});

it.each([
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "skipped",
  "unknown"
] as const)(
  "does not send a cancellation for an independently observed %s run",
  async (conclusion) => {
    const f = fixture();
    vi.mocked(f.deps.observation).mockResolvedValue(
      portSuccess({ identity: f.identity, conclusion })
    );
    const cancelRun = vi.fn(async () => portSuccess(undefined));
    const adapter = createWorkflowExecution({ ...f.deps, cancelRun });
    const result = await adapter.cancel(
      { ...f.scope, operation: "operation.cancel", operationId: "operation" },
      f.identity,
      f.control
    );
    expect(result).toMatchObject(
      conclusion === "unknown" ?
        { status: "unavailable" }
      : {
          status: "ok",
          value: {
            status:
              conclusion === "cancelled" ? "confirmed" : "already_completed"
          }
        }
    );
    expect(cancelRun).not.toHaveBeenCalled();
  }
);
it.each(["operation", "target", "run", "commit", "attempt", "scope"] as const)(
  "refuses mismatched %s cancellation authority before sending a command",
  async (field) => {
    const f = fixture();
    const identity = {
      ...f.identity,
      target: { ...f.identity.target },
      run: { ...f.identity.run }
    };
    const scope = {
      ...f.scope,
      operation: "operation.cancel" as const,
      operationId: "operation"
    };
    if (field === "operation") scope.operationId = "other";
    if (field === "scope") scope.authorizationRef = "";
    if (field === "target") identity.target.environment = "other";
    if (field === "run") identity.run.runId = "latest";
    if (field === "commit") identity.run.commit = "c".repeat(40);
    if (field === "attempt") identity.run.runAttempt = 0;
    const cancelRun = vi.fn(async () => portSuccess(undefined));
    expect(
      await createWorkflowExecution({ ...f.deps, cancelRun }).cancel(
        scope,
        identity,
        f.control
      )
    ).toMatchObject({ status: "failed" });
    expect(cancelRun).not.toHaveBeenCalled();
  }
);
it("refuses a run-attempt race rather than cancelling the replacement", async () => {
  const f = fixture();
  vi.mocked(f.deps.observation).mockResolvedValue(
    portSuccess({
      identity: {
        ...f.identity,
        run: { ...f.identity.run, runAttempt: f.identity.run.runAttempt + 1 }
      },
      conclusion: "in_progress"
    })
  );
  const cancelRun = vi.fn(async () => portSuccess(undefined));
  expect(
    await createWorkflowExecution({ ...f.deps, cancelRun }).cancel(
      { ...f.scope, operation: "operation.cancel", operationId: "operation" },
      f.identity,
      f.control
    )
  ).toMatchObject({ status: "failed", error: { code: "EVIDENCE_MISMATCH" } });
  expect(cancelRun).not.toHaveBeenCalled();
});
it("does not retry an uncertain cancellation command", async () => {
  const f = fixture();
  vi.mocked(f.deps.observation).mockResolvedValue(
    portSuccess({ identity: f.identity, conclusion: "in_progress" })
  );
  const cancelRun = vi.fn(async () => {
    throw new Error("Transport unavailable");
  });
  expect(
    await createWorkflowExecution({ ...f.deps, cancelRun }).cancel(
      { ...f.scope, operation: "operation.cancel", operationId: "operation" },
      f.identity,
      f.control
    )
  ).toMatchObject({ status: "unavailable" });
  expect(cancelRun).toHaveBeenCalledOnce();
});
it.each(["success", "timeout", "exception", "rejected", "nonzero"] as const)(
  "dispatches exactly once when delivery is %s",
  async (mode) => {
    const f = fixture();
    if (mode === "timeout")
      vi.mocked(f.deps.dispatch).mockResolvedValue({ code: 1, timedOut: true });
    if (mode === "exception")
      vi.mocked(f.deps.dispatch).mockRejectedValue(new Error("Transport lost"));
    if (mode === "rejected")
      vi.mocked(f.deps.dispatch).mockResolvedValue({ code: 1, rejected: true });
    if (mode === "nonzero")
      vi.mocked(f.deps.dispatch).mockResolvedValue({ code: 1 });
    const prepared = await f.adapter.prepare(f.input, f.control);
    if (prepared.status !== "ok") throw new Error("Preparation failed");
    const result = await f.adapter.dispatch(prepared.value, f.control);
    expect(result.status).toBe(mode === "rejected" ? "failed" : "unconfirmed");
    expect(await f.adapter.dispatch(prepared.value, f.control)).toMatchObject({
      status: "failed"
    });
    expect(f.deps.dispatch).toHaveBeenCalledOnce();
    expect(vi.mocked(f.deps.dispatch).mock.calls[0]?.[0]).toEqual([
      "workflow",
      "run",
      ".github/workflows/run-rad-commands.yml",
      "--repo",
      "owner/repo",
      "--ref",
      "feature",
      "-f",
      "environment=dev",
      "-f",
      "lifecycle_version=1",
      "-f",
      "lifecycle_operation=deployment.start",
      "-f",
      "operation_id=operation",
      "-f",
      "attempt_id=attempt",
      "-f",
      `expected_commit=${"a".repeat(40)}`
    ]);
  }
);
it.each([
  "repo",
  "environment",
  "application",
  "definition",
  "workflow",
  "commit",
  "producerRef"
] as const)(
  "rejects mismatched selected execution capability: %s",
  async (field) => {
    const f = fixture();
    vi.mocked(f.deps.qualify).mockResolvedValue(
      portSuccess({ ...f.qualification, [field]: "other" })
    );
    expect(await f.adapter.prepare(f.input, f.control)).toMatchObject({
      status: "failed"
    });
    expect(f.deps.dispatch).not.toHaveBeenCalled();
  }
);
it("consumes the preparation before concurrent revalidation and dispatch attempts", async () => {
  const f = fixture();
  const prepared = await f.adapter.prepare(f.input, f.control);
  if (prepared.status !== "ok") throw new Error("No preparation");
  const release: (() => void)[] = [];
  const gate = new Promise<void>((resolve) => release.push(resolve));
  vi.mocked(f.deps.revalidate).mockImplementation(async () => {
    await gate;
    return portSuccess(f.qualification);
  });
  const first = f.adapter.dispatch(prepared.value, f.control);
  expect(f.deps.revalidate).toHaveBeenCalledOnce();
  expect(await f.adapter.dispatch(prepared.value, f.control)).toMatchObject({
    status: "failed"
  });
  expect(f.deps.dispatch).not.toHaveBeenCalled();
  release[0]();
  expect(await first).toMatchObject({ status: "unconfirmed" });
  expect(f.deps.dispatch).toHaveBeenCalledOnce();
});

it("refuses partial templates and changed qualification at the last dispatch boundary", async () => {
  const f = fixture();
  vi.mocked(f.deps.qualify).mockResolvedValueOnce(
    portSuccess({ ...f.qualification, selectedFiles: {} })
  );
  expect(await f.adapter.prepare(f.input, f.control)).toMatchObject({
    status: "failed"
  });
  const prepared = await f.adapter.prepare(f.input, f.control);
  if (prepared.status !== "ok") throw new Error("No preparation");
  vi.mocked(f.deps.revalidate).mockResolvedValue(
    portSuccess({ ...f.qualification, commit: "b".repeat(40) })
  );
  expect(await f.adapter.dispatch(prepared.value, f.control)).toMatchObject({
    status: "failed"
  });
  expect(f.deps.dispatch).not.toHaveBeenCalled();
});
it.each(["missing", "skewed"])(
  "rejects a %s immutable producer rather than claiming v1 support from input names",
  async (kind) => {
    const f = fixture();
    vi.mocked(f.deps.qualify).mockResolvedValue(
      portSuccess({
        ...f.qualification,
        producerFiles:
          kind === "missing" ?
            {}
          : {
              ...f.qualification.producerFiles,
              "teardown/action.yml": "older producer"
            }
      })
    );
    expect(await f.adapter.prepare(f.input, f.control)).toMatchObject({
      status: "failed"
    });
    expect(f.deps.dispatch).not.toHaveBeenCalled();
  }
);

it("never chooses an unrelated newest run or resolves ambiguous duplicate matches", async () => {
  const f = fixture();
  vi.mocked(f.deps.runs).mockResolvedValue(
    portSuccess([
      {
        ...f.identity,
        operationId: "other",
        run: { ...f.identity.run, runId: "999" }
      },
      f.identity
    ])
  );
  expect(
    await f.adapter.reconcile(f.scope, f.input.correlation, f.control)
  ).toMatchObject({ status: "ok", value: { matches: [f.identity.run] } });
  vi.mocked(f.deps.runs).mockResolvedValue(
    portSuccess([f.identity, f.identity])
  );
  expect(
    await f.adapter.reconcile(f.scope, f.input.correlation, f.control)
  ).toMatchObject({
    status: "ok",
    value: { observation: { quality: "unknown" } }
  });
  expect(f.deps.dispatch).not.toHaveBeenCalled();
});
it("bounds transient read retries and honors cancellation without mutation", async () => {
  const f = fixture();
  const transient = portUnavailable(
    "RESULT_UNAVAILABLE",
    { quality: "unknown", completeness: "unavailable", evidence: "workflow" },
    { retryable: true }
  );
  vi.mocked(f.deps.runs).mockResolvedValue(transient);
  expect(
    await f.adapter.reconcile(f.scope, f.input.correlation, f.control)
  ).toMatchObject({ status: "unavailable" });
  expect(f.deps.runs).toHaveBeenCalledTimes(3);
  expect(f.deps.clock.wait).toHaveBeenCalledTimes(2);
  vi.mocked(f.deps.clock.wait).mockResolvedValue(
    portCancelled("request_cancelled")
  );
  expect(
    await f.adapter.reconcile(f.scope, f.input.correlation, f.control)
  ).toMatchObject({ status: "cancelled" });
  expect(f.deps.dispatch).not.toHaveBeenCalled();
});

it("does not adopt a later GitHub rerun as the originally dispatched attempt", async () => {
  const f = fixture();
  vi.mocked(f.deps.runs).mockResolvedValue(
    portSuccess([{ ...f.identity, run: { ...f.identity.run, runAttempt: 2 } }])
  );
  expect(
    await f.adapter.reconcile(f.scope, f.input.correlation, f.control)
  ).toMatchObject({
    status: "ok",
    value: { matches: [], observation: { quality: "unknown" } }
  });
  expect(f.deps.dispatch).not.toHaveBeenCalled();
});
it("honors cancellation before and after reads and preparation without dispatching", async () => {
  const f = fixture();
  let aborted = true;
  const control = {
    ...f.control,
    cancellation: {
      ...f.control.cancellation,
      get aborted() {
        return aborted;
      }
    }
  };
  expect(await f.adapter.prepare(f.input, control)).toMatchObject({
    status: "cancelled"
  });
  expect(
    await f.adapter.reconcile(f.scope, f.input.correlation, control)
  ).toMatchObject({ status: "cancelled" });
  expect(f.deps.runs).not.toHaveBeenCalled();
  aborted = false;
  vi.mocked(f.deps.runs).mockImplementation(async () => {
    aborted = true;
    return portSuccess([]);
  });
  expect(
    await f.adapter.reconcile(f.scope, f.input.correlation, control)
  ).toMatchObject({ status: "cancelled" });
  expect(f.deps.dispatch).not.toHaveBeenCalled();
});

it("propagates policy and revalidation failure and consumes cancelled dispatch admission", async () => {
  const f = fixture();
  expect(
    await f.adapter.prepare(
      { ...f.input, source: { ...f.input.source, commit: "b".repeat(40) } },
      f.control
    )
  ).toMatchObject({ status: "failed" });
  vi.mocked(f.deps.qualify).mockResolvedValueOnce(
    portFailure("PRECONDITION_FAILED")
  );
  expect(await f.adapter.prepare(f.input, f.control)).toMatchObject({
    status: "failed"
  });
  const prepared = await f.adapter.prepare(f.input, f.control);
  if (prepared.status !== "ok") throw new Error("No preparation");
  vi.mocked(f.deps.revalidate).mockResolvedValueOnce(
    portFailure("PRECONDITION_FAILED")
  );
  expect(await f.adapter.dispatch(prepared.value, f.control)).toMatchObject({
    status: "failed"
  });
  const next = await f.adapter.prepare(f.input, f.control);
  if (next.status !== "ok") throw new Error("No next preparation");
  expect(
    await f.adapter.dispatch(next.value, {
      ...f.control,
      cancellation: { ...f.control.cancellation, aborted: true }
    })
  ).toMatchObject({ status: "cancelled" });
  expect(await f.adapter.dispatch(next.value, f.control)).toMatchObject({
    status: "failed"
  });
  expect(f.deps.dispatch).not.toHaveBeenCalled();
});

it("keeps confirmed absence as no match and progress-only evidence incomplete", async () => {
  const f = fixture();
  vi.mocked(f.deps.runs).mockResolvedValue({
    status: "absent",
    reason: "not_found",
    observation: {
      quality: "current",
      completeness: "complete",
      evidence: "workflow",
      observedAt: f.deps.clock.now()
    }
  });
  expect(
    await f.adapter.reconcile(f.scope, f.input.correlation, f.control)
  ).toMatchObject({ status: "ok", value: { matches: [] } });
  vi.mocked(f.deps.observation).mockResolvedValue(
    portSuccess({
      identity: f.identity,
      conclusion: "success",
      progress: JSON.stringify({
        schemaVersion: 2,
        operationId: f.identity.operationId,
        attemptId: f.identity.attemptId,
        operation: f.identity.operation,
        ...f.identity.target,
        expectedCommit: f.identity.expectedCommit,
        actualCommit: f.identity.expectedCommit,
        runId: 123,
        runAttempt: 1,
        sequence: 1,
        updatedAt: f.deps.clock.now(),
        state: "in_progress",
        diagnosticsRedacted: true,
        resources: []
      })
    })
  );
  expect(await f.adapter.observe(f.scope, f.identity, f.control)).toMatchObject(
    {
      status: "ok",
      value: {
        observation: { completeness: "partial" },
        evidence: { status: "ok" }
      }
    }
  );
});

it("retains workflow conclusion with absent artifact and rejects foreign observation", async () => {
  const f = fixture();
  expect(await f.adapter.observe(f.scope, f.identity, f.control)).toMatchObject(
    {
      status: "ok",
      value: { conclusion: "failure", evidence: { status: "unavailable" } }
    }
  );
  vi.mocked(f.deps.observation).mockResolvedValue(
    portSuccess({
      identity: { ...f.identity, attemptId: "foreign" },
      conclusion: "success"
    })
  );
  expect(await f.adapter.observe(f.scope, f.identity, f.control)).toMatchObject(
    { status: "failed", error: { code: "EVIDENCE_MISMATCH" } }
  );
  vi.mocked(f.deps.observation).mockResolvedValue(
    portFailure("EVIDENCE_MISMATCH")
  );
  expect(await f.adapter.observe(f.scope, f.identity, f.control)).toMatchObject(
    { status: "failed" }
  );
  expect(
    await f.adapter.cancel(
      { ...f.scope, operation: "operation.cancel" },
      f.identity,
      f.control
    )
  ).toMatchObject({ status: "unavailable" });
});
