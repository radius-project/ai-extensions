import { describe, expect, it } from "vitest";
import { createDeploymentToolHarness } from "../../test/support/runtime/deployment.js";

describe("production deployment controller binding", () => {
  it("uses the selected executor for both deployment preconditions and default-branch resolution", async () => {
    const f = createDeploymentToolHarness();
    try {
      expect(
        await f.tools.start({ repo: "fixture/app", environment: "dev" })
      ).toContain("branch trunk");
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
      f.tools.shutdown();
    }
  });

  it("never starts when the selected account cannot establish remote preconditions", async () => {
    const f = createDeploymentToolHarness();
    f.run.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "HTTP 403: repository unavailable"
    });
    try {
      expect(
        await f.tools.start({ repo: "fixture/app", environment: "dev" })
      ).toContain("Could not verify whether this environment");
      expect(f.monitor).not.toHaveBeenCalled();
      expect(f.owner.resolve()).toEqual({ kind: "missing" });
      expect(f.owner.activeReservation(f.target)).toBeUndefined();
    } finally {
      f.tools.shutdown();
    }
  });

  it("reports stopped account selection explicitly without a fallback identity", async () => {
    const f = createDeploymentToolHarness();
    f.account.mockResolvedValue({ state: "stopped" });
    try {
      expect(
        await f.tools.start({ repo: "fixture/app", environment: "dev" })
      ).toContain("account selection is stopped");
      expect(f.run).not.toHaveBeenCalled();
    } finally {
      f.tools.shutdown();
    }
  });
});
