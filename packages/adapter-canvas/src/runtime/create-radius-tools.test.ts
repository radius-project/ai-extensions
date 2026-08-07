import { describe, expect, it, vi } from "vitest";
import { createRadiusTools } from "./create-radius-tools.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../test/support/runtime/fakes.js";

function findTool(
  tools: ReturnType<typeof createRadiusTools>,
  name: string
): { handler: (args: Record<string, unknown>) => Promise<any> } {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool as unknown as {
    handler: (args: Record<string, unknown>) => Promise<any>;
  };
}

function setup(options?: Parameters<typeof createFakeDependencies>[0]) {
  const fake = createFakeDependencies(options);
  fake.sessionHolder.set(createFakeSession());
  const tools = createRadiusTools(fake.deps);
  return { ...fake, tools };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// RU-07: radius_generate_app analysis/bundled content/standalone fallback.
describe("RU-07: radius_generate_app", () => {
  it("delegates to the injected skill with the given repoPath", async () => {
    const { tools, deps } = setup();
    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/some/repo"
    });
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith("/some/repo");
    expect(result).toBe("SKILL.md content for /some/repo");
  });

  it("falls back to a standalone invocation when repoPath is omitted", async () => {
    const { tools, deps } = setup();
    const result = await findTool(tools, "radius_generate_app").handler({});
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(undefined);
    expect(result).toBe("SKILL.md content for .");
  });
});

// RU-08: PR diff mapping/fetch failure/markdown.
describe("RU-08: radius_generate_pr_diff_markdown", () => {
  it("reports missing app.bicep on both branches without calling rad", async () => {
    const { tools, deps } = setup();
    const result = await findTool(
      tools,
      "radius_generate_pr_diff_markdown"
    ).handler({ repo: "acme/widgets", baseBranch: "main", headBranch: "feat" });
    expect(result).toContain("does not exist on main or feat yet");
    expect(deps.rad.buildGraphViaRad).not.toHaveBeenCalled();
  });

  it("computes the diff and renders PR-embeddable markdown when bicep exists on both branches", async () => {
    const { tools, deps } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}\nresource cache {}"
      }
    });
    (deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([{ id: "db", name: "db", type: "x" }])
      .mockResolvedValueOnce([
        { id: "db", name: "db", type: "x" },
        { id: "cache", name: "cache", type: "x" }
      ]);
    const result = await findTool(
      tools,
      "radius_generate_pr_diff_markdown"
    ).handler({ repo: "acme/widgets", baseBranch: "main", headBranch: "feat" });
    expect(result).toContain("Application Graph Diff");
    expect(result).toContain("main");
    expect(result).toContain("feat");
  });

  it("maps a fetch/build failure to a friendly warning instead of throwing", async () => {
    const { tools, deps } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}"
      }
    });
    (deps.rad.buildGraphViaRad as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("rad exploded")
    );
    const result = await findTool(
      tools,
      "radius_generate_pr_diff_markdown"
    ).handler({ repo: "acme/widgets", baseBranch: "main", headBranch: "feat" });
    expect(result).toContain("Could not generate app graph diff");
    expect(result).toContain("rad exploded");
  });
});

