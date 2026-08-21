import { describe, expect, it, vi } from "vitest";
import { createPullRequestGraphDiffGuard } from "./pr-graph-diff-guard.js";
import {
  successfulGraphDiffResult,
  unavailableGraphDiffResult
} from "./pr-graph-diff-result.js";

const MARKDOWN =
  "## 📊 Application Graph Diff\n\nComparing `main` → `feature`\n";

function setup(initiallyModeled = false) {
  let modeled = initiallyModeled;
  const deps = {
    hasRadiusApplicationModel: vi.fn(async () => modeled),
    workspaceContext: vi.fn(async () => ({
      repo: "acme/widgets",
      branch: "feature"
    })),
    getDefaultBranch: vi.fn(async () => "main"),
    openGraphDiff: vi.fn(async () => undefined)
  };
  const guard = createPullRequestGraphDiffGuard(deps);
  return {
    guard,
    deps,
    setModeled(value: boolean) {
      modeled = value;
    }
  };
}

function pullRequest(body = "") {
  return {
    toolName: "create_pull_request",
    toolArgs: { title: "Add cache", body },
    workingDirectory: "/worktrees/widgets"
  };
}

function graphDiff(
  toolResult: unknown = successfulGraphDiffResult(MARKDOWN),
  branches: { baseBranch?: string; headBranch?: string } = {
    baseBranch: "main",
    headBranch: "feature"
  }
) {
  return {
    toolName: "radius_generate_pr_diff_markdown",
    toolArgs: {
      repo: "acme/widgets",
      ...branches
    },
    toolResult,
    workingDirectory: "/worktrees/widgets"
  };
}

