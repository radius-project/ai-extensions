import { describe, expect, it } from "vitest";
import {
  resolveWorkflowRollbackRef,
  runWorkflowRollback,
  selectWorkflowRollbackMode,
  type PullRequestState,
  type WorkflowRollbackCommitState,
  type WorkflowRollbackFile,
  type WorkflowRollbackInput,
  type WorkflowRollbackOutcome,
  type WorkflowRollbackPorts
} from "./workflow-rollback.js";
import type {
  BranchHeadState,
  RepositoryFileState
} from "./workflow-provenance.js";

// Every GitHub call is scripted and every unmodelled one throws, so a rollback
// can never be reported as complete because a fake quietly succeeded. The
// provenance verdicts come from the real `workflow-provenance` module.

const BLOB = "b".repeat(40);
const DIGEST = "d".repeat(64);
const VERIFY_PATH = ".github/workflows/radius-verify-credentials.yml";
const DEPLOY_PATH = ".github/workflows/radius-deploy.yml";

function file(
  overrides: Partial<WorkflowRollbackFile> = {}
): WorkflowRollbackFile {
  const path = overrides.path ?? VERIFY_PATH;
  const branch = overrides.branch ?? "main";
  return {
    path,
    branch,
    mode: "default_branch",
    commitSha: "c".repeat(40),
    blobSha: BLOB,
    contentSha256: DIGEST,
    previousBlobSha: null,
    previousBlobKnown: true,
    target: `${path} on ${branch}`,
    identity: `${branch}:${path}`,
    ...overrides
  };
}

function commit(
  overrides: Partial<WorkflowRollbackCommitState> = {}
): WorkflowRollbackCommitState {
  return {
    mode: "default_branch",
    branch: "main",
    baseBranch: null,
    pullRequestUrl: null,
    headSha: null,
    ...overrides
  };
}

interface Journal {
  deleted: Array<{ path: string; branch: string; blobSha: string }>;
  restored: Array<{
    path: string;
    branch: string;
    contentBase64: string;
    message: string;
  }>;
  closed: number[];
  branches: string[];
}

function ports(script: {
  repositoryError?: string;
  files?: Record<string, RepositoryFileState>;
  heads?: Record<string, BranchHeadState>;
  pullRequest?: PullRequestState;
  blobs?: Record<string, string>;
  deleteFails?: string;
  restoreFails?: string;
  closeFails?: boolean;
  deleteBranchFails?: boolean;
}): { ports: WorkflowRollbackPorts; journal: Journal } {
  const journal: Journal = {
    deleted: [],
    restored: [],
    closed: [],
    branches: []
  };
  return {
    journal,
    ports: {
      readRepository: () =>
        Promise.resolve(
          script.repositoryError ?
            { status: "unreadable" as const, detail: script.repositoryError }
          : { status: "readable" as const }
        ),
      readFile: ({ path, ref }) => {
        const state = script.files?.[`${ref}:${path}`];
        if (!state) throw new Error(`unscripted readFile ${ref}:${path}`);
        return Promise.resolve(state);
      },
      readBranchHead: ({ branch }) => {
        const state = script.heads?.[branch];
        if (!state) throw new Error(`unscripted readBranchHead ${branch}`);
        return Promise.resolve(state);
      },
      readPullRequest: () => {
        if (!script.pullRequest) throw new Error("unscripted readPullRequest");
        return Promise.resolve(script.pullRequest);
      },
      readBlob: ({ sha }) => {
        const content = script.blobs?.[sha];
        return Promise.resolve(
          content === undefined ?
            { ok: false, detail: `no blob ${sha}` }
          : { ok: true, contentBase64: content }
        );
      },
      deleteFile: ({ path, branch, blobSha }) => {
        if (script.deleteFails === path)
          return Promise.resolve({ ok: false, detail: "HTTP 409" });
        journal.deleted.push({ path, branch, blobSha });
        return Promise.resolve({ ok: true });
      },
      restoreFile: ({ path, branch, contentBase64, message }) => {
        if (script.restoreFails === path)
          return Promise.resolve({ ok: false, detail: "HTTP 409" });
        journal.restored.push({ path, branch, contentBase64, message });
        return Promise.resolve({ ok: true });
      },
      closePullRequest: ({ number }) => {
        if (script.closeFails)
          return Promise.resolve({ ok: false, detail: "HTTP 403" });
        journal.closed.push(number);
        return Promise.resolve({ ok: true });
      },
      deleteBranch: ({ branch }) => {
        if (script.deleteBranchFails)
          return Promise.resolve({ ok: false, detail: "HTTP 422" });
        journal.branches.push(branch);
        return Promise.resolve({ ok: true });
      }
    }
  };
}

