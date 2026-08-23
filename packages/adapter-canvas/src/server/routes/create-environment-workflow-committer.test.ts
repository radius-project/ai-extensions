import { describe, expect, it } from "vitest";
import {
  createOperation,
  fromPersistedOperation,
  prepareProviderMutation,
  providerRecoveryManualGuidance,
  toPersistedOperation
} from "../../operations.js";
import {
  createWorkflowFileCommitter,
  isProtectedBranchFailure,
  readWorkflowCommitProvenance,
  workflowContentDigest,
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
  createBranch?: { ok: boolean; stderr: string; timedOut?: boolean };
}

interface Harness {
  ports: WorkflowFileCommitterPorts;
  calls: GhCall[];
  steps: string[];
  tempWrites: string[];
  tempRemovals: string[];
}

const CONTENT = Buffer.from("on: push").toString("base64");
// sha256 of the exact bytes CONTENT carries, written out rather than recomputed
// with the production formula so a change to that formula is visible here.
const CONTENT_DIGEST =
  "fff71b97a5a9494941aa5f1ec40300f7e40c4d68b3890ca7a3f27b8f6270763a";
// What the contents API answers a successful write with.
const PUT_RESPONSE = JSON.stringify({
  content: { sha: "blob-1" },
  commit: { sha: "commit-1" }
});
const NO_PROVENANCE = {
  commitSha: null,
  blobSha: null,
  contentSha256: CONTENT_DIGEST,
  previousBlobSha: null,
  previousBlobKnown: false
};
const KNOWN_ABSENT_PROVENANCE = {
  ...NO_PROVENANCE,
  previousBlobKnown: true
};

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
      stderr: next.stderr ?? "",
      ...(next.timedOut ? { timedOut: true } : {})
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

  it.each([["HTTP 500: internal error"], [""], [undefined]])(
    "does not divert %s into the pull-request fallback",
    (stderr) => {
      expect(isProtectedBranchFailure(stderr as string)).toBe(false);
    }
  );
});

