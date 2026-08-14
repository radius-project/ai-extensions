import { describe, expect, it } from "vitest";
import {
  createWorkflowFileCommitter,
  isProtectedBranchFailure,
  type WorkflowFileCommitterPorts
} from "./create-environment-workflow-committer.js";
import type { CreateEnvironmentCommandResult } from "./create-environment-types.js";

interface GhCall {
  kind: "runGh" | "runGhWorkflow";
  args: string[];
}

interface Script {
  runGh?: Partial<CreateEnvironmentCommandResult>[];
  runGhWorkflow?: Partial<CreateEnvironmentCommandResult>[];
  defaultBranch?: string | null;
  headSha?: string | null;
  createBranch?: { ok: boolean; stderr: string };
}

interface Harness {
  ports: WorkflowFileCommitterPorts;
  calls: GhCall[];
  steps: string[];
  tempWrites: string[];
  tempRemovals: string[];
}

const CONTENT = Buffer.from("on: push").toString("base64");

// `gh` and the filesystem are isolated behind scripted fakes that throw on any
// unmodelled call. `isProtectedBranchFailure` is pure and is imported, never
// doubled — a double for it could only diverge from production.
function harness(script: Script = {}): Harness {
  const calls: GhCall[] = [];
  const steps: string[] = [];
  const tempWrites: string[] = [];
  const tempRemovals: string[] = [];
  const runGh = [...(script.runGh ?? [])];
  const runGhWorkflow = [...(script.runGhWorkflow ?? [])];

  const take = (
    kind: GhCall["kind"],
    queue: Partial<CreateEnvironmentCommandResult>[],
    args: string[]
  ): Promise<CreateEnvironmentCommandResult> => {
    calls.push({ kind, args });
    const next = queue.shift();
    if (!next) throw new Error(`unscripted ${kind}: ${args.join(" ")}`);
    return Promise.resolve({
      code: next.code ?? 0,
      stdout: next.stdout ?? "",
      stderr: next.stderr ?? ""
    });
  };

  return {
    calls,
    steps,
    tempWrites,
    tempRemovals,
    ports: {
      runGh: (args) => take("runGh", runGh, args),
      runGhWorkflow: (args) => take("runGhWorkflow", runGhWorkflow, args),
      getDefaultBranch: () => {
        if (!("defaultBranch" in script)) {
          throw new Error("unscripted getDefaultBranch");
        }
        return Promise.resolve(script.defaultBranch);
      },
      getBranchHeadSha: () => {
        if (!("headSha" in script)) {
          throw new Error("unscripted getBranchHeadSha");
        }
        return Promise.resolve(script.headSha);
      },
      createBranchRef: () => {
        if (!script.createBranch) throw new Error("unscripted createBranchRef");
        return Promise.resolve(script.createBranch);
      },
      tempFile: {
        write: (contents) => {
          tempWrites.push(contents);
          return `/tmp/body-${tempWrites.length}.json`;
        },
        remove: (path) => {
          tempRemovals.push(path);
        }
      },
      errorMessage: (error) =>
        error instanceof Error ? error.message : String(error),
      pushStep: (message) => {
        steps.push(message);
      },
      now: () => 1700000000000
    }
  };
}

const target = { targetRepo: "octo/app", envName: "dev" };

describe("isProtectedBranchFailure", () => {
  it.each([
    "HTTP 409: branch protection rules",
    "changes must be made through a pull request",
    "required status check is expected",
    "at least 1 approving review is required",
    "you do not have permission to push",
    "Resource not accessible by integration",
    "push declined due to repository rule violations",
    "HTTP 403: review is required"
  ])("treats %s as a protected-branch refusal", (stderr) => {
    expect(isProtectedBranchFailure(stderr)).toBe(true);
  });

  it("does not treat a missing workflow scope as a protected branch", () => {
    // A pull request cannot fix a missing token scope, so this must not divert
    // the commit into the PR fallback even though the message is an HTTP 403.
    expect(
      isProtectedBranchFailure(
        "HTTP 403: refusing to allow an OAuth App to create or update workflow `.github/workflows/x.yml` without `workflow` scope"
      )
    ).toBe(false);
  });

  it.each([
    ["HTTP 500: internal error"],
    [""],
    [undefined]
  ])("does not divert %s into the pull-request fallback", (stderr) => {
    expect(isProtectedBranchFailure(stderr as string)).toBe(false);
  });
});