// RU-09: publish custom extension confinement/defaults/invoke/errors.
describe("RU-09: radius_publish_custom_type_extension", () => {
  it("reports a missing manifest without invoking rad", async () => {
    const { tools, deps } = setup();
    (deps.process.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(
      false
    );
    const result = await findTool(
      tools,
      "radius_publish_custom_type_extension"
    ).handler({});
    expect(result).toContain("Resource-type manifest not found at");
    expect(deps.rad.runRadBicepPublishExtension).not.toHaveBeenCalled();
  });

  it("defaults manifestPath/targetPath and publishes via the injected rad dependency", async () => {
    const { tools, deps } = setup();
    const result = await findTool(
      tools,
      "radius_publish_custom_type_extension"
    ).handler({});
    expect(
      deps.publishTargets.resolveExistingRadiusArtifact
    ).toHaveBeenCalledWith(
      "/workspace",
      undefined,
      ".radius/custom-types.yaml"
    );
    expect(
      deps.publishTargets.resolveRadiusArtifactTarget
    ).toHaveBeenCalledWith("/workspace", undefined, ".radius/custom-types.tgz");
    expect(deps.rad.runRadBicepPublishExtension).toHaveBeenCalledOnce();
    expect(result).toContain("Published custom-type extension to");
  });

  it("confines paths under the workspace .radius directory (propagates a confinement error)", async () => {
    const { tools, deps } = setup();
    (
      deps.publishTargets.resolveExistingRadiusArtifact as ReturnType<
        typeof vi.fn
      >
    ).mockImplementation(() => {
      throw new Error(
        "Path escapes the workspace .radius directory: ../../etc/passwd"
      );
    });
    const result = await findTool(
      tools,
      "radius_publish_custom_type_extension"
    ).handler({ manifestPath: "../../etc/passwd" });
    expect(result).toContain("Could not publish the custom-type extension");
    expect(result).toContain("escapes the workspace");
  });

  it("surfaces a publish failure as a friendly warning", async () => {
    const { tools, deps } = setup();
    (
      deps.rad.runRadBicepPublishExtension as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("rad bicep publish-extension failed"));
    const result = await findTool(
      tools,
      "radius_publish_custom_type_extension"
    ).handler({});
    expect(result).toContain("Could not publish the custom-type extension");
    expect(result).toContain("rad bicep publish-extension failed");
  });
});

// RU-10: publish recipe confinement/GHCR/errors.
describe("RU-10: radius_publish_recipe", () => {
  it("rejects a target that does not publish under the workspace repo", async () => {
    const { tools, deps } = setup();
    (
      deps.publishTargets.validateGhcrTargetForRepo as ReturnType<typeof vi.fn>
    ).mockReturnValue(
      "The recipe target must publish under the repository being modeled."
    );
    const result = await findTool(tools, "radius_publish_recipe").handler({
      file: ".radius/recipe.bicep",
      target: "br:ghcr.io/other/repo/recipe:v1"
    });
    expect(result).toContain("must publish under the repository");
    expect(deps.withGhcrDockerConfig).not.toHaveBeenCalled();
  });

  it("reports a missing recipe file without invoking GHCR", async () => {
    const { tools, deps } = setup();
    (deps.process.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(
      false
    );
    const result = await findTool(tools, "radius_publish_recipe").handler({
      file: ".radius/recipe.bicep",
      target: "br:ghcr.io/acme/widgets/recipe:v1"
    });
    expect(result).toContain("Recipe file not found at");
    expect(deps.withGhcrDockerConfig).not.toHaveBeenCalled();
  });

  it("publishes through withGhcrDockerConfig and reports the published target", async () => {
    const { tools, deps } = setup();
    const result = await findTool(tools, "radius_publish_recipe").handler({
      file: ".radius/recipe.bicep",
      target: "br:ghcr.io/acme/widgets/recipe:v1"
    });
    expect(deps.withGhcrDockerConfig).toHaveBeenCalledOnce();
    expect(deps.rad.runRadBicepPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        file: expect.any(String),
        target: "br:ghcr.io/acme/widgets/recipe:v1",
        env: { DOCKER_CONFIG: "/tmp/fake-docker-config" }
      })
    );
    expect(result).toContain("Published recipe to");
  });

  it("surfaces a publish failure as a friendly warning", async () => {
    const { tools, deps } = setup();
    (deps.rad.runRadBicepPublish as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("denied: permission_denied")
    );
    const result = await findTool(tools, "radius_publish_recipe").handler({
      file: ".radius/recipe.bicep",
      target: "br:ghcr.io/acme/widgets/recipe:v1"
    });
    expect(result).toContain("Could not publish the recipe");
    expect(result).toContain("permission_denied");
  });
});

