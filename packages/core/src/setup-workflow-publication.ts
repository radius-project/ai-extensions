import type { WorkflowCommitOutcome } from "./setup-workflow-contracts.js";
import { ProviderMutationRecoveryError } from "./setup-recovery-error.js";
export const VERIFY_WORKFLOW_PATH =
  ".github/workflows/radius-verify-credentials.yml";
export type SetupWorkflowPublicationEvent =
  | { kind: "checking"; workflow: "verify" | "deploy" | "delete" }
  | { kind: "commit-failed"; workflow: "verify" }
  | { kind: "commit-failed"; workflow: "deploy"; fileName: string }
  | { kind: "verify-completed" | "deploy-completed"; changed: boolean }
  | { kind: "delete-completed"; outcome: "warnings" | "changed" | "unchanged" }
  | { kind: "delete-commit-failed"; fileName: string; stderr: string }
  | { kind: "delete-generation-failed"; error: unknown };
export type WorkflowPublishResult =
  | {
      outcome: "refused";
      workflow: "verify" | "deploy";
      path: string;
      stderr: string;
    }
  | { outcome: "cancelled" | "published" };
export interface SetupWorkflowCommitRecord {
  path: string;
  branch: string | null;
  mode: string;
  commitSha: string | null;
  blobSha: string | null;
  contentSha256: string | null;
  previousBlobSha: string | null;
  previousBlobKnown: boolean;
}
export interface WorkflowPublisherPorts {
  generateVerifyWorkflow(
    environment: string,
    provider: string,
    marker?: string
  ): Promise<string>;
  generateDeployWorkflow(
    environment: string,
    appFile: string
  ): Promise<Record<string, string>>;
  generateDeleteWorkflow(environment: string): Promise<Record<string, string>>;
  commitWorkflowFileSmart(
    path: string,
    content: string,
    message: string
  ): Promise<WorkflowCommitOutcome>;
  recordCommittedWorkflowFile(entry: SetupWorkflowCommitRecord): void;
  deleteLegacyDeployWorkflow(
    repo: string,
    branch?: string
  ): Promise<boolean | "cancelled">;
  pullRequestBranch(): string | null;
  gate(): Promise<boolean>;
  encode(content: string): string;
  report(event: SetupWorkflowPublicationEvent): void;
}
export interface WorkflowPublisherTarget {
  targetRepo: string;
  envName: string;
  provider: string;
  defaultBranch: string;
  setupPushOperationMarker?: string;
}
export async function publishSetupWorkflowFiles(
  ports: WorkflowPublisherPorts,
  target: WorkflowPublisherTarget
): Promise<WorkflowPublishResult> {
  const {
    targetRepo,
    envName,
    provider,
    defaultBranch,
    setupPushOperationMarker
  } = target;
  // Every field a rollback needs to prove this exact write, recorded with the
  // file rather than derived later: the branch it landed on, the commit it
  // created, the blob it produced, the digest of the bytes Radius sent, and the
  // blob the path held before.
  const commitRecord = (path: string, commit: WorkflowCommitOutcome) => ({
    path,
    branch: commit.viaPr ? ports.pullRequestBranch() : defaultBranch,
    mode: commit.viaPr ? "pull_request" : "default_branch",
    commitSha: commit.commitSha ?? null,
    blobSha: commit.blobSha ?? null,
    contentSha256: commit.contentSha256 ?? null,
    previousBlobSha: commit.previousBlobSha ?? null,
    previousBlobKnown: commit.previousBlobKnown === true
  });

  // Step 3: Commit the verify-credentials workflow
  ports.report({ kind: "checking", workflow: "verify" });
  const verifyWorkflow = await ports.generateVerifyWorkflow(
    envName,
    provider,
    setupPushOperationMarker
  );
  const verifyContent = ports.encode(verifyWorkflow);

  const verifyCommit = await ports.commitWorkflowFileSmart(
    VERIFY_WORKFLOW_PATH,
    verifyContent,
    "Add Radius verify-credentials workflow for environment " + envName
  );
  if (verifyCommit.cancelled) return { outcome: "cancelled" };

  if (!verifyCommit.ok) {
    ports.report({ kind: "commit-failed", workflow: "verify" });
    if (!(await ports.gate())) return { outcome: "cancelled" };
    return {
      outcome: "refused",
      workflow: "verify",
      path: VERIFY_WORKFLOW_PATH,
      stderr: verifyCommit.stderr || ""
    };
  }
  if (verifyCommit.changed) {
    ports.report({ kind: "verify-completed", changed: true });
  } else {
    ports.report({ kind: "verify-completed", changed: false });
  }
  if (verifyCommit.changed) {
    ports.recordCommittedWorkflowFile(
      commitRecord(VERIFY_WORKFLOW_PATH, verifyCommit)
    );
  }
  if (!(await ports.gate())) return { outcome: "cancelled" };

  // Step 4: Also commit the deploy workflows (dispatcher + both provider
  // workflows). The dispatcher references both provider files by path, so all
  // three must exist in the target repo.
  ports.report({ kind: "checking", workflow: "deploy" });
  let deployChanges = 0;
  const deployWorkflows = await ports.generateDeployWorkflow(
    envName,
    ".radius/app.bicep"
  );

  for (const [fileName, content] of Object.entries(deployWorkflows)) {
    const deployContent = ports.encode(content);
    const deployPath = ".github/workflows/" + fileName;

    const deployCommit = await ports.commitWorkflowFileSmart(
      deployPath,
      deployContent,
      "Add Radius deploy workflow (" + fileName + ") for environment " + envName
    );
    if (deployCommit.cancelled) return { outcome: "cancelled" };

    if (!deployCommit.ok) {
      ports.report({ kind: "commit-failed", workflow: "deploy", fileName });
      if (!(await ports.gate())) return { outcome: "cancelled" };
      return {
        outcome: "refused",
        workflow: "deploy",
        path: deployPath,
        stderr: deployCommit.stderr || ""
      };
    }
    if (deployCommit.changed) {
      deployChanges += 1;
      ports.recordCommittedWorkflowFile(commitRecord(deployPath, deployCommit));
    }
    if (!(await ports.gate())) return { outcome: "cancelled" };
  }
  // Remove the legacy monolithic deploy workflow so it cannot double-trigger
  // alongside the new dispatcher. On protected repositories the deletion is
  // committed to the setup branch and lands with the rest of the workflow PR.
  try {
    const legacyDelete = await ports.deleteLegacyDeployWorkflow(
      targetRepo,
      ports.pullRequestBranch() || undefined
    );
    if (legacyDelete === "cancelled") return { outcome: "cancelled" };
  } catch (error) {
    if (!(await ports.gate())) return { outcome: "cancelled" };
    throw error;
  }
  if (!(await ports.gate())) return { outcome: "cancelled" };
  if (deployChanges > 0) {
    ports.report({ kind: "deploy-completed", changed: true });
  } else {
    ports.report({ kind: "deploy-completed", changed: false });
  }

  // Step 4b: Commit the application-delete workflows (dispatcher + Azure
  // provider workflow) so the Delete Deployment button can dispatch `rad app
  // delete`. Only Azure workflows are generated and committed; the AWS provider
  // file is never produced.
  ports.report({ kind: "checking", workflow: "delete" });
  try {
    let deleteChanges = 0;
    let deleteFailures = 0;
    const deleteWorkflows = await ports.generateDeleteWorkflow(envName);
    for (const [fileName, content] of Object.entries(deleteWorkflows)) {
      const delContent = ports.encode(content);
      const delPath = ".github/workflows/" + fileName;

      const delCommit = await ports.commitWorkflowFileSmart(
        delPath,
        delContent,
        "Add Radius delete workflow (" +
          fileName +
          ") for environment " +
          envName
      );
      if (delCommit.cancelled) return { outcome: "cancelled" };

      if (!delCommit.ok) {
        deleteFailures += 1;
        ports.report({
          kind: "delete-commit-failed",
          fileName,
          stderr: delCommit.stderr || ""
        });
      }
      if (delCommit.ok && delCommit.changed) {
        deleteChanges += 1;
        ports.recordCommittedWorkflowFile(commitRecord(delPath, delCommit));
      }
      if (!(await ports.gate())) return { outcome: "cancelled" };
    }
    if (deleteFailures > 0) {
      ports.report({ kind: "delete-completed", outcome: "warnings" });
    } else if (deleteChanges > 0) {
      ports.report({ kind: "delete-completed", outcome: "changed" });
    } else {
      ports.report({ kind: "delete-completed", outcome: "unchanged" });
    }
  } catch (delErr) {
    if (delErr instanceof ProviderMutationRecoveryError) throw delErr;
    // Delete workflows are non-critical to environment creation, so surface the
    // failure but don't abort the whole flow.
    ports.report({ kind: "delete-generation-failed", error: delErr });
  }

  return { outcome: "published" };
}
