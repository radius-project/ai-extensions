import {
  DEPLOY_STATUS_ARTIFACT_PREFIX,
  DEPLOY_STATUS_FILES,
  MAX_ARTIFACT_CANDIDATES,
  WORKFLOW_READ_LIMITS,
  confirmArtifactIdentity,
  parseDeployProgressArtifact,
  readDeleteApplicationName,
  type DeploymentApplicationIdentity,
  type DownloadArtifact,
  type ListArtifacts
} from "@radius-project/core";
import { createWorkflowReadSession } from "./workflow-read-budget.js";

export function createDeploymentIdentityReader(ports: {
  listWorkflowArtifacts: ListArtifacts;
  downloadWorkflowArtifact: DownloadArtifact;
  redactDiagnostic(value: string): string;
}) {
  return async (
    repo: string,
    environment: string,
    runId: number,
    workflow: "deploy" | "delete"
  ): Promise<DeploymentApplicationIdentity> => {
    const unavailable = (reason: string): DeploymentApplicationIdentity => ({
      state: "unavailable",
      reason
    });
    const context = createWorkflowReadSession().observe(
      WORKFLOW_READ_LIMITS.artifactRunMs
    );
    try {
      const artifacts = await ports.listWorkflowArtifacts(
        repo,
        runId,
        undefined,
        context
      );
      const candidates = artifacts.filter(
        (artifact) =>
          artifact.expired !== true &&
          (artifact.workflow_run?.id === undefined ||
            artifact.workflow_run.id === runId) &&
          (workflow === "deploy" ?
            artifact.name.startsWith(DEPLOY_STATUS_ARTIFACT_PREFIX)
          : artifact.name === "rad-delete-result")
      );
      if (candidates.length > MAX_ARTIFACT_CANDIDATES)
        return unavailable(
          "Too many identity artifacts were returned for this deployment."
        );
      let application: string | null = null;
      let sequence = -1;
      for (const candidate of candidates) {
        const files = await ports.downloadWorkflowArtifact(
          repo,
          { ...candidate, workflow_run: { id: runId } },
          context
        );
        if (!files)
          return {
            state: "unavailable",
            readFailed: true,
            reason: "The deployment identity artifact could not be downloaded."
          };
        let name: string | null;
        let nextSequence = 0;
        if (workflow === "delete") {
          name = readDeleteApplicationName(files["rad-delete-result.json"]);
        } else {
          const source = files[DEPLOY_STATUS_FILES.progress];
          if (source === undefined)
            return unavailable("The deployment identity payload is missing.");
          const progress = parseDeployProgressArtifact(source);
          if (
            !progress ||
            !confirmArtifactIdentity(progress, { environment }) ||
            (progress.runId !== undefined && progress.runId !== runId)
          )
            return unavailable(
              "The deployment identity artifact does not match this run and environment."
            );
          // The graph parser normalizes runner-less runId=0 away; destructive
          // identity must reject any explicitly supplied nonmatching run ID.
          const payload: unknown = JSON.parse(source);
          if (
            typeof payload === "object" &&
            payload !== null &&
            "runId" in payload &&
            payload.runId !== runId
          )
            return unavailable(
              "The deployment identity artifact does not match this run."
            );
          name = progress.application.trim();
          nextSequence = progress.sequence;
        }
        if (!name)
          return unavailable(
            "The deployment artifact does not identify an application."
          );
        if (application && application.toLowerCase() !== name.toLowerCase())
          return unavailable(
            "The deployment run contains conflicting application identities."
          );
        if (nextSequence >= sequence) {
          application = name;
          sequence = nextSequence;
        }
      }
      return application ?
          { state: "known", application }
        : unavailable(
            "Application identity is unavailable; the run's identity artifact is missing or expired."
          );
    } catch (error) {
      return {
        state: "unavailable",
        readFailed: true,
        reason: ports.redactDiagnostic(
          `Could not verify deployment identity: ${error instanceof Error ? error.message : String(error)}`
        )
      };
    }
  };
}
