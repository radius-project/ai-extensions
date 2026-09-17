import { afterEach, describe, expect, it, vi } from "vitest";
import { portForbidden, portSuccess } from "@radius-project/core/lifecycle";
import { createLifecycleFixture } from "../../support/lifecycle.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";
import { KEEPALIVE_INTERVAL_MS } from "../../../src/runtime/create-radius-extension.js";
import { createOperation, createRegistry } from "../../../src/operations.js";
import { createLifecycleSetupStore } from "../../../src/runtime/lifecycle-setup-store.js";
import { AUTHORING_TOOL_CONTRACTS } from "../../fixtures/lifecycle/authoring-tool-compatibility.js";
import { unavailableCanvasLifecyclePrerequisite } from "../../../src/runtime/lifecycle-authorization.js";
import { createLifecycleBinding } from "../../../src/runtime/create-lifecycle-binding.js";

afterEach(() => vi.useRealTimers());

function parseToolResult(value: unknown): unknown {
  if (typeof value !== "string")
    throw new Error("Lifecycle tool must return JSON text");
  return JSON.parse(value);
}

describe("frontend-neutral lifecycle foundation runtime integration", () => {
  it("returns the production host prerequisite diagnostic through the public tool", async () => {
    const fixture = createLifecycleFixture({
      overrides: {
        identity: {
          authorizeResponse: async () =>
            unavailableCanvasLifecyclePrerequisite()
        }
      }
    });
    const pending = await fixture.pendingAction();
    const harness = await createRuntimeSdkHarness({
      lifecycle: fixture.binding
    });
    try {
      const tool = harness.extension.tools.find(
        (tool) => tool.name === "radius_lifecycle"
      );
      if (!tool) throw new Error("Missing lifecycle tool");
      expect(parseToolResult(await tool.handler(pending.intent))).toMatchObject(
        {
          error: {
            code: "CAPABILITY_UNAVAILABLE",
            details: [
              {
                message:
                  "The host does not provide verified user approval or external agent assignment authority.",
                truncated: false
              }
            ]
          }
        }
      );
      expect(pending.continuations()).toBe(0);
      expect(harness.getOrCreateServer).not.toHaveBeenCalled();
      expect(harness.session.rpc.canvas.open).not.toHaveBeenCalled();
    } finally {
      await harness.extension.shutdown("test");
    }
  });
  it.each(["target", "base", "head"] as const)(
    "retains the production source prerequisite diagnostic for %s in the public tool",
    async (location) => {
      const fixture = createLifecycleFixture();
      let resolutions = 0;
      const binding = createLifecycleBinding({
        authority: fixture.ports.identity,
        ids: fixture.ports.ids,
        clock: fixture.ports.clock,
        hostBinding: () => ({
          bindingRef: "fixture-binding",
          sessionRef: fixture.caller.sessionRef
        }),
        knownLegacyOperations: () => [],
        resolveWorkspaceSource: async () => {
          resolutions++;
          return location === "head" && resolutions === 1 ?
              portSuccess(fixture.source)
            : unavailableCanvasLifecyclePrerequisite();
        }
      });
      const harness = await createRuntimeSdkHarness({ lifecycle: binding });
      try {
        const target = { repo: "owner/repo", definition: ".radius/app.bicep" };
        const intent =
          location === "target" ?
            {
              operation: "definition.validate",
              target,
              input: { policyVersion: "github-radius/validation/v1" }
            }
          : {
              operation: "graph.diff",
              target: { repo: "owner/repo" },
              input: { kind: "authored", base: target, head: target }
            };
        const tool = harness.extension.tools.find(
          (tool) => tool.name === "radius_lifecycle"
        );
        if (!tool) throw new Error("Missing lifecycle tool");
        expect(parseToolResult(await tool.handler(intent))).toMatchObject({
          error: {
            code: "CAPABILITY_UNAVAILABLE",
            details: [
              {
                message:
                  "The host does not provide verified user approval or external agent assignment authority.",
                truncated: false
              }
            ]
          }
        });
        expect(resolutions).toBe(location === "head" ? 2 : 1);
        expect(harness.getOrCreateServer).not.toHaveBeenCalled();
        expect(harness.session.rpc.canvas.open).not.toHaveBeenCalled();
      } finally {
        await harness.extension.shutdown("test");
        await fixture.binding.close();
      }
    }
  );
  it("preserves caller source expectations through the actual tool boundary", async () => {
    const fixture = createLifecycleFixture();
    const harness = await createRuntimeSdkHarness({
      lifecycle: fixture.binding
    });
    try {
      const tool = harness.extension.tools.find(
        (tool) => tool.name === "radius_lifecycle"
      );
      if (!tool) throw new Error("Missing lifecycle tool");
      const intent = {
        operation: "definition.validate",
        target: { repo: "owner/repo", definition: ".radius/app.bicep" },
        input: { policyVersion: "github-radius/validation/v1" }
      };
      expect(parseToolResult(await tool.handler(intent))).toMatchObject({
        error: { code: "CAPABILITY_UNAVAILABLE" }
      });
      for (const source of [
        {
          ...fixture.source,
          expectedFingerprint: "invalid-expected-fingerprint"
        },
        {
          kind: "git",
          ref: "feature",
          expectedCommit: "invalid-expected-commit"
        }
      ]) {
        expect(
          parseToolResult(
            await tool.handler({
              ...intent,
              target: { ...intent.target, source }
            })
          )
        ).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      }
      expect(fixture.sourceResolutions()).toBe(1);
      expect(harness.servers.size).toBe(0);
      expect(harness.session.rpc.canvas.open).not.toHaveBeenCalled();
    } finally {
      await harness.extension.shutdown("test");
    }
  });
  it("registers the additive tool and handles a trusted response without panels or servers", async () => {
    const fixture = createLifecycleFixture();
    const pending = await fixture.pendingAction();
    const harness = await createRuntimeSdkHarness({
      lifecycle: fixture.binding
    });
    try {
      expect(
        harness.registration.tools.filter(
          (tool) => tool.name !== "radius_lifecycle"
        )
      ).toEqual(AUTHORING_TOOL_CONTRACTS);
      const tool = harness.extension.tools.find(
        (tool) => tool.name === "radius_lifecycle"
      );
      if (!tool) throw new Error("Missing lifecycle tool");
      const response = parseToolResult(await tool.handler(pending.intent));
      expect(response).toMatchObject({
        operation: "operation.respond",
        result: { state: "running" }
      });
      expect(pending.continuations()).toBe(1);
      expect(harness.getOrCreateServer).not.toHaveBeenCalled();
      expect(harness.session.rpc.canvas.open).not.toHaveBeenCalled();
      expect(harness.servers.size).toBe(0);
      await harness.host.close("nonexistent-panel");
      expect(fixture.binding.hasActiveOperations()).toBe(true);
      expect(parseToolResult(await tool.handler(pending.intent))).toMatchObject(
        { error: { code: "ACTION_NOT_OUTSTANDING" } }
      );
    } finally {
      await harness.extension.shutdown("test");
    }
    expect(fixture.binding.hasActiveOperations()).toBe(false);
  });
  it.each([false, true])(
    "keeps panel-free work alive and fences shutdown with metadata failure=%s",
    async (metadataFailure) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
      const fixture = createLifecycleFixture();
      await fixture.pendingAction();
      const harness = await createRuntimeSdkHarness({
        lifecycle: fixture.binding
      });
      if (metadataFailure) {
        harness.session.metadata = {
          snapshot: vi.fn(async () => {
            throw new Error("Host metadata unavailable");
          })
        };
      }
      try {
        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
        expect(harness.session.metadata?.snapshot).toHaveBeenCalledTimes(1);
        expect(harness.getOrCreateServer).not.toHaveBeenCalled();
        await harness.extension.shutdown("test");
        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
        expect(harness.session.metadata?.snapshot).toHaveBeenCalledTimes(1);
        expect(fixture.binding.registry.knownOperations()[0].state).toBe(
          "action_required"
        );
      } finally {
        await harness.extension.shutdown("test");
      }
    }
  );
  it("closes an actual presentation instance without disposing its session operation", async () => {
    const fixture = createLifecycleFixture();
    const pending = await fixture.pendingAction();
    const harness = await createRuntimeSdkHarness({
      lifecycle: fixture.binding
    });
    try {
      await harness.host.open("presentation", { page: "credentials" });
      expect(harness.getOrCreateServer).toHaveBeenCalledTimes(1);
      await harness.host.close("presentation");
      expect(harness.servers.size).toBe(0);
      expect(fixture.binding.hasActiveOperations()).toBe(true);
      const tool = harness.extension.tools.find(
        (tool) => tool.name === "radius_lifecycle"
      );
      if (!tool) throw new Error("Missing lifecycle tool");
      expect(parseToolResult(await tool.handler(pending.intent))).toMatchObject(
        { result: { state: "running" } }
      );
      expect(harness.getOrCreateServer).toHaveBeenCalledTimes(1);
    } finally {
      await harness.extension.shutdown("test");
    }
  });
  it("propagates missing authority and continuation failure without fake success or repeated effects", async () => {
    const fixture = createLifecycleFixture({
      overrides: {
        identity: { authorizeResponse: async () => portForbidden() }
      }
    });
    const pending = await fixture.pendingAction();
    const harness = await createRuntimeSdkHarness({
      lifecycle: fixture.binding
    });
    try {
      const tool = harness.extension.tools.find(
        (tool) => tool.name === "radius_lifecycle"
      );
      if (!tool) throw new Error("Missing lifecycle tool");
      expect(parseToolResult(await tool.handler(pending.intent))).toMatchObject(
        { error: { code: "FORBIDDEN" } }
      );
      expect(pending.continuations()).toBe(0);
      expect(harness.getOrCreateServer).not.toHaveBeenCalled();
      let executions = 0;
      const other = createLifecycleFixture();
      const failure = await other.pendingAction({
        revalidate: async () => portSuccess(undefined),
        continue: async () => {
          executions++;
          throw new Error("Lost acknowledgement");
        }
      });
      expect(await other.binding.execute(failure.intent)).toMatchObject({
        error: { code: "CAPABILITY_UNAVAILABLE" }
      });
      expect(await other.binding.execute(failure.intent)).toMatchObject({
        error: { code: "ACTION_NOT_OUTSTANDING" }
      });
      expect(executions).toBe(1);
      await other.binding.close();
    } finally {
      await harness.extension.shutdown("test");
    }
  });
  it("preserves known legacy and new operations across guarded cutover and rollback with zero duplicate execution", async () => {
    const legacy = createRegistry();
    legacy.put(
      createOperation({
        operationId: "op_legacy",
        repo: "owner/repo",
        provider: "azure"
      })
    );
    const store = createLifecycleSetupStore({ registry: () => legacy });
    const fixture = createLifecycleFixture({
      knownLegacyOperations: store.knownOperations
    });
    const pending = await fixture.pendingAction();
    const harness = await createRuntimeSdkHarness({
      lifecycle: fixture.binding
    });
    try {
      const routing = fixture.binding.routing;
      expect(() =>
        routing.transition("environment", {
          writer: "lifecycle",
          readers: ["lifecycle"],
          controllers: ["lifecycle"]
        })
      ).toThrow("orphan");
      routing.transition("environment", {
        writer: "lifecycle",
        readers: ["legacy", "lifecycle"],
        controllers: ["legacy", "lifecycle"]
      });
      expect(routing.address("op_legacy", true)).toBe("legacy");
      expect(routing.address(pending.operationId, true)).toBe("lifecycle");
      expect(() =>
        routing.claimDispatch("environment", pending.operationId)
      ).toThrow("redispatched");
      routing.transition("environment", {
        writer: "legacy",
        readers: ["legacy", "lifecycle"],
        controllers: ["legacy", "lifecycle"]
      });
      expect(() =>
        routing.transition("environment", {
          writer: "legacy",
          readers: ["legacy"],
          controllers: ["legacy"]
        })
      ).toThrow("orphan");
      expect(store.control("op_legacy", "owner/repo", "stop").path).toBe(
        "/api/operations/op_legacy/stop"
      );
      expect(await fixture.binding.execute(pending.intent)).toMatchObject({
        result: { state: "running" }
      });
      expect(await fixture.binding.execute(pending.intent)).toMatchObject({
        error: { code: "ACTION_NOT_OUTSTANDING" }
      });
      expect(pending.continuations()).toBe(1);
      expect(legacy.size()).toBe(1);
      expect(harness.getOrCreateServer).not.toHaveBeenCalled();
    } finally {
      await harness.extension.shutdown("test");
    }
  });
});
