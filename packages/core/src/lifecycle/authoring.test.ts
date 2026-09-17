import { describe, expect, it, vi } from "vitest";
import {
  createDefinitionAuthoring,
  type DefinitionAuthoringDependencies
} from "./authoring.js";
import { createActionService } from "./actions.js";
import {
  createSessionOperationRegistry,
  reduceOperation
} from "./operations.js";
import {
  portAbsent,
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable
} from "./errors.js";
import type {
  DefinitionAuthoringSourcePort,
  DefinitionValidationPort
} from "./definition-ports.js";
import type {
  AgentAssistancePort,
  AuthorizedScope,
  CallerContext,
  SourceSnapshot,
  StagedOutputs
} from "./ports.js";
import { reduceValidationReport } from "./validation-policy.js";
import { UNSUPPORTED_NO_DOCKERFILE_MESSAGE } from "../modeling/app-source.js";

const fingerprint = `sha256:${"a".repeat(64)}`;
const proposalFingerprint = `sha256:${"b".repeat(64)}`;
const target = {
  repo: "owner/repo",
  definition: ".radius/app.bicep",
  source: {
    kind: "workspace" as const,
    workspaceRef: "workspace",
    branch: "feature",
    expectedFingerprint: fingerprint
  }
};
const caller: CallerContext = {
  principalRef: "principal",
  sessionRef: "session",
  identityRef: "identity",
  responder: "user",
  agentBindingRef: "agent",
  approvedHostActionRef: "approval"
};
const snapshot: SourceSnapshot = {
  snapshotRef: "snapshot",
  selection: target,
  provenance: {
    repo: target.repo,
    kind: "workspace",
    workspaceRef: "workspace",
    branch: "feature",
    fingerprint,
    resolvedAt: "2026-09-15T00:00:00Z"
  },
  manifest: {
    completeness: "complete",
    definition: target.definition,
    fingerprint,
    inputs: [
      {
        path: target.definition,
        kind: "definition",
        existed: false,
        contentHash: null
      },
      {
        path: "Dockerfile",
        kind: "file",
        existed: true,
        contentHash: fingerprint
      }
    ]
  }
};
const scope: AuthorizedScope<"definition.author"> = {
  authorizationRef: "auth",
  principalRef: "principal",
  operation: "definition.author",
  target,
  source: snapshot.provenance,
  approvalRef: "approval"
};
function fixture() {
  let sequence = 0;
  const clock = { now: () => "2026-09-15T00:00:00Z" };
  const ids = { next: (kind: string) => `${kind}-${++sequence}` };
  const signal = { aborted: false, onAbort: () => () => {} };
  const control = { requestId: "request", cancellation: signal };
  const registry = createSessionOperationRegistry({ ids, clock });
  const authorize = vi.fn<
    DefinitionAuthoringDependencies["identity"]["authorize"]
  >(async (request) =>
    portSuccess({
      ...request,
      authorizationRef: "renewed",
      principalRef: caller.principalRef
    })
  );
  const actions = createActionService({
    registry,
    ids,
    clock,
    identity: {
      authorizeResponse: async (_caller, action) =>
        portSuccess({
          authorizationRef: "response",
          principalRef: caller.principalRef,
          operation: "operation.respond",
          operationId: action.operationId,
          target: action.target,
          source: action.source,
          approvalRef: "approval"
        })
    }
  });
  const assign = vi.fn<AgentAssistancePort["assign"]>(
    async (_scope, assignment) =>
      portSuccess({
        deliveryRef: "delivery",
        operationId: assignment.action.operationId,
        actionId: assignment.action.actionId
      })
  );
  const authenticateOutcome = vi.fn<AgentAssistancePort["authenticateOutcome"]>(
    async (_caller, action, outcome) =>
      portSuccess({
        agentBindingRef: "agent",
        operationId: action.operationId,
        actionId: action.actionId,
        outcome
      })
  );
  const outputs = (staging: StagedOutputs["staging"]): StagedOutputs => ({
    staging,
    outputRefs: ["staging/app.bicep"],
    fingerprint: proposalFingerprint,
    outputs: [
      {
        path: target.definition,
        kind: "definition",
        existed: true,
        contentHash: proposalFingerprint
      }
    ]
  });
  const source: DefinitionAuthoringSourcePort = {
    captureForAuthoring: vi.fn<
      DefinitionAuthoringSourcePort["captureForAuthoring"]
    >(async () => portSuccess({ status: "captured", snapshot })),
    prepareStaging: vi.fn(async (_scope, binding) =>
      portSuccess({ ...binding, stagingRef: "staging" })
    ),
    inspectStagedOutputs: vi.fn(async (staging) =>
      portSuccess(outputs(staging))
    ),
    captureProposal: vi.fn<DefinitionAuthoringSourcePort["captureProposal"]>(
      async () =>
        portSuccess({
          status: "captured",
          snapshot: {
            ...snapshot,
            snapshotRef: "proposal",
            provenance: {
              ...snapshot.provenance,
              fingerprint: proposalFingerprint
            },
            manifest: {
              ...snapshot.manifest,
              fingerprint: proposalFingerprint,
              inputs: [
                {
                  path: target.definition,
                  kind: "definition",
                  existed: true,
                  contentHash: proposalFingerprint
                }
              ]
            }
          }
        })
    ),
    promote: vi.fn<DefinitionAuthoringSourcePort["promote"]>(async () => ({
      status: "promoted",
      manifest: {
        ...snapshot.manifest,
        fingerprint: proposalFingerprint,
        inputs: [
          {
            path: target.definition,
            kind: "definition",
            existed: true,
            contentHash: proposalFingerprint
          }
        ]
      }
    })),
    releaseSnapshot: vi.fn<DefinitionAuthoringSourcePort["releaseSnapshot"]>(
      async () => portSuccess({ status: "released" })
    ),
    releaseStaging: vi.fn<DefinitionAuthoringSourcePort["releaseStaging"]>(
      async () => portSuccess({ status: "released" })
    )
  };
  const validator: DefinitionValidationPort = {
    validate: vi.fn<DefinitionValidationPort["validate"]>(async (input) =>
      portSuccess(
        reduceValidationReport(
          input.policy,
          input.policy.checks.map((check) => ({
            ...check,
            status: "passed",
            reason: "Verified."
          })),
          {
            sourceFingerprint: input.sourceFingerprint,
            proposalFingerprint: input.proposalFingerprint
          }
        )
      )
    )
  };
  const deps: DefinitionAuthoringDependencies = {
    source,
    validator,
    registry,
    actions,
    identity: { authorize },
    agent: { assign, authenticateOutcome },
    ids,
    clock
  };
  const service = createDefinitionAuthoring(deps);
  const author = () =>
    service.author(
      scope,
      caller,
      target,
      { intent: "Model application", provider: "azure" },
      control
    );
  async function start() {
    const result = await author();
    if (result.status !== "ok") throw new Error(JSON.stringify(result));
    const operation = result.value;
    const action = operation.actions[0];
    const respond = (
      response: import("./contracts/common.js").ActionResponse = {
        kind: "agent.outcome",
        status: "completed",
        stagedOutputRefs: ["staging/app.bicep"]
      }
    ) =>
      actions.respond(
        {
          authorizationRef: "auth",
          principalRef: caller.principalRef,
          operation: "operation.respond",
          operationId: operation.operationId,
          target,
          source: snapshot.provenance,
          approvalRef: "approval"
        },
        { ...caller, responder: "agent" },
        {
          operationId: operation.operationId,
          actionId: action.actionId,
          response
        },
        control
      );
    return { operation, action, respond };
  }
  return {
    source,
    validator,
    service,
    registry,
    authorize,
    assign,
    authenticateOutcome,
    signal,
    control,
    author,
    start,
    deps,
    actions
  };
}
describe("guarded definition authoring", () => {
  it("refuses cancellation without an owned assignment or cancellation capability", async () => {
    const f = fixture();
    const cancelScope = { ...scope, operation: "operation.cancel" as const };
    expect(
      await f.service.cancel(cancelScope, "missing", f.control)
    ).toMatchObject({ status: "unavailable" });
    const pending = await f.start();
    expect(
      await f.service.cancel(
        cancelScope,
        pending.operation.operationId,
        f.control
      )
    ).toMatchObject({ status: "unavailable" });
    await f.service.close();
  });
  it("preserves staging cleanup failure instead of claiming confirmed local cancellation", async () => {
    const f = fixture();
    f.deps.agent.cancel = async () =>
      portSuccess({
        status: "confirmed",
        requestedAt: "2026-09-15T00:00:00Z",
        observation: {
          quality: "current",
          completeness: "partial",
          evidence: "session"
        }
      });
    const pending = await f.start();
    vi.mocked(f.source.releaseStaging).mockResolvedValueOnce(
      portFailure("PRECONDITION_FAILED")
    );
    expect(
      await f.service.cancel(
        { ...scope, operation: "operation.cancel" },
        pending.operation.operationId,
        f.control
      )
    ).toMatchObject({ error: { code: "PRECONDITION_FAILED" } });
    expect(f.source.promote).not.toHaveBeenCalled();
    await f.service.close();
  });
  it.each(["completed", "failed", "cancelled"] as const)(
    "retains authenticated %s evidence after a requested cancellation without promoting",
    async (status) => {
      const f = fixture();
      f.deps.agent.cancel = async () =>
        portSuccess({
          status: "requested",
          requestedAt: "2026-09-15T00:00:00Z",
          observation: {
            quality: "unknown",
            completeness: "partial",
            evidence: "session"
          }
        });
      const pending = await f.start();
      const cancelScope = { ...scope, operation: "operation.cancel" as const };
      const current = await f.registry.get(
        cancelScope,
        pending.operation.operationId,
        f.control
      );
      if (current.status !== "ok") throw new Error("Missing pending operation");
      await f.registry.compareAndSwap(
        cancelScope,
        {
          operationId: pending.operation.operationId,
          expectedRevision: current.value.revision,
          replacement: {
            ...current.value.operation,
            cancellationRequestedAt: "2026-09-15T00:00:00Z"
          }
        },
        f.control
      );
      await f.service.cancel(
        cancelScope,
        pending.operation.operationId,
        f.control
      );
      const result = await pending.respond(
        status === "completed" ?
          {
            kind: "agent.outcome",
            status,
            stagedOutputRefs: ["staging/app.bicep"]
          }
        : { kind: "agent.outcome", status, diagnostics: [] }
      );
      expect(result).toMatchObject({
        status: "ok",
        value: { state: status === "failed" ? "failed" : "cancelled" }
      });
      expect(f.validator.validate).not.toHaveBeenCalled();
      expect(f.source.promote).not.toHaveBeenCalled();
      expect(f.source.releaseStaging).toHaveBeenCalledOnce();
      expect(await pending.respond()).toMatchObject({
        error: { code: "ACTION_NOT_OUTSTANDING" }
      });
    }
  );
  it("cancels owned validation callbacks without promoting or claiming remote cancellation", async () => {
    const f = fixture();
    const entered = deferred();
    let cancellationObserved = false;
    f.deps.agent.cancel = async () =>
      portSuccess({
        status: "requested",
        requestedAt: "2026-09-15T00:00:00Z",
        observation: {
          quality: "unknown",
          completeness: "partial",
          evidence: "session"
        }
      });
    vi.mocked(f.validator.validate).mockImplementation(
      async (_input, control) => {
        const removeBrokenCallback = control.cancellation.onAbort(() => {
          throw new Error("One owned callback failed");
        });
        await new Promise<void>((resolve) => {
          const unsubscribe = control.cancellation.onAbort(() => {
            cancellationObserved = control.cancellation.aborted;
            unsubscribe();
            removeBrokenCallback();
            resolve();
          });
          entered.resolve();
        });
        return portCancelled("request_cancelled");
      }
    );
    const pending = await f.start();
    const response = pending.respond();
    await entered.promise;
    expect(
      await f.service.cancel(
        { ...scope, operation: "operation.cancel" },
        pending.operation.operationId,
        f.control
      )
    ).toMatchObject({ value: { status: "requested" } });
    expect(await response).toMatchObject({
      status: "ok",
      value: {
        state: "cancelled",
        observation: {
          limitation: expect.stringContaining("remote workflow cancellation")
        }
      }
    });
    expect(cancellationObserved).toBe(true);
    expect(f.source.promote).not.toHaveBeenCalled();
    expect(f.source.releaseStaging).toHaveBeenCalledOnce();
  });
  const absent = () =>
    portAbsent({
      quality: "current",
      completeness: "complete",
      evidence: "source",
      observedAt: "2026-09-15T00:00:00Z"
    });
  const incomplete = () =>
    portSuccess({
      status: "incomplete" as const,
      manifest: {
        completeness: "incomplete" as const,
        definition: target.definition,
        inputs: [],
        diagnostics: []
      }
    });
  function deferred() {
    let resolve: () => void = () => {
      throw new Error("Not initialized");
    };
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  it("binds first-model staging to an operation and consumes the action exactly once before promotion", async () => {
    const f = fixture();
    const started = await f.start();
    expect(started.operation.state).toBe("action_required");
    expect(f.source.promote).not.toHaveBeenCalled();
    expect(await started.respond()).toMatchObject({
      status: "ok",
      value: {
        state: "succeeded",
        result: {
          kind: "definition",
          proposal: { promotion: "promoted", originalFingerprint: fingerprint }
        }
      }
    });
    expect(f.source.promote).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedManifest: snapshot.manifest,
        proposal: expect.objectContaining({
          operationId: started.operation.operationId,
          actionId: started.action.actionId
        })
      }),
      expect.objectContaining({
        requestId: f.control.requestId,
        cancellation: expect.objectContaining({ aborted: false })
      })
    );
    expect(f.validator.validate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFingerprint: fingerprint,
        proposalFingerprint,
        policy: expect.objectContaining({
          purpose: "authoring",
          provider: "azure"
        }),
        snapshot: expect.objectContaining({ snapshotRef: "proposal" })
      }),
      expect.objectContaining({
        requestId: f.control.requestId,
        cancellation: expect.objectContaining({ aborted: false })
      })
    );
    expect(await started.respond()).toMatchObject({
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    expect(f.source.promote).toHaveBeenCalledTimes(1);
    expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(2);
    expect(f.source.releaseStaging).toHaveBeenCalledTimes(1);
  });
  it.each(["completion", "shutdown", "failure"] as const)(
    "preserves opaque snapshot ownership during %s without exposing snapshots",
    async (ending) => {
      const f = fixture();
      const captured = structuredClone(snapshot);
      const proposal: SourceSnapshot = {
        ...captured,
        snapshotRef: "owned-proposal",
        provenance: {
          ...captured.provenance,
          fingerprint: proposalFingerprint
        },
        manifest: {
          ...captured.manifest,
          fingerprint: proposalFingerprint,
          inputs: [
            {
              path: target.definition,
              kind: "definition",
              existed: true,
              contentHash: proposalFingerprint
            }
          ]
        }
      };
      vi.mocked(f.source.captureForAuthoring).mockResolvedValue(
        portSuccess({ status: "captured", snapshot: captured })
      );
      vi.mocked(f.source.prepareStaging).mockImplementation(
        async (_scope, binding) => {
          if (binding.snapshot !== captured) return portForbidden();
          return portSuccess({ ...binding, stagingRef: "staging" });
        }
      );
      vi.mocked(f.source.captureProposal).mockResolvedValue(
        portSuccess({ status: "captured", snapshot: proposal })
      );
      vi.mocked(f.source.releaseSnapshot).mockImplementation(
        async (released) =>
          released === captured || released === proposal ?
            portSuccess({ status: "released" })
          : portForbidden()
      );
      const before = structuredClone(captured);
      if (ending === "failure") {
        f.assign.mockResolvedValue(portForbidden());
        expect(await f.author()).toMatchObject({ status: "forbidden" });
      } else {
        const started = await f.start();
        expect(started.operation).not.toHaveProperty("snapshot");
        expect(started.action).not.toHaveProperty("snapshot");
        expect(started.operation.source).not.toBe(captured.provenance);
        if (ending === "completion") {
          expect(await started.respond()).toMatchObject({
            status: "ok",
            value: { state: "succeeded" }
          });
          expect(
            vi.mocked(f.validator.validate).mock.calls[0][0].snapshot
          ).toBe(proposal);
          expect(vi.mocked(f.source.releaseSnapshot).mock.calls[0][0]).toBe(
            proposal
          );
        } else {
          expect(await f.service.close()).toMatchObject({ status: "ok" });
        }
      }
      expect(vi.mocked(f.source.releaseSnapshot).mock.calls.at(-1)?.[0]).toBe(
        captured
      );
      expect(captured).toEqual(before);
    }
  );
  it.each([
    {
      path: "src/main.ts",
      existed: true,
      status: "failed",
      code: "VALIDATION_FAILED"
    },
    {
      path: "node_modules/pkg/Dockerfile",
      existed: true,
      status: "failed",
      code: "VALIDATION_FAILED"
    },
    {
      path: ".devcontainer/Dockerfile",
      existed: true,
      status: "failed",
      code: "VALIDATION_FAILED"
    },
    {
      path: "Dockerfile",
      existed: false,
      status: "unavailable",
      code: "SOURCE_UNAVAILABLE"
    }
  ])(
    "refuses nonmodelable evidence $path before all side effects",
    async ({ path, existed, status, code }) => {
      const f = fixture();
      const captured: SourceSnapshot = {
        ...snapshot,
        manifest: {
          ...snapshot.manifest,
          inputs: [
            snapshot.manifest.inputs[0],
            {
              path,
              existed,
              kind: "file",
              contentHash: existed ? fingerprint : null
            }
          ]
        }
      };
      vi.mocked(f.source.captureForAuthoring).mockResolvedValue(
        portSuccess({ status: "captured", snapshot: captured })
      );
      const result = await f.author();
      expect(result).toMatchObject({ status, error: { code } });
      if (status === "failed")
        expect(result).toMatchObject({
          error: {
            details: [
              {
                message: UNSUPPORTED_NO_DOCKERFILE_MESSAGE,
                classification: "modelability.no_dockerfile"
              }
            ]
          }
        });
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.assign).not.toHaveBeenCalled();
      expect(f.source.prepareStaging).not.toHaveBeenCalled();
      expect(f.validator.validate).not.toHaveBeenCalled();
      expect(f.source.promote).not.toHaveBeenCalled();
      expect(vi.mocked(f.source.releaseSnapshot).mock.calls[0][0]).toBe(
        captured
      );
      expect(
        await f.registry.list(
          { ...scope, operation: "operation.list" },
          {},
          f.control
        )
      ).toMatchObject({ status: "ok", value: { items: [] } });
    }
  );
  it.each(["cancelled", "stale", "missingHash"] as const)(
    "checks %s source evidence before modelability refusal or assignment",
    async (condition) => {
      const f = fixture();
      const captured: SourceSnapshot = {
        ...snapshot,
        provenance: {
          ...snapshot.provenance,
          kind: "workspace",
          workspaceRef: "workspace",
          branch: condition === "stale" ? "changed" : "feature"
        },
        manifest: {
          ...snapshot.manifest,
          inputs: [
            snapshot.manifest.inputs[0],
            {
              path: "src/main.ts",
              kind: "file",
              existed: true,
              contentHash: condition === "missingHash" ? null : fingerprint
            }
          ]
        }
      };
      vi.mocked(f.source.captureForAuthoring).mockImplementation(async () => {
        f.signal.aborted = condition === "cancelled";
        return portSuccess({ status: "captured", snapshot: captured });
      });
      expect(await f.author()).toMatchObject(
        condition === "cancelled" ?
          { status: "cancelled" }
        : {
            error: {
              code:
                condition === "stale" ? "SOURCE_CHANGED" : (
                  "VALIDATION_INCOMPLETE"
                )
            }
          }
      );
      expect(f.assign).not.toHaveBeenCalled();
      expect(f.source.prepareStaging).not.toHaveBeenCalled();
      expect(vi.mocked(f.source.releaseSnapshot).mock.calls[0][0]).toBe(
        captured
      );
    }
  );
  it.each([
    ["services/api/Dockerfile.dev"],
    ["services/api/Dockerfile", "services/web/prod.Dockerfile"]
  ])("assigns modelable captured Dockerfile evidence %j", async (...paths) => {
    const f = fixture();
    vi.mocked(f.source.captureForAuthoring).mockResolvedValue(
      portSuccess({
        status: "captured",
        snapshot: {
          ...snapshot,
          manifest: {
            ...snapshot.manifest,
            inputs: [
              snapshot.manifest.inputs[0],
              ...paths.map((path) => ({
                path,
                kind: "file" as const,
                existed: true,
                contentHash: fingerprint
              }))
            ]
          }
        }
      })
    );
    expect(await f.author()).toMatchObject({
      status: "ok",
      value: { state: "action_required" }
    });
    expect(f.assign).toHaveBeenCalledOnce();
    expect(await f.service.close()).toMatchObject({ status: "ok" });
  });
  it.each(["agent", "approval", "workspace"] as const)(
    "requires trusted %s before any work",
    async (missing) => {
      const f = fixture();
      const result = await f.service.author(
        missing === "approval" ? { ...scope, approvalRef: undefined } : scope,
        missing === "agent" ?
          { ...caller, agentBindingRef: undefined }
        : caller,
        missing === "workspace" ?
          {
            ...target,
            source: {
              kind: "git",
              ref: "main",
              expectedCommit: "a".repeat(40)
            }
          }
        : target,
        { intent: "Model", provider: "azure" },
        f.control
      );
      expect(result.status).not.toBe("ok");
      expect(f.source.captureForAuthoring).not.toHaveBeenCalled();
      expect(f.assign).not.toHaveBeenCalled();
    }
  );
  it("cancels shutdown during source capture before modelability or staging", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    const captured: SourceSnapshot = {
      ...snapshot,
      manifest: {
        ...snapshot.manifest,
        inputs: [
          snapshot.manifest.inputs[0],
          {
            path: "src/main.ts",
            kind: "file",
            existed: true,
            contentHash: fingerprint
          }
        ]
      }
    };
    vi.mocked(f.source.captureForAuthoring).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return portSuccess({ status: "captured", snapshot: captured });
    });
    const authoring = f.author();
    await entered.promise;
    const closing = f.service.close();
    release.resolve();
    expect(await authoring).toMatchObject({ status: "cancelled" });
    expect(await closing).toMatchObject({ status: "ok" });
    expect(f.assign).not.toHaveBeenCalled();
    expect(f.source.prepareStaging).not.toHaveBeenCalled();
    expect(vi.mocked(f.source.releaseSnapshot).mock.calls[0][0]).toBe(captured);
  });
  it("revalidates actual authority before promotion and refuses stale approval", async () => {
    const f = fixture();
    const started = await f.start();
    f.authorize.mockResolvedValue(portForbidden());
    expect(await started.respond()).toMatchObject({ status: "forbidden" });
    expect(f.source.promote).not.toHaveBeenCalled();
    await f.service.close();
    expect(f.source.releaseStaging).toHaveBeenCalledOnce();
  });
  it.each(["failed", "cancelled"] as const)(
    "preserves agent %s and cleans without validation or promotion",
    async (status) => {
      const f = fixture();
      const started = await f.start();
      expect(
        await started.respond({
          kind: "agent.outcome",
          status,
          diagnostics: []
        })
      ).toMatchObject({ status: "ok", value: { state: status } });
      expect(f.validator.validate).not.toHaveBeenCalled();
      expect(f.source.promote).not.toHaveBeenCalled();
      expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    }
  );
  it.each(["failed", "unavailable"] as const)(
    "blocks required %s reports",
    async (status) => {
      const f = fixture();
      vi.mocked(f.validator.validate).mockImplementation(async (input) =>
        portSuccess(
          reduceValidationReport(
            input.policy,
            input.policy.checks.map((check) => ({
              ...check,
              status,
              reason: "Cannot verify."
            })),
            {
              sourceFingerprint: input.sourceFingerprint,
              proposalFingerprint: input.proposalFingerprint
            }
          )
        )
      );
      const started = await f.start();
      expect(await started.respond()).toMatchObject({
        status: "ok",
        value: {
          state: "failed",
          result: {
            proposal: {
              promotion: "refused",
              validation: {
                status: status === "failed" ? "failed" : "incomplete"
              }
            }
          }
        }
      });
      expect(f.source.promote).not.toHaveBeenCalled();
    }
  );
  it("refuses changed effective inputs reported by the guarded promotion", async () => {
    const f = fixture();
    vi.mocked(f.source.promote).mockResolvedValue({
      status: "refused",
      failure: {
        status: "failed",
        error: {
          code: "SOURCE_CHANGED",
          message: "Changed.",
          retryable: false
        }
      }
    });
    const started = await f.start();
    expect(await started.respond()).toMatchObject({
      status: "ok",
      value: { state: "failed", error: { code: "SOURCE_CHANGED" } }
    });
  });
  it("cleans on cancelled requests and idempotent shutdown", async () => {
    const f = fixture();
    f.signal.aborted = true;
    expect(await f.author()).toMatchObject({ status: "cancelled" });
    expect(f.source.captureForAuthoring).not.toHaveBeenCalled();
    f.signal.aborted = false;
    const started = await f.start();
    await f.service.close();
    await f.service.close();
    expect(await started.respond()).toMatchObject({ status: "cancelled" });
    expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    expect(f.source.promote).not.toHaveBeenCalled();
  });
  it.each(["absent", "incomplete", "forbidden", "throw"] as const)(
    "preserves %s baseline capture",
    async (status) => {
      const f = fixture();
      vi.mocked(f.source.captureForAuthoring).mockImplementation(async () => {
        if (status === "throw") throw new Error("Capture unavailable");
        return (
          status === "absent" ? absent()
          : status === "incomplete" ? incomplete()
          : portForbidden()
        );
      });
      expect((await f.author()).status).toBe(
        status === "forbidden" ? "forbidden" : "unavailable"
      );
      expect(f.assign).not.toHaveBeenCalled();
      expect(f.source.releaseSnapshot).not.toHaveBeenCalled();
    }
  );
  it.each(["selection", "source", "path"] as const)(
    "rejects stale or unsafe %s before staging",
    async (kind) => {
      const f = fixture();
      if (kind === "path") {
        const unsafe = { ...target, definition: "../app.bicep" };
        expect(
          await f.service.author(
            { ...scope, target: unsafe },
            caller,
            unsafe,
            { intent: "Model", provider: "azure" },
            f.control
          )
        ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      } else {
        vi.mocked(f.source.captureForAuthoring).mockResolvedValue(
          portSuccess({
            status: "captured",
            snapshot:
              kind === "selection" ?
                {
                  ...snapshot,
                  selection: { ...target, definition: "other.bicep" }
                }
              : {
                  ...snapshot,
                  provenance: {
                    ...snapshot.provenance,
                    fingerprint: proposalFingerprint
                  }
                }
          })
        );
        expect(await f.author()).toMatchObject({
          error: { code: "EVIDENCE_MISMATCH" }
        });
        expect(f.source.releaseSnapshot).toHaveBeenCalledOnce();
      }
      expect(f.source.prepareStaging).not.toHaveBeenCalled();
    }
  );
  it.each([
    "authorizationRef",
    "principalRef",
    "operationId",
    "approvalRef",
    "target",
    "source"
  ] as const)("rechecks current authorization %s", async (field) => {
    const f = fixture();
    f.authorize.mockImplementation(async (request) => {
      if (request.operation !== "definition.author")
        throw new Error("Unexpected repair authorization.");
      return portSuccess({
        ...request,
        authorizationRef: field === "authorizationRef" ? "" : "renewed",
        principalRef: field === "principalRef" ? "other" : caller.principalRef,
        operationId: field === "operationId" ? "other" : request.operationId,
        approvalRef: field === "approvalRef" ? "other" : request.approvalRef,
        target:
          field === "target" ?
            { ...target, repo: "other/repo" }
          : request.target,
        source:
          field === "source" ?
            { ...snapshot.provenance, fingerprint: proposalFingerprint }
          : request.source
      });
    });
    expect(await f.author()).toMatchObject({ status: "forbidden" });
    expect(f.source.prepareStaging).not.toHaveBeenCalled();
    expect(f.source.releaseSnapshot).toHaveBeenCalledOnce();
  });
  it.each(["prepare", "assign", "throw", "delivery"] as const)(
    "records %s startup failure and cleans acquired resources",
    async (phase) => {
      const f = fixture();
      if (phase === "prepare")
        vi.mocked(f.source.prepareStaging).mockResolvedValue(portForbidden());
      else if (phase === "assign") f.assign.mockResolvedValue(portForbidden());
      else if (phase === "throw")
        f.assign.mockRejectedValue(new Error("Agent disconnected"));
      else
        f.assign.mockResolvedValue(
          portSuccess({
            deliveryRef: "delivery",
            operationId: "other",
            actionId: "other"
          })
        );
      expect((await f.author()).status).not.toBe("ok");
      const records = await f.registry.list(
        { ...scope, operation: "operation.list" },
        {},
        f.control
      );
      expect(records).toMatchObject({
        status: "ok",
        value: { items: [{ operation: { state: "failed" } }] }
      });
      expect(f.source.promote).not.toHaveBeenCalled();
      expect(f.source.releaseSnapshot).toHaveBeenCalledOnce();
      expect(f.source.releaseStaging).toHaveBeenCalledTimes(
        phase === "prepare" ? 0 : 1
      );
    }
  );
  it.each(["operationId", "actionId", "snapshot"] as const)(
    "rejects staging with a mismatched %s",
    async (field) => {
      const f = fixture();
      vi.mocked(f.source.prepareStaging).mockImplementation(
        async (_scope, binding) =>
          portSuccess({
            ...binding,
            stagingRef: "staging",
            operationId:
              field === "operationId" ? "other" : binding.operationId,
            actionId: field === "actionId" ? "other" : binding.actionId,
            snapshot:
              field === "snapshot" ?
                { ...snapshot, snapshotRef: "other" }
              : binding.snapshot
          })
      );
      expect(await f.author()).toMatchObject({
        error: { code: "EVIDENCE_MISMATCH" }
      });
      expect(f.assign).not.toHaveBeenCalled();
      expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    }
  );
  it.each(["binding", "operation", "action", "outcome", "forbidden"] as const)(
    "rejects %s agent authentication evidence before consumption",
    async (field) => {
      const f = fixture();
      const started = await f.start();
      f.authenticateOutcome.mockImplementation(
        async (_caller, action, outcome) =>
          field === "forbidden" ? portForbidden() : (
            portSuccess({
              agentBindingRef: field === "binding" ? "other" : "agent",
              operationId: field === "operation" ? "other" : action.operationId,
              actionId: field === "action" ? "other" : action.actionId,
              outcome:
                field === "outcome" ?
                  {
                    kind: "agent.outcome",
                    status: "cancelled",
                    diagnostics: []
                  }
                : outcome
            })
          )
      );
      expect(await started.respond()).toMatchObject({ status: "forbidden" });
      expect(f.source.inspectStagedOutputs).not.toHaveBeenCalled();
      await f.service.close();
    }
  );
  it.each(["staging", "references", "denied"] as const)(
    "rejects %s staged-output evidence",
    async (field) => {
      const f = fixture();
      const original = vi
        .mocked(f.source.inspectStagedOutputs)
        .getMockImplementation();
      if (!original) throw new Error("Missing fixture");
      vi.mocked(f.source.inspectStagedOutputs).mockImplementation(
        async (...args) => {
          if (field === "denied") return portForbidden();
          const result = await original(...args);
          if (result.status !== "ok") return result;
          return portSuccess({
            ...result.value,
            ...(field === "staging" ?
              { staging: { ...result.value.staging, actionId: "other" } }
            : { outputRefs: ["foreign-staging/app.bicep"] })
          });
        }
      );
      const started = await f.start();
      expect(await started.respond()).toMatchObject({
        status: "ok",
        value: { state: "failed" }
      });
      expect(f.source.captureProposal).not.toHaveBeenCalled();
      expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    }
  );
  it.each(["absent", "incomplete", "denied", "throw"] as const)(
    "preserves %s proposal capture",
    async (field) => {
      const f = fixture();
      vi.mocked(f.source.captureProposal).mockImplementation(async () => {
        if (field === "throw") throw new Error("Proposal unavailable");
        return (
          field === "absent" ? absent()
          : field === "incomplete" ? incomplete()
          : portForbidden()
        );
      });
      const started = await f.start();
      expect(await started.respond()).toMatchObject({
        status: "ok",
        value: { state: "failed" }
      });
      expect(f.validator.validate).not.toHaveBeenCalled();
      expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    }
  );
  it.each([
    "snapshot",
    "selection",
    "definition",
    "fingerprint",
    "provenance",
    "output"
  ] as const)("rejects wrong proposal %s", async (field) => {
    const f = fixture();
    const original = vi
      .mocked(f.source.captureProposal)
      .getMockImplementation();
    if (!original) throw new Error("Missing fixture");
    vi.mocked(f.source.captureProposal).mockImplementation(async (...args) => {
      const result = await original(...args);
      if (result.status !== "ok" || result.value.status !== "captured")
        return result;
      const proposed = result.value.snapshot;
      return portSuccess({
        status: "captured",
        snapshot: {
          ...proposed,
          snapshotRef:
            field === "snapshot" ? snapshot.snapshotRef : proposed.snapshotRef,
          selection:
            field === "selection" ? { ...target, repo: "other/repo" } : target,
          provenance:
            field === "provenance" ?
              { ...proposed.provenance, repo: "other/repo" }
            : field === "fingerprint" ? { ...proposed.provenance, fingerprint }
            : proposed.provenance,
          manifest: {
            ...proposed.manifest,
            definition:
              field === "definition" ? "other.bicep" : (
                proposed.manifest.definition
              ),
            inputs:
              field === "output" ?
                proposed.manifest.inputs.map((input) => ({
                  ...input,
                  contentHash: fingerprint
                }))
              : proposed.manifest.inputs
          }
        }
      });
    });
    const started = await f.start();
    expect(await started.respond()).toMatchObject({
      status: "ok",
      value: { state: "failed" }
    });
    expect(f.validator.validate).not.toHaveBeenCalled();
    expect(f.source.promote).not.toHaveBeenCalled();
  });
  it.each(["stale", "denied", "throw"] as const)(
    "refuses %s validator results",
    async (field) => {
      const f = fixture();
      vi.mocked(f.validator.validate).mockImplementation(async (input) => {
        if (field === "throw") throw new Error("Validator unavailable");
        return field === "denied" ? portForbidden() : (
            portSuccess(
              reduceValidationReport(
                input.policy,
                input.policy.checks.map((check) => ({
                  ...check,
                  status: "passed",
                  reason: "Verified."
                })),
                {
                  sourceFingerprint: proposalFingerprint,
                  proposalFingerprint
                }
              )
            )
          );
      });
      const started = await f.start();
      expect(await started.respond()).toMatchObject({
        status: "ok",
        value: { state: "failed" }
      });
      expect(f.source.promote).not.toHaveBeenCalled();
      expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(2);
    }
  );
  it.each(["restored", "incomplete", "not_needed"] as const)(
    "reports failed promotion with %s rollback",
    async (rollback) => {
      const f = fixture();
      vi.mocked(f.source.promote).mockResolvedValue({
        status: "failed",
        failure: portFailure("PRECONDITION_FAILED"),
        rollback,
        diagnostics: []
      });
      const started = await f.start();
      expect(await started.respond()).toMatchObject({
        status: "ok",
        value: {
          state: "failed",
          result: {
            proposal: {
              promotion: rollback === "restored" ? "rolled_back" : "failed"
            }
          }
        }
      });
      expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(2);
    }
  );
  it("does not trust mismatched promotion receipts", async () => {
    const f = fixture();
    vi.mocked(f.source.promote).mockResolvedValue({
      status: "promoted",
      manifest: snapshot.manifest
    });
    const started = await f.start();
    expect(await started.respond()).toMatchObject({
      status: "ok",
      value: { state: "failed", error: { code: "EVIDENCE_MISMATCH" } }
    });
  });
  it.each(["staging", "snapshot"] as const)(
    "surfaces %s cleanup failures without hiding promoted files",
    async (phase) => {
      const f = fixture();
      if (phase === "staging")
        vi.mocked(f.source.releaseStaging).mockResolvedValue(portForbidden());
      else
        vi.mocked(f.source.releaseSnapshot).mockRejectedValue(
          new Error("Cannot release")
        );
      const started = await f.start();
      expect(await started.respond()).toMatchObject({
        status: "ok",
        value: {
          state: "failed",
          result: { proposal: { promotion: "promoted" } }
        }
      });
      expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(2);
      expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    }
  );
  it("waits for acquired resources before shutdown cleanup", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    vi.mocked(f.source.prepareStaging).mockImplementation(
      async (_scope, binding) => {
        entered.resolve();
        await release.promise;
        return portSuccess({ ...binding, stagingRef: "staging" });
      }
    );
    const pending = f.author();
    await entered.promise;
    const closing = f.service.close();
    expect(f.source.releaseSnapshot).not.toHaveBeenCalled();
    release.resolve();
    expect(await pending).toMatchObject({ status: "cancelled" });
    expect(await closing).toMatchObject({ status: "ok" });
    expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    expect(f.assign).not.toHaveBeenCalled();
  });
  it("does not promote during shutdown while validation is running", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    const original = vi.mocked(f.validator.validate).getMockImplementation();
    if (!original) throw new Error("Missing fixture");
    vi.mocked(f.validator.validate).mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const started = await f.start();
    const response = started.respond();
    await entered.promise;
    const closing = f.service.close();
    release.resolve();
    expect(await response).toMatchObject({
      status: "ok",
      value: { state: "cancelled" }
    });
    expect(await closing).toMatchObject({ status: "ok" });
    expect(f.source.promote).not.toHaveBeenCalled();
    expect(f.source.releaseStaging).toHaveBeenCalledOnce();
  });
  it("surfaces shutdown cleanup failure and rejects missing dependencies", async () => {
    const f = fixture();
    await f.start();
    vi.mocked(f.source.releaseStaging).mockResolvedValue(portForbidden());
    expect(await f.service.close()).toMatchObject({ status: "forbidden" });
    const incompleteDeps = { ...f.deps };
    Reflect.deleteProperty(incompleteDeps, "agent");
    expect(() => createDefinitionAuthoring(incompleteDeps)).toThrow();
  });
  it("preserves typed promotion cancellation without claiming success", async () => {
    const f = fixture();
    vi.mocked(f.source.promote).mockResolvedValue(
      portCancelled("request_cancelled")
    );
    const started = await f.start();
    expect(await started.respond()).toMatchObject({
      status: "ok",
      value: { state: "cancelled" }
    });
    expect(f.source.releaseSnapshot).toHaveBeenCalledTimes(2);
  });
  it("preserves unavailable trusted agent authority without attempting staging", async () => {
    const f = fixture();
    f.authorize.mockResolvedValue(
      portUnavailable("CAPABILITY_UNAVAILABLE", {
        quality: "unknown",
        completeness: "unavailable",
        evidence: "session"
      })
    );
    expect(await f.author()).toMatchObject({ status: "unavailable" });
    expect(f.source.prepareStaging).not.toHaveBeenCalled();
    expect(f.source.releaseSnapshot).toHaveBeenCalledOnce();
  });
  it.each([
    "capture",
    "authorization",
    "outputs",
    "proposal",
    "assignment"
  ] as const)("cleans request cancellation during %s", async (phase) => {
    const f = fixture();
    if (phase === "capture")
      vi.mocked(f.source.captureForAuthoring).mockImplementation(async () => {
        f.signal.aborted = true;
        throw new Error("Cancelled");
      });
    else if (phase === "authorization")
      f.authorize.mockImplementation(async (request) => {
        f.signal.aborted = true;
        return portSuccess({
          ...request,
          authorizationRef: "renewed",
          principalRef: caller.principalRef
        });
      });
    else if (phase === "assignment")
      f.assign.mockImplementation(async (_scope, assignment) => {
        f.signal.aborted = true;
        return portSuccess({
          deliveryRef: "delivery",
          operationId: assignment.action.operationId,
          actionId: assignment.action.actionId
        });
      });
    if (phase === "outputs" || phase === "proposal") {
      const started = await f.start();
      if (phase === "outputs") {
        const original = vi
          .mocked(f.source.inspectStagedOutputs)
          .getMockImplementation();
        if (!original) throw new Error("Missing fixture");
        vi.mocked(f.source.inspectStagedOutputs).mockImplementation(
          async (...args) => {
            f.signal.aborted = true;
            return original(...args);
          }
        );
      } else {
        const original = vi
          .mocked(f.source.captureProposal)
          .getMockImplementation();
        if (!original) throw new Error("Missing fixture");
        vi.mocked(f.source.captureProposal).mockImplementation(
          async (...args) => {
            f.signal.aborted = true;
            return original(...args);
          }
        );
      }
      expect(await started.respond()).toMatchObject({ status: "cancelled" });
      expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    } else expect(await f.author()).toMatchObject({ status: "cancelled" });
    expect(f.source.promote).not.toHaveBeenCalled();
  });
  it("records failed startup even when cleanup fails", async () => {
    const f = fixture();
    f.assign.mockResolvedValue(portForbidden());
    vi.mocked(f.source.releaseStaging).mockResolvedValue(
      portFailure("PRECONDITION_FAILED")
    );
    expect(await f.author()).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    const listed = await f.registry.list(
      { ...scope, operation: "operation.list" },
      {},
      f.control
    );
    expect(listed).toMatchObject({
      status: "ok",
      value: { items: [{ operation: { state: "failed" } }] }
    });
  });
  it("rejects concurrent outcomes without replaying validation or promotion", async () => {
    const f = fixture();
    const started = await f.start();
    const results = await Promise.all([started.respond(), started.respond()]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "failed",
      "ok"
    ]);
    expect(f.validator.validate).toHaveBeenCalledOnce();
    expect(f.source.promote).toHaveBeenCalledOnce();
  });
  it("rejects another operation's action and early responses before staging exists", async () => {
    const f = fixture();
    const entered = deferred();
    const release = deferred();
    vi.mocked(f.source.prepareStaging).mockImplementation(
      async (_scope, binding) => {
        entered.resolve();
        await release.promise;
        return portSuccess({ ...binding, stagingRef: "staging" });
      }
    );
    const pending = f.author();
    await entered.promise;
    const listed = await f.registry.list(
      { ...scope, operation: "operation.list" },
      {},
      f.control
    );
    if (listed.status !== "ok") throw new Error("Missing operation");
    const operation = listed.value.items[0].operation;
    const response = {
      operationId: operation.operationId,
      actionId: operation.actions[0].actionId,
      response: {
        kind: "agent.outcome" as const,
        status: "completed" as const,
        stagedOutputRefs: ["staging/app.bicep"]
      }
    };
    const responderScope: AuthorizedScope<"operation.respond"> = {
      ...scope,
      operation: "operation.respond",
      operationId: operation.operationId
    };
    expect(
      await f.actions.respond(
        responderScope,
        { ...caller, responder: "agent" },
        response,
        f.control
      )
    ).toMatchObject({ error: { code: "ACTION_RESPONSE_INVALID" } });
    release.resolve();
    await pending;
    const other = await f.author();
    if (other.status !== "ok") throw new Error("Missing other operation");
    expect(
      await f.actions.respond(
        { ...responderScope, operationId: other.value.operationId },
        { ...caller, responder: "agent" },
        { ...response, operationId: other.value.operationId },
        f.control
      )
    ).toMatchObject({ error: { code: "ACTION_NOT_OUTSTANDING" } });
    expect(f.source.inspectStagedOutputs).not.toHaveBeenCalled();
    await f.service.close();
  });
  it.each(["registry", "actions"] as const)(
    "does not continue with a closed %s owner",
    async (owner) => {
      const f = fixture();
      if (owner === "registry") await f.registry.close();
      else f.actions.close();
      expect(await f.author()).toMatchObject({ status: "cancelled" });
      expect(f.source.prepareStaging).not.toHaveBeenCalled();
      expect(f.source.releaseSnapshot).toHaveBeenCalledOnce();
    }
  );
  it.each(["absent", "denied"] as const)(
    "fails closed when accepted operation readback is %s",
    async (status) => {
      const f = fixture();
      vi.spyOn(f.registry, "get").mockResolvedValue(
        status === "absent" ? absent() : portForbidden()
      );
      expect((await f.author()).status).toBe(
        status === "absent" ? "failed" : "forbidden"
      );
      expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    }
  );
  it("preserves an immediate authenticated outcome rather than returning stale action state", async () => {
    const f = fixture();
    f.assign.mockImplementation(async (_scope, assignment) => {
      const response = await f.actions.respond(
        {
          ...scope,
          operation: "operation.respond",
          operationId: assignment.action.operationId
        },
        { ...caller, responder: "agent" },
        {
          operationId: assignment.action.operationId,
          actionId: assignment.action.actionId,
          response: {
            kind: "agent.outcome",
            status: "completed",
            stagedOutputRefs: ["staging/app.bicep"]
          }
        },
        f.control
      );
      expect(response.status).toBe("ok");
      return portSuccess({
        deliveryRef: "delivery",
        operationId: assignment.action.operationId,
        actionId: assignment.action.actionId
      });
    });
    expect(await f.author()).toMatchObject({
      status: "ok",
      value: { state: "succeeded" }
    });
    expect(f.source.promote).toHaveBeenCalledOnce();
  });
  it("never commits, pushes or deploys even after successful authoring", async () => {
    const f = fixture();
    const prohibited = vi.fn(() => {
      throw new Error("Prohibited side effect");
    });
    Object.assign(f.deps, {
      commit: prohibited,
      push: prohibited,
      deploy: prohibited
    });
    const started = await f.start();
    expect((await started.respond()).status).toBe("ok");
    expect(prohibited).not.toHaveBeenCalled();
  });
  it("surfaces persistence failure without replaying agent delivery", async () => {
    const f = fixture();
    f.assign.mockImplementation(async () => {
      vi.spyOn(f.registry, "compareAndSwap").mockResolvedValue(
        portFailure("PRECONDITION_FAILED")
      );
      return portForbidden();
    });
    expect(await f.author()).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(f.assign).toHaveBeenCalledOnce();
    expect(f.source.releaseStaging).toHaveBeenCalledOnce();
  });
  it.each(["denied", "throw", "cleanup"] as const)(
    "cleans an already-consumed action when renewed authority is %s",
    async (failure) => {
      const f = fixture();
      const started = await f.start();
      const original = f.authorize.getMockImplementation();
      if (!original) throw new Error("Missing fixture");
      f.authorize
        .mockImplementationOnce(original)
        .mockImplementation(async () => {
          if (failure === "throw") throw new Error("Authority unavailable");
          return portForbidden();
        });
      if (failure === "cleanup")
        vi.mocked(f.source.releaseStaging).mockResolvedValue(
          portFailure("PRECONDITION_FAILED")
        );
      expect((await started.respond()).status).not.toBe("ok");
      expect(await started.respond()).toMatchObject({
        error: { code: "ACTION_NOT_OUTSTANDING" }
      });
      expect(f.source.releaseStaging).toHaveBeenCalledOnce();
      expect(f.source.promote).not.toHaveBeenCalled();
    }
  );
  it("retains unavailable validation and cleanup errors without replaying an action", async () => {
    const f = fixture();
    vi.mocked(f.validator.validate).mockResolvedValue(portForbidden());
    vi.mocked(f.source.releaseStaging).mockResolvedValue(
      portFailure("PRECONDITION_FAILED")
    );
    const started = await f.start();
    expect(await started.respond()).toMatchObject({
      status: "ok",
      value: { state: "failed", error: { code: "PRECONDITION_FAILED" } }
    });
    expect(await started.respond()).toMatchObject({
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
  });
  it("does not clean twice when agent delivery reports failure after an immediate completion", async () => {
    const f = fixture();
    f.assign.mockImplementation(async (_scope, assignment) => {
      await f.actions.respond(
        {
          ...scope,
          operation: "operation.respond",
          operationId: assignment.action.operationId
        },
        { ...caller, responder: "agent" },
        {
          operationId: assignment.action.operationId,
          actionId: assignment.action.actionId,
          response: {
            kind: "agent.outcome",
            status: "cancelled",
            diagnostics: []
          }
        },
        f.control
      );
      return portForbidden();
    });
    expect((await f.author()).status).not.toBe("ok");
    expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    expect(f.source.releaseSnapshot).toHaveBeenCalledOnce();
    const listed = await f.registry.list(
      { ...scope, operation: "operation.list" },
      {},
      f.control
    );
    expect(listed).toMatchObject({
      status: "ok",
      value: { items: [{ operation: { state: "cancelled" } }] }
    });
  });
  it("accepts source completion only for matching validated proposals and consumed actions", async () => {
    const f = fixture();
    const started = await f.start();
    const result = await started.respond();
    if (result.status !== "ok" || result.value.result?.kind !== "definition")
      throw new Error("Missing definition result");
    const final = result.value.result;
    const operation = {
      ...started.operation,
      state: "queued" as const,
      actions: started.operation.actions.map((action) => ({
        ...action,
        status: "accepted" as const
      }))
    };
    const event = {
      kind: "definition_completed" as const,
      state: "succeeded" as const,
      observation: result.value.observation,
      result: final
    };
    expect(reduceOperation(operation, event).status).toBe("ok");
    expect(
      reduceOperation({ ...operation, operation: "environment.create" }, event)
        .status
    ).toBe("failed");
    expect(reduceOperation(result.value, event).status).toBe("failed");
    expect(reduceOperation(started.operation, event).status).toBe("failed");
    expect(
      reduceOperation(operation, { ...event, result: undefined }).status
    ).toBe("failed");
    for (const proposal of [
      { ...final.proposal, promotion: "pending" as const },
      { ...final.proposal, operationId: "other" },
      { ...final.proposal, originalFingerprint: proposalFingerprint },
      {
        ...final.proposal,
        validation: {
          ...final.proposal.validation,
          status: "failed" as const
        }
      },
      {
        ...final.proposal,
        validation: {
          ...final.proposal.validation,
          sourceFingerprint: proposalFingerprint
        }
      },
      {
        ...final.proposal,
        validation: {
          ...final.proposal.validation,
          proposalFingerprint: undefined
        }
      }
    ])
      expect(
        reduceOperation(operation, {
          ...event,
          result: { kind: "definition", proposal }
        }).status
      ).toBe("failed");
  });
  it("cancels between the action lease and continuation without leaking owned staging", async () => {
    const f = fixture();
    const started = await f.start();
    const compare = f.registry.compareAndSwap.bind(f.registry);
    let accepted = 0;
    let closing: Promise<import("./errors.js").PortResult<void>> | undefined;
    vi.spyOn(f.registry, "compareAndSwap").mockImplementation(
      async (...args) => {
        const result = await compare(...args);
        if (
          args[1].replacement.actions.some(
            (action) => action.status === "accepted"
          ) &&
          ++accepted === 2
        )
          closing = f.service.close();
        return result;
      }
    );
    expect(await started.respond()).toMatchObject({
      status: "ok",
      value: { state: "cancelled" }
    });
    await closing;
    expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    expect(f.source.promote).not.toHaveBeenCalled();
  });
  it("rechecks shutdown after final approval before promotion", async () => {
    const f = fixture();
    const started = await f.start();
    const original = f.authorize.getMockImplementation();
    if (!original) throw new Error("Missing fixture");
    let calls = 0;
    let closing: Promise<import("./errors.js").PortResult<void>> | undefined;
    f.authorize.mockImplementation((...args) => {
      if (++calls === 3)
        queueMicrotask(() =>
          queueMicrotask(() => {
            closing = f.service.close();
          })
        );
      return original(...args);
    });
    expect(await started.respond()).toMatchObject({
      status: "ok",
      value: { state: "cancelled" }
    });
    await closing;
    expect(f.source.promote).not.toHaveBeenCalled();
    expect(f.source.releaseStaging).toHaveBeenCalledOnce();
  });
  it("keeps advisory warnings visible without blocking an otherwise valid proposal", async () => {
    const f = fixture();
    vi.mocked(f.validator.validate).mockImplementation(async (input) =>
      portSuccess(
        reduceValidationReport(
          input.policy,
          input.policy.checks.map((check) => ({
            ...check,
            status:
              check.classification === "advisory" ? "unavailable" : "passed",
            reason: "Description enrichment unavailable."
          })),
          {
            sourceFingerprint: input.sourceFingerprint,
            proposalFingerprint: input.proposalFingerprint
          }
        )
      )
    );
    const started = await f.start();
    expect(await started.respond()).toMatchObject({
      status: "ok",
      value: {
        state: "succeeded",
        result: {
          proposal: {
            validation: { status: "passed", warnings: [expect.any(String)] }
          }
        }
      }
    });
    expect(f.source.promote).toHaveBeenCalledOnce();
  });
});