const unchanged: RepositoryFileState = {
  status: "present",
  blobSha: BLOB,
  contentSha256: DIGEST
};

// One repository, one attempt, one recorded file unless a scenario says
// otherwise, so each test states only the part of the request it is about.
function rollback(
  ports: WorkflowRollbackPorts,
  input: Partial<WorkflowRollbackInput> = {}
): Promise<WorkflowRollbackOutcome> {
  return runWorkflowRollback(
    {
      repo: "contoso/store",
      attempt: 1,
      commit: commit(),
      files: [file()],
      ...input
    },
    ports
  );
}

describe("selectWorkflowRollbackMode", () => {
  const prFile = file({ mode: "pull_request", branch: "radius/setup" });
  const prCommit = commit({
    mode: "pull_request",
    branch: "radius/setup",
    baseBranch: "main"
  });

  it.each([
    ["no pull request state is known", null],
    [
      "the pull request is still open",
      { status: "open", number: 7 } as PullRequestState
    ],
    [
      "the pull request was closed unmerged",
      { status: "closed", number: 7 } as PullRequestState
    ]
  ])("deletes the setup branch when %s", (_label, pullRequest) => {
    expect(selectWorkflowRollbackMode(prCommit, [prFile], pullRequest)).toEqual(
      {
        kind: "delete_setup_branch",
        branch: "radius/setup"
      }
    );
  });

  it.each([
    [
      "the pull request merged",
      { status: "merged", number: 7 } as PullRequestState
    ],
    [
      "the pull request could not be read",
      { status: "unknown", detail: "HTTP 500" } as PullRequestState
    ]
  ])("reverts file by file when %s", (_label, pullRequest) => {
    expect(selectWorkflowRollbackMode(prCommit, [prFile], pullRequest)).toEqual(
      {
        kind: "revert_files"
      }
    );
  });

  it("never deletes a branch for a direct commit", () => {
    expect(selectWorkflowRollbackMode(commit(), [file()], null)).toEqual({
      kind: "revert_files"
    });
    // A pull-request commit that never recorded its branch cannot name one to
    // delete either.
    expect(
      selectWorkflowRollbackMode(
        commit({ mode: "pull_request", branch: null }),
        [file()],
        null
      )
    ).toEqual({ kind: "revert_files" });
  });

  it("never deletes a branch when a file was committed somewhere else", () => {
    // A mixed commit — one file direct, one on the setup branch — cannot be
    // undone by discarding the branch, because the direct file survives it.
    expect(
      selectWorkflowRollbackMode(prCommit, [prFile, file()], {
        status: "open",
        number: 7
      })
    ).toEqual({ kind: "revert_files" });
  });
});

describe("resolveWorkflowRollbackRef", () => {
  it("follows a merged pull request onto its base branch", () => {
    expect(
      resolveWorkflowRollbackRef(
        file({ mode: "pull_request", branch: "radius/setup" }),
        commit({
          mode: "pull_request",
          branch: "radius/setup",
          baseBranch: "main"
        }),
        true
      )
    ).toBe("main");
  });

  it("stays on the setup branch while the pull request is open", () => {
    expect(
      resolveWorkflowRollbackRef(
        file({ mode: "pull_request", branch: "radius/setup" }),
        commit({ mode: "pull_request", branch: "radius/setup" }),
        false
      )
    ).toBe("radius/setup");
  });

  it("reports no ref when a merged pull request saved no base branch", () => {
    expect(
      resolveWorkflowRollbackRef(
        file({ mode: "pull_request", branch: "radius/setup" }),
        commit({ mode: "pull_request", branch: "radius/setup" }),
        true
      )
    ).toBeNull();
  });

  it("falls back to the commit branch when the file saved none", () => {
    expect(
      resolveWorkflowRollbackRef(file({ branch: "" }), commit(), false)
    ).toBe("main");
  });

  it("reports no ref when neither the file nor the commit named a branch", () => {
    expect(
      resolveWorkflowRollbackRef(
        file({ branch: "" }),
        commit({ branch: null }),
        false
      )
    ).toBeNull();
  });
});