describe("pull request application graph diff guard", () => {
  it("activates at startup only when the worktree contains a Radius model", async () => {
    const enabled = setup(true);
    const unrelated = setup();

    await expect(
      enabled.guard.activateAtSessionStart("/worktrees/widgets")
    ).resolves.toBe(true);
    await expect(
      unrelated.guard.activateAtSessionStart("/worktrees/unrelated")
    ).resolves.toBe(false);
    await expect(
      unrelated.guard.activateAtSessionStart(undefined)
    ).resolves.toBe(false);
  });

  it("does not inspect or block pull requests in unrelated worktrees", async () => {
    const { guard, deps } = setup();

    await expect(guard.onPreToolUse(pullRequest())).resolves.toBeUndefined();
    expect(deps.workspaceContext).not.toHaveBeenCalled();
    expect(deps.getDefaultBranch).not.toHaveBeenCalled();
  });

  it("does not inherit a modeled worktree when a later hook omits its directory", async () => {
    const { guard, deps } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");

    await expect(
      guard.onPreToolUse({
        toolName: "create_pull_request",
        toolArgs: { title: "Other repo", body: "" }
      })
    ).resolves.toBeUndefined();
    expect(deps.workspaceContext).not.toHaveBeenCalled();
  });

  it("detects a model created after startup and requires a matching graph diff", async () => {
    const { guard, deps, setModeled } = setup();
    await guard.activateAtSessionStart("/worktrees/widgets");
    setModeled(true);

    const result = await guard.onPreToolUse(pullRequest());

    expect(result?.permissionDecision).toBe("deny");
    expect(result?.additionalContext).toContain("repo `acme/widgets`");
    expect(result?.additionalContext).toContain("baseBranch `main`");
    expect(result?.additionalContext).toContain("headBranch `feature`");
    expect(deps.getDefaultBranch).toHaveBeenCalledExactlyOnceWith(
      "acme/widgets"
    );
  });

  it("uses explicit repository and branch arguments when a PR tool supplies them", async () => {
    const { guard, deps } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");

    const result = await guard.onPreToolUse({
      toolName: "github/create_pull_request",
      toolArgs: {
        repo_full_name: "acme/other",
        base_branch: "develop",
        head_branch: "topic",
        body: ""
      },
      workingDirectory: "/worktrees/widgets"
    });

    expect(result?.additionalContext).toContain("repo `acme/other`");
    expect(result?.additionalContext).toContain("baseBranch `develop`");
    expect(result?.additionalContext).toContain("headBranch `topic`");
    expect(deps.getDefaultBranch).not.toHaveBeenCalled();
  });

  it("allows the PR without a graph when model verification fails", async () => {
    const { guard, deps } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");
    deps.hasRadiusApplicationModel.mockRejectedValueOnce(
      new Error("filesystem unavailable")
    );

    const result = await guard.onPreToolUse(pullRequest());

    expect(result).not.toHaveProperty("permissionDecision");
    expect(result?.additionalContext).toContain("filesystem unavailable");
    expect(result?.additionalContext).toContain("without a graph diff section");
  });

  it("does not activate an unrelated session when model verification fails", async () => {
    const { guard, deps } = setup();
    deps.hasRadiusApplicationModel.mockRejectedValueOnce(
      new Error("filesystem unavailable")
    );

    await expect(guard.onPreToolUse(pullRequest())).resolves.toBeUndefined();
  });

  it("allows the PR without a graph when identity lookup is unavailable", async () => {
    const unresolved = setup(true);
    await unresolved.guard.activateAtSessionStart("/worktrees/widgets");
    unresolved.deps.workspaceContext.mockResolvedValueOnce({
      repo: "",
      branch: ""
    });
    unresolved.deps.getDefaultBranch.mockResolvedValueOnce("");

    const missing = await unresolved.guard.onPreToolUse(pullRequest());
    expect(missing).not.toHaveProperty("permissionDecision");
    expect(missing?.additionalContext).toContain(
      "repository, base branch, and head branch"
    );

    const failed = setup(true);
    await failed.guard.activateAtSessionStart("/worktrees/widgets");
    failed.deps.workspaceContext.mockRejectedValueOnce(
      new Error("git unavailable")
    );

    const error = await failed.guard.onPreToolUse(pullRequest());
    expect(error).not.toHaveProperty("permissionDecision");
    expect(error?.additionalContext).toContain("git unavailable");

    const defaultBranchFailed = setup(true);
    await defaultBranchFailed.guard.activateAtSessionStart(
      "/worktrees/widgets"
    );
    defaultBranchFailed.deps.getDefaultBranch.mockRejectedValueOnce(
      new Error("GitHub rate limited")
    );

    const rateLimited =
      await defaultBranchFailed.guard.onPreToolUse(pullRequest());
    expect(rateLimited).not.toHaveProperty("permissionDecision");
    expect(rateLimited?.additionalContext).toContain("GitHub rate limited");
  });

  it("allows a PR without a graph after an explicit unavailable result", async () => {
    const { guard } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");

    await guard.onPostToolUse(
      graphDiff(unavailableGraphDiffResult("No committed model"))
    );
    const result = await guard.onPreToolUse(pullRequest("Summary"));
    expect(result).not.toHaveProperty("permissionDecision");
    expect(result?.additionalContext).toContain("No committed model");
    expect(result?.additionalContext).toContain("Report this reason in chat");
  });

  it("requires a successful graph diff for the exact branch pair", async () => {
    const { guard } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");

    await guard.onPostToolUse(
      graphDiff(successfulGraphDiffResult(MARKDOWN), {
        baseBranch: "develop",
        headBranch: "feature"
      })
    );
    expect(
      (await guard.onPreToolUse(pullRequest(MARKDOWN)))?.permissionDecision
    ).toBe("deny");
  });

  it("requires the exact generated markdown at the top of the PR body", async () => {
    const { guard, deps } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");
    await guard.onPostToolUse(graphDiff());

    const result = await guard.onPreToolUse(
      pullRequest(`PR summary\n\n${MARKDOWN}`)
    );

    expect(result?.permissionDecision).toBe("deny");
    expect(result?.additionalContext).toContain("byte-exact");
    expect(result?.additionalContext).toContain("repository template");
    expect(
      (await guard.onPreToolUse(pullRequest(`\n${MARKDOWN}\nPR summary`)))
        ?.permissionDecision
    ).toBe("deny");
    await expect(
      guard.onPreToolUse(pullRequest(`${MARKDOWN}\nPR summary`))
    ).resolves.toBeUndefined();
    expect(deps.getDefaultBranch).toHaveBeenCalledOnce();
  });

  it("allows the PR after the graph tool is denied", async () => {
    const { guard } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");
    guard.recordDeniedGraphDiff(graphDiff(), "No committed model exists");

    const result = await guard.onPreToolUse(pullRequest("Summary"));

    expect(result).not.toHaveProperty("permissionDecision");
    expect(result?.additionalContext).toContain("No committed model exists");
  });

  it("ignores denied tools that are not identifiable graph diff attempts", () => {
    const { guard } = setup();

    guard.recordDeniedGraphDiff(
      { toolName: "some_other_tool", toolArgs: {} },
      "denied"
    );
    guard.recordDeniedGraphDiff(
      { toolName: "radius_generate_pr_diff_markdown", toolArgs: {} },
      "denied"
    );
  });

  it("allows the PR after graph generation fails", async () => {
    const { guard } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");
    await guard.onPostToolUseFailure({
      toolName: "radius_generate_pr_diff_markdown",
      toolArgs: {
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "feature"
      },
      error: "rad failed",
      workingDirectory: "/worktrees/widgets"
    });

    const result = await guard.onPreToolUse(pullRequest("Summary"));

    expect(result).not.toHaveProperty("permissionDecision");
    expect(result?.additionalContext).toContain("rad failed");
  });

  it("stops denying when a graph tool call has no observable result", async () => {
    const { guard } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");

    expect((await guard.onPreToolUse(pullRequest()))?.permissionDecision).toBe(
      "deny"
    );
    expect((await guard.onPreToolUse(pullRequest()))?.permissionDecision).toBe(
      "deny"
    );
    await guard.onPreToolUse(
      graphDiff(unavailableGraphDiffResult("not observed"))
    );
    const retry = await guard.onPreToolUse(pullRequest("Summary"));

    expect(retry).not.toHaveProperty("permissionDecision");
    expect(retry?.additionalContext).toContain(
      "rejected, denied, or timed out"
    );
  });

  it("retains unavailable outcomes across failed PR retries", async () => {
    const { guard } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");
    await guard.onPostToolUse(
      graphDiff(unavailableGraphDiffResult("No committed model"))
    );

    const first = await guard.onPreToolUse(pullRequest("Summary"));
    const retry = await guard.onPreToolUse(pullRequest("Summary"));

    expect(first?.additionalContext).toContain("No committed model");
    expect(retry?.additionalContext).toContain("No committed model");
  });

  it("opens the matching interactive diff after PR creation and consumes the proof", async () => {
    const { guard, deps } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");
    await guard.onPostToolUse(graphDiff());
    const request = pullRequest(`${MARKDOWN}\nPR summary`);
    await guard.onPreToolUse(request);

    await expect(guard.onPostToolUse(request)).resolves.toBeUndefined();
    expect(deps.openGraphDiff).toHaveBeenCalledExactlyOnceWith({
      repo: "acme/widgets",
      baseBranch: "main",
      headBranch: "feature"
    });
    expect((await guard.onPreToolUse(request))?.permissionDecision).toBe(
      "deny"
    );
  });

  it("does not open a Canvas for a PR that did not pass the guard", async () => {
    const { guard, deps } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");

    await expect(
      guard.onPostToolUse(pullRequest(MARKDOWN))
    ).resolves.toBeUndefined();
    expect(deps.openGraphDiff).not.toHaveBeenCalled();
  });

  it("does not open a Canvas when post-PR identity is incomplete", async () => {
    const { guard, deps } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");
    deps.workspaceContext.mockResolvedValueOnce({ repo: "", branch: "" });
    deps.getDefaultBranch.mockResolvedValueOnce("");

    await expect(
      guard.onPostToolUse(pullRequest("Summary"))
    ).resolves.toBeUndefined();
    expect(deps.openGraphDiff).not.toHaveBeenCalled();
  });

  it("returns recovery guidance when the post-PR Canvas open fails", async () => {
    const { guard, deps } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");
    await guard.onPostToolUse(graphDiff());
    const request = pullRequest(MARKDOWN);
    await guard.onPreToolUse(request);
    deps.openGraphDiff.mockRejectedValueOnce(new Error("host disconnected"));

    const result = await guard.onPostToolUse(request);

    expect(result?.additionalContext).toContain("host disconnected");
    expect(result?.additionalContext).toContain("radius-panel");
    expect(result?.additionalContext).toContain("graph-diff");
  });

  it("surfaces post-activation model checks that fail after explicit Radius use", async () => {
    const { guard, deps, setModeled } = setup();
    setModeled(true);
    await guard.onPostToolUse({
      toolName: "open_canvas",
      toolArgs: { canvasId: "radius", input: { page: "graph" } },
      workingDirectory: "/worktrees/widgets"
    });
    deps.hasRadiusApplicationModel.mockRejectedValueOnce(
      new Error("disk offline")
    );

    const result = await guard.onPreToolUse(pullRequest());

    expect(result?.additionalContext).toContain("disk offline");
  });

  it("reports activation checks that fail after an explicit Radius operation", async () => {
    const { guard, deps } = setup();
    deps.hasRadiusApplicationModel.mockRejectedValueOnce(
      new Error("disk offline")
    );

    const result = await guard.onPostToolUse({
      toolName: "open_canvas",
      toolArgs: { canvasId: "radius" },
      workingDirectory: "/worktrees/widgets"
    });

    expect(result?.additionalContext).toContain("disk offline");
    expect(result?.additionalContext).toContain("remain inactive");
  });

  it("reports PR identity lookup failures after creation", async () => {
    const { guard, deps } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");
    deps.workspaceContext.mockRejectedValueOnce(new Error("git unavailable"));

    const result = await guard.onPostToolUse(pullRequest());

    expect(result?.additionalContext).toContain("git unavailable");
    expect(result?.additionalContext).toContain("radius-panel");
  });

  it("bounds remembered diff proofs and pending PR opens", async () => {
    const { guard, deps } = setup(true);
    await guard.activateAtSessionStart("/worktrees/widgets");

    for (let index = 0; index <= 20; index++) {
      const headBranch = `feature-${index}`;
      const markdown = `${MARKDOWN}${index}`;
      await guard.onPostToolUse(
        graphDiff(successfulGraphDiffResult(markdown), {
          baseBranch: "main",
          headBranch
        })
      );
      await expect(
        guard.onPreToolUse({
          toolName: "create_pull_request",
          toolArgs: {
            repo: "acme/widgets",
            baseBranch: "main",
            headBranch,
            body: markdown
          },
          workingDirectory: "/worktrees/widgets"
        })
      ).resolves.toBeUndefined();
    }

    const oldest = {
      toolName: "create_pull_request",
      toolArgs: {
        repo: "acme/widgets",
        baseBranch: "main",
        headBranch: "feature-0",
        body: `${MARKDOWN}0`
      },
      workingDirectory: "/worktrees/widgets"
    };
    expect((await guard.onPreToolUse(oldest))?.permissionDecision).toBe("deny");
    await guard.onPostToolUse(oldest);
    expect(deps.openGraphDiff).not.toHaveBeenCalled();
  });

  it("ignores non-Radius tools and unsuccessful diff outputs", async () => {
    const { guard, deps } = setup();

    await expect(
      guard.onPostToolUse({
        toolName: "some_other_tool",
        toolArgs: null,
        toolResult: null
      })
    ).resolves.toBeUndefined();
    await expect(
      guard.onPostToolUse({
        toolName: "open_canvas",
        toolArgs: null
      })
    ).resolves.toBeUndefined();
    await expect(
      guard.onPostToolUse(
        graphDiff(
          {
            resultType: "success",
            textResultForLlm: MARKDOWN
          },
          {}
        )
      )
    ).resolves.toBeUndefined();
    expect(deps.hasRadiusApplicationModel).toHaveBeenCalledExactlyOnceWith(
      "/worktrees/widgets"
    );
  });

  it("ignores failed non-graph tools and graph failures without an identity", async () => {
    const { guard } = setup();

    await expect(
      guard.onPostToolUseFailure({
        toolName: "other_tool",
        error: "failed"
      })
    ).resolves.toBeUndefined();
    await expect(
      guard.onPostToolUseFailure({
        toolName: "radius_generate_pr_diff_markdown",
        toolArgs: {},
        error: 42
      })
    ).resolves.toBeUndefined();
  });
});
