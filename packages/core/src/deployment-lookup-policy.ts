export const ABANDONED_DEPLOYMENT_DESCRIPTION =
  "Tracking abandoned in Radius Canvas; cloud resources were not deleted.";

export interface DeploymentRow {
  app: string;
  environment: string;
  provider: string;
  status: string;
  deploymentId: string;
  runUrl: string;
}

export interface DeploymentRecord {
  id: string;
  state: string;
  description: string;
  runUrl: string;
  workflow: "deploy" | "delete" | "unrelated" | "unknown";
  runStatus: string;
  runConclusion: string;
}

export function classifyDeploymentWorkflow(
  hasRun: boolean,
  path: string,
  deployWorkflowFile: string,
  deleteWorkflowFile: string
): DeploymentRecord["workflow"] {
  if (!hasRun || !path) return "unknown";
  const matches = (file: string) =>
    new RegExp(`(^|/)${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(
      path
    );
  return (
    matches(deployWorkflowFile) ? "deploy"
    : matches(deleteWorkflowFile) ? "delete"
    : "unrelated"
  );
}

export function resolveDeployStatus(record: {
  runConclusion?: string;
  runStatus?: string;
  state?: string;
}): string {
  if (record.runConclusion === "success") return "success";
  if (record.runConclusion) return "failed";
  if (record.runStatus && record.runStatus !== "completed") return "pending";
  if (record.state === "success") return "success";
  if (record.state === "failure" || record.state === "error") return "failed";
  return "pending";
}

export function selectDeploymentRecord(
  record: DeploymentRecord,
  context: { appName: string; environment: string; provider: string }
): DeploymentRow | "skip" | null {
  if (
    record.state === "inactive" &&
    record.description === ABANDONED_DEPLOYMENT_DESCRIPTION
  )
    return null;
  if (record.workflow === "unknown") {
    throw new Error(
      `Could not identify GitHub deployment ${record.id} for environment ${context.environment}.`
    );
  }
  if (record.workflow === "unrelated") return "skip";
  if (record.workflow === "delete" && record.runConclusion === "success")
    return null;
  return {
    app: context.appName,
    environment: context.environment,
    provider: context.provider,
    status:
      record.workflow === "delete" ?
        record.runConclusion ?
          "delete-failed"
        : "deleting"
      : resolveDeployStatus(record),
    deploymentId: record.id,
    runUrl: record.runUrl
  };
}

/** Retains the workflow-compatible first-name fallback for older application models. */
export function extractAppName(source: unknown): string {
  if (typeof source !== "string" || !source) return "";
  const onResource = source.match(
    /applications@[^'"]*['"]\s*=\s*\{[\s\S]*?\bname:\s*['"]([^'"]+)['"]/
  );
  if (onResource) return onResource[1];
  const first = source.match(/\bname:\s*['"]([^'"]+)['"]/);
  return first ? first[1] : "";
}
