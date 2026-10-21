import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeploymentToolHarness,
  createDeploymentPipelineRunner
} from "../../support/runtime/deployment.js";
import { createRuntimeSdkHarness } from "../../support/runtime/sdk-harness.js";
import { createDeferred } from "../../support/browser/fakes.js";
import { createDeploymentNotifications } from "../../../src/runtime/deployment-notifications.js";
import { createDeploymentPresentation } from "../../../src/server/services/deployment-presentation.js";
import type { CanvasState } from "../../../src/shared.js";
import { createProductionDeploymentTools } from "../../../src/runtime/production-deployment-tools.js";
import { BARE_GH_COMMAND_PRESENTATION } from "../../../src/gh-command-display.js";
import { createProductionDeploymentExecutionOwner } from "../../../src/runtime/production-deployment-execution-owner.js";

afterEach(() => vi.useRealTimers());

describe("registered direct deployment tools", () => {
  it.each(["success", "uncertain"] as const)(
    "runs the registered production deployment pipeline to %s without a panel or local transport",
    async (conclusion) => {
      vi.useFakeTimers();
      const sdk = await createRuntimeSdkHarness();
      const pipeline = createDeploymentPipelineRunner(conclusion);
      const deployment = createDeploymentToolHarness({
        owner: createProductionDeploymentExecutionOwner(),
        run: pipeline.run
      });
      sdk.deps.deployment = createProductionDeploymentTools({
        owner: deployment.owner,
        account: deployment.account,
        session: sdk.deps.session,
        ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
        runAz: async () => {
          throw new Error("Unscripted Azure command");
        },
        buildGraph: async () => [],
        readRadArtifacts: async () => ({
          dir: "fixture-artifacts",
          remote: true
        }),
        reportError: deployment.reportError,
        redactDiagnostic: (value) => value,
        reportWorkflowProgress: vi.fn(),
        invalidateDeployListCache: vi.fn()
      });
      const start = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy"
      );
      const status = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy_status"
      );
      if (!start || !status)
        throw new Error("Missing registered deployment tools");
      try {
        expect(
          await start.handler({
            repo: "fixture/app",
            environment: "dev",
            branch: "feature/model",
            provider: "aws",
            appFile: "apps/custom.bicep"
          })
        ).toContain("started");
        for (
          let tick = 0;
          tick < 100 && deployment.owner.activeReservation(deployment.target);
          tick++
        )
          await vi.advanceTimersByTimeAsync(1000);
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined();
        const selected = deployment.owner.resolve();
        if (selected.kind !== "resolved") throw new Error(selected.kind);
        expect(
          JSON.parse(
            String(
              await status.handler({ attemptId: selected.invocation.attemptId })
            )
          )
        ).toMatchObject(
          conclusion === "success" ?
            {
              status: "success",
              errorKind: null,
              deployRunUrl: "https://github.com/fixture/app/actions/runs/42"
            }
          : { status: "failed", errorKind: "run-unconfirmed" }
        );
        expect(pipeline.unexpected).toEqual([]);
        expect(
          pipeline.run.mock.calls.filter(([args]) => args[0] === "workflow")
        ).toHaveLength(1);
        expect(sdk.session.send).toHaveBeenCalledTimes(
          conclusion === "success" ? 0 : 1
        );
        expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
        expect(sdk.deps.deploy.fetch).not.toHaveBeenCalled();
      } finally {
        await sdk.extension.shutdown("test");
      }
    }
  );

  it("shuts down the production monitor while a selected command is pending without sending a late notification", async () => {
    const sdk = await createRuntimeSdkHarness();
    const pipeline = createDeploymentPipelineRunner("success");
    const pending = createDeferred<void>();
    let readingBranch = false;
    const deployment = createDeploymentToolHarness({
      owner: createProductionDeploymentExecutionOwner(),
      run: async (args, options) => {
        if (args[1].includes("/git/ref/heads/")) {
          readingBranch = true;
          await pending.promise;
        }
        return pipeline.run(args, options);
      }
    });
    sdk.deps.deployment = createProductionDeploymentTools({
      owner: deployment.owner,
      account: deployment.account,
      session: sdk.deps.session,
      ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
      runAz: async () => {
        throw new Error("Unscripted Azure command");
      },
      buildGraph: async () => [],
      readRadArtifacts: async () => ({
        dir: "fixture-artifacts",
        remote: true
      }),
      reportError: deployment.reportError,
      redactDiagnostic: (value) => value,
      reportWorkflowProgress: vi.fn(),
      invalidateDeployListCache: vi.fn()
    });
    const start = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy"
    );
    if (!start) throw new Error("Missing registered deploy tool");
    try {
      await start.handler({
        repo: "fixture/app",
        environment: "dev",
        branch: "feature/model",
        provider: "aws"
      });
      await vi.waitFor(() => expect(readingBranch).toBe(true));
      await sdk.extension.shutdown("test");
      expect(
        deployment.owner.activeReservation(deployment.target)
      ).toBeDefined();
      pending.resolve();
      await vi.waitFor(() =>
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined()
      );
      expect(sdk.session.send).not.toHaveBeenCalled();
      expect(
        pipeline.run.mock.calls.some(([args]) => args[0] === "workflow")
      ).toBe(false);
    } finally {
      pending.resolve();
      await sdk.extension.shutdown("test");
    }
  });

  it.each([undefined, "unsupported"])(
    "returns explicit unavailable guidance through the registered status handler for %s",
    async (deployStatus) => {
      const sdk = await createRuntimeSdkHarness();
      const deployment = createDeploymentToolHarness();
      sdk.deps.deployment = deployment.tools;
      const execution = deployment.seed();
      execution.state.deployStatus = deployStatus;
      const status = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy_status"
      );
      if (!status) throw new Error("Missing registered status tool");
      try {
        expect(
          await status.handler({ attemptId: execution.invocation.attemptId })
        ).toContain("Deployment status is unavailable");
        expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      } finally {
        await sdk.extension.shutdown("test");
      }
    }
  );

  it("routes the SDK handler through the actual production monitor and session-holder notification with a shared panel owner", async () => {
    const sdk = await createRuntimeSdkHarness();
    const deployment = createDeploymentToolHarness();
    const admission = deployment.run.getMockImplementation();
    if (!admission) throw new Error("Missing admission fixture");
    deployment.run.mockImplementation(async (args, options) => {
      if (args[0] === "api" && args[1].includes("/contents/"))
        return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      if (args[0] === "api" && args[1].includes("/git/ref/heads/"))
        return { code: 1, stdout: "", stderr: "HTTP 403: branch unavailable" };
      return admission(args, options);
    });
    sdk.deps.deployment = createProductionDeploymentTools({
      owner: deployment.owner,
      account: deployment.account,
      session: sdk.deps.session,
      ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
      runAz: async () => {
        throw new Error("Unscripted Azure command");
      },
      reportError: deployment.reportError,
      redactDiagnostic: (value) => value,
      reportWorkflowProgress: vi.fn(),
      invalidateDeployListCache: vi.fn()
    });
    const start = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy"
    );
    const status = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy_status"
    );
    if (!start || !status)
      throw new Error("Missing registered deployment tools");
    const presentation = createDeploymentPresentation(deployment.owner);
    try {
      await start.handler({
        repo: "fixture/app",
        environment: "dev",
        branch: "feature/model",
        provider: "aws"
      });
      const selected = deployment.owner.resolve();
      if (selected.kind !== "resolved") throw new Error(selected.kind);
      const panel: CanvasState = {};
      presentation.attach("production-panel", panel, selected.invocation);
      await vi.waitFor(() =>
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined()
      );
      expect(
        JSON.parse(
          String(
            await status.handler({ attemptId: selected.invocation.attemptId })
          )
        )
      ).toMatchObject({
        status: "failed",
        errorKind: "dispatch-refused"
      });
      expect(panel.deployErrorKind).toBe("dispatch-refused");
      expect(sdk.session.send).toHaveBeenCalledOnce();
      expect(sdk.session.send).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("branch unavailable")
        })
      );
      expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      expect(sdk.deps.deploy.fetch).not.toHaveBeenCalled();
      expect(deployment.monitor).not.toHaveBeenCalled();
    } finally {
      presentation.detach("production-panel");
      await sdk.extension.shutdown("test");
    }
  });

  it.each([
    ["pending", "pending"],
    ["in_progress", "in_progress"],
    ["complete", "success"],
    ["failed", "failed"]
  ])(
    "serializes owned %s as %s without renaming the attached Canvas state",
    async (canvasStatus, toolStatus) => {
      const sdk = await createRuntimeSdkHarness();
      const deployment = createDeploymentToolHarness();
      sdk.deps.deployment = deployment.tools;
      const execution = deployment.seed({
        deployStatus: canvasStatus,
        deployRunUrl: "https://github.com/fixture/app/actions/runs/42",
        deployStartedAt: 1700000000000,
        deployFinishedAt:
          canvasStatus === "complete" || canvasStatus === "failed" ?
            1700000060000
          : undefined
      });
      const presentation = createDeploymentPresentation(deployment.owner);
      const panel: CanvasState = {};
      presentation.attach("status-panel", panel, execution.invocation);
      const status = sdk.extension.tools.find(
        ({ name }) => name === "radius_deploy_status"
      );
      if (!status) throw new Error("Missing registered status tool");
      try {
        expect(
          JSON.parse(
            String(
              await status.handler({
                attemptId: execution.invocation.attemptId
              })
            )
          )
        ).toEqual({
          status: toolStatus,
          attemptId: execution.invocation.attemptId,
          errorKind: null,
          deployRunUrl: "https://github.com/fixture/app/actions/runs/42",
          startedAt: 1700000000000,
          finishedAt:
            canvasStatus === "complete" || canvasStatus === "failed" ?
              1700000060000
            : null
        });
        expect(panel.deployStatus).toBe(canvasStatus);
        expect(execution.state.deployStatus).toBe(canvasStatus);
        expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
        expect(sdk.deps.deploy.fetch).not.toHaveBeenCalled();
      } finally {
        presentation.detach("status-panel");
        await sdk.extension.shutdown("test");
      }
    }
  );

  it("starts, repeats and observes a named attempt without opening a panel or fetching loopback HTTP", async () => {
    const sdk = await createRuntimeSdkHarness();
    const deployment = createDeploymentToolHarness();
    sdk.deps.deployment = deployment.tools;
    const start = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy"
    );
    const status = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy_status"
    );
    if (!start || !status)
      throw new Error("Missing registered deployment tools");
    try {
      expect(
        await start.handler({
          repo: "fixture/app",
          environment: "dev",
          branch: "feature/model"
        })
      ).toContain("started");
      await vi.waitFor(() =>
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined()
      );
      const first = deployment.owner.resolve();
      if (first.kind !== "resolved") throw new Error(first.kind);
      expect(
        JSON.parse(
          String(
            await status.handler({ attemptId: first.invocation.attemptId })
          )
        )
      ).toMatchObject({ status: "success" });
      expect(await start.handler({})).toContain("started");
      expect(deployment.monitor).toHaveBeenCalledTimes(2);
      expect(
        await start.handler({ attemptId: first.invocation.attemptId })
      ).toContain("no longer active");
      expect(sdk.getOrCreateServer).not.toHaveBeenCalled();
      expect(sdk.deps.deploy.fetch).not.toHaveBeenCalled();
      expect(sdk.servers.size).toBe(0);
    } finally {
      await sdk.extension.shutdown("test");
    }
  });

  it("shares one repair claim with an attached presentation and reports SDK delivery rejection", async () => {
    const sdk = await createRuntimeSdkHarness();
    const deployment = createDeploymentToolHarness();
    sdk.deps.deployment = deployment.tools;
    const pending = createDeferred<void>();
    const send = vi.mocked(sdk.session.send);
    send.mockImplementation(() => pending.promise);
    const notifications = createDeploymentNotifications({
      owner: deployment.owner,
      repair: (input) => {
        const callback = sdk.capturedHostCallbacks.deployRepairHandoff;
        if (!callback) throw new Error("Repair callback was not registered.");
        return callback(input);
      },
      notice: vi.fn(),
      reportError: deployment.reportError
    });
    deployment.notify.mockImplementation(notifications);
    const execution = deployment.seed({
      deployStatus: "failed",
      deployError: "model failure"
    });
    const panel: CanvasState = {};
    const presentation = createDeploymentPresentation(deployment.owner);
    presentation.attach("attached-panel", panel, execution.invocation);
    const status = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy_status"
    );
    if (!status) throw new Error("Missing registered status tool");
    try {
      await status.handler({ attemptId: execution.invocation.attemptId });
      notifications(execution);
      expect(send).toHaveBeenCalledOnce();
      expect(panel.deployHandoffState).toBe("pending");
      pending.reject(new Error("SDK unavailable"));
      await vi.waitFor(() =>
        expect(panel.deployHandoffState).toBe("retryable")
      );
      expect(deployment.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "SDK unavailable" })
      );
      expect(sdk.deps.deploy.fetch).not.toHaveBeenCalled();
    } finally {
      presentation.detach("attached-panel");
      await sdk.extension.shutdown("test");
    }
  });

  it("stops a tool-started monitor during zero-panel SDK shutdown without releasing its lease before settlement", async () => {
    const sdk = await createRuntimeSdkHarness();
    const deployment = createDeploymentToolHarness();
    sdk.deps.deployment = deployment.tools;
    const pending = createDeferred<void>();
    deployment.monitor.mockImplementation(() => pending.promise);
    const start = sdk.extension.tools.find(
      ({ name }) => name === "radius_deploy"
    );
    if (!start) throw new Error("Missing registered deploy tool");
    try {
      await start.handler({
        repo: "fixture/app",
        environment: "dev",
        branch: "feature/model"
      });
      const selected = deployment.owner.resolve();
      if (selected.kind !== "resolved") throw new Error(selected.kind);
      const execution = deployment.owner.execution(selected.invocation);
      await sdk.extension.shutdown("test");
      expect(execution?.observation.stopped).toBe(true);
      expect(
        deployment.owner.activeReservation(deployment.target)
      ).toBeDefined();
      pending.resolve();
      await vi.waitFor(() =>
        expect(
          deployment.owner.activeReservation(deployment.target)
        ).toBeUndefined()
      );
      expect(deployment.notify).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
      await sdk.extension.shutdown("test");
    }
  });
});
