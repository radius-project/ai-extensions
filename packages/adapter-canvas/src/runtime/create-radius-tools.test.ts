import { describe, expect, it, vi } from "vitest";
import {
  UNIDENTIFIED_APPLICATION_MESSAGE,
  UNSUPPORTED_NO_DOCKERFILE_MESSAGE
} from "@radius-project/core";
import { createRadiusTools } from "./create-radius-tools.js";
import {
  createMissingModelHandoffClaims,
  missingModelHandoffTarget
} from "./missing-model-handoff-claims.js";
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
  const modelingActivity = {
    announce: vi.fn(),
    release: vi.fn(),
    inFlight: vi.fn(async () => false)
  };
  const missingModelHandoffs = createMissingModelHandoffClaims(() =>
    Date.now()
  );
  const tools = createRadiusTools(
    fake.deps,
    modelingActivity,
    missingModelHandoffs
  );
  return { ...fake, tools, modelingActivity, missingModelHandoffs };
}

function parseSkillHandoff(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error("Expected the skill handoff to be JSON text.");
  }
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected the skill handoff to be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function expectSkillHandoff(
  value: unknown,
  repoPath: string,
  brief?: string
): void {
  const handoff = parseSkillHandoff(value);
  expect(handoff).toMatchObject({
    skill: "radius-app-bicep",
    repoPath,
    skillBase: "/test/skills/radius-app-bicep",
    skillVersion: "0.1.0-test",
    instruction: `SKILL.md content for ${repoPath}`
  });
  if (brief === undefined) expect(handoff).not.toHaveProperty("brief");
  else expect(handoff.brief).toBe(brief);
}

function skillBrief(value: unknown): string {
  const brief = parseSkillHandoff(value).brief;
  return typeof brief === "string" ? brief : "";
}

