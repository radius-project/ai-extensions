import { describe, expect, it } from "vitest";
import {
  publishSetupWorkflowFiles,
  type WorkflowPublisherPorts,
  type SetupWorkflowCommitRecord,
  type SetupWorkflowPublicationEvent
} from "./setup-workflow-publication.js";
import type { WorkflowCommitOutcome } from "./setup-workflow-contracts.js";
import { ProviderMutationRecoveryError } from "./setup-recovery-error.js";

function harness(outcomes: WorkflowCommitOutcome[]) {
  const calls: unknown[] = [];
  const records: SetupWorkflowCommitRecord[] = [];
  const events: SetupWorkflowPublicationEvent[] = [];
  const ports: WorkflowPublisherPorts = {
    generateVerifyWorkflow: async () => "verify",
    generateDeployWorkflow: async () => ({ "deploy.yml": "deploy" }),
    generateDeleteWorkflow: async () => ({ "delete.yml": "delete" }),
    encode: (content) => `encoded:${content}`,
    commitWorkflowFileSmart: async (path, content, message) => {
      calls.push({ path, content, message });
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("Unexpected workflow write");
      return outcome;
    },
    recordCommittedWorkflowFile: (record) => {
      records.push(record);
      calls.push(record);
    },
    deleteLegacyDeployWorkflow: async () => {
      calls.push("legacy-delete");
      return true;
    },
    pullRequestBranch: () => "setup-branch",
    report: (event) => {
      events.push(event);
    },
    gate: async () => {
      calls.push("checkpoint");
      return true;
    }
  };
  const target = {
    targetRepo: "octo/app",
    envName: "dev",
    provider: "azure",
    defaultBranch: "trunk"
  };
  return { ports, target, calls, records, events };
}
const changed = { ok: true, changed: true, viaPr: false };

