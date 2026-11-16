import { describe, expect, it, vi } from "vitest";
import { prepareDeploymentCleanup } from "./deployment-cleanup-details.js";
import type { DeploymentRow } from "./deployment-resolver.js";

const selection = {
  runId: 42,
  runAttempt: 1,
  deploymentId: "3",
  runUrl: "https://github.com/octo/app/actions/runs/42"
};
const row: DeploymentRow = {
  app: "",
  environment: "dev",
  provider: "azure",
  status: "failed",
  deploymentId: selection.deploymentId,
  runUrl: selection.runUrl,
  identity: { state: "unavailable", reason: "Artifacts expired." },
  recovery: {
    ...selection,
    revision: "a".repeat(64),
    deploymentIds: ["3", "2"],
    confirmation: "octo/app/run-42@1/dev",
    canMarkCleanupComplete: true
  }
};
const target = { repo: "octo/app", environment: "dev" };

function dependencies(current: DeploymentRow | null = row) {
  return {
    isValidRepoSlug: (value: unknown) => value === target.repo,
    resolveEnvDeployment: vi.fn(async () => current)
  };
}

describe("cleanup preparation", () => {
  it("only enables confirmation for the freshly resolved selected current run", async () => {
    const h = dependencies();
    expect(
      await prepareDeploymentCleanup({ ...target, ...selection }, h)
    ).toEqual({
      status: 200,
      body: { deployment: row, selection, prepared: true }
    });
    expect(h.resolveEnvDeployment).toHaveBeenCalledWith("octo/app", "dev", "");
  });

  it.each([null, row])(
    "discovers current history without issuing confirmation authority",
    async (current) => {
      const result = await prepareDeploymentCleanup(
        target,
        dependencies(current)
      );
      expect(result.status).toBe(200);
      expect(result.body.prepared).toBe(false);
      if (current)
        expect(result.body.deployment).not.toHaveProperty("recovery");
      else expect(result.body.deployment).toBeNull();
    }
  );

  it.each([
    null,
    [],
    "",
    {},
    { repo: "../wrong", environment: "dev" },
    { ...target, environment: " " }
  ])("rejects malformed target %j before reading history", async (payload) => {
    const h = dependencies();
    expect((await prepareDeploymentCleanup(payload, h)).status).toBe(400);
    expect(h.resolveEnvDeployment).not.toHaveBeenCalled();
  });

  it.each([
    { runId: 42 },
    { runAttempt: 1 },
    { deploymentId: "3" },
    { runUrl: selection.runUrl },
    { ...selection, runId: 0 },
    { ...selection, runId: "42" },
    { ...selection, runId: 1.5 },
    { ...selection, runAttempt: 0 },
    { ...selection, runAttempt: "1" },
    { ...selection, runAttempt: 1.5 },
    { ...selection, deploymentId: 3 },
    { ...selection, deploymentId: " " },
    { ...selection, runUrl: 42 },
    { ...selection, runUrl: " " }
  ])(
    "rejects an incomplete or malformed selection %j before reading",
    async (selected) => {
      const h = dependencies();
      expect(
        (await prepareDeploymentCleanup({ ...target, ...selected }, h)).status
      ).toBe(400);
      expect(h.resolveEnvDeployment).not.toHaveBeenCalled();
    }
  );

  it.each([
    { runId: 41 },
    { runAttempt: 2 },
    { deploymentId: "other" },
    { runUrl: "https://github.com/other/app/actions/runs/42" }
  ])("rejects stale selection %j", async (changed) => {
    expect(
      (
        await prepareDeploymentCleanup(
          { ...target, ...selection, ...changed },
          dependencies()
        )
      ).status
    ).toBe(409);
  });

  it.each(["newer", "active", "absence"] as const)(
    "refuses a selection when fresh history reports %s",
    async (change) => {
      const current =
        change === "absence" ? null
        : change === "active" ?
          { ...row, recovery: undefined, status: "pending" }
        : { ...row, runUrl: "https://github.com/octo/app/actions/runs/43" };
      expect(
        (
          await prepareDeploymentCleanup(
            { ...target, ...selection },
            dependencies(current)
          )
        ).status
      ).toBe(409);
    }
  );

  it("surfaces incomplete or unavailable evidence without a success-shaped empty result", async () => {
    const h = dependencies();
    h.resolveEnvDeployment.mockRejectedValue(new Error("read budget"));
    expect(await prepareDeploymentCleanup(target, h)).toMatchObject({
      status: 503,
      body: { error: expect.stringContaining("could not be verified") }
    });
  });

  it("reports a non-Error history failure explicitly", async () => {
    const h = dependencies();
    h.resolveEnvDeployment.mockRejectedValue("GitHub rate limit");
    expect(await prepareDeploymentCleanup(target, h)).toMatchObject({
      status: 503,
      body: { error: expect.stringContaining("GitHub rate limit") }
    });
  });
});
