import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeploymentToolHarness,
  createDeploymentPipelineRunner
} from "../../test/support/runtime/deployment.js";
import { createFakeSession } from "../../test/support/runtime/fakes.js";
import { BARE_GH_COMMAND_PRESENTATION } from "../gh-command-display.js";
import { createProductionDeploymentTools } from "./production-deployment-tools.js";
import { createSessionHolder } from "./session.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  const f = createDeploymentToolHarness();
  const session = createSessionHolder();
  const host = createFakeSession();
  session.set(host);
  const tools = createProductionDeploymentTools({
    owner: f.owner,
    account: f.account,
    session,
    reportError: f.reportError,
    redactDiagnostic: (value) => value,
    ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION,
    runAz: async () => {
      throw new Error("Unscripted Azure command");
    },
    reportWorkflowProgress: vi.fn(),
    invalidateDeployListCache: vi.fn()
  });
  return { ...f, tools, host, session };
}

describe("production deployment tool composition", () => {
  it("keeps command fixtures isolated and fails explicitly on unspecified targets or missing secret input", async () => {
    const first = createDeploymentPipelineRunner("success");
    const second = createDeploymentPipelineRunner("success");
    await first.run([
      "workflow",
      "run",
      "run-rad-commands.yml",
      "--repo",
      "fixture/app"
    ]);
    expect(
      JSON.parse(
        (await first.run(["run", "list", "--repo", "fixture/app"])).stdout
      )
    ).toHaveLength(1);
    expect(
      JSON.parse(
        (await second.run(["run", "list", "--repo", "fixture/app"])).stdout
      )
    ).toEqual([]);
    await expect(
      first.run(["api", "/repos/unrelated/app/git/ref/heads/main"])
    ).rejects.toThrow("Unexpected command");
    await expect(
      first.run([
        "secret",
        "set",
        "RADIUS_DEPLOY_PARAMS",
        "--repo",
        "fixture/app"
      ])
    ).rejects.toThrow("Unexpected command");
    expect(second.unexpected).toEqual([]);
  });

  it("runs the real controller and monitor and sends a nonrepairable refusal through the current session", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const admission = f.run.getMockImplementation();
    if (!admission) throw new Error("Missing admission fixture");
    f.run.mockImplementation(async (args, options) => {
      if (args[0] === "api" && args[1].includes("/contents/"))
        return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      if (args[0] === "api" && args[1].includes("/git/ref/heads/"))
        return { code: 1, stdout: "", stderr: "HTTP 403: branch unavailable" };
      return admission(args, options);
    });
    try {
      expect(
        await f.tools.start({
          repo: "fixture/app",
          environment: "dev",
          branch: "feature/model",
          provider: "aws"
        })
      ).toContain("started");
      for (
        let tick = 0;
        tick < 10 && f.owner.activeReservation(f.target);
        tick++
      )
        await vi.advanceTimersByTimeAsync(1);
      expect(f.owner.activeReservation(f.target)).toBeUndefined();
      expect(JSON.parse(await f.tools.status({}))).toMatchObject({
        status: "failed",
        errorKind: "dispatch-refused"
      });
      expect(f.host.send).toHaveBeenCalledOnce();
      expect(f.host.send).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("branch unavailable")
        })
      );
      expect(f.run.mock.calls.some(([args]) => args[0] === "workflow")).toBe(
        false
      );
    } finally {
      f.tools.shutdown();
    }
  });

  it("retries repair delivery through a replaced SDK session without changing the attempt or account", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const execution = f.seed({
      deployStatus: "failed",
      deployError: "model invalid"
    });
    vi.mocked(f.host.send).mockRejectedValue(new Error("disconnected"));
    try {
      await f.tools.status({ attemptId: execution.invocation.attemptId });
      expect(execution.state.deployHandoffState).toBe("retryable");
      const replacement = createFakeSession();
      f.session.set(replacement);
      await vi.advanceTimersByTimeAsync(2000);
      expect(replacement.send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            `attemptId "${execution.invocation.attemptId}"`
          )
        })
      );
      expect(execution.state.deployHandoffState).toBe("delivered");
      expect(f.host.send).toHaveBeenCalledOnce();
      expect(f.account).not.toHaveBeenCalled();
    } finally {
      f.tools.shutdown();
    }
  });
});
