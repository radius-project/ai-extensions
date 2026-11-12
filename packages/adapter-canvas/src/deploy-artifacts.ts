import { cliExec, redactGhCredentials } from "./gh.js";
import { createDeploymentObservationBindings } from "@radius-project/adapter-shared";

const bindings = createDeploymentObservationBindings({
  execute: (...args) => cliExec(...args),
  redactDiagnostic: redactGhCredentials
});

export const {
  listWorkflowArtifacts,
  downloadWorkflowArtifact,
  createDeployStatusReader
} = bindings;

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
  settleDeployStatuses,
  DEPLOY_COMPLETED_UNCONFIRMED_MESSAGE
} from "@radius-project/core";
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
