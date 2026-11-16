import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkflowObservationScope } from "@radius-project/adapter-shared";
import {
  DEPLOY_REPAIR_ATTEMPT_CAP,
  redactCredentials,
  type DeploymentErrorKind
} from "@radius-project/core";
import { createDeploymentDelivery } from "../../../src/server/services/deployment-delivery.js";
import { createTestDeploymentRuntime } from "../../support/server/deployment-runtime.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";
import { createDeferred } from "../../support/browser/fakes.js";
import {
  deployFailureNoticeMessage,
  deployRepairHandoffMessage
} from "../../../src/runtime/hooks.js";

afterEach(() => vi.useRealTimers());

async function startDeployment(
  sdk: Awaited<ReturnType<typeof createRuntimeSdkHarness>>
) {
  const tool = sdk.extension.tools.find(({ name }) => name === "radius_deploy");
  if (!tool) throw new Error("Missing registered deployment tool");
  const started = await tool.handler({
    repo: "acme/app",
    environment: "production",
    branch: "feature",
    appFile: "models/custom.bicep"
  });
  const current = sdk.deps.deployment.owner.lookup();
  if (current.kind !== "found") throw new Error(String(started));
  expect(started).toContain(current.invocation.observationId);
  return current.invocation;
}

async function harness(
  kind: "repair" | "notice" | DeploymentErrorKind,
  error = "Model failed"
) {
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
          entry.state.deployError = error;
          entry.state.deployRunUrl =
            "https://github.com/acme/app/actions/runs/42";
          if (kind === "notice")
            entry.state.deployErrorKind = "run-unconfirmed";
          else if (kind !== "repair") entry.state.deployErrorKind = kind;
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
    "does not exclude recovery mutations while a registered SDK %s send is unresolved",
    async (kind) => {
      const { sdk, runtime } = await harness(kind);
      const sent = createDeferred<void>();
      const delivered = createDeferred<void>();
      vi.mocked(sdk.session.send).mockImplementation(async () => {
        expect(runtime.owner.hasActiveWork()).toBe(false);
        sent.resolve();
        await delivered.promise;
      });
      try {
        const invocation = await startDeployment(sdk);
        await sent.promise;
        expect(runtime.owner.hasPendingDelivery()).toBe(true);
        for (const operation of ["delete", "abandon", "deploy"] as const) {
          const reservation = runtime.owner.reserve(
            invocation.target,
            operation
          );
          expect(reservation).not.toBeNull();
          if (reservation) runtime.owner.release(reservation);
        }
        expect(runtime.owner.retire(invocation)).toBe(true);
        const stopping = await runtime.owner.shutdown(0);
        expect(stopping).toEqual({
          complete: false,
          pending: [`delivery:${invocation.observationId}`]
        });
        delivered.resolve();
        await vi.waitFor(() =>
          expect(runtime.owner.hasPendingDelivery()).toBe(false)
        );
        expect(sdk.session.send).toHaveBeenCalledOnce();
        expect(invocation.state.deployRepairing).not.toBe(true);
      } finally {
        delivered.resolve();
        await sdk.extension.shutdown("test");
      }
    }
  );

  it.each([
    [
      "model-preflight-failed",
      "The selected model is missing. Commit the selected file."
    ],
    [
      "workflow-preflight-failed",
      "The workflow has incompatible inputs. Update the workflow."
    ]
  ] satisfies [DeploymentErrorKind, string][])(
    "keeps %s ineligible for automatic model repair",
    async (kind, error) => {
      const { sdk, runtime } = await harness(kind, error);
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
        expect(sdk.session.send).not.toHaveBeenCalled();
        expect(result.invocation.state.deployError).toBe(error);
        expect(result.invocation.state.deployRepairing).not.toBe(true);
      } finally {
        await sdk.extension.shutdown("test");
      }
    }
  );

  it("uses the shared repair cap and actionable refusal wording at admission", async () => {
    const { sdk, runtime } = await harness("repair");
    try {
      const first = await runtime.start({
        repo: "acme/app",
        environment: "production",
        branch: "feature"
      });
      if (!first.ok) throw new Error(first.error);
      await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
      first.invocation.state.deployRepairAttempts = DEPLOY_REPAIR_ATTEMPT_CAP;
      const refused = await runtime.start({
        attemptId: first.invocation.attemptId
      });
      expect(refused).toEqual({
        ok: false,
        status: 409,
        error: `This repair loop has already used its ${DEPLOY_REPAIR_ATTEMPT_CAP} automatic repair attempts, so nothing was deployed. Stop retrying: report the remaining failure and what you tried to the user, and let them decide whether to deploy again.`
      });
      expect(runtime.owner.lookup()).toEqual({
        kind: "found",
        invocation: first.invocation
      });
    } finally {
      await sdk.extension.shutdown("test");
    }
  });

  it("keeps owned execution across duplicate registered close and reopen events", async () => {
    const finished = createDeferred<void>();
    const entered = createDeferred<void>();
    const delivery = createDeploymentDelivery();
    const runtime = createTestDeploymentRuntime({
      resolveDeployment: async () => null,
      createExecution: () => ({
        observation: createWorkflowObservationScope(() => {
          throw new Error("Unexpected artifact read");
        }),
        monitor: {
          async run({ entry }) {
            entered.resolve();
            await finished.promise;
            entry.state.deployStatus = "failed";
            entry.state.deployError = "Model failed";
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
      deps.hostCallbacks.setDeployRepairHandoff =
        delivery.setDeployRepairHandoff;
      deps.hostCallbacks.setDeployFailureNotice =
        delivery.setDeployFailureNotice;
    });
    try {
      const input = {
        repo: "acme/app",
        branch: "feature",
        page: "deploying"
      };
      const invocation = await startDeployment(sdk);
      expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      await sdk.host.open("panel", input);
      await entered.promise;
      await sdk.host.close("panel");
      await sdk.host.close("panel");
      expect(sdk.servers.size).toBe(0);
      expect(runtime.owner.hasActiveWork()).toBe(true);
      expect(invocation.signal.aborted).toBe(false);
      await sdk.host.open("panel", input);
      expect(runtime.owner.isCurrent(invocation)).toBe(true);
      await sdk.host.close("panel");
      finished.resolve();
      await vi.waitFor(() => expect(runtime.owner.hasActiveWork()).toBe(false));
      expect(sdk.session.send).toHaveBeenCalledExactlyOnceWith(
        deployRepairHandoffMessage(input.repo, input.branch, {
          error: "Model failed",
          deployRunUrl: "",
          appFile: "models/custom.bicep",
          attemptId: invocation.attemptId
        })
      );
    } finally {
      finished.resolve();
      await sdk.extension.shutdown("test");
    }
  });

  it.each(["repair", "notice"] as const)(
    "delivers a %s through runtime-local callbacks without a Canvas entry",
    async (kind) => {
      const { sdk, runtime } = await harness(kind);
      try {
        const invocation = await startDeployment(sdk);
        await vi.waitFor(() =>
          expect(
            kind === "repair" ?
              invocation.state.deployHandoffState
            : invocation.state.deployNoticeState
          ).toBe("delivered")
        );
        expect(runtime.owner.hasActiveWork()).toBe(false);
        const evidence = {
          error: "Model failed",
          deployRunUrl: "https://github.com/acme/app/actions/runs/42"
        };
        expect(sdk.session.send).toHaveBeenCalledExactlyOnceWith(
          kind === "repair" ?
            deployRepairHandoffMessage("acme/app", "feature", {
              ...evidence,
              appFile: "models/custom.bicep",
              attemptId: invocation.attemptId
            })
          : deployFailureNoticeMessage("acme/app", "feature", evidence)
        );
        expect(sdk.servers.size).toBe(0);
        expect(invocation.state.deployRepairing).toBe(kind === "repair");
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
      const invocation = await startDeployment(sdk);
      await vi.runAllTimersAsync();
      expect(sdk.session.send).toHaveBeenCalledTimes(2);
      expect(vi.mocked(sdk.session.send).mock.calls[0]).toEqual(
        vi.mocked(sdk.session.send).mock.calls[1]
      );
      expect(invocation.state.deployHandoffAttempts).toBe(2);
      expect(invocation.state.deployHandoffState).toBe("delivered");
      expect(runtime.owner.hasActiveWork()).toBe(false);
    } finally {
      vi.useRealTimers();
      await sdk.extension.shutdown("test");
    }
  });
});
