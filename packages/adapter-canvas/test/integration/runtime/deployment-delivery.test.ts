import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowObservationScope } from "@radius-project/adapter-shared";
import { redactCredentials } from "@radius-project/core";
import { createDeploymentDelivery } from "../../../src/server/services/deployment-delivery.js";
import { createTestDeploymentRuntime } from "../../support/server/deployment-runtime.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";
import {
  deployFailureNoticeMessage,
  deployRepairHandoffMessage
} from "../../../src/runtime/hooks.js";

afterEach(() => vi.useRealTimers());

async function harness(kind: "repair" | "notice") {
  const delivery = createDeploymentDelivery();
  const runtime = createTestDeploymentRuntime({
    resolveDeployment: async () => null,
    createExecution: () => ({
      observation: createWorkflowObservationScope(() => {
        throw new Error("Unexpected artifact read");
      }),
      monitor: {
        async run({ entry }) {
          entry.state.deployStatus = "failed";
          entry.state.deployError = "Model failed";
          entry.state.deployRunUrl =
            "https://github.com/acme/app/actions/runs/42";
          if (kind === "notice")
            entry.state.deployErrorKind = "run-unconfirmed";
        }
      }
    }),
    delivery: {
      ...delivery.ports,
      redactDiagnostic: redactCredentials,
      reportDiagnostic: () => {}
    }
  });
  const sdk = await createRuntimeSdkHarness({}, (deps) => {
    deps.deployment = runtime;
    deps.hostCallbacks.setDeployRepairHandoff = delivery.setDeployRepairHandoff;
    deps.hostCallbacks.setDeployFailureNotice = delivery.setDeployFailureNotice;
  });
  return { sdk, runtime };
}

describe("deployment delivery through registered SDK handlers", () => {
  it.each(["repair", "notice"] as const)(
    "delivers a %s through runtime-local callbacks without a Canvas entry",
    async (kind) => {
      const { sdk, runtime } = await harness(kind);
      try {
        const result = await runtime.start({
          repo: "acme/app",
          environment: "production",
          branch: "feature"
        });
        if (!result.ok) throw new Error(result.error);
        await vi.waitFor(() =>
          expect(runtime.owner.hasActiveWork()).toBe(false)
        );
        const evidence = {
          error: "Model failed",
          deployRunUrl: "https://github.com/acme/app/actions/runs/42"
        };
        expect(sdk.session.send).toHaveBeenCalledExactlyOnceWith(
          kind === "repair" ?
            deployRepairHandoffMessage("acme/app", "feature", {
              ...evidence,
              attemptId: result.invocation.attemptId
            })
          : deployFailureNoticeMessage("acme/app", "feature", evidence)
        );
        expect(sdk.servers.size).toBe(0);
        expect(result.invocation.state.deployRepairing).toBe(kind === "repair");
      } finally {
        await sdk.extension.shutdown("test");
      }
    }
  );

  it("retains failed SDK delivery as owned retry work and sends the same repair identity", async () => {
    const { sdk, runtime } = await harness("repair");
    try {
      vi.mocked(sdk.session.send).mockRejectedValueOnce(
        new Error("SDK unavailable")
      );
      vi.useFakeTimers();
      const result = await runtime.start({
        repo: "acme/app",
        environment: "production",
        branch: "feature"
      });
      if (!result.ok) throw new Error(result.error);
      await vi.runAllTimersAsync();
      expect(sdk.session.send).toHaveBeenCalledTimes(2);
      expect(vi.mocked(sdk.session.send).mock.calls[0]).toEqual(
        vi.mocked(sdk.session.send).mock.calls[1]
      );
      expect(result.invocation.state.deployHandoffAttempts).toBe(2);
      expect(result.invocation.state.deployHandoffState).toBe("delivered");
      expect(runtime.owner.hasActiveWork()).toBe(false);
    } finally {
      vi.useRealTimers();
      await sdk.extension.shutdown("test");
    }
  });
});
