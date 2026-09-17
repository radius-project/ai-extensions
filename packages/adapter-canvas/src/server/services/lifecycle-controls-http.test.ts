import { expect, it, vi } from "vitest";
import {
  lifecycleError,
  portForbidden,
  portSuccess,
  portCancelled,
  type OperationRecord
} from "@radius-project/core/lifecycle";
import {
  createLifecycleControlsHttp,
  lifecycleControlView
} from "./lifecycle-controls-http.js";

function fixture() {
  const source = {
    kind: "workspace" as const,
    workspaceRef: "workspace",
    branch: "feature",
    expectedFingerprint: `sha256:${"a".repeat(64)}`
  };
  const record: OperationRecord = {
    operationId: "operation",
    operation: "definition.author",
    target: { repo: "owner/repo", definition: ".radius/app.bicep", source },
    state: "queued",
    attempts: [],
    actions: [],
    observation: {
      quality: "current",
      completeness: "complete",
      evidence: "session",
      observedAt: "2026-09-17T19:00:00Z"
    }
  };
  const records = [record];
  const envelope = {
    apiVersion: "github-radius/v1" as const,
    requestId: "request"
  };
  const read = {
    ...envelope,
    operation: "operation.get" as const,
    result: record
  };
  type Binding = Parameters<typeof createLifecycleControlsHttp>[0];
  const execute = vi.fn<Binding["execute"]>(async () => {
    throw new Error("Unmodeled lifecycle request");
  });
  const resolveWorkspaceSource = vi.fn<Binding["resolveWorkspaceSource"]>(
    async () => portSuccess(source)
  );
  const address = vi.fn(() => "lifecycle" as const);
  const service = createLifecycleControlsHttp({
    execute,
    resolveWorkspaceSource,
    routing: { address },
    registry: { knownOperations: () => records }
  });
  return {
    service,
    record,
    records,
    read,
    execute,
    envelope,
    resolveWorkspaceSource,
    address,
    source
  };
}
it("leaves missing operations with their established 404 contract", async () => {
  const f = fixture();
  expect(await f.service.status("missing")).toMatchObject({ status: 404 });
  expect(
    await f.service.control("missing", "cancel-workflow", {})
  ).toMatchObject({ status: 404 });
  expect(f.execute).not.toHaveBeenCalled();
});
it("observes an exact known record without continuing it", async () => {
  const f = fixture();
  f.execute.mockResolvedValue(f.read);
  expect(await f.service.status("operation")).toMatchObject({
    status: 200,
    body: { operation: { kind: "lifecycle_operation" } }
  });
  expect(f.execute).toHaveBeenCalledWith({
    operation: "operation.get",
    target: { repo: "owner/repo" },
    input: { operationId: "operation" }
  });
  expect(f.address).toHaveBeenCalledWith("operation");
});
it.each([
  ["FORBIDDEN", 403],
  ["CAPABILITY_UNAVAILABLE", 503],
  ["INVALID_REQUEST", 400],
  ["PRECONDITION_FAILED", 409]
] as const)("preserves %s as HTTP %s", async (code, status) => {
  const f = fixture();
  f.execute.mockResolvedValue({ ...f.envelope, error: lifecycleError(code) });
  expect(await f.service.status("operation")).toMatchObject({ status });
  expect(
    await f.service.control("operation", "cancel-workflow", {})
  ).toMatchObject({ status });
  expect(
    await f.service.control("operation", "retry/repair", {})
  ).toMatchObject({ status });
});
it.each([
  ["stop", {}, 409],
  ["rollback", {}, 409],
  ["exit", {}, 409],
  ["cancel-workflow", { runId: "42" }, 409],
  ["continue", null, 400],
  ["continue", { response: {}, choice: "continue" }, 400],
  ["continue", { response: {}, approvalRef: "public" }, 400],
  ["retry/repair", { deploy: true }, 409]
])(
  "rejects unsupported or contradictory %s input without mutation",
  async (command, input, status) => {
    const f = fixture();
    expect(
      await f.service.control(String(command), "invalid", {})
    ).toMatchObject({ status: 404 });
    expect(
      await f.service.control("operation", String(command), input)
    ).toMatchObject({ status });
    expect(f.execute).not.toHaveBeenCalled();
  }
);
it.each([true, false])(
  "binds explicit repair source (provided=%s) and returns its linked status URL",
  async (provided) => {
    const f = fixture();
    f.execute.mockResolvedValueOnce(f.read).mockResolvedValueOnce({
      ...f.envelope,
      operation: "operation.repair",
      result: {
        operationId: "linked",
        target: { repo: "owner/repo" },
        state: "queued",
        source: {
          kind: "workspace",
          repo: "owner/repo",
          workspaceRef: "workspace",
          branch: "feature",
          fingerprint: f.source.expectedFingerprint,
          resolvedAt: "2026-09-17T19:00:00Z"
        },
        observation: f.record.observation
      }
    });
    expect(
      await f.service.control("operation", "retry/repair", {
        ...(provided ? { source: f.source } : {}),
        repairPolicy: { mode: "manual", maxAttempts: 1 }
      })
    ).toMatchObject({
      status: 202,
      body: { operationId: "linked", statusUrl: "/api/operations/linked" }
    });
    expect(f.resolveWorkspaceSource).toHaveBeenCalledTimes(provided ? 0 : 1);
    expect(f.execute.mock.calls[1]?.[0]).toMatchObject({
      operation: "operation.repair",
      input: { source: f.source }
    });
  }
);
it.each([true, false])(
  "does not substitute failed source resolution (error=%s)",
  async (hasError) => {
    const f = fixture();
    f.execute.mockResolvedValue(f.read);
    f.resolveWorkspaceSource.mockResolvedValue(
      hasError ? portForbidden() : portCancelled("request_cancelled")
    );
    expect(
      await f.service.control("operation", "retry/repair", {})
    ).toMatchObject({ status: hasError ? 403 : 409 });
    expect(f.execute).toHaveBeenCalledOnce();
  }
);
it("cannot repair an operation without a definition", async () => {
  const f = fixture();
  delete f.record.target.definition;
  f.execute.mockResolvedValue(f.read);
  expect(
    await f.service.control("operation", "retry/repair", {})
  ).toMatchObject({ status: 409 });
  expect(f.resolveWorkspaceSource).not.toHaveBeenCalled();
});
it.each([true, false])(
  "keeps agent outcomes distinct from user decisions (agent=%s)",
  async (agent) => {
    const f = fixture();
    f.execute.mockResolvedValue({
      ...f.envelope,
      operation: "operation.respond",
      result: f.record
    });
    const input =
      agent ?
        {
          actionId: "action",
          response: { kind: "agent.outcome", status: "failed", diagnostics: [] }
        }
      : {
          actionId: "action",
          choice: "continue",
          approvalRef: "public-reference"
        };
    expect(
      await f.service.control("operation", "continue", input)
    ).toMatchObject({ status: 202 });
    expect(f.execute.mock.calls[0]?.[0]).toMatchObject({
      operation: "operation.respond",
      input: { response: { kind: agent ? "agent.outcome" : "user.decision" } }
    });
  }
);
it("returns requested cancellation without claiming termination", async () => {
  const f = fixture();
  f.execute.mockResolvedValue({
    ...f.envelope,
    operation: "operation.cancel",
    result: { cancellation: { status: "requested" }, operation: f.record }
  });
  expect(
    await f.service.control("operation", "cancel-workflow", {})
  ).toMatchObject({
    status: 202,
    body: {
      cancellation: { status: "requested" },
      operation: { state: "queued" }
    }
  });
});
it.each([
  "failed",
  "succeeded",
  "cancelled",
  "action_required",
  "running"
] as const)(
  "renders truthful %s controls with no destructive rollback mapping",
  (state) => {
    const f = fixture();
    const view = lifecycleControlView({ ...f.record, state });
    expect(
      view.actions.every(
        (action) =>
          !action.requiresConfirmation && !/rollback/.test(action.path)
      )
    ).toBe(true);
    expect(view.summary).not.toContain("Configuration");
    if (state === "failed")
      expect(view.actions[0]?.kind).toBe("lifecycle.repair");
  }
);

