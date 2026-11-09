export const ABANDONED_DEPLOYMENT_DESCRIPTION =
  "Tracking abandoned in Radius Canvas; cloud resources were not deleted.";

export type DeploymentApplicationIdentity =
  | { state: "known"; application: string }
  | { state: "unavailable"; reason: string; readFailed?: boolean };

export interface DeploymentRow {
  app: string;
  environment: string;
  provider: string;
  status: string;
  deploymentId: string;
  runUrl: string;
  identity?: DeploymentApplicationIdentity;
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
  context: {
    identity: DeploymentApplicationIdentity;
    environment: string;
    provider: string;
  }
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
    app: context.identity.state === "known" ? context.identity.application : "",
    identity: context.identity,
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

export function deploymentIdentityRefusal(
  row: DeploymentRow | null,
  application: string,
  expected: { deploymentId?: string; runUrl?: string } = {}
): { status: 409 | 503; error: string } | null {
  if (
    (expected.deploymentId && row?.deploymentId !== expected.deploymentId) ||
    (expected.runUrl && row?.runUrl !== expected.runUrl)
  )
    return {
      status: 409,
      error: "The deployment changed. Refresh the listing before trying again."
    };
  if (!row) return null;
  if (row.identity?.state !== "known")
    return {
      status: row.identity?.readFailed ? 503 : 409,
      error:
        row.identity?.reason ||
        "The deployment's application identity is unavailable."
    };
  const actual = row.identity.application.trim().toLowerCase();
  if (
    !actual ||
    actual !== row.app.trim().toLowerCase() ||
    actual !== application.trim().toLowerCase()
  )
    return {
      status: 409,
      error:
        "The application does not match the current deployment. Refresh the listing before trying again."
    };
  return null;
}

export function readDeleteApplicationName(
  source: string | undefined
): string | null {
  if (!source) return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("resourceType" in value) ||
    value.resourceType !== "application" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    !value.name.trim()
  )
    return null;
  return value.name.trim();
}

export function deploymentRunId(repo: string, runUrl: string): number | null {
  let url: URL;
  try {
    url = new URL(runUrl);
  } catch {
    return null;
  }
  const prefix = `/${repo}/actions/runs/`;
  if (
    url.origin !== "https://github.com" ||
    !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())
  )
    return null;
  const suffix = url.pathname.slice(prefix.length);
  const match = /^(\d+)(?:\/job\/\d+)?\/?$/.exec(suffix);
  const id = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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
