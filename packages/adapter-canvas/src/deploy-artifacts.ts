import { cliExec, redactGhCredentials } from "./gh.js";
import type { ListArtifacts, DownloadArtifact } from "@radius-project/core";
import {
  createWorkflowArtifactReader,
  createWorkflowArtifactReads
} from "@radius-project/adapter-shared";
import type {
  WorkflowRunner,
  WorkflowArtifactReaderOptions
} from "@radius-project/adapter-shared";
export {
  DEPLOY_STATUS_FILES,
  DEPLOY_STATUS_ARTIFACT_PREFIX,
  DEPLOY_PROGRESS_SCHEMA_VERSION,
  MAX_ARTIFACT_CANDIDATES,
  ARTIFACT_PAGE_SIZE,
  MAX_ARTIFACT_PAGES,
  isLiveSlotArtifactName,
  sanitizeArtifactSegment,
  deployStatusArtifactPrefix,
  selectDeployStatusArtifacts,
  parseDeployProgressArtifact,
  parseDeployGraphArtifact,
  confirmArtifactIdentity,
  normalizeProvisioningState,
  resolveResourceStatus,
  buildDeployStatusMap,
  buildDeployMessageMap,
  applyDeployMessages,
  applyDeployStatusToResources,
  DEPLOY_CANCELLED_MESSAGE,
  DEPLOY_TIMED_OUT_MESSAGE,
  DEPLOY_MONITOR_TIMED_OUT_MESSAGE,
  DEPLOY_FAILED_MESSAGE,
  MAX_DEPLOY_MESSAGE_LENGTH,
  unfinishedDeployMessage,
  settleDeployStatuses
} from "@radius-project/core";
export { DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE } from "./deploy-messages.js";
export type {
  DeployProgress,
  DeployProgressResource,
  WorkflowArtifact,
  ArtifactFiles,
  ListArtifacts,
  DownloadArtifact,
  ReaderStatus,
  SettleableResource
} from "@radius-project/core";
export type { WorkflowArtifactReaderOptions as DeployStatusReaderOptions } from "@radius-project/adapter-shared";

const run: WorkflowRunner = (args, options) =>
  new Promise((resolve) => {
    cliExec("gh", args, options, (error, stdout, stderr) => {
      resolve({
        code: error ? (error.code ?? 1) : 0,
        stdout,
        stderr: redactGhCredentials(stderr || error?.message || "")
      });
    });
  });
export const listWorkflowArtifacts: ListArtifacts = (...args) =>
  createWorkflowArtifactReads(run).listWorkflowArtifacts(...args);
export const downloadWorkflowArtifact: DownloadArtifact = (...args) =>
  createWorkflowArtifactReads(run).downloadWorkflowArtifact(...args);
export function createDeployStatusReader(
  options: WorkflowArtifactReaderOptions
) {
  return createWorkflowArtifactReader(
    {
      ...options,
      allowApplicationFallback: options.allowApplicationFallback ?? true
    },
    run
  );
}