// RU-07: radius_generate_app analysis and compact skill bootstrap.
describe("RU-07: radius_generate_app", () => {
  it("delegates to the injected skill with the given repoPath", async () => {
    const { tools, deps } = setup();
    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/some/repo"
    });
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "/some/repo",
      undefined
    );
    expectSkillHandoff(result, "/some/repo");
  });

  it("falls back to a standalone invocation when repoPath is omitted", async () => {
    const { tools, deps } = setup();
    const result = await findTool(tools, "radius_generate_app").handler({});
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(undefined, undefined);
    expectSkillHandoff(result, ".");
  });

  it("withholds the skill and reports the unsupported repository when it has no Dockerfile", async () => {
    const { tools, deps } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(result).toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);
    expect(result).toContain("acme/widgets");
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });

  it("hands over the skill when the repository has a Dockerfile", async () => {
    const { tools, deps } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "services/api/Dockerfile"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expectSkillHandoff(result, "/workspace");
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "/workspace",
      undefined
    );
  });

  it("announces the run it is about to start, so a graph render defers instead of asking for it again", async () => {
    const { tools, modelingActivity } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "services/api/Dockerfile"]
      }
    });

    await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(modelingActivity.announce).toHaveBeenCalledWith({
      repo: "acme/widgets",
      branch: "main"
    });
  });

  it("does not announce a repository-wide wildcard when the workspace branch is unresolved", async () => {
    const { tools, modelingActivity } = setup({
      workspaceContext: {
        workspacePath: "/workspace",
        repo: "acme/widgets",
        branch: ""
      }
    });

    await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });

  it("announces the run when the agent is briefed about several candidate directories", async () => {
    const { tools, modelingActivity } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": [
          "services/api/Dockerfile",
          "services/web/Dockerfile"
        ]
      }
    });

    await findTool(tools, "radius_generate_app").handler({});

    expect(modelingActivity.announce).toHaveBeenCalledWith({
      repo: "acme/widgets",
      branch: "main"
    });
  });

  it("announces nothing for a repository it refuses to model", async () => {
    const { tools, modelingActivity } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });

  it("announces nothing when the workspace context cannot be resolved", async () => {
    const { tools, deps, modelingActivity } = setup();
    (
      deps.workspace.detectWorkspaceContext as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("no session"));

    await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });

  it("hands over the skill when the repository cannot be listed", async () => {
    const { tools, deps } = setup();
    (
      deps.workspace.fetchWorkspaceTree as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("permission denied"));

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expectSkillHandoff(result, "/workspace");
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "/workspace",
      undefined
    );
  });

  it("hands over the skill when the workspace context cannot be resolved", async () => {
    const { tools, deps } = setup();
    (
      deps.workspace.detectWorkspaceContext as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("no session"));

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expectSkillHandoff(result, "/workspace");
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "/workspace",
      undefined
    );
  });

  it("hands over the skill when deciding which listing to use throws", async () => {
    const { tools, deps } = setup();
    (
      deps.workspace.isWorkspaceSelection as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(() => {
      throw new Error("selection unavailable");
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expectSkillHandoff(result, "/workspace");
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "/workspace",
      undefined
    );
  });

  // Without a repository the worktree predicate is fail-closed, so nothing can
  // be listed and no verdict is available. The gate must hand over the skill
  // rather than refuse, and must not spend a doomed remote lookup to get there.
  it("hands over the skill, without listing, when the workspace has no repo context", async () => {
    const { tools, deps } = setup({
      workspaceContext: { workspacePath: "/workspace", repo: "", branch: "" }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expectSkillHandoff(result, "/workspace");
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "/workspace",
      undefined
    );
    expect(deps.github.treePaths).not.toHaveBeenCalled();
    expect(deps.workspace.fetchWorkspaceTree).not.toHaveBeenCalled();
  });

  // A sibling whose name merely starts with the workspace root is not inside
  // it, and neither is a path that walks back out of it.
  it.each([
    ["a sibling with a shared prefix", "/workspace-other"],
    ["a path that escapes upward", "/workspace/../elsewhere"]
  ])("does not gate %s", async (_label, repoPath) => {
    const { tools, deps } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath
    });

    expectSkillHandoff(result, repoPath);
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(repoPath, undefined);
  });

  // The listing the check can obtain describes the workspace, so it is not
  // evidence about some other directory the caller named.
  it("does not refuse a target outside the workspace on the workspace's contents", async () => {
    const { tools, deps, modelingActivity } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/elsewhere/other-repo"
    });

    expectSkillHandoff(result, "/elsewhere/other-repo");
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "/elsewhere/other-repo",
      undefined
    );
    expect(modelingActivity.announce).not.toHaveBeenCalled();
  });

  it.each([
    ["a trailing slash", "/workspace/"],
    ["Windows separators", "\\workspace"],
    ["a dot form", "/workspace/."],
    ["a subdirectory", "/workspace/services/api"],
    ["a nested dot form", "/workspace/services/../services/api"]
  ])("still gates the workspace named with %s", async (_label, repoPath) => {
    const { tools, deps } = setup({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath
    });

    expect(result).toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });

  it("does not gate when the workspace path itself is unknown", async () => {
    const { tools, deps } = setup({
      workspaceContext: {
        workspacePath: "",
        repo: "acme/widgets",
        branch: "main"
      },
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });

    expectSkillHandoff(result, "/workspace");
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "/workspace",
      undefined
    );
  });
});

