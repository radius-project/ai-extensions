import { describe, expect, it, vi } from "vitest";
import {
  serializeAppOrigin,
  APP_ORIGIN_REPO_PATH,
  APP_ORIGIN_ROOT_PATH
} from "@radius-project/core";
import { hashAppBicep } from "../app-bicep-hash.js";
import { createGraphContextHelpers } from "./graph-context.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../test/support/runtime/fakes.js";
import type { CanvasState } from "../shared.js";

const MODEL = "resource app 'Radius.Core/applications@2025-08-01-preview' = {}";
const COMMIT = "a".repeat(40);
const VERSION = "0.1.0-test";

const WORKSPACE_STATE: CanvasState = {
  workspacePath: "/workspace",
  workspaceRepo: "acme/widgets",
  workspaceBranch: "main",
  contextRepo: "acme/widgets",
  contextBranch: "main"
};

function origin(
  overrides: {
    sourceCommit?: string;
    skillVersion?: string;
    model?: string;
  } = {}
): string {
  return serializeAppOrigin({
    generatedAt: "2026-08-11T05:32:32.000Z",
    sourceCommit: overrides.sourceCommit ?? COMMIT,
    skillVersion: overrides.skillVersion ?? VERSION,
    appBicepHash: hashAppBicep(overrides.model ?? MODEL)
  });
}

function helpers(options: Parameters<typeof createFakeDependencies>[0] = {}) {
  const fake = createFakeDependencies({
    generatorVersion: VERSION,
    ...options
  });
  fake.sessionHolder.set(createFakeSession());
  return {
    deps: fake.deps,
    ...createGraphContextHelpers(fake.deps)
  };
}

