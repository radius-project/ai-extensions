import {
  createWorkflowFileCommitter as createCoreCommitter,
  recordedSetupBranchCreate as recordedCoreBranch,
  type WorkflowFileCommitter,
  type WorkflowFileCommitterPorts as CoreWorkflowFileCommitterPorts,
  type WorkflowFileCommitterTarget
} from "@radius-project/core";
import {
  workflowBlobSha,
  workflowContentDigest
} from "@radius-project/adapter-shared";
import { providerMutationsByKind } from "../../operations.js";
import type { CreateEnvironmentCommandResult } from "./create-environment-types.js";
import { createSetupWorkflowRecoveryPort } from "../services/setup-workflow-recovery.js";
import { parseBranchDeleteTarget } from "../services/recovered-branch-delete.js";
import {
  branchRefListingArgs,
  branchRefReadArgs,
  proveBranchAbsent
} from "../services/branch-absence.js";
export {
  isProtectedBranchFailure,
  readWorkflowCommitProvenance,
  setupWorkflowBranchName
} from "@radius-project/core";
export { workflowContentDigest } from "@radius-project/adapter-shared";
export type {
  WorkflowFileCommitter,
  WorkflowFileCommitterTarget
} from "@radius-project/core";
export interface WorkflowTempFilePort {
  // Writes the request body for `gh api --input` and returns its path.
  write(contents: string): string;
  // Best-effort removal; the legacy arm swallowed unlink failures.
  remove(path: string): void;
}

export interface WorkflowFileCommitterPorts {
  runGh(args: string[]): Promise<CreateEnvironmentCommandResult>;
  runGhWorkflow(args: string[]): Promise<CreateEnvironmentCommandResult>;
  getDefaultBranch(repo: string): Promise<string | null | undefined>;
  getBranchHeadSha(
    repo: string,
    branch: string
  ): Promise<string | null | undefined>;
  createBranchRef(
    repo: string,
    branch: string,
    sha: string
  ): Promise<{ ok: boolean; stderr: string; timedOut?: boolean }>;
  mutationRecovery?: {
    isStopped(): boolean;
    operation: object & {
      operationId: string;
      providerRecovery?: { state?: string };
    };
    persist(): Promise<void>;
    beforeMutation?(kind: string, target: string): Promise<boolean>;
  };
  tempFile: WorkflowTempFilePort;
  errorMessage(error: unknown): string;
  pushStep(message: string): void;
  now(): number;
}

export function recordedSetupBranchCreate(operation: unknown, repo: string) {
  return recordedCoreBranch(
    providerMutationsByKind(operation, "github_branch.create"),
    repo,
    parseBranchDeleteTarget
  );
}

export function createWorkflowFileCommitter(
  ports: WorkflowFileCommitterPorts,
  target: WorkflowFileCommitterTarget
): WorkflowFileCommitter {
  return createCoreCommitter(bindWorkflowFileCommitterPorts(ports), target);
}

export function bindWorkflowFileCommitterPorts(
  ports: WorkflowFileCommitterPorts
): CoreWorkflowFileCommitterPorts {
  return {
    ...ports,
    mutationRecovery:
      ports.mutationRecovery ?
        {
          ...createSetupWorkflowRecoveryPort(
            ports.mutationRecovery.operation,
            ports.mutationRecovery.persist,
            ports.mutationRecovery.isStopped
          ),
          beforeMutation: ports.mutationRecovery.beforeMutation
        }
      : undefined,
    contentDigest: workflowContentDigest,
    blobSha: workflowBlobSha,
    parseBranchTarget: parseBranchDeleteTarget,
    proveBranchAbsent: (repo, branch) =>
      proveBranchAbsent({
        repo,
        branch,
        ports: {
          listBranchRefs: (page) =>
            ports.runGh(branchRefListingArgs(repo, branch, page)),
          readBranchRef: () => ports.runGh(branchRefReadArgs(repo, branch))
        }
      }),
    report: ({ branch, base }) =>
      ports.pushStep(
        `ℹ️ No permission to push to "${base}" directly — committing workflows to branch "${branch}" and opening a pull request.`
      )
  };
}