// RU-07b: several Dockerfiles brief the agent without refusing to model.
describe("RU-07b: radius_generate_app with several Dockerfiles", () => {
  const MICROSERVICES = [
    "services/api/Dockerfile",
    "services/web/Dockerfile",
    "services/worker/Dockerfile",
    "pnpm-workspace.yaml"
  ];

  async function generateFor(paths: string[], repoPath = "/workspace") {
    const { tools, deps } = setup({
      workspaceTreeByRepoBranch: { "acme/widgets@main": paths }
    });
    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath
    });
    return { result: String(result), deps };
  }

  // The central regression: a microservices repository is ONE application, so
  // several Dockerfiles must never withhold the skill or trigger the question.
  it("still hands over the full skill so the services are modeled as one application", async () => {
    const { result, deps } = await generateFor(MICROSERVICES);
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "/workspace",
      expect.any(String)
    );
    expectSkillHandoff(
      result,
      "/workspace",
      String(parseSkillHandoff(result).brief)
    );
    expect(result).not.toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);
  });

  it("does not instruct the agent to ask merely because there are several", async () => {
    const { result } = await generateFor(MICROSERVICES);
    expect(skillBrief(result)).toContain("ONE application");
    expect(skillBrief(result)).toMatch(/Ask the user only if/);
  });

  it("includes the candidate directories it found in the brief field", async () => {
    const { result } = await generateFor(MICROSERVICES);
    expect(skillBrief(result)).toContain("`services/api`");
    expect(skillBrief(result)).toContain("`services/web`");
    expect(skillBrief(result)).toContain("`services/worker`");
  });

  it("carries the specified question for the case where no application can be identified", async () => {
    const { result } = await generateFor(MICROSERVICES);
    expect(skillBrief(result)).toContain(UNIDENTIFIED_APPLICATION_MESSAGE);
  });

  it("reports the workspace manifest it found", async () => {
    const { result } = await generateFor(MICROSERVICES);
    expect(skillBrief(result)).toContain("`pnpm-workspace.yaml`");
  });

  // The user's answer to the question comes back as repoPath naming a
  // subdirectory. That is not the workspace, so the evidence gate skips the
  // block entirely and the question cannot be re-asked after being answered.
  it("says nothing more once the user has answered with a directory", async () => {
    const { result, deps } = await generateFor(MICROSERVICES, "services/api");
    expect(deps.radiusAppBicepSkill).toHaveBeenCalledWith(
      "services/api",
      undefined
    );
    expectSkillHandoff(result, "services/api");
  });

  // Acceptance criterion 3 of #437: the answer scopes the next analysis to that
  // directory, which means the question must not be posed a second time.
  it("says nothing more for an absolute path inside the workspace either", async () => {
    const { result } = await generateFor(
      MICROSERVICES,
      "/workspace/services/api"
    );
    expect(parseSkillHandoff(result)).not.toHaveProperty("brief");
  });

  it("does not re-ask when the answer is a dot-relative path inside the tree", async () => {
    const { result } = await generateFor(
      MICROSERVICES,
      "/workspace/./services/api"
    );
    expect(parseSkillHandoff(result)).not.toHaveProperty("brief");
  });

  it("still refuses a scoped answer when the whole tree has no Dockerfile", async () => {
    // The refusal survives the scope check: a tree with no Dockerfile has none
    // in the named subdirectory either, so 2.1's evidence still applies.
    const { result, deps } = await generateFor(
      ["src/index.ts", "package.json"],
      "/workspace/services/api"
    );
    expect(result).toContain(UNSUPPORTED_NO_DOCKERFILE_MESSAGE);
    expect(deps.radiusAppBicepSkill).not.toHaveBeenCalled();
  });

  it("still briefs for a location outside the worktree", async () => {
    // Not the user's answer to this question, and the worktree listing is not
    // evidence about it, so the gate skips the block entirely.
    const { result, deps } = await generateFor(MICROSERVICES, "/elsewhere/api");
    expectSkillHandoff(result, "/elsewhere/api");
    expect(deps.workspace.isWorkspacePath).toHaveBeenCalled();
  });

  it("briefs when the target is the workspace root", async () => {
    const { result } = await generateFor(MICROSERVICES, "/workspace/");
    expect(skillBrief(result)).toContain(UNIDENTIFIED_APPLICATION_MESSAGE);
  });

  // Now reachable: the brief reads the listing through the same branch-aware
  // lister as the classification, so a non-workspace branch is briefed from the
  // repository tree rather than losing the signal.
  it("briefs from the repository tree when the branch is not the worktree", async () => {
    const { tools, deps } = setup({
      remoteTreeByRepoBranch: { "acme/widgets@main": MICROSERVICES }
    });
    vi.mocked(deps.workspace.isWorkspaceSelection).mockReturnValue(false);

    const result = String(
      await findTool(tools, "radius_generate_app").handler({
        repoPath: "/workspace"
      })
    );

    expect(skillBrief(result)).toContain("`services/api`");
    expect(skillBrief(result)).toContain("`pnpm-workspace.yaml`");
    expect(deps.github.treePaths).toHaveBeenCalledWith("acme/widgets", "main");
  });

  it("still briefs the agent when the workspace-manifest re-read fails", async () => {
    // The signal is an enhancement, not a precondition: losing it must not cost
    // the candidate directories or the question.
    const { tools, deps } = setup({
      workspaceTreeByRepoBranch: { "acme/widgets@main": MICROSERVICES }
    });
    vi.mocked(deps.workspace.fetchWorkspaceTree)
      .mockImplementationOnce(async () => MICROSERVICES)
      .mockRejectedValueOnce(new Error("permission denied"));

    const result = String(
      await findTool(tools, "radius_generate_app").handler({
        repoPath: "/workspace"
      })
    );

    expect(skillBrief(result)).toContain("`services/api`");
    expect(skillBrief(result)).toContain(UNIDENTIFIED_APPLICATION_MESSAGE);
    expect(skillBrief(result)).not.toContain("`pnpm-workspace.yaml`");
  });

  it("omits the brief when a single Dockerfile makes the location unambiguous", async () => {
    const { result } = await generateFor(["services/api/Dockerfile"]);
    expectSkillHandoff(result, "/workspace");
  });

  it("omits the brief when the listing could not be established", async () => {
    // An unlistable repository is `unknown`, never a report to the user.
    const { tools } = setup();
    const result = await findTool(tools, "radius_generate_app").handler({
      repoPath: "/workspace"
    });
    expectSkillHandoff(result, "/workspace");
  });

  it("ignores Dockerfiles in vendored directories when counting candidates", async () => {
    const { result } = await generateFor([
      "services/api/Dockerfile",
      "node_modules/some-dep/Dockerfile"
    ]);
    expectSkillHandoff(result, "/workspace");
  });
});

