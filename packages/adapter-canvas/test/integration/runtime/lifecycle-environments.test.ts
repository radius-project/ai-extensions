import { expect, it, vi } from "vitest";
import { portSuccess } from "@radius-project/core/lifecycle";
import { createLifecycleBinding } from "../../../src/runtime/create-lifecycle-binding.js";
import { createLifecycleFixture } from "../../support/lifecycle.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";
import { createEnvironmentFixture } from "../../support/lifecycle-environments.js";

it("exposes read-only credential prerequisites through the real panel-free runtime", async () => {
  const fixture = createLifecycleFixture();
  const inspect = vi.fn(async () =>
    portSuccess({
      prerequisites: [
        {
          provider: "azure" as const,
          status: "missing" as const,
          reason: "Explicit authentication is required."
        }
      ],
      observation: {
        quality: "current" as const,
        completeness: "complete" as const,
        evidence: "configuration" as const
      }
    })
  );
  const configure = vi.fn(async (): Promise<never> => {
    throw new Error("Inspection must not configure credentials");
  });
  const dependencies = {
    authority: fixture.ports.identity,
    ids: fixture.ports.ids,
    clock: fixture.ports.clock,
    hostBinding: () => ({
      bindingRef: "fixture-binding",
      sessionRef: fixture.caller.sessionRef
    }),
    resolveWorkspaceSource: async (): Promise<never> => {
      throw new Error("Credential inspection must not resolve source");
    },
    knownLegacyOperations: () => [],
    credentials: { providers: ["azure" as const], inspect, configure }
  };
  const binding = createLifecycleBinding(dependencies);
  const runtime = await createRuntimeSdkHarness({ lifecycle: binding });
  try {
    const tool = runtime.extension.tools.find(
      (entry) => entry.name === "radius_lifecycle"
    );
    if (!tool) throw new Error("Missing lifecycle tool");
    const result = JSON.parse(
      String(
        await tool.handler({
          operation: "credentials.inspect",
          target: { repo: "owner/repo" },
          input: { provider: "azure" }
        })
      )
    );
    expect(result).toMatchObject({
      operation: "credentials.inspect",
      result: { prerequisites: [{ status: "missing" }], actions: [] }
    });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(configure).not.toHaveBeenCalled();
    expect(runtime.getOrCreateServer).not.toHaveBeenCalled();
    expect(runtime.session.rpc.canvas.open).not.toHaveBeenCalled();
  } finally {
    await runtime.extension.shutdown("test");
    await binding.close();
    await fixture.binding.close();
  }
});

it.each([
  "credentials.configure",
  "environment.create",
  "environment.configure"
] as const)(
  "preserves a core prerequisite refusal from %s through the real runtime tool",
  async (operation) => {
    const fixture = await createEnvironmentFixture();
    const runtime = await createRuntimeSdkHarness({
      lifecycle: fixture.binding
    });
    try {
      fixture.state.exists = operation === "environment.create";
      if (operation === "credentials.configure")
        await fixture.binding.registry.close();
      const tool = runtime.extension.tools.find(
        (entry) => entry.name === "radius_lifecycle"
      );
      if (!tool) throw new Error("Missing lifecycle tool");
      const input =
        operation === "credentials.configure" ?
          { provider: "azure", intent: "authenticate" }
        : operation === "environment.create" ?
          { configuration: fixture.configuration }
        : { patch: { provider: "azure", settings: { location: "eastus" } } };
      const result: unknown = JSON.parse(
        String(await tool.handler({ operation, target: fixture.target, input }))
      );
      expect(result).toMatchObject({
        error: {
          code: "PRECONDITION_FAILED"
        }
      });
      expect(
        fixture.state.calls.some(
          (call) =>
            call === "authenticate" ||
            call.startsWith("commit:") ||
            call.startsWith("variable:")
        )
      ).toBe(false);
      expect(runtime.getOrCreateServer).not.toHaveBeenCalled();
      expect(runtime.session.rpc.canvas.open).not.toHaveBeenCalled();
    } finally {
      await runtime.extension.shutdown("test");
      await fixture.close();
    }
  }
);

it("retains legacy setup control before admitting a new composed environment writer", async () => {
  const fixture = await createEnvironmentFixture();
  try {
    fixture.state.legacyOperations = [
      {
        operationId: "unrelated",
        family: "deployment",
        owner: "legacy",
        needsControl: true
      },
      {
        operationId: "canonical",
        family: "environment",
        owner: "lifecycle",
        needsControl: true
      },
      {
        operationId: "finished",
        family: "environment",
        owner: "legacy",
        needsControl: false
      },
      {
        operationId: "legacy-setup",
        family: "environment",
        owner: "legacy",
        needsControl: true
      }
    ];
    const before = [...fixture.state.calls];
    expect(await fixture.start()).toMatchObject({
      error: { code: "PRECONDITION_FAILED" }
    });
    expect(fixture.state.calls).toEqual(before);
    expect(fixture.binding.registry.knownOperations()).toHaveLength(0);
    fixture.state.legacyOperations.pop();
    expect(await fixture.start()).toMatchObject({
      result: { state: "action_required" }
    });
    expect(fixture.state.exists).toBe(false);
  } finally {
    await fixture.close();
  }
});

it.each(["azure", "aws"] as const)(
  "composes %s setup and profile changes without a panel or implicit deployment",
  async (provider) => {
    const fixture = await createEnvironmentFixture(provider);
    const runtime = await createRuntimeSdkHarness({
      lifecycle: fixture.binding
    });
    try {
      const tool = runtime.extension.tools.find(
        (entry) => entry.name === "radius_lifecycle"
      );
      if (!tool) throw new Error("Missing lifecycle tool");
      const invoke = async (operation: string, input: unknown) =>
        JSON.parse(
          String(
            await tool.handler({ operation, target: fixture.target, input })
          )
        );
      const started = await invoke("environment.create", {
        configuration: fixture.configuration
      });
      expect(started).toMatchObject({ result: { state: "action_required" } });
      expect(fixture.state.exists).toBe(false);
      const completed = await invoke("operation.respond", {
        operationId: started.result.operationId,
        actionId: started.result.requiredAction.actionId,
        response: { kind: "user.decision", choice: "continue" }
      });
      expect(completed).toMatchObject({
        result: { state: "succeeded", result: { kind: "configuration" } }
      });
      expect(fixture.state.exists).toBe(true);
      expect(fixture.state.protections).toEqual({
        requiredReviewers: true,
        waitTimerMinutes: 5,
        branchPolicy: "protected"
      });
      const mutations = [...fixture.state.calls];
      for (let read = 0; read < 100; read++) {
        expect(
          await invoke("operation.get", {
            operationId: started.result.operationId
          })
        ).toMatchObject({ result: { state: "succeeded" } });
      }
      expect(fixture.state.calls).toEqual(mutations);
      expect(runtime.getOrCreateServer).not.toHaveBeenCalled();
      expect(runtime.session.rpc.canvas.open).not.toHaveBeenCalled();
      expect(
        await invoke("operation.respond", {
          operationId: started.result.operationId,
          actionId: started.result.requiredAction.actionId,
          response: { kind: "user.decision", choice: "continue" }
        })
      ).toMatchObject({ error: { code: "ACTION_NOT_OUTSTANDING" } });
      expect(fixture.state.calls).toEqual(mutations);
    } finally {
      await runtime.extension.shutdown("test");
      await fixture.close();
    }
  }
);
