import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/support/browser/fakes.js";
import { createDeploymentToolHarness } from "../../test/support/runtime/deployment.js";

describe("typed deployment execution controller", () => {
  it("rechecks ownership when shutdown interleaves with completion of the admitted default-branch read", async () => {
    const f = createDeploymentToolHarness();
    const branch = createDeferred<{
      code: number;
      stdout: string;
      stderr: string;
    }>();
    const admission = f.run.getMockImplementation();
    if (!admission) throw new Error("Missing admission fixture");
    let readingBranch = false;
    f.run.mockImplementation((args, options) => {
      if (args[0] === "repo") {
        readingBranch = true;
        return branch.promise;
      }
      return admission(args, options);
    });
    const starting = f.controller.start({
      data: { targetRepo: "fixture/app", environment: "dev" },
      source: {},
      isCurrent: () => true,
      present: vi.fn(),
      notifications: []
    });
    try {
      await vi.waitFor(() => expect(readingBranch).toBe(true));
      // Let the selected command and branch projection settle, then retire
      // before the awaiting controller can consume core's admission result.
      const retiring = branch.promise.then(() =>
        queueMicrotask(() => queueMicrotask(() => f.owner.shutdown()))
      );
      branch.resolve({ code: 0, stdout: "trunk", stderr: "" });
      expect(await starting).toMatchObject({
        kind: "refused",
        message: "The deployment context changed during admission."
      });
      await retiring;
      expect(f.monitor).not.toHaveBeenCalled();
      expect(f.owner.activeReservation(f.target)).toBeUndefined();
    } finally {
      branch.resolve({ code: 0, stdout: "trunk", stderr: "" });
      f.tools.shutdown();
    }
  });

  it("releases admission and refuses success if presentation retires the runtime before launch", async () => {
    const f = createDeploymentToolHarness();
    try {
      expect(
        await f.controller.start({
          data: {
            targetRepo: "fixture/app",
            environment: "dev",
            branch: "feature/model"
          },
          source: {},
          isCurrent: () => true,
          present: () => f.owner.shutdown(),
          notifications: []
        })
      ).toMatchObject({
        kind: "refused",
        message: expect.stringContaining("before its monitor")
      });
      expect(f.monitor).not.toHaveBeenCalled();
      expect(f.owner.activeReservation(f.target)).toBeUndefined();
    } finally {
      f.tools.shutdown();
    }
  });
  it("reserves before account selection and returns one owned execution without a transport or presentation", async () => {
    const f = createDeploymentToolHarness();
    const selected = createDeferred<void>();
    const finished = createDeferred<void>();
    f.account.mockImplementation(async () => {
      expect(f.owner.activeReservation(f.target)).toMatchObject({
        kind: "deploy"
      });
      await selected.promise;
      return {
        state: "selected",
        login: f.executor.login,
        executor: f.executor
      };
    });
    f.monitor.mockImplementation(() => finished.promise);
    const present = vi.fn();
    const notify = vi.fn();
    const starting = f.controller.start({
      data: {
        targetRepo: f.target.repo,
        environment: f.target.environment,
        branch: f.target.branch
      },
      source: {},
      isCurrent: () => true,
      present,
      notifications: [notify]
    });
    try {
      expect(f.owner.resolve()).toEqual({ kind: "missing" });
      selected.resolve();
      const result = await starting;
      expect(result.kind).toBe("started");
      if (result.kind !== "started") throw new Error(result.message);
      expect(present).toHaveBeenCalledExactlyOnceWith(result.execution);
      expect(f.owner.execution(result.execution.invocation)).toBe(
        result.execution
      );
      expect(f.owner.activeReservation(f.target)).toBeDefined();
      expect(notify).not.toHaveBeenCalled();
      finished.resolve();
      await vi.waitFor(() =>
        expect(f.owner.activeReservation(f.target)).toBeUndefined()
      );
      expect(notify).toHaveBeenCalledExactlyOnceWith(result.execution);
    } finally {
      selected.resolve();
      finished.resolve();
      f.tools.shutdown();
    }
  });

  it("refuses a retired caller after account admission without starting a monitor", async () => {
    const f = createDeploymentToolHarness();
    let current = true;
    f.account.mockImplementation(async () => {
      current = false;
      return {
        state: "selected",
        login: f.executor.login,
        executor: f.executor
      };
    });
    try {
      const result = await f.controller.start({
        data: {
          targetRepo: "fixture/app",
          environment: "dev",
          branch: "feature/model"
        },
        source: {},
        isCurrent: () => current,
        present: vi.fn(),
        notifications: []
      });
      expect(result).toMatchObject({
        kind: "refused",
        reason: "invalid",
        message: "The deployment context changed during admission."
      });
      expect(f.monitor).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
      expect(f.owner.activeReservation(f.target)).toBeUndefined();
    } finally {
      f.tools.shutdown();
    }
  });

  it.each(["synchronous", "asynchronous"])(
    "settles a monitor exception as unconfirmed despite a %s callback failure",
    async (mode) => {
      const f = createDeploymentToolHarness();
      f.monitor.mockRejectedValue(new Error("observation unavailable"));
      const broken = vi.fn(() => {
        if (mode === "asynchronous")
          return Promise.reject(new Error("host unavailable"));
        throw new Error("host unavailable");
      });
      const notice = vi.fn();
      try {
        const result = await f.controller.start({
          data: {
            targetRepo: "fixture/app",
            environment: "dev",
            branch: "feature/model"
          },
          source: {},
          isCurrent: () => true,
          present: vi.fn(),
          notifications: [broken, notice]
        });
        expect(result.kind).toBe("started");
        if (result.kind !== "started") throw new Error(result.message);
        await vi.waitFor(() =>
          expect(f.owner.activeReservation(f.target)).toBeUndefined()
        );
        expect(result.execution.state).toMatchObject({
          deployStatus: "failed",
          deployErrorKind: "run-unconfirmed",
          deployError: expect.stringContaining("observation unavailable")
        });
        expect(notice).toHaveBeenCalledOnce();
        expect(f.reportError).toHaveBeenCalledWith(
          expect.objectContaining({ message: "host unavailable" })
        );
      } finally {
        f.tools.shutdown();
      }
    }
  );
});
