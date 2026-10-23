import { describe, expect, it } from "vitest";
import {
  createDeploymentControllerHarness,
  createDeploymentPipelineRunner
} from "./deployment.js";

describe("deployment controller fixture", () => {
  it("completes one real admission and releases its reservation", async () => {
    const fixture = createDeploymentControllerHarness();
    try {
      const result = await fixture.controller.start({
        data: { ...fixture.target, targetRepo: fixture.target.repo },
        source: {},
        isCurrent: () => true,
        present: () => {},
        notifications: [fixture.notify]
      });
      expect(result.kind).toBe("started");
      await expect.poll(() => fixture.monitor.mock.calls.length).toBe(1);
      await expect
        .poll(() => fixture.owner.activeReservation(fixture.target))
        .toBeUndefined();
      expect(fixture.owner.resolve()).toMatchObject({ kind: "resolved" });
      expect(fixture.notify).toHaveBeenCalledOnce();
      expect(fixture.reportError).not.toHaveBeenCalled();
    } finally {
      fixture.owner.shutdown();
    }
  });

  it("isolates seeded attempts and rejects unscripted commands", async () => {
    const first = createDeploymentControllerHarness();
    const second = createDeploymentControllerHarness();
    try {
      const seeded = first.seed({ deployStatus: "failed" });
      expect(first.owner.snapshot(seeded.invocation)?.deployStatus).toBe(
        "failed"
      );
      expect(second.owner.resolve()).toEqual({ kind: "missing" });
      await expect(first.run(["unexpected"])).rejects.toThrow(
        "Unscripted GitHub command"
      );
      expect(first.owner.activeReservation(first.target)).toBeUndefined();
      first.owner.shutdown();
      expect(() => first.seed()).toThrow("Could not reserve fixture target.");
    } finally {
      first.owner.shutdown();
      second.owner.shutdown();
    }
  });
});

describe("selected deployment pipeline fixture", () => {
  it("models current workflows and no secure parameters without accepting writes", async () => {
    const fixture = createDeploymentPipelineRunner("success", {
      existingEnvironment: true
    });
    const source = JSON.parse(
      (
        await fixture.run([
          "api",
          "/repos/fixture/app/contents/app.bicep?ref=trunk"
        ])
      ).stdout
    );
    expect(Buffer.from(source.content, "base64").toString()).not.toContain(
      "@secure"
    );
    const workflow = JSON.parse(
      (
        await fixture.run([
          "api",
          "/repos/fixture/app/contents/.github/workflows/run-rad-commands.yml?ref=trunk"
        ])
      ).stdout
    );
    expect(Buffer.from(workflow.content, "base64").toString()).toContain(
      "workflow_dispatch"
    );
    await expect(
      fixture.run([
        "api",
        "--method",
        "PUT",
        "/repos/fixture/app/contents/workflow"
      ])
    ).rejects.toThrow("forbids workflow writes");
    await expect(
      fixture.run(["api", "/repos/fixture/app/environments/dev/secrets"])
    ).rejects.toThrow("forbids secret reads");
    await expect(
      fixture.run(["secret", "set", "--repo", "fixture/app"], {
        stdin: "value"
      })
    ).rejects.toThrow("forbids secret writes");
  });
  it("fails and records commands outside the scripted repository", async () => {
    const fixture = createDeploymentPipelineRunner("success");
    const command = ["api", "/repos/another/app"];
    await expect(fixture.run(command)).rejects.toThrow("Unexpected command");
    expect(fixture.unexpected).toEqual([command]);
  });

  it("isolates run visibility and secret state between harness instances", async () => {
    const first = createDeploymentPipelineRunner("success");
    const second = createDeploymentPipelineRunner("success");
    const list = ["run", "list", "--repo", "fixture/app"];
    const secrets = ["api", "/repos/fixture/app/environments/dev/secrets"];
    expect(JSON.parse((await first.run(list)).stdout)).toEqual([]);
    await first.run(["workflow", "run", "--repo", "fixture/app"]);
    await first.run(["secret", "set", "--repo", "fixture/app"], {
      stdin: "fixture-input"
    });
    expect(JSON.parse((await first.run(list)).stdout)).toEqual([
      expect.objectContaining({ databaseId: 42, conclusion: "success" })
    ]);
    expect(JSON.parse((await first.run(secrets)).stdout)).toEqual([
      { secrets: [{ name: "RADIUS_DEPLOY_PARAMS" }] }
    ]);
    expect(JSON.parse((await second.run(list)).stdout)).toEqual([]);
    expect(JSON.parse((await second.run(secrets)).stdout)).toEqual([
      { secrets: [] }
    ]);
    expect(first.unexpected).toEqual([]);
    expect(second.unexpected).toEqual([]);
  });

  it("rejects unspecified workflow templates rather than reaching the network", async () => {
    const fixture = createDeploymentPipelineRunner("success");
    await expect(
      fixture.run([
        "api",
        "/repos/radius-project/ai-extensions/contents/.github/extension/missing.yml"
      ])
    ).rejects.toThrow("Unscripted template missing.yml");
  });
});
