import { expect, it, vi } from "vitest";
import {
  portUnavailable,
  portSuccess,
  portFailure,
  portCancelled,
  reduceValidationReport,
  type DefinitionAuthoringSourcePort,
  type AgentOutcome,
  type SourceSnapshot,
  type DefinitionValidationPort
} from "@radius-project/core/lifecycle";
import { createLifecycleBinding } from "./create-lifecycle-binding.js";
import { createLifecycleFixture } from "../../test/support/lifecycle.js";
import { createLifecycleValidators } from "@radius-project/adapter-shared";
import type { LifecycleAgent } from "./lifecycle-agent.js";
import { authorizeFixture } from "../../test/support/lifecycle.js";
import { createLifecycleDefinitionRegistrations } from "./lifecycle-definitions.js";

function authorFixture() {
  const f = createLifecycleFixture({
    caller: {
      principalRef: "principal",
      identityRef: "identity",
      sessionRef: "session",
      responder: "agent",
      agentBindingRef: "agent",
      approvedHostActionRef: "approval"
    }
  });
  const target = {
    repo: "owner/repo",
    definition: ".radius/app.bicep",
    source: f.source
  };
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const proposalFingerprint = `sha256:${"b".repeat(64)}`;
  const snapshot: SourceSnapshot = {
    selection: target,
    snapshotRef: "snapshot",
    provenance: {
      kind: "workspace",
      repo: target.repo,
      workspaceRef: "fixture-workspace",
      branch: "feature",
      fingerprint,
      resolvedAt: "2026-09-16T00:00:00Z"
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
  const proposal: SourceSnapshot = {
    ...snapshot,
    snapshotRef: "proposal",
    provenance: { ...snapshot.provenance, fingerprint: proposalFingerprint },
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
  };
  const source: DefinitionAuthoringSourcePort = {
    captureForAuthoring: vi.fn(async () =>
      portSuccess({ status: "captured", snapshot } as const)
    ),
    prepareStaging: vi.fn(async (_scope, input) =>
      portSuccess({ ...input, stagingRef: "staging" })
    ),
    inspectStagedOutputs: vi.fn(async (staging, outputRefs) =>
      portSuccess({
        staging,
        outputRefs,
        fingerprint: proposalFingerprint,
        outputs: proposal.manifest.inputs
      })
    ),
    captureProposal: vi.fn(async () =>
      portSuccess({ status: "captured", snapshot: proposal } as const)
    ),
    promote: vi.fn(
      async () => ({ status: "promoted", manifest: proposal.manifest }) as const
    ),
    releaseSnapshot: vi.fn(async () =>
      portSuccess({ status: "released" } as const)
    ),
    releaseStaging: vi.fn(async () =>
      portSuccess({ status: "released" } as const)
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
            reason: "Unit port evidence."
          })),
          {
            sourceFingerprint: input.sourceFingerprint,
            proposalFingerprint: input.proposalFingerprint
          }
        )
      )
    )
  };
  const agent: LifecycleAgent = {
    assign: vi.fn(async (_scope, assignment) =>
      portSuccess({
        deliveryRef: "delivery",
        operationId: assignment.action.operationId,
        actionId: assignment.action.actionId
      })
    ),
    authenticateOutcome: vi.fn(async (_caller, action, outcome) =>
      portSuccess({
        agentBindingRef: "agent",
        operationId: action.operationId,
        actionId: action.actionId,
        outcome
      })
    ),
    cancel: vi.fn(async () => {
      throw new Error("No remote cancellation");
    }),
    close: vi.fn()
  };
  const binding = createLifecycleBinding({
    ids: f.ports.ids,
    clock: f.ports.clock,
    authority: {
      ...f.ports.identity,
      authorize: async (request) =>
        portSuccess({
          ...authorizeFixture(request),
          ...(request.operation === "definition.author" ?
            { approvalRef: "approval" }
          : {})
        })
    },
    hostBinding: () => ({
      bindingRef: "binding",
      sessionRef: f.caller.sessionRef
    }),
    knownLegacyOperations: () => [
      {
        operationId: "legacy",
        family: "definition",
        owner: "legacy",
        needsControl: true
      }
    ],
    resolveWorkspaceSource: async () => portSuccess(f.source),
    definitions: {
      source: {
        capture: async () => portSuccess({ status: "captured", snapshot }),
        releaseSnapshot: source.releaseSnapshot
      },
      validator,
      authoring: { source, agent }
    }
  });
  const intent = {
    operation: "definition.author",
    target,
    input: { intent: "Create a model without deployment.", provider: "azure" }
  };
  const respond = (
    operationId: string,
    actionId: string,
    response: AgentOutcome
  ) =>
    binding.execute({
      operation: "operation.respond",
      target: { repo: target.repo },
      input: { operationId, actionId, response }
    });
  return {
    binding,
    source,
    agent,
    validator,
    intent,
    respond,
    ports: f.ports,
    async close() {
      try {
        await binding.close();
      } finally {
        await f.binding.close();
      }
    }
  };
}