describe("runWorkflowRollback", () => {
  it("does nothing, and blocks nothing, when no file was committed", async () => {
    const { ports: p } = ports({});
    await expect(rollback(p, { files: [] })).resolves.toEqual({
      results: [],
      warnings: [],
      steps: [],
      blocked: false
    });
  });

  it("deletes each unchanged file Radius created, through its own commit", async () => {
    const { ports: p, journal } = ports({
      files: {
        [`main:${VERIFY_PATH}`]: unchanged,
        [`main:${DEPLOY_PATH}`]: unchanged
      }
    });

    const outcome = await rollback(p, {
      attempt: 2,
      files: [file(), file({ path: DEPLOY_PATH })]
    });

    expect(outcome.blocked).toBe(false);
    expect(journal.deleted).toEqual([
      { path: VERIFY_PATH, branch: "main", blobSha: BLOB },
      { path: DEPLOY_PATH, branch: "main", blobSha: BLOB }
    ]);
    expect(outcome.results).toEqual([
      {
        attempt: 2,
        artifactType: "workflow_file",
        target: `${VERIFY_PATH} on main`,
        identity: `main:${VERIFY_PATH}`,
        outcome: "deleted",
        detail: null
      },
      {
        attempt: 2,
        artifactType: "workflow_file",
        target: `${DEPLOY_PATH} on main`,
        identity: `main:${DEPLOY_PATH}`,
        outcome: "deleted",
        detail: null
      }
    ]);
  });

  it("restores the version it replaced instead of deleting a file it did not create", async () => {
    const { ports: p, journal } = ports({
      files: { [`main:${VERIFY_PATH}`]: unchanged },
      blobs: { "old-blob": "cHJldmlvdXM=" }
    });

    const outcome = await rollback(p, {
      files: [file({ previousBlobSha: "old-blob" })]
    });

    expect(outcome.blocked).toBe(false);
    expect(journal.deleted).toEqual([]);
    expect(journal.restored).toEqual([
      {
        path: VERIFY_PATH,
        branch: "main",
        contentBase64: "cHJldmlvdXM=",
        message: `Restore workflow after deleting Radius environment setup: ${VERIFY_PATH}`
      }
    ]);
    expect(outcome.results[0]?.outcome).toBe("restored");
  });

  it("converges without another write when a previous restore response was lost", async () => {
    const previousBlobSha = "old-blob";
    const { ports: p, journal } = ports({
      files: {
        [`main:${VERIFY_PATH}`]: {
          ...unchanged,
          blobSha: previousBlobSha
        }
      }
    });

    const outcome = await rollback(p, {
      files: [file({ previousBlobSha })]
    });

    expect(outcome.blocked).toBe(false);
    expect(journal.restored).toEqual([]);
    expect(journal.deleted).toEqual([]);
    expect(outcome.results[0]).toMatchObject({
      outcome: "restored",
      detail: null
    });
  });

  it("records an already-restored file even when another workflow blocks cleanup", async () => {
    const previousBlobSha = "old-blob";
    const { ports: p, journal } = ports({
      files: {
        [`main:${VERIFY_PATH}`]: {
          ...unchanged,
          blobSha: previousBlobSha
        },
        [`main:${DEPLOY_PATH}`]: {
          ...unchanged,
          blobSha: "e".repeat(40)
        }
      }
    });

    const outcome = await rollback(p, {
      files: [file({ previousBlobSha }), file({ path: DEPLOY_PATH })]
    });

    expect(outcome.blocked).toBe(true);
    expect(journal.restored).toEqual([]);
    expect(journal.deleted).toEqual([]);
    expect(outcome.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: `${VERIFY_PATH} on main`,
          outcome: "restored"
        }),
        expect.objectContaining({
          target: `${DEPLOY_PATH} on main`,
          outcome: "skipped"
        })
      ])
    );
  });

  it("blocks before file reads when the selected account cannot read the repository", async () => {
    const { ports: p, journal } = ports({
      repositoryError: "HTTP 404: Not Found"
    });

    const outcome = await rollback(p);

    expect(outcome.blocked).toBe(true);
    expect(outcome.warnings[0]).toContain(
      'could not read repository "contoso/store"'
    );
    expect(outcome.results[0]).toMatchObject({
      outcome: "warning",
      detail: expect.stringContaining("HTTP 404")
    });
    expect(journal.deleted).toEqual([]);
  });

  it("blocks when it cannot determine whether the setup pull request merged", async () => {
    const { ports: p, journal } = ports({
      pullRequest: { status: "unknown", detail: "HTTP 500" }
    });

    const outcome = await rollback(p, {
      commit: commit({
        mode: "pull_request",
        branch: "radius/setup",
        baseBranch: "main",
        pullRequestUrl: "https://github.com/contoso/store/pull/7"
      }),
      files: [file({ mode: "pull_request", branch: "radius/setup" })]
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.results[0]).toMatchObject({
      outcome: "warning",
      detail: expect.stringContaining("could not determine")
    });
    expect(journal.deleted).toEqual([]);
    expect(journal.branches).toEqual([]);
  });

  it("closes an open setup pull request when mixed-branch files require individual reverts", async () => {
    const setupBranch = "radius/setup";
    const { ports: p, journal } = ports({
      pullRequest: { status: "open", number: 17 },
      files: {
        [`main:${VERIFY_PATH}`]: unchanged,
        [`${setupBranch}:${DEPLOY_PATH}`]: unchanged
      }
    });

    const outcome = await rollback(p, {
      commit: commit({
        mode: "pull_request",
        branch: setupBranch,
        baseBranch: "main",
        pullRequestUrl: "https://github.com/contoso/store/pull/17"
      }),
      files: [
        file(),
        file({
          path: DEPLOY_PATH,
          branch: setupBranch,
          mode: "pull_request"
        })
      ]
    });

    expect(outcome.blocked).toBe(false);
    expect(journal.closed).toEqual([17]);
    expect(journal.deleted.map(({ branch }) => branch)).toEqual([
      "main",
      setupBranch
    ]);
  });

  it("reports but does not block on an open mixed-branch pull request that cannot close", async () => {
    const setupBranch = "radius/setup";
    const { ports: p } = ports({
      pullRequest: { status: "open", number: 17 },
      closeFails: true,
      files: {
        [`main:${VERIFY_PATH}`]: unchanged,
        [`${setupBranch}:${DEPLOY_PATH}`]: unchanged
      }
    });

    const outcome = await rollback(p, {
      commit: commit({
        mode: "pull_request",
        branch: setupBranch,
        baseBranch: "main",
        pullRequestUrl: "https://github.com/contoso/store/pull/17"
      }),
      files: [
        file(),
        file({
          path: DEPLOY_PATH,
          branch: setupBranch,
          mode: "pull_request"
        })
      ]
    });

    expect(outcome.blocked).toBe(false);
    expect(outcome.warnings[0]).toContain(
      "Could not close setup pull request #17"
    );
    expect(outcome.steps).toContain(
      "⚠️ Setup pull request #17 remains open after its workflow files were reverted."
    );
  });

  it("leaves a file alone and blocks the rollback when it changed", async () => {
    const { ports: p, journal } = ports({
      files: {
        [`main:${VERIFY_PATH}`]: { ...unchanged, blobSha: "e".repeat(40) },
        [`main:${DEPLOY_PATH}`]: unchanged
      }
    });

    const outcome = await rollback(p, {
      files: [file(), file({ path: DEPLOY_PATH })]
    });

    expect(outcome.blocked).toBe(true);
    // Nothing is written at all: the verified file is kept too, because a
    // half-removed workflow set is worse than an untouched one.
    expect(journal.deleted).toEqual([]);
    expect(outcome.results.map((entry) => entry.outcome)).toEqual([
      "skipped",
      "warning"
    ]);
    expect(outcome.results[1]?.detail).toContain(
      "another workflow file from this setup could not be verified"
    );
  });

  it("records an unreadable file as a retryable warning rather than a manual action", async () => {
    const { ports: p } = ports({
      files: {
        [`main:${VERIFY_PATH}`]: { status: "unreadable", detail: "HTTP 500" }
      }
    });

    const outcome = await rollback(p);

    expect(outcome.blocked).toBe(true);
    expect(outcome.results[0]?.outcome).toBe("warning");
  });

  it("blocks when it cannot tell which branch a file is on now", async () => {
    const { ports: p } = ports({
      pullRequest: { status: "merged", number: 7 }
    });

    const outcome = await rollback(p, {
      // A merged pull request with no saved base branch: the file is somewhere,
      // but not somewhere Radius can name.
      commit: commit({
        mode: "pull_request",
        branch: "radius/setup",
        pullRequestUrl: "https://github.com/contoso/store/pull/7"
      }),
      files: [file({ mode: "pull_request", branch: "radius/setup" })]
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.results[0]?.detail).toContain("cannot tell where");
  });

  it("blocks the whole pass when only one file cannot be located", async () => {
    const { ports: p, journal } = ports({});

    const outcome = await rollback(p, {
      commit: commit({ branch: null }),
      files: [file(), file({ path: DEPLOY_PATH, branch: "" })]
    });

    expect(outcome.blocked).toBe(true);
    expect(journal.deleted).toEqual([]);
    expect(outcome.results[0]?.detail).toContain(
      "another workflow file from this setup could not be located"
    );
    expect(outcome.results[1]?.detail).toContain("cannot tell where");
  });

  it("blocks a file saved without the blob id a revert has to pass back", async () => {
    // The ledger gate refuses this record before the service is reached, so the
    // service must not be the only thing standing between a null blob id and a
    // contents API call that would act on the wrong version — or on none.
    const { ports: p, journal } = ports({});

    const outcome = await rollback(p, { files: [file({ blobSha: null })] });

    expect(outcome.blocked).toBe(true);
    expect(journal.deleted).toEqual([]);
    expect(outcome.results[0]?.outcome).toBe("warning");
  });

  it("blocks a file whose previous path state was never proven", async () => {
    const { ports: p, journal } = ports({});

    const outcome = await rollback(p, {
      files: [file({ previousBlobKnown: false })]
    });

    expect(outcome.blocked).toBe(true);
    expect(journal.deleted).toEqual([]);
    expect(outcome.results[0]?.detail).toContain("did not save whether");
  });

  it("reports a target with no stable identity as unidentified rather than blank", async () => {
    const { ports: p } = ports({
      files: { [`main:${VERIFY_PATH}`]: unchanged }
    });

    const outcome = await rollback(p, { files: [file({ identity: "" })] });

    expect(outcome.results[0]?.identity).toBeNull();
  });

  it("reports an already absent file as removed without writing anything", async () => {
    const { ports: p, journal } = ports({
      files: { [`main:${VERIFY_PATH}`]: { status: "absent" } }
    });

    const outcome = await rollback(p);

    expect(outcome.blocked).toBe(false);
    expect(journal.deleted).toEqual([]);
    expect(outcome.results[0]?.outcome).toBe("not_found");
  });

  it("blocks when a removal is refused, keeping the resources behind it", async () => {
    const { ports: p } = ports({
      files: { [`main:${VERIFY_PATH}`]: unchanged },
      deleteFails: VERIFY_PATH
    });

    const outcome = await rollback(p);

    expect(outcome.blocked).toBe(true);
    expect(outcome.results[0]).toMatchObject({
      outcome: "warning",
      detail: expect.stringContaining("HTTP 409")
    });
  });

  it("blocks when the version it must restore cannot be read", async () => {
    const { ports: p } = ports({
      files: { [`main:${VERIFY_PATH}`]: unchanged }
    });

    const outcome = await rollback(p, {
      files: [file({ previousBlobSha: "old-blob" })]
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.results[0]?.detail).toContain("no blob old-blob");
  });

  it("blocks when a restore is refused", async () => {
    const { ports: p } = ports({
      files: { [`main:${VERIFY_PATH}`]: unchanged },
      blobs: { "old-blob": "cHJldmlvdXM=" },
      restoreFails: VERIFY_PATH
    });

    const outcome = await rollback(p, {
      files: [file({ previousBlobSha: "old-blob" })]
    });

    expect(outcome.blocked).toBe(true);
    expect(outcome.results[0]?.outcome).toBe("warning");
  });
});

describe("runWorkflowRollback on an unmerged setup branch", () => {
  const setupCommit = commit({
    mode: "pull_request",
    branch: "radius/setup",
    baseBranch: "main",
    pullRequestUrl: "https://github.com/contoso/store/pull/7",
    headSha: "head-1"
  });
  const setupFile = file({ mode: "pull_request", branch: "radius/setup" });

  function branchScript(overrides: Parameters<typeof ports>[0] = {}) {
    return ports({
      files: { [`radius/setup:${VERIFY_PATH}`]: unchanged },
      heads: { "radius/setup": { status: "present", sha: "head-1" } },
      pullRequest: { status: "open", number: 7 },
      ...overrides
    });
  }

  function rollbackBranch(
    p: WorkflowRollbackPorts,
    commitState: WorkflowRollbackCommitState = setupCommit
  ): Promise<WorkflowRollbackOutcome> {
    return rollback(p, { commit: commitState, files: [setupFile] });
  }

  it("closes the pull request and deletes the branch it wrote", async () => {
    const { ports: p, journal } = branchScript();

    const outcome = await rollbackBranch(p);

    expect(outcome.blocked).toBe(false);
    expect(journal.closed).toEqual([7]);
    expect(journal.branches).toEqual(["radius/setup"]);
    expect(journal.deleted).toEqual([]);
    expect(outcome.results[0]?.outcome).toBe("deleted");
  });

  it("deletes a setup branch whose pull request was never opened", async () => {
    // Radius commits the workflows before it opens the pull request, so a
    // failure in between leaves a branch with no pull request at all.
    const { ports: p, journal } = ports({
      files: { [`radius/setup:${VERIFY_PATH}`]: unchanged },
      heads: { "radius/setup": { status: "present", sha: "head-1" } }
    });

    const outcome = await rollbackBranch(p, {
      ...setupCommit,
      pullRequestUrl: null
    });

    expect(outcome.blocked).toBe(false);
    expect(journal.closed).toEqual([]);
    expect(journal.branches).toEqual(["radius/setup"]);
  });

  it("does not try to close a pull request that is already closed", async () => {
    const { ports: p, journal } = branchScript({
      pullRequest: { status: "closed", number: 7 }
    });

    await rollbackBranch(p);

    expect(journal.closed).toEqual([]);
    expect(journal.branches).toEqual(["radius/setup"]);
  });

  it("still deletes the branch when the pull request cannot be closed", async () => {
    // GitHub closes a pull request itself when its head branch disappears, so a
    // refused close is narrated rather than treated as a failed rollback.
    const { ports: p, journal } = branchScript({ closeFails: true });

    const outcome = await rollbackBranch(p);

    expect(outcome.blocked).toBe(false);
    expect(journal.branches).toEqual(["radius/setup"]);
    expect(outcome.warnings[0]).toContain("Could not close setup pull request");
  });

  it("refuses to delete a branch that has moved since Radius wrote it", async () => {
    const { ports: p, journal } = branchScript({
      heads: { "radius/setup": { status: "present", sha: "head-2" } }
    });

    const outcome = await rollbackBranch(p);

    expect(outcome.blocked).toBe(true);
    expect(journal.branches).toEqual([]);
    expect(outcome.results[0]?.outcome).toBe("skipped");
  });

  it("refuses to delete a branch whose head could not be read", async () => {
    const { ports: p, journal } = branchScript({
      heads: { "radius/setup": { status: "unreadable", detail: "HTTP 500" } }
    });

    const outcome = await rollbackBranch(p);

    expect(outcome.blocked).toBe(true);
    expect(journal.branches).toEqual([]);
    expect(outcome.results[0]?.outcome).toBe("warning");
  });

  it("reports a branch that is already gone as removed", async () => {
    const { ports: p, journal } = branchScript({
      heads: { "radius/setup": { status: "absent" } }
    });

    const outcome = await rollbackBranch(p);

    expect(outcome.blocked).toBe(false);
    expect(journal.branches).toEqual([]);
    expect(outcome.results[0]?.outcome).toBe("not_found");
  });

  it("blocks when the branch deletion is refused", async () => {
    const { ports: p } = branchScript({ deleteBranchFails: true });

    const outcome = await rollbackBranch(p);

    expect(outcome.blocked).toBe(true);
    expect(outcome.results[0]).toMatchObject({
      outcome: "warning",
      detail: expect.stringContaining("HTTP 422")
    });
  });

  it("reverts on the base branch once the setup pull request merged", async () => {
    const { ports: p, journal } = ports({
      files: { [`main:${VERIFY_PATH}`]: unchanged },
      pullRequest: { status: "merged", number: 7 }
    });

    const outcome = await rollbackBranch(p);

    expect(outcome.blocked).toBe(false);
    // The file lives on the base branch now, and a git blob id is content
    // addressed, so the identity Radius saved still finds it there.
    expect(journal.deleted).toEqual([
      { path: VERIFY_PATH, branch: "main", blobSha: BLOB }
    ]);
    expect(journal.branches).toEqual([]);
  });
});
