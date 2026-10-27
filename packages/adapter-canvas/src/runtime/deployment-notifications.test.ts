import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeploymentControllerHarness } from "../../test/support/runtime/deployment.js";
import { createDeploymentNotifications } from "./deployment-notifications.js";

afterEach(() => vi.useRealTimers());

describe("owned deployment notification composition", () => {
  it.each([null, "run-unconfirmed", "dispatch-refused"] as const)(
    "explicitly composes the appropriate notification for %s exactly once",
    async (kind) => {
      const f = createDeploymentControllerHarness();
      const execution = f.seed({
        deployStatus: "failed",
        deployErrorKind: kind,
        deployError: "workflow unavailable"
      });
      const repair = vi.fn(async () => {});
      const notice = vi.fn(async () => {});
      const notify = createDeploymentNotifications({
        owner: f.owner,
        repair,
        notice,
        reportError: f.reportError
      });
      try {
        notify(execution);
        notify(execution);
        await Promise.resolve();
        if (kind === null) {
          expect(repair).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              repo: f.target.repo,
              branch: f.target.branch,
              appFile: f.target.appFile,
              attemptId: execution.invocation.attemptId,
              instanceId: ""
            })
          );
          expect(notice).not.toHaveBeenCalled();
        } else {
          expect(notice).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              repo: f.target.repo,
              error: "workflow unavailable",
              ...(kind === "dispatch-refused" ? { dispatchRefused: true } : {})
            })
          );
          expect(repair).not.toHaveBeenCalled();
        }
      } finally {
        f.owner.shutdown();
      }
    }
  );

  it("owns retries without a panel and cancels a pending retry during shutdown", async () => {
    vi.useFakeTimers();
    const f = createDeploymentControllerHarness();
    const execution = f.seed({ deployStatus: "failed" });
    const repair = vi.fn(async () => {
      throw new Error("host unavailable");
    });
    const notice = vi.fn();
    const notify = createDeploymentNotifications({
      owner: f.owner,
      repair,
      notice,
      reportError: f.reportError
    });
    try {
      notify(execution);
      await vi.advanceTimersByTimeAsync(0);
      expect(execution.state.deployHandoffState).toBe("retryable");
      expect(f.owner.hasPendingWork()).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(repair).toHaveBeenCalledTimes(2);
      f.owner.shutdown();
      expect(f.owner.hasPendingWork()).toBe(false);
      await vi.runAllTimersAsync();
      expect(repair).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      f.owner.shutdown();
    }
  });

  it("reports an observation-owned retry scheduling failure through the retained executor", async () => {
    const f = createDeploymentControllerHarness();
    const execution = f.seed({ deployStatus: "failed" });
    vi.spyOn(execution.observation, "delay").mockRejectedValue(
      new Error("delay unavailable")
    );
    const notify = createDeploymentNotifications({
      owner: f.owner,
      repair: async () => {
        throw new Error("host unavailable");
      },
      notice: vi.fn(),
      reportError: f.reportError
    });
    try {
      notify(execution);
      await vi.waitFor(() =>
        expect(f.reportError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "delay unavailable" })
        )
      );
    } finally {
      f.owner.shutdown();
    }
  });

  it("never delivers or publishes for a retired invocation", () => {
    const f = createDeploymentControllerHarness();
    const execution = f.seed({ deployStatus: "failed" });
    const repair = vi.fn();
    const notice = vi.fn();
    const publish = vi.spyOn(f.owner, "publish");
    const notify = createDeploymentNotifications({
      owner: f.owner,
      repair,
      notice,
      reportError: f.reportError
    });
    f.owner.shutdown();
    notify(execution);
    expect(repair).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