it("advertises trusted authoring and returns a real core action whose ownership survives routing rollback", async () => {
  const f = authorFixture();
  try {
    const response = await f.binding.execute(f.intent);
    expect(response).toMatchObject({
      operation: "definition.author",
      result: {
        state: "action_required",
        requiredAction: {
          kind: "agent.author_definition",
          status: "outstanding"
        }
      }
    });

    expect(createLifecycleValidators().validateResponse(response).valid).toBe(
      true
    );
    if (
      !("operation" in response) ||
      response.operation !== "definition.author" ||
      response.result.state !== "action_required"
    )
      throw new Error("Expected author action");
    const result = response.result;
    expect(f.binding.routing.address(result.operationId, true)).toBe(
      "lifecycle"
    );
    expect(() =>
      f.binding.routing.claimDispatch("definition", result.operationId)
    ).toThrow("redispatched");
    expect(() =>
      f.binding.routing.transition("definition", {
        writer: "legacy",
        readers: ["legacy"],
        controllers: ["legacy"]
      })
    ).toThrow("orphan");
    f.binding.routing.transition("definition", {
      writer: "legacy",
      readers: ["legacy", "lifecycle"],
      controllers: ["legacy", "lifecycle"]
    });
    expect(await f.binding.execute(f.intent)).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(f.agent.assign).toHaveBeenCalledTimes(1);
    expect(
      await f.respond(result.operationId, result.requiredAction.actionId, {
        kind: "agent.outcome",
        status: "cancelled",
        diagnostics: []
      })
    ).toMatchObject({ result: { state: "cancelled" } });
    expect(f.binding.routing.address("legacy", true)).toBe("legacy");
    expect(f.binding.routing.address(result.operationId)).toBe("lifecycle");
    expect(f.agent.cancel).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("rejects malformed agent ownership at registration and memoizes direct registration cleanup", async () => {
  const f = authorFixture();
  const dependencies = {
    source: {
      capture: f.ports.source.capture,
      releaseSnapshot: f.source.releaseSnapshot
    },
    validator: f.validator,
    identity: f.ports.identity,
    registry: f.binding.registry,
    actions: f.binding.actions,
    clock: f.ports.clock,
    ids: f.ports.ids,
    routing: f.binding.routing
  };
  try {
    expect(() =>
      Reflect.apply(createLifecycleDefinitionRegistrations, undefined, [
        {
          ...dependencies,
          authoring: { source: f.source, agent: {} }
        }
      ])
    ).toThrow("owned agent lifecycle");
    const close = vi.fn();
    const registration = createLifecycleDefinitionRegistrations({
      ...dependencies,
      authoring: { source: f.source, agent: { ...f.agent, close } }
    });
    const first = registration.close();
    expect(registration.close()).toBe(first);
    await first;
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it("returns a refused proposal when actual core validation policy fails during assignment", async () => {
  const f = authorFixture();
  vi.mocked(f.validator.validate).mockImplementation(async (input) =>
    portSuccess(
      reduceValidationReport(
        input.policy,
        input.policy.checks.map((check) => ({
          ...check,
          status: "failed",
          reason: "Required unit evidence rejected."
        })),
        {
          sourceFingerprint: input.sourceFingerprint,
          proposalFingerprint: input.proposalFingerprint
        }
      )
    )
  );
  vi.mocked(f.agent.assign).mockImplementation(async (_scope, assignment) => {
    await f.respond(assignment.action.operationId, assignment.action.actionId, {
      kind: "agent.outcome",
      status: "completed",
      stagedOutputRefs: ["staging/app.bicep"]
    });
    return portSuccess({
      deliveryRef: "delivery",
      operationId: assignment.action.operationId,
      actionId: assignment.action.actionId
    });
  });
  try {
    expect(await f.binding.execute(f.intent)).toMatchObject({
      operation: "definition.author",
      result: {
        state: "failed",
        error: { code: "VALIDATION_FAILED" },
        proposal: { promotion: "refused", validation: { status: "failed" } }
      }
    });
    expect(f.source.promote).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("consumes one action response and rejects repeats and foreign operation identity without double promotion", async () => {
  const f = authorFixture();
  try {
    const response = await f.binding.execute(f.intent);
    if (
      !("operation" in response) ||
      response.operation !== "definition.author" ||
      response.result.state !== "action_required"
    )
      throw new Error("Expected author action");
    const { operationId, requiredAction } = response.result;
    const outcome: AgentOutcome = {
      kind: "agent.outcome",
      status: "completed",
      stagedOutputRefs: ["staging/app.bicep"]
    };
    expect(
      await f.respond("foreign-operation", requiredAction.actionId, outcome)
    ).toMatchObject({
      error: { code: "OPERATION_UNAVAILABLE" }
    });
    expect(
      await f.respond(operationId, requiredAction.actionId, outcome)
    ).toMatchObject({
      result: { state: "succeeded" }
    });
    expect(
      await f.respond(operationId, requiredAction.actionId, outcome)
    ).toMatchObject({
      error: { code: "ACTION_NOT_OUTSTANDING" }
    });
    expect(f.agent.authenticateOutcome).toHaveBeenCalledTimes(2);
    expect(f.source.promote).toHaveBeenCalledOnce();
  } finally {
    await f.close();
  }
});

it.each(["succeeded", "failed", "cancelled"] as const)(
  "serializes a real core %s terminal outcome completed during assignment without a dangling action",
  async (state) => {
    const f = authorFixture();
    let continuation: unknown;
    vi.mocked(f.agent.assign).mockImplementation(async (_scope, assignment) => {
      const response: AgentOutcome =
        state === "succeeded" ?
          {
            kind: "agent.outcome",
            status: "completed",
            stagedOutputRefs: ["staging/app.bicep"]
          }
        : state === "failed" ?
          {
            kind: "agent.outcome",
            status: "failed",
            diagnostics: [{ message: "Modeling refused.", truncated: false }]
          }
        : { kind: "agent.outcome", status: "cancelled", diagnostics: [] };
      const continued = await f.respond(
        assignment.action.operationId,
        assignment.action.actionId,
        response
      );
      continuation = continued;
      return portSuccess({
        deliveryRef: "delivery",
        operationId: assignment.action.operationId,
        actionId: assignment.action.actionId
      });
    });
    try {
      const response = await f.binding.execute(f.intent);
      expect(continuation).toMatchObject({ operation: "operation.respond" });
      expect(response).toMatchObject({
        operation: "definition.author",
        result: { state }
      });
      expect(createLifecycleValidators().validateResponse(response).valid).toBe(
        true
      );
      if (
        !("operation" in response) ||
        response.operation !== "definition.author"
      )
        throw new Error("Expected author response");
      expect(response.result).not.toHaveProperty("requiredAction");
      if (state === "succeeded") {
        expect(response.result).toHaveProperty("proposal");
        expect(f.source.promote).toHaveBeenCalledOnce();
      } else expect(f.source.promote).not.toHaveBeenCalled();
      if (state === "failed")
        expect(response.result).toHaveProperty(
          "error.code",
          "VALIDATION_FAILED"
        );
    } finally {
      await f.close();
    }
  }
);

it.each([portFailure("SOURCE_CHANGED"), portCancelled("request_cancelled")])(
  "preserves core authoring refusal and cancellation errors: $status",
  async (result) => {
    const f = authorFixture();
    vi.mocked(f.source.captureForAuthoring).mockResolvedValue(result);
    try {
      expect(await f.binding.execute(f.intent)).toMatchObject({
        error: {
          code:
            result.status === "cancelled" ?
              "PRECONDITION_FAILED"
            : "SOURCE_CHANGED"
        }
      });
      expect(f.agent.assign).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  }
);

it("fences pending authoring before cleanup and retains exactly-once failed cleanup across repeated close calls", async () => {
  const f = authorFixture();
  const closeRegistry = vi.spyOn(f.binding.registry, "close");
  await f.binding.execute(f.intent);
  vi.mocked(f.agent.close).mockImplementation(() => {
    throw new Error("Host teardown failed");
  });
  vi.mocked(f.source.releaseStaging).mockResolvedValue(
    portFailure("PRECONDITION_FAILED")
  );
  try {
    const closes = await Promise.allSettled([
      f.binding.close(),
      f.binding.close()
    ]);
    expect(closes.map((result) => result.status)).toEqual([
      "rejected",
      "rejected"
    ]);
    expect(f.agent.close).toHaveBeenCalledOnce();
    expect(f.source.releaseStaging).toHaveBeenCalledOnce();
    expect(f.source.releaseSnapshot).toHaveBeenCalledOnce();
    expect(closeRegistry).toHaveBeenCalledOnce();
    expect(await f.binding.execute(f.intent)).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(f.agent.cancel).not.toHaveBeenCalled();
    await expect(f.binding.close()).rejects.toThrow("Lifecycle cleanup failed");
    expect(f.agent.close).toHaveBeenCalledOnce();
  } finally {
    await f.close().catch(() => {});
  }
});

it("represents an immediately cancelled authoring operation without an outstanding action", () => {
  const validators = createLifecycleValidators();
  const response = {
    apiVersion: "github-radius/v1",
    requestId: "request",
    operation: "definition.author",
    result: {
      operationId: "operation",
      state: "cancelled",
      target: {
        repo: "owner/repo",
        definition: ".radius/app.bicep",
        source: {
          kind: "workspace",
          workspaceRef: "workspace",
          branch: "main",
          expectedFingerprint: `sha256:${"a".repeat(64)}`
        }
      },
      source: {
        kind: "workspace",
        repo: "owner/repo",
        workspaceRef: "workspace",
        branch: "main",
        fingerprint: `sha256:${"a".repeat(64)}`,
        resolvedAt: "2026-09-16T00:00:00Z"
      },
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "session"
      }
    }
  };
  expect(validators.validateResponse(response).valid).toBe(true);
  expect(
    validators.validateResponse({
      ...response,
      result: { ...response.result, state: "succeeded" }
    }).valid
  ).toBe(false);
  expect(
    validators.validateResponse({
      ...response,
      result: { ...response.result, requiredAction: {} }
    }).valid
  ).toBe(false);
});

it("registers no-agent validation and explicit unavailable authoring without touching source", async () => {
  const f = createLifecycleFixture();
  const validate = vi.fn<DefinitionValidationPort["validate"]>(async () => {
    throw new Error("Unexpected validation without source");
  });
  const capture = vi.fn(async () =>
    portUnavailable("SOURCE_UNAVAILABLE", {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "source"
    })
  );
  const binding = createLifecycleBinding({
    authority: f.ports.identity,
    ids: f.ports.ids,
    clock: f.ports.clock,
    hostBinding: () => ({
      bindingRef: "fixture-host",
      sessionRef: f.caller.sessionRef
    }),
    resolveWorkspaceSource: async () => portSuccess(f.source),
    knownLegacyOperations: () => [],
    definitions: {
      source: { capture, releaseSnapshot: f.ports.source.releaseSnapshot },
      validator: { validate }
    }
  });
  try {
    const capabilities = await binding.execute({
      operation: "capabilities.get",
      target: { repo: "owner/repo" },
      input: {}
    });
    expect(capabilities).toMatchObject({
      result: {
        capabilities: expect.arrayContaining([
          expect.objectContaining({
            operation: "definition.validate",
            requiresAgent: false,
            contexts: ["workspace", "git"]
          })
        ])
      }
    });
    expect(capabilities).not.toMatchObject({
      result: {
        capabilities: expect.arrayContaining([
          expect.objectContaining({ operation: "definition.author" })
        ])
      }
    });
    expect(
      await binding.execute({
        operation: "definition.author",
        target: { repo: "owner/repo", definition: ".radius/app.bicep" },
        input: { intent: "Author without publishing.", provider: "azure" }
      })
    ).toMatchObject({ error: { code: "CAPABILITY_UNAVAILABLE" } });
    expect(capture).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  } finally {
    await binding.close();
  }
});