it("retains source target, state-save and cleanup evidence for deployment controls", async () => {
  const f = fixture();
  f.record.operation = "deployment.start";
  f.record.target.environment = "dev";
  f.record.target.application = "app";
  f.record.state = "running";
  f.record.cancellationRequestedAt = "2026-09-17T19:00:00Z";
  f.record.attempts = [
    {
      attemptId: "attempt",
      operationId: "operation",
      observation: f.record.observation,
      phases: [
        {
          phase: "cleanup",
          status: "failed",
          exitCode: 1,
          reason: "Owned cleanup failed."
        }
      ]
    }
  ];
  f.execute.mockResolvedValue(f.read);
  expect(await f.service.status("operation")).toMatchObject({
    body: {
      operation: {
        summary: expect.stringContaining("Cancellation requested"),
        actions: [],
        stages: [{ state: "failed" }]
      }
    }
  });
  expect(f.execute).toHaveBeenCalledWith({
    operation: "operation.get",
    target: { repo: "owner/repo", environment: "dev", application: "app" },
    input: { operationId: "operation" }
  });
  expect(
    lifecycleControlView({ ...f.record, state: "succeeded" }).summary
  ).toContain("Deployment completion");
  expect(
    lifecycleControlView({ ...f.record, state: "failed" }).summary
  ).toContain("Deployment");
});
it("does not accept an unrelated operation response as a status observation", async () => {
  const f = fixture();
  f.execute.mockResolvedValue({
    ...f.envelope,
    operation: "operation.respond",
    result: f.record
  });
  await expect(f.service.status("operation")).rejects.toThrow(
    "Unexpected operation observation"
  );
});

it("does not fabricate a public approval reference for a user decision", async () => {
  const f = fixture();
  f.execute.mockResolvedValue({
    ...f.envelope,
    operation: "operation.respond",
    result: f.record
  });
  expect(
    await f.service.control("operation", "continue", {
      actionId: "action",
      choice: "continue"
    })
  ).toMatchObject({ status: 202 });
  expect(f.execute.mock.calls[0]?.[0]).toMatchObject({
    input: { response: { kind: "user.decision", choice: "continue" } }
  });
  expect(JSON.stringify(f.execute.mock.calls)).not.toContain("approvalRef");
  expect(
    lifecycleControlView({
      ...f.record,
      operation: "operation.repair",
      state: "failed"
    }).summary
  ).toContain("Definition repair");
});
