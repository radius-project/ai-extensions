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

interface DeploymentRecord {
  id: string;
  state: string;
  description: string;
  runUrl: string;
  isDeploy: boolean;
  isDelete: boolean;
  runStatus: string;
  runConclusion: string;
}

interface DeployStatusRecord {
  runConclusion?: string;
  runStatus?: string;
  state?: string;
}

export interface DeploymentResolverDependencies {
  ghOrThrow(args: string[]): Promise<string>;
  deployWorkflowFile: string;
  deleteWorkflowFile: string;
  maxParallelRecords: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveDeployStatus(rec: DeployStatusRecord): string {
  if (rec.runConclusion === "success") return "success";
  if (rec.runConclusion) return "failed";
  if (rec.runStatus && rec.runStatus !== "completed") return "pending";
  if (rec.state === "success") return "success";
  if (rec.state === "failure" || rec.state === "error") return "failed";
  return "pending";
}

export async function resolveEnvironmentDeployment(
  repo: string,
  environment: string,
  appName: string,
  dependencies: DeploymentResolverDependencies
): Promise<DeploymentRow | null> {
  const resolvedAppName = appName || repo.split("/").pop() || repo;
  let provider = "";
  try {
    const varsRaw = await dependencies.ghOrThrow([
      "api",
      `/repos/${repo}/environments/${encodeURIComponent(
        environment
      )}/variables?per_page=100`,
      "--jq",
      ".variables[].name"
    ]);
    if (/AZURE_/.test(varsRaw)) provider = "azure";
    else if (/AWS_/.test(varsRaw)) provider = "aws";
  } catch {
    provider = "";
  }

  const idsRaw = await dependencies.ghOrThrow([
    "api",
    `/repos/${repo}/deployments?per_page=100&environment=${encodeURIComponent(
      environment
    )}`,
    "--jq",
    ".[].id"
  ]);
  const ids = idsRaw ? idsRaw.split("\n").filter(Boolean) : [];
  const deployWorkflow = new RegExp(
    `(^|/)${escapeRegExp(dependencies.deployWorkflowFile)}$`
  );
  const deleteWorkflow = new RegExp(
    `(^|/)${escapeRegExp(dependencies.deleteWorkflowFile)}$`
  );

  const resolveRecord = async (id: string): Promise<DeploymentRecord> => {
    const statusRaw = await dependencies.ghOrThrow([
      "api",
      `/repos/${repo}/deployments/${id}/statuses?per_page=100`,
      "--jq",
      '(.[0].state // "") + "\\t" + ([.[] | (.log_url // .target_url // "") | select(. != "")][0] // "") + "\\t" + (.[0].description // "")'
    ]);
    const [state = "", logUrl = "", description = ""] = statusRaw.split("\t");
    let runUrl = "";
    const match = /actions\/runs\/(\d+)/.exec(logUrl);
    if (match) {
      runUrl = `https://github.com/${repo}/actions/runs/${match[1]}`;
    } else if (/^https?:\/\//.test(logUrl)) {
      runUrl = logUrl;
    }

    let runPath = "";
    let runStatus = "";
    let runConclusion = "";
    if (match) {
      const runInfo = await dependencies.ghOrThrow([
        "api",
        `/repos/${repo}/actions/runs/${match[1]}`,
        "--jq",
        '(.path // "") + "\\t" + (.status // "") + "\\t" + (.conclusion // "")'
      ]);
      [runPath = "", runStatus = "", runConclusion = ""] = runInfo.split("\t");
    }

    return {
      id,
      state,
      description,
      runUrl,
      isDeploy: deployWorkflow.test(runPath),
      isDelete: deleteWorkflow.test(runPath),
      runStatus,
      runConclusion
    };
  };

  const decide = (record: DeploymentRecord): DeploymentRow | "skip" | null => {
    if (
      record.state === "inactive" &&
      record.description === ABANDONED_DEPLOYMENT_DESCRIPTION
    ) {
      return null;
    }
    if (!record.isDeploy && !record.isDelete) return "skip";
    if (record.state === "inactive") return null;
    if (record.isDelete && record.runConclusion === "success") return null;
    if (
      record.isDelete &&
      record.runConclusion &&
      record.runConclusion !== "success"
    ) {
      return "skip";
    }
    return {
      app: resolvedAppName,
      environment,
      provider,
      status: record.isDelete ? "deleting" : resolveDeployStatus(record),
      deploymentId: record.id,
      runUrl: record.runUrl
    };
  };

  const batch = ids.slice(0, dependencies.maxParallelRecords);
  const resolved = await Promise.all(batch.map(resolveRecord));
  for (const record of resolved) {
    const deployment = decide(record);
    if (deployment === "skip") continue;
    return deployment;
  }
  for (const id of ids.slice(dependencies.maxParallelRecords)) {
    const deployment = decide(await resolveRecord(id));
    if (deployment === "skip") continue;
    return deployment;
  }
  return null;
}