// RU-08: PR diff mapping/fetch failure/markdown.
describe("TL-11: radius_report_modeling_failure", () => {
  async function currentAttempt(
    options?: Parameters<typeof createFakeDependencies>[0]
  ) {
    const harness = setup(options);
    const entry = await harness.deps.getOrCreateServer("radius-panel", "graph");
    Object.assign(entry.state, {
      contextRepo: "acme/widgets",
      contextBranch: "main",
      workspaceRepo: "acme/widgets",
      workspaceBranch: "main",
      workspacePath: "/workspace",
      appModelAttemptTokens: {
        "acme/widgets::main": "attempt-1"
      }
    });
    return { ...harness, entry };
  }

  const report = {
    instanceId: "radius-panel",
    repo: "acme/widgets",
    branch: "main",
    attemptToken: "attempt-1",
    error: "The configured Recipe rejects the required credential shape."
  };

  it("records a permanent failure for the current missing-model attempt", async () => {
    const { tools, entry } = await currentAttempt();

    const result = await findTool(
      tools,
      "radius_report_modeling_failure"
    ).handler(report);

    expect(result).toEqual({ recorded: true });
    expect(entry.state.appModelFailures?.["acme/widgets::main"]).toEqual({
      attemptToken: "attempt-1",
      error: report.error
    });
  });

  it("records saved workspace source with a failure on the workspace branch", async () => {
    const { tools, entry } = await currentAttempt({
      headCommits: { "workspace:/workspace": "sha-workspace" }
    });

    await findTool(tools, "radius_report_modeling_failure").handler(report);

    expect(entry.state.appModelFailures?.["acme/widgets::main"]).toEqual({
      attemptToken: "attempt-1",
      error: report.error,
      sourceRevision: "sha-workspace"
    });
  });

  it("records the source baseline captured when the attempt started", async () => {
    const { tools, entry, deps } = await currentAttempt({
      headCommits: { "workspace:/workspace": "workspace:edited-later" }
    });
    entry.state.appModelAttemptSourceRevisions = {
      "acme/widgets::main": "workspace:at-start"
    };

    await findTool(tools, "radius_report_modeling_failure").handler(report);

    expect(entry.state.appModelFailures?.["acme/widgets::main"]).toEqual({
      attemptToken: "attempt-1",
      error: report.error,
      sourceRevision: "workspace:at-start"
    });
    expect(deps.appModel.workspaceSourceRevision).not.toHaveBeenCalled();
  });

  it("records the attempted environment, not a selection changed during source capture", async () => {
    const { tools, entry, deps } = await currentAttempt();
    entry.state.appModelAttemptEnvironments = {
      "acme/widgets::main": '["azure","dev"]'
    };
    entry.state.plannedEnvironment = "production";
    vi.mocked(deps.appModel.workspaceSourceRevision).mockImplementation(
      async () => {
        entry.state.plannedEnvironment = "new-selection";
        return "workspace:source-1";
      }
    );
    await findTool(tools, "radius_report_modeling_failure").handler(report);
    expect(entry.state.appModelFailures?.["acme/widgets::main"]).toMatchObject({
      sourceRevision: "workspace:source-1",
      environmentKey: '["azure","dev"]'
    });
  });

  it("releases only this branch's delivered panel handoffs after a failure", async () => {
    const { tools, entry } = await currentAttempt();
    entry.state.appBicepHandoffKeys = {
      "acme/widgets::main": "single",
      "acme/widgets::main:release": "diff",
      "acme/widgets::other": "unrelated",
      "other/repo::main": "other-repository"
    };
    entry.state.appBicepHandoffKey = "diff";
    await findTool(tools, "radius_report_modeling_failure").handler(report);
    expect(entry.state.appBicepHandoffKeys).toEqual({
      "acme/widgets::other": "unrelated",
      "other/repo::main": "other-repository"
    });
    expect(entry.state.appBicepHandoffKey).toBeUndefined();
  });

  it("records the remote branch head commit for a branch outside the workspace", async () => {
    const { tools, entry } = await currentAttempt({
      headCommits: { "acme/widgets@release": "sha-remote" }
    });
    entry.state.appModelAttemptTokens = {
      "acme/widgets::release": "attempt-1"
    };

    await findTool(tools, "radius_report_modeling_failure").handler({
      ...report,
      branch: "release"
    });

    expect(entry.state.appModelFailures?.["acme/widgets::release"]).toEqual({
      attemptToken: "attempt-1",
      error: report.error,
      sourceRevision: "remote:sha-remote"
    });
  });

  it("records the failure without a commit when the head commit cannot be read", async () => {
    const { tools, entry, deps } = await currentAttempt();
    vi.mocked(deps.appModel.workspaceSourceRevision).mockRejectedValue(
      new Error("git failed")
    );

    const result = await findTool(
      tools,
      "radius_report_modeling_failure"
    ).handler(report);

    expect(result).toEqual({ recorded: true });
    expect(entry.state.appModelFailures?.["acme/widgets::main"]).toEqual({
      attemptToken: "attempt-1",
      error: report.error
    });
  });

  it.each(["empty", "failed"])(
    "records a failure without source evidence when the remote revision is %s",
    async (read) => {
      const { tools, entry, deps } = await currentAttempt();
      entry.state.appModelAttemptTokens = {
        "acme/widgets::release": "attempt-1"
      };
      if (read === "failed")
        vi.mocked(deps.appModel.branchHeadCommit).mockRejectedValue(
          new Error("offline")
        );
      expect(
        await findTool(tools, "radius_report_modeling_failure").handler({
          ...report,
          branch: "release"
        })
      ).toEqual({ recorded: true });
      expect(entry.state.appModelFailures?.["acme/widgets::release"]).toEqual({
        attemptToken: "attempt-1",
        error: report.error
      });
      expect(deps.appModel.workspaceSourceRevision).not.toHaveBeenCalled();
    }
  );

  it("rejects a report superseded while the saved source revision is read", async () => {
    const { tools, entry, deps } = await currentAttempt();
    deps.appModel.workspaceSourceRevision = async () => {
      entry.state.appModelAttemptTokens = {
        "acme/widgets::main": "attempt-2"
      };
      return "saved-source-2";
    };
    const result = await findTool(
      tools,
      "radius_report_modeling_failure"
    ).handler(report);
    expect(result).toMatchObject({ recorded: false });
    expect(entry.state.appModelFailures).toBeUndefined();
    expect(entry.state.appModelAttemptTokens?.["acme/widgets::main"]).toBe(
      "attempt-2"
    );
  });

  it("releases the dead run's handoff claim so the promised retry can be sent", async () => {
    const { tools, missingModelHandoffs, modelingActivity } =
      await currentAttempt();
    const delivered = missingModelHandoffs.claim(
      "acme/widgets::main",
      "missing-model-key"
    );
    expect(delivered).not.toBeNull();
    missingModelHandoffs.markDelivered(delivered!);
    expect(missingModelHandoffs.current("acme/widgets::main")).toBe(delivered);

    await findTool(tools, "radius_report_modeling_failure").handler(report);

    expect(missingModelHandoffs.current("acme/widgets::main")).toBeNull();
    expect(
      missingModelHandoffs.claim("acme/widgets::main", "missing-model-key")
    ).not.toBeNull();
    expect(modelingActivity.release).toHaveBeenCalledWith({
      repo: "acme/widgets",
      branch: "main"
    });
  });

  it("also releases the two-branch diff claim that covers the failed branch", async () => {
    const { tools, missingModelHandoffs } = await currentAttempt();
    const diffTarget = missingModelHandoffTarget("acme/widgets", [
      "release",
      "main"
    ]);
    const diffClaim = missingModelHandoffs.claim(
      diffTarget,
      "missing-model-key"
    );
    expect(diffClaim).not.toBeNull();
    missingModelHandoffs.markDelivered(diffClaim!);

    await findTool(tools, "radius_report_modeling_failure").handler(report);

    expect(missingModelHandoffs.current(diffTarget)).toBeNull();
  });

  it("leaves an unrelated target's claim alone when a failure is recorded", async () => {
    const { tools, missingModelHandoffs } = await currentAttempt();
    const other = missingModelHandoffs.claim(
      "acme/widgets::release",
      "missing-model-key"
    );

    await findTool(tools, "radius_report_modeling_failure").handler(report);

    expect(missingModelHandoffs.current("acme/widgets::release")).toBe(other);
  });

  it("rejects incomplete, oversized, and stale reports", async () => {
    const { tools, entry } = await currentAttempt();
    const tool = findTool(tools, "radius_report_modeling_failure");

    await expect(tool.handler({})).resolves.toMatchObject({ recorded: false });
    await expect(
      tool.handler({ ...report, error: "x".repeat(4001) })
    ).resolves.toMatchObject({ recorded: false });
    await expect(
      tool.handler({ ...report, attemptToken: "stale-attempt" })
    ).resolves.toMatchObject({ recorded: false });
    await expect(
      tool.handler({ ...report, instanceId: "closed-panel" })
    ).resolves.toMatchObject({ recorded: false });
    expect(entry.state.appModelFailures).toBeUndefined();
  });

  it("propagates a model read failure instead of recording an unverified failure", async () => {
    const { tools, deps, entry } = await currentAttempt();
    vi.mocked(deps.workspace.fetchWorkspaceBicep).mockRejectedValue(
      new Error("workspace unavailable")
    );

    await expect(
      findTool(tools, "radius_report_modeling_failure").handler(report)
    ).rejects.toThrow("workspace unavailable");
    expect(entry.state.appModelFailures).toBeUndefined();
  });

  it("rejects a report superseded while the model recheck is in flight", async () => {
    const { tools, deps, entry } = await currentAttempt();
    let finishRead!: (content: string | null) => void;
    vi.mocked(deps.workspace.fetchWorkspaceBicep).mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          finishRead = resolve;
        })
    );

    const pending = findTool(tools, "radius_report_modeling_failure").handler(
      report
    );
    await vi.waitFor(() =>
      expect(deps.workspace.fetchWorkspaceBicep).toHaveBeenCalledOnce()
    );
    const tokens = entry.state.appModelAttemptTokens;
    if (!tokens) throw new Error("expected current modeling attempt");
    tokens["acme/widgets::main"] = "attempt-2";
    finishRead(null);

    await expect(pending).resolves.toMatchObject({ recorded: false });
    expect(entry.state.appModelFailures).toBeUndefined();
  });

  it("rejects a stale failure when the application model now exists", async () => {
    const { tools, entry } = await currentAttempt({
      bicepByRepoBranch: {
        "workspace:acme/widgets@main": "extension radius"
      }
    });
    entry.state.appModelFailures = {
      "acme/widgets::main": {
        attemptToken: "attempt-1",
        error: "older failure"
      }
    };

    const result = await findTool(
      tools,
      "radius_report_modeling_failure"
    ).handler(report);

    expect(result).toMatchObject({ recorded: false });
    expect(entry.state.appModelFailures).toEqual({});
    expect(entry.state.appModelAttemptTokens).toEqual({});
  });
});