// RU-11: deploy identity/mapping/dispatch/repeat/failure.
describe("RU-11: radius_deploy", () => {
  it("reports there is nothing to deploy when no canvas session is open", async () => {
    const { tools } = setup();
    const result = await findTool(tools, "radius_deploy").handler({});
    expect(result).toContain("No Radius canvas session is open");
  });

  it("reports an inactive attempt when attemptId does not match any open instance", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:0",
      url: "http://127.0.0.1:0/?page=deployed",
      page: "deployed",
      state: { deployAttempt: { id: "attempt-A", targetRepo: "acme/widgets" } }
    });
    const result = await findTool(tools, "radius_deploy").handler({
      attemptId: "attempt-B"
    });
    expect(result).toContain('"attempt-B"');
    expect(result).toContain("no longer active");
  });

  it("dispatches the deploy via fetch and reports the started message, identifying repo/branch/environment", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({})
    );
    const result = await findTool(tools, "radius_deploy").handler({
      repo: "acme/widgets",
      environment: "production",
      branch: "main",
      provider: "azure"
    });
    expect(deps.deploy.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/api/deploy",
      expect.objectContaining({ method: "POST" })
    );
    expect(result).toContain("acme/widgets");
    expect(result).toContain("production");
    expect(result).toContain("started");
  });

  it("repeats the last deploy from this session when called with no arguments", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {
        deployParams: {
          targetRepo: "acme/widgets",
          environment: "production",
          branch: "main",
          provider: "azure",
          appFile: ".radius/app.bicep"
        },
        deployStartedAt: Date.now()
      }
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({})
    );
    await findTool(tools, "radius_deploy").handler({});
    const body = JSON.parse(
      (deps.deploy.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body
    );
    expect(body.targetRepo).toBe("acme/widgets");
    expect(body.environment).toBe("production");
  });

  it("surfaces a dispatch failure returned by the server as a friendly warning", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ error: "workflow dispatch failed" }, 500)
    );
    const result = await findTool(tools, "radius_deploy").handler({
      repo: "acme/widgets",
      environment: "production"
    });
    expect(result).toContain("Could not start the deploy");
    expect(result).toContain("workflow dispatch failed");
  });
});

// RU-12: deploy status/log bounds/URL/diagnostics.
describe("RU-12: radius_deploy_status", () => {
  it("reports no deploy status when no canvas session is open", async () => {
    const { tools } = setup();
    const result = await findTool(tools, "radius_deploy_status").handler({});
    expect(result).toContain("no deploy status to report");
  });

  it("reports the workflow run URL and a bounded log tail on failure", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    const logs = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({
        status: "failed",
        error: "deploy failed",
        deployRunUrl: "https://github.com/acme/widgets/actions/runs/1",
        logs
      })
    );
    const result = await findTool(tools, "radius_deploy_status").handler({});
    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("failed");
    expect(parsed.deployRunUrl).toBe(
      "https://github.com/acme/widgets/actions/runs/1"
    );
    expect(parsed.diagnostic).toContain("line 299");
    // Default tail cap is 40 lines — "line 259" is the 40th-from-end line.
    expect(parsed.diagnostic).toContain("line 260");
    expect(parsed.diagnostic).not.toContain("line 259\n");
  });

  it("honors a custom logLines count bounded to the max", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    const logs = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ status: "failed", error: "x", logs })
    );
    const result = await findTool(tools, "radius_deploy_status").handler({
      logLines: 999
    });
    const parsed = JSON.parse(result);
    // capped at DEPLOY_LOG_TAIL_MAX (200)
    expect(parsed.diagnostic).toContain("line 100");
    expect(parsed.diagnostic).not.toContain("line 99\n");
  });

  it("reports a read failure as a friendly warning", async () => {
    const { tools, deps } = setup();
    deps.servers.set("radius-panel", {
      server: { close: vi.fn((cb?: () => void) => cb?.()) } as never,
      baseUrl: "http://127.0.0.1:9999",
      url: "http://127.0.0.1:9999/?page=deployed",
      page: "deployed",
      state: {}
    });
    (deps.deploy.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({}, 500)
    );
    const result = await findTool(tools, "radius_deploy_status").handler({});
    expect(result).toContain("Could not read the deploy status");
    expect(result).toContain("HTTP 500");
  });
});
