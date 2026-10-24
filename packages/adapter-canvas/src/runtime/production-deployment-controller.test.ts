import { describe, expect, it } from "vitest";
import { createDeploymentControllerHarness } from "../../test/support/runtime/deployment.js";

function start(fixture: ReturnType<typeof createDeploymentControllerHarness>) {
  return fixture.controller.start({
    data: { targetRepo: "fixture/app", environment: "dev" },
    source: {},
    isCurrent: () => true,
    present: () => {},
    notifications: [fixture.notify]
  });
}

describe("production deployment controller binding", () => {
  it("uses the selected executor for both deployment preconditions and default-branch resolution", async () => {
    const f = createDeploymentControllerHarness();
    try {
      expect(await start(f)).toMatchObject({
        kind: "started",
        execution: { invocation: { target: { branch: "trunk" } } }
      });
      expect(f.run.mock.calls.map(([args]) => args)).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            "api",
            "/repos/fixture/app/environments/dev/variables?per_page=100"
          ]),
          expect.arrayContaining([
            "repo",
            "view",
            "fixture/app",
            "--json",
            "defaultBranchRef"
          ])
        ])
      );
      expect(
        f.run.mock.calls.every(([, options]) => options?.timeout === 30000)
      ).toBe(true);
    } finally {
      f.owner.shutdown();
    }
  });

  it("never starts when the selected account cannot establish remote preconditions", async () => {
    const f = createDeploymentControllerHarness();
    f.run.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "HTTP 403: repository unavailable"
    });
    try {
      expect(await start(f)).toMatchObject({
        kind: "refused",
        message: expect.stringContaining(
          "Could not verify whether this environment"
        )
      });
      expect(f.monitor).not.toHaveBeenCalled();
      expect(f.owner.resolve()).toEqual({ kind: "missing" });
      expect(f.owner.activeReservation(f.target)).toBeUndefined();
    } finally {
      f.owner.shutdown();
    }
  });

  it("reports stopped account selection explicitly without a fallback identity", async () => {
    const f = createDeploymentControllerHarness();
    f.account.mockResolvedValue({ state: "stopped" });
    try {
      expect(await start(f)).toMatchObject({
        kind: "refused",
        message: expect.stringContaining("account selection is stopped")
      });

      expect(f.run).not.toHaveBeenCalled();
    } finally {
      f.owner.shutdown();
    }
  });

  it("preserves the selected account's unavailable diagnostic", async () => {
    const f = createDeploymentControllerHarness();
    f.account.mockResolvedValue({
      state: "unavailable",
      message: "The authorized account cannot access this repository."
    });
    try {
      expect(await start(f)).toMatchObject({
        kind: "refused",
        message: "The authorized account cannot access this repository."
      });
      expect(f.run).not.toHaveBeenCalled();
    } finally {
      f.owner.shutdown();
    }
  });
});