describe("RU-08: radius_generate_pr_diff_markdown", () => {
  it("reports missing app.bicep on both branches without calling rad", async () => {
    const { tools, deps } = setup();
    const result = await findTool(
      tools,
      "radius_generate_pr_diff_markdown"
    ).handler({ repo: "acme/widgets", baseBranch: "main", headBranch: "feat" });
    expect(result).toMatchObject({
      resultType: "success",
      textResultForLlm: expect.stringContaining(
        "does not exist on main or feat yet"
      ),
      toolTelemetry: { radiusGraphDiff: { outcome: "unavailable" } }
    });
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
    expect(result).toMatchObject({
      resultType: "success",
      textResultForLlm: expect.stringContaining("Application Graph Diff"),
      toolTelemetry: { radiusGraphDiff: { outcome: "diff" } }
    });
    expect(result.textResultForLlm).toContain("main");
    expect(result.textResultForLlm).toContain("feat");
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
    expect(result).toMatchObject({
      resultType: "failure",
      error: expect.stringContaining("rad exploded"),
      textResultForLlm: expect.stringContaining(
        "Could not generate app graph diff"
      )
    });
  });

  it("logs graph build progress when available without letting a logging failure break the diff", async () => {
    const { tools, deps } = setup({
      bicepByRepoBranch: {
        "remote:acme/widgets@main": "resource db {}",
        "remote:acme/widgets@feat": "resource db {}"
      }
    });
    const session = deps.session.get();
    session.log = vi.fn(() => {
      throw new Error("log unavailable");
    });
    (
      deps.rad.radArtifactsDirForSelection as ReturnType<typeof vi.fn>
    ).mockImplementation(async ({ log }) => {
      log("building graph");
      return { dir: "/workspace/.radius", remote: false };
    });

    const result = await findTool(
      tools,
      "radius_generate_pr_diff_markdown"
    ).handler({ repo: "acme/widgets", baseBranch: "main", headBranch: "feat" });

    expect(session.log).toHaveBeenCalledWith("building graph");
    expect(result.textResultForLlm).toContain("Application Graph Diff");
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

  // A modeling run writes into `.radius/.staging-<runId>/` and publishes only
  // once it is complete, so the package this tool produces has to land in the
  // run's directory rather than where the product reads it.
  it("defaults into the run's staging directory when one is given", async () => {
    const { tools, deps } = setup();
    await findTool(tools, "radius_publish_custom_type_extension").handler({
      stagingDir: ".staging-run-42"
    });
    expect(
      deps.publishTargets.resolveExistingRadiusArtifact
    ).toHaveBeenCalledWith(
      "/workspace",
      undefined,
      ".radius/.staging-run-42/custom-types.yaml"
    );
    expect(
      deps.publishTargets.resolveRadiusArtifactTarget
    ).toHaveBeenCalledWith(
      "/workspace",
      undefined,
      ".radius/.staging-run-42/custom-types.tgz"
    );
  });

  it("rejects a staging directory that is not a staging directory", async () => {
    const { tools, deps } = setup();
    const result = await findTool(
      tools,
      "radius_publish_custom_type_extension"
    ).handler({ stagingDir: "../../etc" });
    expect(result).toContain("Could not publish the custom-type extension");
    expect(deps.rad.runRadBicepPublishExtension).not.toHaveBeenCalled();
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

describe("RU-11/RU-12 direct deployment handler wiring", () => {
  it.each([
    ["radius_deploy", "start"],
    ["radius_deploy_status", "status"]
  ] as const)(
    "forwards %s to the shared runtime without a panel or HTTP request",
    async (name, method) => {
      const { tools, deps } = setup();
      const input = { attemptId: "attempt-A", logLines: 12 };
      vi.mocked(deps.deployment[method]).mockResolvedValue("runtime result");
      expect(await findTool(tools, name).handler(input)).toBe("runtime result");
      expect(deps.deployment[method]).toHaveBeenCalledExactlyOnceWith(input);
      expect(deps.servers.size).toBe(0);
      expect(deps.getOrCreateServer).not.toHaveBeenCalled();
      expect(deps.deploy.fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["radius_deploy", "start"],
    ["radius_deploy_status", "status"]
  ] as const)(
    "never turns a %s binding failure into an empty successful response",
    async (name, method) => {
      const { tools, deps } = setup();
      vi.mocked(deps.deployment[method]).mockRejectedValue(
        new Error("runtime unavailable")
      );
      await expect(findTool(tools, name).handler({})).rejects.toThrow(
        "runtime unavailable"
      );
      expect(deps.deploy.fetch).not.toHaveBeenCalled();
    }
  );
});