describe("resolveAppModelStatus", () => {
  it("reports a missing model on a branch that has none", async () => {
    const { resolveAppModelStatus } = helpers();

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status).toMatchObject({
      repo: "acme/widgets",
      branch: "main",
      refreshable: false
    });
    expect(status.freshness.status).toBe("missing");
  });

  it("judges a worktree model against the worktree record and head commit", async () => {
    const { resolveAppModelStatus } = helpers({
      bicepByRepoBranch: { "workspace:acme/widgets@main": MODEL },
      filesByRepoBranch: {
        [`workspace:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]: origin()
      },
      headCommits: { "workspace:/workspace": COMMIT }
    });

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.refreshable).toBe(true);
    expect(status.freshness.status).toBe("up-to-date");
  });

  it("reports drift when the worktree moved past the recorded commit", async () => {
    const { resolveAppModelStatus } = helpers({
      bicepByRepoBranch: { "workspace:acme/widgets@main": MODEL },
      filesByRepoBranch: {
        [`workspace:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]: origin()
      },
      headCommits: { "workspace:/workspace": "b".repeat(40) }
    });

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.refreshable).toBe(true);
    expect(status.freshness.status).toBe("source-changed");
  });

  it("does not call a model-only commit a source change", async () => {
    // The worktree can see that only .radius/ moved, which is exactly what
    // committing a freshly generated model looks like.
    const { resolveAppModelStatus } = helpers({
      sourceChangedSince: false,
      bicepByRepoBranch: { "workspace:acme/widgets@main": MODEL },
      filesByRepoBranch: {
        [`workspace:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]: origin()
      },
      headCommits: { "workspace:/workspace": "b".repeat(40) }
    });

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("up-to-date");
  });

  it("asks the worktree about source drift, not just the head commit", async () => {
    const { resolveAppModelStatus, deps } = helpers({
      sourceChangedSince: true,
      bicepByRepoBranch: { "workspace:acme/widgets@main": MODEL },
      filesByRepoBranch: {
        [`workspace:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]: origin()
      },
      headCommits: { "workspace:/workspace": COMMIT }
    });

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("source-changed");
    expect(deps.appModel.workspaceSourceChangedSince).toHaveBeenCalledWith(
      "/workspace",
      COMMIT
    );
  });

  it("falls back to head equality when git cannot answer", async () => {
    const { resolveAppModelStatus, deps } = helpers({
      bicepByRepoBranch: { "workspace:acme/widgets@main": MODEL },
      filesByRepoBranch: {
        [`workspace:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]: origin()
      },
      headCommits: { "workspace:/workspace": "b".repeat(40) }
    });
    deps.appModel.workspaceSourceChangedSince = async () => {
      throw new Error("git unavailable");
    };

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("source-changed");
  });

  it("finds an origin record written beside a root-level model", async () => {
    const { resolveAppModelStatus } = helpers({
      sourceChangedSince: false,
      bicepByRepoBranch: { "workspace:acme/widgets@main": MODEL },
      filesByRepoBranch: {
        [`workspace:acme/widgets@main:${APP_ORIGIN_ROOT_PATH}`]: origin()
      },
      headCommits: { "workspace:/workspace": COMMIT }
    });

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("up-to-date");
  });

  it("reports a generator upgrade against the installed version", async () => {
    const { resolveAppModelStatus } = helpers({
      generatorVersion: "0.2.0",
      bicepByRepoBranch: { "workspace:acme/widgets@main": MODEL },
      filesByRepoBranch: {
        [`workspace:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]: origin()
      },
      headCommits: { "workspace:/workspace": COMMIT }
    });

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("generator-changed");
  });

  // The branch head is not fetched for a branch we do not have checked out. The
  // only check it feeds cannot say anything there, because committing an app
  // model is itself a commit past the one its record names, so the comparison
  // never matches. Fetching it would spend a GitHub round trip on a verdict
  // nothing reads.
  it("does not spend a GitHub call on a comparison it cannot use", async () => {
    const { resolveAppModelStatus, deps } = helpers({
      bicepByRepoBranch: { "remote:other/repo@release": MODEL },
      filesByRepoBranch: {
        [`remote:other/repo@release:${APP_ORIGIN_REPO_PATH}`]: origin({
          sourceCommit: "c".repeat(40)
        })
      },
      headCommits: { "other/repo@release": "d".repeat(40) }
    });

    const status = await resolveAppModelStatus(
      "other/repo",
      "release",
      WORKSPACE_STATE
    );

    expect(status.refreshable).toBe(false);
    expect(status.freshness.status).toBe("up-to-date");
    expect(deps.appModel.branchHeadCommit).not.toHaveBeenCalled();
    expect(deps.appModel.workspaceHeadCommit).not.toHaveBeenCalled();
    expect(deps.appModel.fetchWorkspaceFile).not.toHaveBeenCalled();
  });

  it("still reads the record on a branch it cannot diff, so a skill change is seen", async () => {
    const { resolveAppModelStatus } = helpers({
      generatorVersion: "0.2.0",
      bicepByRepoBranch: { "remote:other/repo@release": MODEL },
      filesByRepoBranch: {
        [`remote:other/repo@release:${APP_ORIGIN_REPO_PATH}`]: origin()
      }
    });

    const status = await resolveAppModelStatus(
      "other/repo",
      "release",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("generator-changed");
  });

  it("does not judge a GitHub-served model against the worktree, even for the workspace branch", async () => {
    // The worktree has no model on disk, so the branch's committed model is what
    // renders, and the worktree head commit says nothing about it.
    const { resolveAppModelStatus, deps } = helpers({
      bicepByRepoBranch: { "remote:acme/widgets@main": MODEL },
      filesByRepoBranch: {
        [`remote:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]: origin(),
        [`workspace:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]: origin({
          sourceCommit: "b".repeat(40)
        })
      },
      headCommits: {
        "workspace:/workspace": "b".repeat(40),
        "acme/widgets@main": COMMIT
      }
    });

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.refreshable).toBe(false);
    expect(status.freshness.status).toBe("up-to-date");
    expect(deps.appModel.fetchRepoFile).toHaveBeenCalledWith(
      "acme/widgets",
      "main",
      APP_ORIGIN_REPO_PATH
    );
  });

  it("reports a model with no origin record as refreshable without confirmation", async () => {
    const { resolveAppModelStatus } = helpers({
      bicepByRepoBranch: { "workspace:acme/widgets@main": MODEL },
      headCommits: { "workspace:/workspace": COMMIT }
    });

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("unrecorded");
    expect(status.freshness.requiresConfirmation).toBe(false);
  });

  it("reports a hand-edited model as requiring confirmation", async () => {
    const { resolveAppModelStatus } = helpers({
      bicepByRepoBranch: { "workspace:acme/widgets@main": `${MODEL}\n// edit` },
      filesByRepoBranch: {
        [`workspace:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]: origin()
      },
      headCommits: { "workspace:/workspace": COMMIT }
    });

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("edited");
    expect(status.freshness.requiresConfirmation).toBe(true);
  });

  it("fails open when the origin record cannot be read", async () => {
    const { resolveAppModelStatus, deps } = helpers({
      bicepByRepoBranch: { "workspace:acme/widgets@main": MODEL },
      headCommits: { "workspace:/workspace": COMMIT }
    });
    deps.appModel.fetchWorkspaceFile = async () => {
      throw new Error("worktree unreadable");
    };

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("unrecorded");
  });

  it("falls back to GitHub when reading the worktree model fails", async () => {
    const { resolveAppModelStatus, deps } = helpers({
      bicepByRepoBranch: { "remote:acme/widgets@main": MODEL }
    });
    deps.workspace.fetchWorkspaceBicep = async () => {
      throw new Error("worktree unreadable");
    };

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.refreshable).toBe(false);
    expect(status.freshness.status).toBe("unrecorded");
  });

  it("fails open when the head commit cannot be resolved", async () => {
    const { resolveAppModelStatus, deps } = helpers({
      bicepByRepoBranch: { "workspace:acme/widgets@main": MODEL },
      filesByRepoBranch: {
        [`workspace:acme/widgets@main:${APP_ORIGIN_REPO_PATH}`]: origin()
      }
    });
    deps.appModel.workspaceHeadCommit = async () => {
      throw new Error("git unavailable");
    };

    const status = await resolveAppModelStatus(
      "acme/widgets",
      "main",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("up-to-date");
  });

  it("treats an unreadable model as missing rather than propagating the failure", async () => {
    const { resolveAppModelStatus, deps } = helpers();
    deps.core.fetchBicepFromRepo = async () => {
      throw new Error("contents unavailable");
    };

    const status = await resolveAppModelStatus(
      "other/repo",
      "main",
      WORKSPACE_STATE
    );

    expect(status.freshness.status).toBe("missing");
  });

  it("does not look in the worktree when no repo is known", async () => {
    const { resolveAppModelStatus, deps } = helpers();

    const status = await resolveAppModelStatus("", "main", WORKSPACE_STATE);

    expect(status.freshness.status).toBe("missing");
    expect(deps.workspace.fetchWorkspaceBicep).not.toHaveBeenCalled();
  });
});

describe("workspaceState", () => {
  it("seeds both the workspace and the context from the detected worktree", async () => {
    const { workspaceState } = helpers();

    expect(await workspaceState()).toEqual({
      workspacePath: "/workspace",
      workspaceRepo: "acme/widgets",
      workspaceBranch: "main",
      contextRepo: "acme/widgets",
      contextBranch: "main"
    });
  });
});

describe("fetchBicepForBranch", () => {
  it("prefers the worktree model for the workspace selection", async () => {
    const { fetchBicepForBranch } = helpers({
      bicepByRepoBranch: {
        "workspace:acme/widgets@main": MODEL,
        "remote:acme/widgets@main": "// committed"
      }
    });

    expect(
      await fetchBicepForBranch("acme/widgets", "main", WORKSPACE_STATE)
    ).toBe(MODEL);
  });

  it("falls back to GitHub when the worktree has no model", async () => {
    const { fetchBicepForBranch } = helpers({
      bicepByRepoBranch: { "remote:acme/widgets@main": "// committed" }
    });

    expect(
      await fetchBicepForBranch("acme/widgets", "main", WORKSPACE_STATE)
    ).toBe("// committed");
  });
});

describe("listSourceTreeForBranch", () => {
  it("returns the worktree listing when the selection is the workspace", async () => {
    const { listSourceTreeForBranch } = helpers({
      workspaceTreeByRepoBranch: { "acme/widgets@main": ["Dockerfile"] }
    });
    expect(
      await listSourceTreeForBranch("acme/widgets", "main", WORKSPACE_STATE)
    ).toEqual(["Dockerfile"]);
  });

  it("normalizes an empty listing to null so it cannot read as absent files", async () => {
    // `treePaths` resolves to [] on failure, which a caller reading the raw
    // listing could otherwise misread as "this repository has no manifests".
    const { listSourceTreeForBranch } = helpers({
      remoteTreeByRepoBranch: { "acme/widgets@feat": [] }
    });
    expect(
      await listSourceTreeForBranch("acme/widgets", "feat", WORKSPACE_STATE)
    ).toBeNull();
  });

  it("returns null without listing when there is no repository", async () => {
    const { listSourceTreeForBranch, deps } = helpers();
    expect(
      await listSourceTreeForBranch("", "main", WORKSPACE_STATE)
    ).toBeNull();
    expect(deps.github.treePaths).not.toHaveBeenCalled();
  });

  it("returns null when the lister rejects", async () => {
    const { listSourceTreeForBranch, deps } = helpers();
    vi.mocked(deps.workspace.fetchWorkspaceTree).mockRejectedValueOnce(
      new Error("permission denied")
    );
    expect(
      await listSourceTreeForBranch("acme/widgets", "main", WORKSPACE_STATE)
    ).toBeNull();
  });
});

describe("evaluateAppSourceForBranch", () => {
  it("classifies the workspace branch from the worktree listing", async () => {
    const { evaluateAppSourceForBranch, deps } = helpers({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "Dockerfile"]
      }
    });

    expect(
      await evaluateAppSourceForBranch("acme/widgets", "main", WORKSPACE_STATE)
    ).toEqual({ status: "single", dockerfiles: ["Dockerfile"] });
    expect(deps.github.treePaths).not.toHaveBeenCalled();
  });

  it("reports none when the worktree listing holds no Dockerfile", async () => {
    const { evaluateAppSourceForBranch } = helpers({
      workspaceTreeByRepoBranch: {
        "acme/widgets@main": ["src/index.ts", "package.json"]
      }
    });

    expect(
      await evaluateAppSourceForBranch("acme/widgets", "main", WORKSPACE_STATE)
    ).toEqual({ status: "none", dockerfiles: [] });
  });

  it("classifies another branch from the repository tree listing", async () => {
    const { evaluateAppSourceForBranch, deps } = helpers({
      remoteTreeByRepoBranch: {
        "acme/widgets@feat": ["services/api/Dockerfile", "src/index.ts"]
      }
    });

    expect(
      await evaluateAppSourceForBranch("acme/widgets", "feat", WORKSPACE_STATE)
    ).toEqual({ status: "single", dockerfiles: ["services/api/Dockerfile"] });
    expect(deps.github.treePaths).toHaveBeenCalledWith("acme/widgets", "feat");
  });

  it("skips a vendored Dockerfile on the remote path, which prunes nothing itself", async () => {
    const { evaluateAppSourceForBranch } = helpers({
      remoteTreeByRepoBranch: {
        "acme/widgets@feat": [
          "node_modules/some-pkg/Dockerfile",
          "src/index.ts"
        ]
      }
    });

    expect(
      await evaluateAppSourceForBranch("acme/widgets", "feat", WORKSPACE_STATE)
    ).toEqual({ status: "none", dockerfiles: [] });
  });

  it("reports unknown when the worktree listing fails", async () => {
    const { evaluateAppSourceForBranch, deps } = helpers();
    (
      deps.workspace.fetchWorkspaceTree as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("permission denied"));

    expect(
      await evaluateAppSourceForBranch("acme/widgets", "main", WORKSPACE_STATE)
    ).toEqual({ status: "unknown", dockerfiles: [] });
  });

  it("reports unknown when the worktree cannot be listed at all", async () => {
    const { evaluateAppSourceForBranch } = helpers();

    expect(
      await evaluateAppSourceForBranch("acme/widgets", "main", WORKSPACE_STATE)
    ).toEqual({ status: "unknown", dockerfiles: [] });
  });

  // The worktree predicate is fail-closed on an empty repo, so without this the
  // call falls through to the remote lister and waits out a doomed request.
  it("reports unknown without listing anything when there is no repository", async () => {
    const { evaluateAppSourceForBranch, deps } = helpers();

    expect(
      await evaluateAppSourceForBranch("", "main", WORKSPACE_STATE)
    ).toEqual({ status: "unknown", dockerfiles: [] });
    expect(deps.github.treePaths).not.toHaveBeenCalled();
    expect(deps.workspace.fetchWorkspaceTree).not.toHaveBeenCalled();
  });

  it("reports unknown when the repository tree listing fails or is empty", async () => {
    const { evaluateAppSourceForBranch, deps } = helpers();
    (deps.github.treePaths as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("gh unavailable")
    );

    expect(
      await evaluateAppSourceForBranch("acme/widgets", "feat", WORKSPACE_STATE)
    ).toEqual({ status: "unknown", dockerfiles: [] });
    expect(
      await evaluateAppSourceForBranch("acme/widgets", "feat", WORKSPACE_STATE)
    ).toEqual({ status: "unknown", dockerfiles: [] });
  });
});
