import { expect, it, vi } from "vitest";
import { createLifecycleValidators } from "@radius-project/adapter-shared";
import { portSuccess } from "@radius-project/core/lifecycle";
import {
  createAuthoringBoundaryFixture,
  startAuthoringRuntime,
  authorDefinition
} from "../../support/lifecycle-authoring.js";

it("bounds actual coordinator compilation to the initial proposal plus five linked repairs", async () => {
  const fixture = await createAuthoringBoundaryFixture({
    trustedHost: true,
    warning: true
  });
  const runtime = await startAuthoringRuntime(fixture);
  try {
    await runtime.execute({
      operation: "definition.author",
      target: { repo: "owner/repo", definition: authorDefinition },
      input: { intent: "Model application", provider: "azure" }
    });
    const original = fixture.assignments[0];
    if (!original) throw new Error("Missing initial assignment");
    expect(
      await runtime.execute(fixture.response(original.action.actionId))
    ).toMatchObject({ result: { state: "failed" } });
    expect(
      await runtime.execute({
        operation: "operation.repair",
        target: { repo: "owner/repo" },
        input: {
          operationId: original.action.operationId,
          source: (await fixture.selection()).source,
          repairPolicy: { mode: "automatic", maxAttempts: 5 }
        }
      })
    ).toMatchObject({ result: { state: "action_required" } });
    for (let cycle = 1; cycle <= 5; cycle++) {
      const assignment = fixture.assignments[cycle];
      if (!assignment) throw new Error(`Missing authorized cycle ${cycle}`);
      expect(
        await runtime.execute(fixture.response(assignment.action.actionId))
      ).toMatchObject({ result: { state: "failed" } });
    }
    expect(fixture.assignments).toHaveLength(6);
    expect(
      fixture.runProcess.mock.calls.filter(([, args]) => args[0] === "build")
    ).toHaveLength(process.platform === "win32" ? 0 : 6);
    await fixture.expectUnchanged();
    expect(fixture.forbidden).toEqual([]);
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it.each(["approval", "agent", "user"] as const)(
  "rechecks %s authority before a repair outcome can promote source",
  async (mode) => {
    const fixture = await createAuthoringBoundaryFixture({ trustedHost: true });
    const runtime = await startAuthoringRuntime(fixture);
    try {
      await runtime.execute({
        operation: "definition.author",
        target: { repo: "owner/repo", definition: authorDefinition },
        input: { intent: "Model application", provider: "azure" }
      });
      const original = fixture.assignments[0];
      if (!original) throw new Error("Missing assignment");
      fixture.attest(original.action.actionId, {
        kind: "agent.outcome",
        status: "failed",
        diagnostics: []
      });
      await runtime.execute(fixture.response(original.action.actionId));
      await runtime.execute({
        operation: "operation.repair",
        target: { repo: "owner/repo" },
        input: {
          operationId: original.action.operationId,
          source: (await fixture.selection()).source,
          repairPolicy: { mode: "manual", maxAttempts: 5 }
        }
      });
      const repair = fixture.assignments[1];
      if (!repair) throw new Error("Missing repair assignment");
      if (mode === "approval") fixture.revokeApproval();
      else
        fixture.setCaller({
          ...fixture.caller,
          ...(mode === "agent" ?
            { agentBindingRef: "other-agent" }
          : { responder: "user" as const })
        });
      expect(
        await runtime.execute(fixture.response(repair.action.actionId))
      ).toHaveProperty("error");
      await runtime.extension.shutdown("rejected response cleanup");
      await fixture.expectUnchanged();
      expect(fixture.forbidden).toEqual([]);
    } finally {
      await runtime.extension.shutdown("test");
      await fixture.close();
    }
  }
);

it("advances an explicitly authorized automatic repair only after authenticated failure and exhausts its inherited ceiling", async () => {
  const fixture = await createAuthoringBoundaryFixture({ trustedHost: true });
  const runtime = await startAuthoringRuntime(fixture);
  try {
    await runtime.execute({
      operation: "definition.author",
      target: { repo: "owner/repo", definition: authorDefinition },
      input: { intent: "Model application", provider: "azure" }
    });
    const initial = fixture.assignments[0];
    if (!initial) throw new Error("Missing real assignment");
    const fail = async (actionId: string) => {
      fixture.attest(actionId, {
        kind: "agent.outcome",
        status: "failed",
        diagnostics: []
      });
      expect(await runtime.execute(fixture.response(actionId))).toMatchObject({
        result: { state: "failed" }
      });
    };
    await fail(initial.action.actionId);
    expect(
      await runtime.execute({
        operation: "operation.repair",
        target: { repo: "owner/repo" },
        input: {
          operationId: initial.action.operationId,
          source: (await fixture.selection()).source,
          repairPolicy: { mode: "automatic", maxAttempts: 2 }
        }
      })
    ).toMatchObject({ result: { state: "action_required" } });
    const first = fixture.assignments[1];
    if (!first) throw new Error("Missing first repair assignment");
    await fail(first.action.actionId);
    const second = fixture.assignments[2];
    if (!second) throw new Error("Automatic policy did not advance");
    await fail(second.action.actionId);
    expect(fixture.assignments).toHaveLength(3);
    for (let index = 0; index < 100; index++)
      expect(
        await runtime.execute({
          operation: "operation.get",
          target: { repo: "owner/repo" },
          input: { operationId: initial.action.operationId }
        })
      ).toMatchObject({ result: { state: "failed" } });
    expect(
      await runtime.execute({
        operation: "operation.repair",
        target: { repo: "owner/repo" },
        input: {
          operationId: initial.action.operationId,
          source: (await fixture.selection()).source,
          repairPolicy: { mode: "manual", maxAttempts: 5 }
        }
      })
    ).toMatchObject({ error: { code: "REPAIR_LIMIT_REACHED" } });
    expect(fixture.assignments).toHaveLength(3);
    expect(fixture.forbidden).toEqual([]);
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});

it.each(["requested", "confirmed"] as const)(
  "retains %s cancellation evidence and refuses late agent promotion after confirmation",
  async (status) => {
    const fixture = await createAuthoringBoundaryFixture({ trustedHost: true });
    const runtime = await startAuthoringRuntime(fixture);
    try {
      await runtime.execute({
        operation: "definition.author",
        target: { repo: "owner/repo", definition: authorDefinition },
        input: { intent: "Model application", provider: "azure" }
      });
      const assignment = fixture.assignments[0];
      if (!assignment) throw new Error("Missing assignment");
      vi.mocked(fixture.host.cancel).mockResolvedValue(
        portSuccess({
          status,
          requestedAt: "2026-09-17T19:00:00Z",
          observation: {
            quality: status === "confirmed" ? "current" : "unknown",
            completeness: "partial",
            evidence: "session",
            limitation:
              "Agent cancellation does not cancel remote workflows or roll back cloud resources."
          }
        })
      );
      expect(
        await runtime.execute({
          operation: "operation.cancel",
          target: { repo: "owner/repo" },
          input: { operationId: assignment.action.operationId }
        })
      ).toMatchObject({
        result: {
          cancellation: { status: "requested" },
          operation: {
            state: status === "confirmed" ? "cancelled" : "action_required"
          }
        }
      });
      expect(fixture.host.cancel).toHaveBeenCalledOnce();
      if (status === "confirmed") {
        expect(
          await runtime.execute(fixture.response(assignment.action.actionId))
        ).toHaveProperty("error");
        await fixture.expectUnchanged();
      } else {
        fixture.attest(assignment.action.actionId, {
          kind: "agent.outcome",
          status: "failed",
          diagnostics: []
        });
        expect(
          await runtime.execute(fixture.response(assignment.action.actionId))
        ).toMatchObject({ result: { state: "failed" } });
      }
      expect(fixture.forbidden).toEqual([]);
    } finally {
      await runtime.extension.shutdown("test");
      await fixture.close();
    }
  }
);

it("fences pending agent work on session shutdown without claiming remote cancellation", async () => {
  const fixture = await createAuthoringBoundaryFixture({ trustedHost: true });
  const runtime = await startAuthoringRuntime(fixture);
  try {
    await runtime.execute({
      operation: "definition.author",
      target: { repo: "owner/repo", definition: authorDefinition },
      input: { intent: "Model application", provider: "azure" }
    });
    const assignment = fixture.assignments[0];
    if (!assignment) throw new Error("Missing assignment");
    await runtime.extension.shutdown("test");
    expect(
      await fixture.binding.execute(
        fixture.response(assignment.action.actionId)
      )
    ).toHaveProperty("error");
    expect(fixture.host.cancel).not.toHaveBeenCalled();
    await fixture.expectUnchanged();
  } finally {
    await fixture.close();
  }
});
it("repairs a failed operation through authenticated staging without a panel or implicit publication", async () => {
  const fixture = await createAuthoringBoundaryFixture({ trustedHost: true });
  const runtime = await startAuthoringRuntime(fixture);
  try {
    const authoredResult = createLifecycleValidators().validateResponse(
      await runtime.execute({
        operation: "definition.author",
        target: { repo: "owner/repo", definition: authorDefinition },
        input: { intent: "Model application", provider: "azure" }
      })
    );
    if (!authoredResult.valid) throw new Error(JSON.stringify(authoredResult));
    const authored = authoredResult.value;
    if (
      !("result" in authored) ||
      authored.operation !== "definition.author" ||
      authored.result.state !== "action_required"
    )
      throw new Error(JSON.stringify(authored));
    const originalId = authored.result.operationId;
    const actionId = authored.result.requiredAction.actionId;
    fixture.attest(actionId, {
      kind: "agent.outcome",
      status: "failed",
      diagnostics: []
    });
    expect(await runtime.execute(fixture.response(actionId))).toMatchObject({
      result: { state: "failed" }
    });
    const repairedResult = createLifecycleValidators().validateResponse(
      await runtime.execute({
        operation: "operation.repair",
        target: { repo: "owner/repo" },
        input: {
          operationId: originalId,
          source: (await fixture.selection()).source,
          repairPolicy: { mode: "manual", maxAttempts: 5 }
        }
      })
    );
    if (!repairedResult.valid) throw new Error(JSON.stringify(repairedResult));
    const repaired = repairedResult.value;
    expect(repaired).toMatchObject({
      operation: "operation.repair",
      result: { state: "action_required" }
    });
    expect(fixture.assignments).toHaveLength(2);
    expect(fixture.assignments[1]).toMatchObject({
      operation: "operation.repair",
      failedOperationId: originalId
    });
    if (
      !("result" in repaired) ||
      repaired.operation !== "operation.repair" ||
      repaired.result.state !== "action_required"
    )
      throw new Error(JSON.stringify(repaired));
    const canvas = runtime.extension.canvases[0];
    if (!canvas) throw new Error("Missing registered canvas");
    await canvas.onClose({
      instanceId: "closed-repair-panel",
      extensionId: "fixture",
      canvasId: "radius"
    });
    expect(fixture.binding.hasActiveOperations()).toBe(true);
    expect(fixture.host.cancel).not.toHaveBeenCalled();
    const completed = await runtime.execute(
      fixture.response(repaired.result.requiredAction.actionId)
    );
    expect(completed, JSON.stringify(completed)).toMatchObject({
      result: {
        state: process.platform === "win32" ? "failed" : "succeeded",
        result: {
          proposal: {
            promotion: process.platform === "win32" ? "refused" : "promoted"
          }
        }
      }
    });
    for (let i = 0; i < 100; i++)
      expect(
        await runtime.execute({
          operation: "operation.get",
          target: { repo: "owner/repo" },
          input: { operationId: originalId }
        })
      ).toMatchObject({ result: { state: "failed" } });
    expect(fixture.assignments).toHaveLength(2);
    expect(fixture.forbidden).toEqual([]);
    expect(runtime.open).not.toHaveBeenCalled();
  } finally {
    await runtime.extension.shutdown("test");
    await fixture.close();
  }
});