describe("committing a workflow file", () => {
  it("commits straight to the default branch and reports no pull request", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 0 }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toEqual({ ok: true, viaPr: false });
    expect(committer.pullRequestState()).toBeUndefined();
    expect(h.steps).toEqual([]);
    expect(h.calls[1]?.args).toEqual([
      "api",
      "--method",
      "PUT",
      "/repos/octo/app/contents/.github/workflows/a.yml",
      "--input",
      "/tmp/body-1.json"
    ]);
    expect(JSON.parse(h.tempWrites[0] ?? "{}")).toEqual({
      message: "Add a",
      content: CONTENT
    });
  });

  it("updates an existing file by carrying its blob sha", async () => {
    const h = harness({
      runGh: [{ code: 0, stdout: "  abc123\n" }],
      runGhWorkflow: [{ code: 0 }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart(
      ".github/workflows/a.yml",
      CONTENT,
      "Update a"
    );
    expect(JSON.parse(h.tempWrites[0] ?? "{}")).toEqual({
      message: "Update a",
      content: CONTENT,
      sha: "abc123"
    });
  });

  it("removes the request body file after the commit, success or failure", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "HTTP 500" }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart("p", CONTENT, "m");
    expect(h.tempRemovals).toEqual(["/tmp/body-1.json"]);
  });

  it("surfaces a non-permission failure verbatim without opening a pull request", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "HTTP 500: server error" }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      stderr: "HTTP 500: server error",
      viaPr: false
    });
    expect(committer.pullRequestState()).toBeUndefined();
  });
});

describe("the protected-branch pull-request fallback", () => {
  it("creates a branch off the default branch head and re-commits there", async () => {
    const h = harness({
      runGh: [{ code: 1 }, { code: 1 }],
      runGhWorkflow: [
        { code: 1, stderr: "protected branch" },
        { code: 0 }
      ],
      defaultBranch: "trunk",
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({ ok: true, stderr: "", viaPr: true });
    expect(committer.pullRequestState()).toEqual({
      branch: "radius/setup-dev-workflows-1700000000000",
      base: "trunk"
    });
    expect(h.steps).toEqual([
      'ℹ️ No permission to push to "trunk" directly — committing workflows to branch "radius/setup-dev-workflows-1700000000000" and opening a pull request.'
    ]);
    // The retry reads the blob sha on the new ref, not on the default branch.
    expect(h.calls[2]?.args[1]).toBe(
      "/repos/octo/app/contents/p?ref=radius%2Fsetup-dev-workflows-1700000000000"
    );
    expect(JSON.parse(h.tempWrites[1] ?? "{}")).toMatchObject({
      branch: "radius/setup-dev-workflows-1700000000000"
    });
  });

  it("falls back to main when the repository reports no default branch", async () => {
    const h = harness({
      runGh: [{ code: 1 }, { code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }, { code: 0 }],
      defaultBranch: null,
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart("p", CONTENT, "m");
    expect(committer.pullRequestState()?.base).toBe("main");
  });

  it("sends every later commit to the established branch without probing the default branch again", async () => {
    const h = harness({
      runGh: [{ code: 1 }, { code: 1 }, { code: 1 }],
      runGhWorkflow: [
        { code: 1, stderr: "protected branch" },
        { code: 0 },
        { code: 0 }
      ],
      defaultBranch: "main",
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart("first", CONTENT, "m");
    await expect(
      committer.commitWorkflowFileSmart("second", CONTENT, "m")
    ).resolves.toEqual({ ok: true, stderr: "", viaPr: true });
    // `createBranchRef` is scripted once; a second branch creation would exhaust
    // it and throw, so a single announcement pins the laziness.
    expect(h.steps).toHaveLength(1);
  });

  it("reports a failed commit on the pull-request branch as a pull-request commit", async () => {
    const h = harness({
      runGh: [{ code: 1 }, { code: 1 }, { code: 1 }],
      runGhWorkflow: [
        { code: 1, stderr: "protected branch" },
        { code: 0 },
        { code: 1, stderr: "HTTP 422" }
      ],
      defaultBranch: "main",
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart("first", CONTENT, "m");
    await expect(
      committer.commitWorkflowFileSmart("second", CONTENT, "m")
    ).resolves.toEqual({ ok: false, stderr: "HTTP 422", viaPr: true });
  });

  it("keeps the original refusal and explains the fallback failure when the base head cannot be resolved", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }],
      defaultBranch: "main",
      headSha: null
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      stderr:
        'protected branch (PR fallback failed: could not resolve head of base branch "main")',
      viaPr: false
    });
    expect(committer.pullRequestState()).toBeUndefined();
  });

  it("keeps the original refusal when the branch cannot be created", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }],
      defaultBranch: "main",
      headSha: "sha-1",
      createBranch: { ok: false, stderr: "name already exists" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      stderr:
        'protected branch (PR fallback failed: could not create branch "radius/setup-dev-workflows-1700000000000": name already exists)',
      viaPr: false
    });
    expect(committer.pullRequestState()).toBeUndefined();
  });
});
