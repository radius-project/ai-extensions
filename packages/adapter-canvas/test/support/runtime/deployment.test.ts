import { describe, expect, it } from "vitest";
import { createDeploymentPipelineRunner } from "./deployment.js";

describe("selected deployment pipeline fixture", () => {
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