describe("committing a workflow file", () => {
  it("adopts an exact workflow write after a timed-out response", async () => {
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        {
          code: 0,
          stdout: JSON.stringify([
            {
              sha: "a".repeat(40),
              commit: {
                message:
                  "Add a\n\nRadius-Operation: radius-operation:op_workflow:workflow:fff71b97a5a94949"
              }
            }
          ])
        }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      operation,
      persist: async () => {}
    };
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toMatchObject({
      ok: true,
      viaPr: false,
      commitSha: "a".repeat(40),
      blobSha: "blob-recovered",
      contentSha256: CONTENT_DIGEST,
      previousBlobKnown: true
    });
    expect(
      h.calls.filter((call) => call.kind === "runGhWorkflow")
    ).toHaveLength(1);
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "confirmed",
      intent: {
        branch: "<default>",
        path: ".github/workflows/a.yml",
        previousBlobSha: null,
        previousBlobKnown: true,
        contentSha256: CONTENT_DIGEST
      }
    });
  });

  it("restores the pre-write blob and exact commit after a lost response and restart", async () => {
    const first = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        { code: 1, stderr: "commit history temporarily unavailable" }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    first.ports.mutationRecovery = {
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(first.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });

    const restored = fromPersistedOperation(toPersistedOperation(operation));
    const second = harness({
      runGh: [
        { code: 0, stdout: "blob-recovered" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        {
          code: 0,
          stdout: JSON.stringify([
            {
              sha: "b".repeat(40),
              commit: {
                message:
                  "Add a\n\nRadius-Operation: radius-operation:op_workflow:workflow:fff71b97a5a94949"
              }
            }
          ])
        }
      ]
    });
    second.ports.mutationRecovery = {
      operation: restored,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(second.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toMatchObject({
      ok: true,
      commitSha: "b".repeat(40),
      blobSha: "blob-recovered",
      previousBlobSha: null,
      previousBlobKnown: true
    });
    expect(
      second.calls.filter((call) => call.kind === "runGhWorkflow")
    ).toEqual([]);
  });

  it("fails closed when exact created commit provenance cannot be recovered", async () => {
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({ sha: "blob-recovered", content: CONTENT })
        },
        { code: 0, stdout: "[]" }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: expect.stringContaining("one exact commit")
    });
    expect(operation.providerRecovery.mutations[0]).toMatchObject({
      status: "manual_required"
    });
  });

  it("fails closed when the workflow path changed after a timed-out response", async () => {
    const otherContent = Buffer.from("different").toString("base64");
    const h = harness({
      runGh: [
        { code: 1, stderr: "HTTP 404: Not Found" },
        {
          code: 0,
          stdout: JSON.stringify({
            sha: "blob-other",
            content: otherContent
          })
        }
      ],
      runGhWorkflow: [{ code: 1, timedOut: true }]
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      operation,
      persist: async () => {}
    };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).rejects.toMatchObject({
      code: "provider-mutation-manual-required",
      message: expect.stringContaining("will not overwrite or remove it")
    });
    expect(operation.providerRecovery.state).toBe("manual_required");
  });

  it("commits straight to the default branch and reports no pull request", async () => {
    const h = harness({
      runGh: [{ code: 1, stderr: "HTTP 404: Not Found" }],
      runGhWorkflow: [{ code: 0 }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toEqual({
      ok: true,
      stderr: "",
      viaPr: false,
      ...KNOWN_ABSENT_PROVENANCE
    });
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
      runGh: [{ code: 1, stderr: "HTTP 404: Not Found" }],
      runGhWorkflow: [{ code: 1, stderr: "HTTP 500" }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await committer.commitWorkflowFileSmart("p", CONTENT, "m");
    expect(h.tempRemovals).toEqual(["/tmp/body-1.json"]);
  });

  it("captures the commit, blob and content identities of a successful write", async () => {
    const h = harness({
      runGh: [{ code: 1, stderr: "HTTP 404: Not Found" }],
      runGhWorkflow: [{ code: 0, stdout: PUT_RESPONSE }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    // Everything a later rollback needs to prove this file is still Radius's
    // own work, captured at the moment of the write rather than reconstructed.
    await expect(
      committer.commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Add a"
      )
    ).resolves.toEqual({
      ok: true,
      stderr: "",
      viaPr: false,
      commitSha: "commit-1",
      blobSha: "blob-1",
      contentSha256: CONTENT_DIGEST,
      previousBlobSha: null,
      previousBlobKnown: true
    });
  });

  it("records the blob it replaced so a rollback can restore it", async () => {
    const h = harness({
      runGh: [{ code: 0, stdout: "  existing-blob\n" }],
      runGhWorkflow: [{ code: 0, stdout: PUT_RESPONSE }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart(
        ".github/workflows/a.yml",
        CONTENT,
        "Update a"
      )
    ).resolves.toMatchObject({ previousBlobSha: "existing-blob" });
    await expect(
      createWorkflowFileCommitter(
        harness({
          runGh: [{ code: 1, stderr: "HTTP 500" }],
          runGhWorkflow: [{ code: 0, stdout: PUT_RESPONSE }]
        }).ports,
        target
      ).commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toMatchObject({ previousBlobKnown: false });
  });

  it("keeps a failed commit free of provenance", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "HTTP 500" }]
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({ ok: false, stderr: "HTTP 500", viaPr: false });
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

describe("reading a contents-API write back", () => {
  it("reads the commit and blob identities GitHub reported", () => {
    expect(readWorkflowCommitProvenance(PUT_RESPONSE)).toEqual({
      commitSha: "commit-1",
      blobSha: "blob-1"
    });
  });

  it.each([
    ["empty output", ""],
    ["unparseable output", "not json"],
    ["a JSON scalar", "42"],
    ["an object with no identities", '{"content":{},"commit":{}}'],
    ["an object with neither key", "{}"],
    ["blank identities", '{"content":{"sha":"  "},"commit":{"sha":""}}'],
    ["non-string identities", '{"content":{"sha":7},"commit":{"sha":null}}']
  ])("reports no provenance for %s rather than guessing", (_label, stdout) => {
    expect(readWorkflowCommitProvenance(stdout)).toEqual({
      commitSha: null,
      blobSha: null
    });
  });

  it("reports no provenance when the response is undefined", () => {
    expect(readWorkflowCommitProvenance(undefined)).toEqual({
      commitSha: null,
      blobSha: null
    });
  });

  it("digests the exact bytes a base64 body carries", () => {
    expect(workflowContentDigest(CONTENT)).toBe(CONTENT_DIGEST);
    // Base64 is permissive, so an unusable value degrades to "no digest"
    // rather than to a digest of something else.
    expect(workflowContentDigest("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("the protected-branch pull-request fallback", () => {
  it("adopts a timed-out operation-specific branch without creating a duplicate", async () => {
    const h = harness({
      runGh: [
        { code: 1 },
        {
          code: 0,
          stdout: JSON.stringify({ object: { sha: "sha-1" } })
        },
        { code: 1, stderr: "HTTP 404: Not Found" }
      ],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }, { code: 0 }],
      defaultBranch: "main",
      headSha: "sha-1",
      createBranch: { ok: false, stderr: "terminated", timedOut: true }
    });
    const operation = createOperation({ operationId: "op_workflow" });
    h.ports.mutationRecovery = {
      operation,
      persist: async () => {}
    };
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toMatchObject({ ok: true, viaPr: true });
    expect(operation.providerRecovery.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "github_branch.create",
          status: "confirmed"
        })
      ])
    );
  });

  it("removes a recovered empty setup branch before automatic rollback", async () => {
    const h = harness({
      runGh: [
        { code: 1 },
        {
          code: 0,
          stdout: JSON.stringify({ object: { sha: "sha-1" } })
        }
      ],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }, { code: 0 }],
      defaultBranch: "main",
      headSha: "sha-1"
    });
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: "octo/app\0radius/setup-dev-workflows-workflow\0sha-1",
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    h.ports.mutationRecovery = {
      operation,
      persist: async () => {}
    };
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toMatchObject({
      ok: false,
      stderr: expect.stringContaining(
        "Radius reconciled and removed recovered setup branch"
      )
    });
    expect(
      h.calls.filter(
        (call) => call.kind === "runGhWorkflow" && call.args.includes("DELETE")
      )
    ).toHaveLength(1);
  });

  it("reports no removal and starts no rollback when GitHub refuses the delete", async () => {
    const h = harness({
      runGh: [
        { code: 1 },
        { code: 0, stdout: JSON.stringify({ object: { sha: "sha-1" } }) }
      ],
      runGhWorkflow: [
        { code: 1, stderr: "protected branch" },
        { code: 1, stderr: "HTTP 403: Required status check is not met" }
      ],
      defaultBranch: "main",
      headSha: "sha-1"
    });
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: "octo/app\0radius/setup-dev-workflows-workflow\0sha-1",
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    h.ports.mutationRecovery = { operation, persist: async () => {} };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).resolves.toMatchObject({
      ok: false,
      stderr: expect.stringContaining("could not remove the setup branch")
    });
    // One delete attempt, never repeated, and no rollback claimed off the back
    // of a removal that did not happen.
    expect(
      h.calls.filter(
        (call) => call.kind === "runGhWorkflow" && call.args.includes("DELETE")
      )
    ).toHaveLength(1);
    expect(operation.providerRecovery.state).toBe("rollback_pending");
    expect(
      operation.providerRecovery.mutations.find(
        (entry: { kind: string }) => entry.kind === "github_branch.delete"
      )
    ).toMatchObject({ status: "manual_required" });
    // Manual guidance is what stops the automatic rollback from starting off a
    // removal that never happened; the record still offers a customer-driven
    // rollback for the resources Radius can prove it owns.
    expect(providerRecoveryManualGuidance(operation)).toContain(
      "Remove that exact branch yourself"
    );
  });

  it("leaves the delete unresolved when its answer is lost rather than refused", async () => {
    const h = harness({
      runGh: [
        { code: 1 },
        { code: 0, stdout: JSON.stringify({ object: { sha: "sha-1" } }) },
        // The reconcile read that follows the lost delete.
        { code: 1, stderr: "HTTP 500: server error" }
      ],
      runGhWorkflow: [
        { code: 1, stderr: "protected branch" },
        { code: 1, stderr: "socket hang up" }
      ],
      defaultBranch: "main",
      headSha: "sha-1"
    });
    const operation = createOperation({ operationId: "op_workflow" });
    operation.recoveryState = "provider_reconciliation_pending";
    prepareProviderMutation(operation, {
      kind: "github_branch.create",
      target: "octo/app\0radius/setup-dev-workflows-workflow\0sha-1",
      providerIdempotencyKey: "radius/setup-dev-workflows-workflow"
    });
    h.ports.mutationRecovery = { operation, persist: async () => {} };

    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        "p",
        CONTENT,
        "m"
      )
    ).resolves.toMatchObject({ ok: false });
    expect(
      operation.providerRecovery.mutations.find(
        (entry: { kind: string }) => entry.kind === "github_branch.delete"
      )
    ).toMatchObject({ status: "outcome_unknown" });
    expect(
      h.calls.filter(
        (call) => call.kind === "runGhWorkflow" && call.args.includes("DELETE")
      )
    ).toHaveLength(1);
  });

  it("creates a branch off the default branch head and re-commits there", async () => {
    const h = harness({
      runGh: [{ code: 1 }, { code: 1, stderr: "HTTP 404: Not Found" }],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }, { code: 0 }],
      defaultBranch: "trunk",
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: true,
      stderr: "",
      viaPr: true,
      ...KNOWN_ABSENT_PROVENANCE
    });
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

  it("refuses PR fallback when the repository reports no default branch", async () => {
    const h = harness({
      runGh: [{ code: 1 }],
      runGhWorkflow: [{ code: 1, stderr: "protected branch" }],
      defaultBranch: null
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      stderr:
        "protected branch (PR fallback failed: could not resolve the repository default branch)",
      viaPr: false
    });
    expect(committer.pullRequestState()).toBeUndefined();
  });

  it("reports the branch commit failure when the fallback commit is refused too", async () => {
    const h = harness({
      runGh: [{ code: 1 }, { code: 1 }],
      runGhWorkflow: [
        { code: 1, stderr: "protected branch" },
        { code: 1, stderr: "HTTP 422: branch is behind" }
      ],
      defaultBranch: "trunk",
      headSha: "sha-1",
      createBranch: { ok: true, stderr: "" }
    });
    const committer = createWorkflowFileCommitter(h.ports, target);

    // The branch exists, so the failure belongs to it: no provenance is
    // reported, and the caller is told the commit went through the pull-request
    // path.
    await expect(
      committer.commitWorkflowFileSmart("p", CONTENT, "m")
    ).resolves.toEqual({
      ok: false,
      stderr: "HTTP 422: branch is behind",
      viaPr: true
    });
    expect(committer.pullRequestState()).toMatchObject({ base: "trunk" });
  });

  it("sends every later commit to the established branch without probing the default branch again", async () => {
    const h = harness({
      runGh: [
        { code: 1 },
        { code: 1, stderr: "HTTP 404: Not Found" },
        { code: 1, stderr: "HTTP 404: Not Found" }
      ],
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
    ).resolves.toEqual({
      ok: true,
      stderr: "",
      viaPr: true,
      ...KNOWN_ABSENT_PROVENANCE
    });
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
