import {
  isProtectedBranchFailure,
  readWorkflowCommitProvenance,
  setupWorkflowBranchName
} from "./setup-workflow-committer.js";
import { describe, expect, it } from "vitest";
import { createWorkflowFileCommitter } from "./setup-workflow-committer.js";
import { setupEnvironmentHarness } from "../test/support/setup-environment.js";
import type { SetupWorkflowCommandResult } from "./setup-workflow-contracts.js";
import { ProviderMutationRecoveryError } from "./setup-recovery-error.js";

const target = { targetRepo: "octo/app", envName: "dev" };
const path = ".github/workflows/verify.yml";

function harness(results: Partial<SetupWorkflowCommandResult>[] = []) {
  const h = setupEnvironmentHarness();
  const calls: string[][] = [];
  const queue = [...results];
  const run = async (args: string[]) => {
    calls.push(args);
    const result = queue.shift();
    if (!result) throw new Error(`Unexpected read: ${args.join(" ")}`);
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  const ports = h.ports.workflowFiles({
    ...target,
    runGh: run,
    runGhWorkflow: async () => ({
      code: 0,
      stdout: '{"content":{"sha":"blob"},"commit":{"sha":"commit"}}',
      stderr: ""
    })
  });
  ports.mutationRecovery = h.ports.recovery;
  return { ...h, ports, calls };
}

describe("workflow publication recovery decisions", () => {
  it.each([
    ["not found", { code: 1, stderr: "HTTP 404" }, "absent"],
    ["denied", { code: 1, stderr: "HTTP 403" }, "HTTP 403"],
    ["missing diagnostic", { code: 1 }, "could not"],
    ["unreadable JSON", { stdout: "invalid" }, "unreadable"],
    ["missing object", { stdout: "{}" }, "did not report"],
    ["missing sha", { stdout: '{"object":{}}' }, "did not report"],
    [
      "replacement",
      { stdout: '{"object":{"sha":"replacement"}}' },
      "different commit"
    ]
  ] as const)(
    "reconciles a recorded branch with %s without repeating creation",
    async (_, read, expected) => {
      const h = harness([read]);
      h.mutations.push({
        mutationId: "branch",
        kind: "github_branch.create",
        target: "octo/app\0saved-branch\0base-sha",
        status: "prepared",
        evidence: null
      });
      const committer = createWorkflowFileCommitter(h.ports, target);
      if (expected === "absent") {
        await expect(
          committer.commitWorkflowFileSmart(path, "content", "message")
        ).rejects.toThrow('could not create branch "saved-branch"');
      } else {
        await expect(
          committer.commitWorkflowFileSmart(path, "content", "message")
        ).rejects.toThrow(expected);
      }
      expect(
        h.transcript.some((item) => Array.isArray(item) && item[0] === "branch")
      ).toBe(false);
      expect(h.calls).toHaveLength(1);
    }
  );

  it("does not accept a bare branch 404 without the enumeration proof", async () => {
    const h = harness([{ code: 1, stdout: "Not Found" }]);
    h.mutations.push({
      mutationId: "branch",
      kind: "github_branch.create",
      target: "octo/app\0saved\0base",
      status: "prepared",
      evidence: null
    });
    h.ports.proveBranchAbsent = async () => ({
      state: "unknown",
      detail: "listing forbidden"
    });
    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        path,
        "content",
        "message"
      )
    ).rejects.toThrow("could not be proven absent");
  });

  it.each(["pre-write", "after-prepare"] as const)(
    "observes stop %s on a direct contents write",
    async (when) => {
      const h = harness([{ code: 1, stderr: "HTTP 404" }]);
      const recovery = h.ports.mutationRecovery;
      if (!recovery) throw new Error("Missing recovery fixture");
      let stopObserved = when === "pre-write";
      h.ports.mutationRecovery = {
        ...recovery,
        beforeMutation: async () => !stopObserved
      };
      if (when === "after-prepare") {
        recovery.persist = async () => {
          stopObserved = true;
          h.stop();
        };
      }
      const result = await createWorkflowFileCommitter(
        h.ports,
        target
      ).commitWorkflowFileSmart(path, "content", "message");
      expect(result).toMatchObject({
        ok: false,
        changed: false,
        cancelled: true,
        viaPr: false
      });
      expect(
        h.transcript.some(
          (entry) => Array.isArray(entry) && entry[0] === "write"
        )
      ).toBe(false);
    }
  );

  it.each([
    ["absent", { code: 1, stderr: "HTTP 404" }, "not-applied"],
    ["empty diagnostic", { code: 1 }, "unreadable"],
    ["invalid JSON", { stdout: "{" }, "manual"],
    ["missing content", { stdout: '{"sha":"blob"}' }, "manual"],
    [
      "mismatched content",
      { stdout: '{"sha":"blob","content":"other"}' },
      "manual"
    ]
  ] as const)(
    "rereads an interrupted workflow that is %s",
    async (_, current, expected) => {
      const h = harness([{ stdout: "previous" }, current]);
      h.mutations.push({
        mutationId: "workflow",
        kind: "github_workflow.put",
        target: `octo/app:<default>:${path}`,
        status: "prepared",
        evidence: null,
        intent: {
          branch: "<default>",
          path,
          contentSha256: "digest:content",
          operationMarker: "marker",
          previousBlobKnown: true,
          previousBlobSha: null
        }
      });
      const pending = createWorkflowFileCommitter(
        h.ports,
        target
      ).commitWorkflowFileSmart(path, "content", "message");
      if (expected === "not-applied") {
        await expect(pending).resolves.toMatchObject({
          ok: false,
          stderr: "GitHub confirmed the workflow write was not applied."
        });
      } else if (expected === "unreadable") {
        await expect(pending).rejects.toThrow(
          "GitHub workflow state could not be read."
        );
      } else {
        await expect(pending).rejects.toBeInstanceOf(
          ProviderMutationRecoveryError
        );
      }
      expect(
        h.transcript.filter(
          (entry) => Array.isArray(entry) && entry[0] === "remove"
        )
      ).toEqual([["remove", "body.json"]]);
    }
  );

  it("does not accept identical content when the durable pre-write provenance disappeared", async () => {
    const h = harness([
      { stdout: "previous" },
      { stdout: '{"sha":"blob","content":"content"}' }
    ]);
    h.mutations.push({
      mutationId: "workflow",
      kind: "github_workflow.put",
      target: `octo/app:<default>:${path}`,
      status: "prepared",
      evidence: null
    });
    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        path,
        "content",
        "message"
      )
    ).rejects.toThrow("complete pre-write deletion provenance");
  });

  it.each(["before-branch", "after-branch-prepare"] as const)(
    "stops %s without the first fallback workflow write",
    async (when) => {
      const h = harness([{ code: 1, stderr: "HTTP 404" }]);
      const recovery = h.ports.mutationRecovery;
      if (!recovery) throw new Error("Missing recovery fixture");
      let observed = when === "before-branch";
      h.ports.mutationRecovery = {
        ...recovery,
        beforeMutation: async (kind) =>
          kind !== "github_branch.create" || !observed
      };
      h.ports.runGhWorkflow = async () => ({
        code: 1,
        stdout: "",
        stderr: "HTTP 403: protected branch"
      });
      if (when === "after-branch-prepare") {
        recovery.persist = async () => {
          if (h.mutations.at(-1)?.kind === "github_branch.create") {
            observed = true;
            h.stop();
          }
        };
      }
      expect(
        await createWorkflowFileCommitter(
          h.ports,
          target
        ).commitWorkflowFileSmart(path, "content", "message")
      ).toMatchObject({
        ok: false,
        changed: false,
        cancelled: true,
        viaPr: false
      });
      expect(
        h.transcript.some(
          (entry) => Array.isArray(entry) && entry[0] === "branch"
        )
      ).toBe(false);
    }
  );

  it("stops before a new write on a previously recorded fallback branch", async () => {
    const h = harness([{ stdout: "old" }]);
    h.mutations.push(
      {
        mutationId: "branch",
        kind: "github_branch.create",
        target: "octo/app\0saved\0base",
        status: "confirmed",
        evidence: null
      },
      {
        mutationId: "other",
        kind: "github_workflow.put",
        target: "other",
        status: "prepared",
        evidence: null,
        intent: { branch: "saved" }
      }
    );
    const recovery = h.ports.mutationRecovery;
    if (!recovery) throw new Error("Missing recovery fixture");
    h.ports.mutationRecovery = {
      ...recovery,
      beforeMutation: async () => false
    };
    expect(
      await createWorkflowFileCommitter(
        h.ports,
        target
      ).commitWorkflowFileSmart(path, "content", "message")
    ).toMatchObject({ ok: false, cancelled: true, viaPr: true });
  });

  it.each(["direct", "branch"] as const)(
    "preserves a recovery error from the %s intent checkpoint",
    async (phase) => {
      const h = harness([{ stdout: "old" }]);
      const recovery = h.ports.mutationRecovery;
      if (!recovery) throw new Error("Missing recovery fixture");
      const error = new ProviderMutationRecoveryError("save failed");
      recovery.persist = async () => {
        if (
          phase === "direct" ||
          h.mutations.at(-1)?.kind === "github_branch.create"
        )
          throw error;
      };
      h.ports.runGhWorkflow = async () => ({
        code: 1,
        stdout: "",
        stderr: "HTTP 403: protected branch"
      });
      await expect(
        createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
          path,
          "content",
          "message"
        )
      ).rejects.toBe(error);
    }
  );

  it.each(["direct", "branch"] as const)(
    "does not invent a successful stop when the %s caller has no stop handler",
    async (phase) => {
      const h = harness([{ stdout: "old" }]);
      const recovery = h.ports.mutationRecovery;
      if (!recovery) throw new Error("Missing recovery fixture");
      recovery.persist = async () => {
        if (
          phase === "direct" ||
          h.mutations.at(-1)?.kind === "github_branch.create"
        )
          h.stop();
      };
      h.ports.runGhWorkflow = async () => ({
        code: 1,
        stdout: "",
        stderr: "HTTP 403: protected branch"
      });
      await expect(
        createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
          path,
          "content",
          "message"
        )
      ).rejects.toMatchObject({ code: "provider-mutation-outcome-unknown" });
    }
  );

  it("preserves stdout evidence when the recovered-branch delete is definitively refused", async () => {
    const h = harness([{ stdout: '{"object":{"sha":"base"}}' }]);
    h.mutations.push({
      mutationId: "branch",
      kind: "github_branch.create",
      target: "octo/app\0saved\0base",
      status: "confirmed",
      evidence: null
    });
    const recovery = h.ports.mutationRecovery;
    if (!recovery) throw new Error("Missing recovery fixture");
    recovery.rollbackPending = () => true;
    h.ports.runGhWorkflow = async () => ({
      code: 1,
      stdout: "HTTP 403: forbidden",
      stderr: ""
    });
    await expect(
      createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
        path,
        "content",
        "message"
      )
    ).rejects.toThrow("HTTP 403: forbidden");
  });

  it.each([
    { code: 1, stdout: "", stderr: "HTTP 404" },
    { code: 0, stdout: '{"object":{"sha":"replacement"}}', stderr: "" }
  ])(
    "does not guess after branch state changes between enumeration and ref read: %j",
    async (current) => {
      const h = harness([{ stdout: '{"object":{"sha":"base"}}' }, current]);
      h.mutations.push(
        {
          mutationId: "branch",
          kind: "github_branch.create",
          target: "octo/app\0saved\0base",
          status: "confirmed",
          evidence: null
        },
        {
          mutationId: "delete",
          kind: "github_branch.delete",
          target: "octo/app\0saved\0base",
          status: "prepared",
          evidence: null
        }
      );
      const recovery = h.ports.mutationRecovery;
      if (!recovery) throw new Error("Missing recovery fixture");
      recovery.rollbackPending = () => true;
      h.ports.proveBranchAbsent = async () => ({
        state: "present",
        detail: "present at enumeration"
      });
      await expect(
        createWorkflowFileCommitter(h.ports, target).commitWorkflowFileSmart(
          path,
          "content",
          "message"
        )
      ).rejects.toMatchObject({ code: "provider-mutation-manual-required" });
    }
  );
});

describe("setup workflow branch identity", () => {
  it("uses the persisted operation suffix and a clock fallback", () => {
    expect(setupWorkflowBranchName("dev", "op_abcdef123456789", 99)).toBe(
      "radius/setup-dev-workflows-abcdef123456"
    );
    expect(setupWorkflowBranchName("dev", "", 99)).toBe(
      "radius/setup-dev-workflows-99"
    );
  });
});

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

describe("reading a contents-API write back", () => {
  it("reads the commit and blob identities GitHub reported", () => {
    expect(
      readWorkflowCommitProvenance(
        '{"content":{"sha":"blob-1"},"commit":{"sha":"commit-1"}}'
      )
    ).toEqual({
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
});