describe("setup workflow publication", () => {
  it("forwards the approved marker and exact encoded content to publication ports", async () => {
    const h = harness([changed, changed, changed]);
    const generated: unknown[] = [];
    h.ports.generateVerifyWorkflow = async (...args) => {
      generated.push(args);
      return "verify";
    };
    await publishSetupWorkflowFiles(h.ports, {
      ...h.target,
      setupPushOperationMarker: "op-1"
    });
    expect(generated).toEqual([["dev", "azure", "op-1"]]);
    expect(h.calls).toContainEqual({
      path: ".github/workflows/radius-verify-credentials.yml",
      content: "encoded:verify",
      message: "Add Radius verify-credentials workflow for environment dev"
    });
    expect(h.calls).toContainEqual({
      path: ".github/workflows/deploy.yml",
      content: "encoded:deploy",
      message: "Add Radius deploy workflow (deploy.yml) for environment dev"
    });
  });

  it("retains the exact proof from each changed file rather than sharing provenance", async () => {
    const outcomes = [1, 2, 3].map((id) => ({
      ...changed,
      commitSha: `commit-${id}`,
      blobSha: `blob-${id}`,
      contentSha256: `digest-${id}`,
      previousBlobSha: id === 2 ? "previous-deploy" : null,
      previousBlobKnown: true
    }));
    const h = harness([...outcomes]);
    await publishSetupWorkflowFiles(h.ports, h.target);
    for (const [index, outcome] of outcomes.entries()) {
      expect(h.records[index]).toMatchObject({
        commitSha: outcome.commitSha,
        blobSha: outcome.blobSha,
        contentSha256: outcome.contentSha256,
        previousBlobSha: outcome.previousBlobSha,
        previousBlobKnown: true
      });
    }
  });

  it("does not journal unchanged files and reports all three workflows unchanged", async () => {
    const h = harness(
      Array.from({ length: 3 }, () => ({ ...changed, changed: false }))
    );
    expect(await publishSetupWorkflowFiles(h.ports, h.target)).toEqual({
      outcome: "published"
    });
    expect(h.records).toEqual([]);
    expect(h.calls.filter((call) => call === "checkpoint")).toHaveLength(4);
    expect(h.events).toEqual([
      { kind: "checking", workflow: "verify" },
      { kind: "verify-completed", changed: false },
      { kind: "checking", workflow: "deploy" },
      { kind: "deploy-completed", changed: false },
      { kind: "checking", workflow: "delete" },
      { kind: "delete-completed", outcome: "unchanged" }
    ]);
  });

  it.each([null, "setup-branch"])(
    "removes the legacy workflow on the receiving branch %j",
    async (branch) => {
      const h = harness([changed, changed, changed]);
      h.ports.pullRequestBranch = () => branch;
      const deletions: unknown[] = [];
      h.ports.deleteLegacyDeployWorkflow = async (...args) => {
        deletions.push(args);
        return true;
      };
      await publishSetupWorkflowFiles(h.ports, h.target);
      expect(deletions).toEqual([["octo/app", branch || undefined]]);
    }
  );

  it.each([1, 2, 3, 4])(
    "stops publication after checkpoint %i refuses",
    async (stopAt) => {
      const h = harness([changed, changed, changed]);
      let gates = 0;
      h.ports.gate = async () => ++gates !== stopAt;
      expect(await publishSetupWorkflowFiles(h.ports, h.target)).toEqual({
        outcome: "cancelled"
      });
      expect(h.records).toHaveLength(
        stopAt === 1 ? 1
        : stopAt === 4 ? 3
        : 2
      );
      expect(gates).toBe(stopAt);
    }
  );

  it.each(["verify", "legacy", "verify-refusal"] as const)(
    "retains cancellation at %s without later writes",
    async (boundary) => {
      const h = harness([
        boundary === "verify" ? { ...changed, cancelled: true }
        : boundary === "verify-refusal" ? { ...changed, ok: false }
        : changed,
        changed
      ]);
      let gates = 0;
      h.ports.gate = async () => {
        gates++;
        return boundary !== "verify-refusal";
      };
      h.ports.deleteLegacyDeployWorkflow = async () => "cancelled";
      expect(await publishSetupWorkflowFiles(h.ports, h.target)).toEqual({
        outcome: "cancelled"
      });
      expect(h.records).toHaveLength(boundary === "legacy" ? 2 : 0);
      expect(gates).toBe(
        boundary === "verify" ? 0
        : boundary === "legacy" ? 2
        : 1
      );
    }
  );

  it.each(["HTTP 404", undefined])(
    "keeps delete refusal %j best effort without journaling a write",
    async (stderr) => {
      const h = harness([changed, changed, { ...changed, ok: false, stderr }]);
      expect(await publishSetupWorkflowFiles(h.ports, h.target)).toEqual({
        outcome: "published"
      });
      expect(h.events.slice(-2)).toEqual([
        {
          kind: "delete-commit-failed",
          fileName: "delete.yml",
          stderr: stderr || ""
        },
        { kind: "delete-completed", outcome: "warnings" }
      ]);
      expect(h.records).toHaveLength(2);
      expect(h.calls.filter((call) => call === "checkpoint")).toHaveLength(4);
    }
  );

  it("reports an ordinary delete generator failure but does not fail setup", async () => {
    const error = new Error("generator exploded");
    const h = harness([changed, changed]);
    h.ports.generateDeleteWorkflow = async () => {
      throw error;
    };
    expect(await publishSetupWorkflowFiles(h.ports, h.target)).toEqual({
      outcome: "published"
    });
    expect(h.events.at(-1)).toEqual({
      kind: "delete-generation-failed",
      error
    });
    expect(h.records).toHaveLength(2);
  });

  it("publishes every generated deploy file before any delete file", async () => {
    const h = harness(Array.from({ length: 5 }, () => changed));
    h.ports.generateDeployWorkflow = async () => ({
      "dispatcher.yml": "dispatcher",
      "azure.yml": "azure",
      "aws.yml": "aws"
    });
    await publishSetupWorkflowFiles(h.ports, h.target);
    expect(h.records.map((record) => record.path)).toEqual([
      ".github/workflows/radius-verify-credentials.yml",
      ".github/workflows/dispatcher.yml",
      ".github/workflows/azure.yml",
      ".github/workflows/aws.yml",
      ".github/workflows/delete.yml"
    ]);
  });

  it("records exact provenance before every checkpoint and keeps the legacy removal between deploy and delete", async () => {
    const h = harness([changed, { ...changed, viaPr: true }, changed]);
    expect(await publishSetupWorkflowFiles(h.ports, h.target)).toEqual({
      outcome: "published"
    });
    expect(h.records).toEqual([
      {
        path: ".github/workflows/radius-verify-credentials.yml",
        branch: "trunk",
        mode: "default_branch",
        commitSha: null,
        blobSha: null,
        contentSha256: null,
        previousBlobSha: null,
        previousBlobKnown: false
      },
      {
        path: ".github/workflows/deploy.yml",
        branch: "setup-branch",
        mode: "pull_request",
        commitSha: null,
        blobSha: null,
        contentSha256: null,
        previousBlobSha: null,
        previousBlobKnown: false
      },
      {
        path: ".github/workflows/delete.yml",
        branch: "trunk",
        mode: "default_branch",
        commitSha: null,
        blobSha: null,
        contentSha256: null,
        previousBlobSha: null,
        previousBlobKnown: false
      }
    ]);
    for (const record of h.records)
      expect(h.calls[h.calls.indexOf(record) + 1]).toBe("checkpoint");
    expect(h.calls.indexOf("legacy-delete")).toBeGreaterThan(
      h.calls.indexOf(h.records[1])
    );
    expect(h.calls.indexOf("legacy-delete")).toBeLessThan(
      h.calls.indexOf(h.records[2])
    );
  });

  it.each(["verify", "deploy"] as const)(
    "fails required %s without a presentation or HTTP envelope",
    async (workflow) => {
      const h = harness([
        ...(workflow === "deploy" ? [changed] : []),
        { ok: false, changed: false, viaPr: false }
      ]);
      expect(await publishSetupWorkflowFiles(h.ports, h.target)).toEqual({
        outcome: "refused",
        workflow,
        path:
          workflow === "verify" ?
            ".github/workflows/radius-verify-credentials.yml"
          : ".github/workflows/deploy.yml",
        stderr: ""
      });
      expect(h.calls.at(-1)).toBe("checkpoint");
    }
  );

  it("keeps delete rejection best effort but propagates the same recovery exception", async () => {
    const h = harness([
      changed,
      changed,
      { ok: false, changed: false, viaPr: false }
    ]);
    expect(await publishSetupWorkflowFiles(h.ports, h.target)).toEqual({
      outcome: "published"
    });
    expect(h.events.at(-1)).toEqual({
      kind: "delete-completed",
      outcome: "warnings"
    });
    const error = new ProviderMutationRecoveryError(
      "unresolved",
      "provider-mutation-outcome-unknown"
    );
    const failed = harness([changed, changed]);
    failed.ports.generateDeleteWorkflow = async () => {
      throw error;
    };
    await expect(
      publishSetupWorkflowFiles(failed.ports, failed.target)
    ).rejects.toBe(error);
  });

  it.each([
    "deploy-write",
    "deploy-refusal-gate",
    "deploy-checkpoint",
    "delete-write"
  ])("stops at %s without publishing subsequent files", async (boundary) => {
    const h = harness([
      changed,
      boundary === "deploy-write" ?
        { ok: false, changed: false, viaPr: false, cancelled: true }
      : boundary === "deploy-refusal-gate" ?
        { ok: false, changed: false, viaPr: false }
      : changed,
      boundary === "delete-write" ?
        { ok: false, changed: false, viaPr: false, cancelled: true }
      : changed
    ]);
    let gates = 0;
    h.ports.gate = async () => {
      gates++;
      return !(
        (boundary === "deploy-refusal-gate" ||
          boundary === "deploy-checkpoint") &&
        gates === 2
      );
    };
    expect(await publishSetupWorkflowFiles(h.ports, h.target)).toEqual({
      outcome: "cancelled"
    });
    expect(h.records.some((record) => record.path.endsWith("delete.yml"))).toBe(
      false
    );
  });

  it("lets the stop checkpoint win after a failed legacy removal", async () => {
    const h = harness([changed, changed]);
    h.ports.deleteLegacyDeployWorkflow = async () => {
      throw new Error("legacy removal refused");
    };
    let gates = 0;
    h.ports.gate = async () => ++gates < 3;
    expect(await publishSetupWorkflowFiles(h.ports, h.target)).toEqual({
      outcome: "cancelled"
    });
    expect(h.records).toHaveLength(2);
  });
});
