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
