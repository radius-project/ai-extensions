import {
  ABANDONED_DEPLOYMENT_DESCRIPTION,
  extractAppName,
  classifyDeploymentWorkflow,
  selectDeploymentRecord,
  deploymentRunId,
  type DeploymentApplicationIdentity,
  type DeploymentRecord,
  type DeploymentRow
} from "@radius-project/core";

export interface DeploymentResolverDependencies {
  readApplicationIdentity(
    repo: string,
    environment: string,
    runId: number,
    workflow: "deploy" | "delete"
  ): Promise<DeploymentApplicationIdentity>;
  ghOrThrow(args: string[]): Promise<string>;
  deployWorkflowFile: string;
  deleteWorkflowFile: string;
  maxParallelRecords: number;
}

export async function resolveEnvironmentDeployment(
  repo: string,
  environment: string,
  _appName: string,
  dependencies: DeploymentResolverDependencies
): Promise<DeploymentRow | null> {
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

  const resolveRecord = async (id: string): Promise<DeploymentRecord> => {
    const latestStatusRaw = await dependencies.ghOrThrow([
      "api",
      `/repos/${repo}/deployments/${id}/statuses?per_page=1`,
      "--jq",
      '(.[0].state // "") + "\\t" + (.[0].log_url // .[0].target_url // "") + "\\t" + (.[0].description // "")'
    ]);
    const [state = "", latestLogUrl = "", description = ""] =
      latestStatusRaw.split("\t");
    if (
      state === "inactive" &&
      description === ABANDONED_DEPLOYMENT_DESCRIPTION
    ) {
      return {
        id,
        state,
        description,
        runUrl: "",
        workflow: "unknown",
        runStatus: "",
        runConclusion: ""
      };
    }
    let logUrl = latestLogUrl;
    if (!logUrl) {
      logUrl = await dependencies.ghOrThrow([
        "api",
        `/repos/${repo}/deployments/${id}/statuses?per_page=100`,
        "--jq",
        '[.[] | (.log_url // .target_url // "") | select(. != "")][0] // ""'
      ]);
    }
    let runUrl = "";
    const matchedRunId = deploymentRunId(repo, logUrl);
    if (matchedRunId) {
      runUrl = `https://github.com/${repo}/actions/runs/${matchedRunId}`;
    } else if (/^https?:\/\//.test(logUrl)) {
      runUrl = logUrl;
    }

    let runPath = "";
    let runStatus = "";
    let runConclusion = "";
    if (matchedRunId) {
      const runInfo = await dependencies.ghOrThrow([
        "api",
        `/repos/${repo}/actions/runs/${matchedRunId}`,
        "--jq",
        '(.path // "") + "\\t" + (.status // "") + "\\t" + (.conclusion // "")'
      ]);
      [runPath = "", runStatus = "", runConclusion = ""] = runInfo.split("\t");
    }
    const workflow = classifyDeploymentWorkflow(
      !!matchedRunId,
      runPath,
      dependencies.deployWorkflowFile,
      dependencies.deleteWorkflowFile
    );

    return {
      id,
      state,
      description,
      runUrl,
      workflow,
      runStatus,
      runConclusion
    };
  };

  const decide = async (record: DeploymentRecord) => {
    const context: {
      identity: DeploymentApplicationIdentity;
      environment: string;
      provider: string;
    } = {
      identity: {
        state: "unavailable",
        reason: "Application identity has not been verified."
      },
      environment,
      provider
    };
    const row = selectDeploymentRecord(record, context);
    if (!row || row === "skip") return row;
    const runId = deploymentRunId(repo, row.runUrl);
    if (
      runId &&
      (record.workflow === "deploy" || record.workflow === "delete")
    ) {
      context.identity = await dependencies.readApplicationIdentity(
        repo,
        environment,
        runId,
        record.workflow
      );
    }
    return selectDeploymentRecord(record, context);
  };

  const batch = ids.slice(0, dependencies.maxParallelRecords);
  const resolved = await Promise.allSettled(batch.map(resolveRecord));
  for (const result of resolved) {
    if (result.status === "rejected") throw result.reason;
    const deployment = await decide(result.value);
    if (deployment === "skip") continue;
    return deployment;
  }
  for (const id of ids.slice(dependencies.maxParallelRecords)) {
    const deployment = await decide(await resolveRecord(id));
    if (deployment === "skip") continue;
    return deployment;
  }
  return null;
}

export function createDeploymentLookup(
  dependencies: Omit<DeploymentResolverDependencies, "maxParallelRecords"> & {
    maxParallelRecords?: number;
  }
) {
  const resolverDependencies = {
    ...dependencies,
    maxParallelRecords: dependencies.maxParallelRecords ?? 10
  };

  async function resolveRepoAppName(
    repo: string,
    branch: string
  ): Promise<string> {
    let appName = repo.split("/").pop() || repo;
    const ref = branch || "main";
    for (const path of [".radius/app.bicep", "app.bicep"]) {
      let raw: string;
      try {
        raw = await dependencies.ghOrThrow([
          "api",
          `/repos/${repo}/contents/${path}?ref=${ref}`,
          "--jq",
          ".content"
        ]);
      } catch {
        raw = "";
      }
      if (!raw) continue;
      let decoded: string;
      try {
        decoded = Buffer.from(raw, "base64").toString("utf8");
      } catch {
        decoded = "";
      }
      const name = extractAppName(decoded);
      if (name) {
        appName = name;
        break;
      }
    }
    return appName;
  }

  return {
    resolveRepoAppName,
    resolveEnvDeployment: (
      repo: string,
      environment: string,
      appName: string
    ) =>
      resolveEnvironmentDeployment(
        repo,
        environment,
        appName,
        resolverDependencies
      )
  };
}
