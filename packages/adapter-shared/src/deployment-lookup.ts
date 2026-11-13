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
import {
  cleanupConfirmation,
  cleanupMarker,
  cleanupRevision
} from "./deployment-cleanup-marker.js";

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
  if (
    !Number.isSafeInteger(dependencies.maxParallelRecords) ||
    dependencies.maxParallelRecords < 1
  )
    throw new Error("Deployment lookup requires a positive concurrency limit.");
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

  const ids: string[] = [];
  const readIds = async (page: number): Promise<boolean> => {
    const idsRaw = await dependencies.ghOrThrow([
      "api",
      `/repos/${repo}/deployments?per_page=100&environment=${encodeURIComponent(
        environment
      )}${page === 1 ? "" : `&page=${page}`}`,
      "--jq",
      ".[].id"
    ]);
    const next = idsRaw ? idsRaw.split("\n").filter(Boolean) : [];
    if (
      next.some((id) => ids.includes(id)) ||
      new Set(next).size !== next.length
    )
      throw new Error(
        "GitHub deployment history changed during pagination. Refresh and retry."
      );
    ids.push(...next);
    return next.length === 100;
  };
  let more = await readIds(1);

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
    let runAttempt: number | undefined;
    let headSha: string | undefined;
    let runTitle: string | undefined;
    let runEvent: string | undefined;
    let runRepository: string | undefined;
    let confirmedRunId: number | undefined;
    if (matchedRunId) {
      const runInfo = await dependencies.ghOrThrow([
        "api",
        `/repos/${repo}/actions/runs/${matchedRunId}`,
        "--jq",
        '(.path // "") + "\\t" + (.status // "") + "\\t" + (.conclusion // "") + "\\t" + ((.run_attempt // 0) | tostring) + "\\t" + (.head_sha // "") + "\\t" + (.display_title // "") + "\\t" + ((.id // 0) | tostring) + "\\t" + (.repository.full_name // "") + "\\t" + (.event // "")'
      ]);
      const [
        path = "",
        status = "",
        conclusion = "",
        attempt = "",
        sha = "",
        title = "",
        id = "",
        repository = "",
        event = ""
      ] = runInfo.split("\t");
      runPath = path;
      runStatus = status;
      runConclusion = conclusion;
      if (/^[1-9]\d*$/.test(attempt) && Number.isSafeInteger(Number(attempt)))
        runAttempt = Number(attempt);
      if (/^[a-f0-9]{40}$/.test(sha)) headSha = sha;
      runTitle = title;
      runEvent = event;
      runRepository = repository;
      if (Number(id) === matchedRunId) confirmedRunId = matchedRunId;
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
      runConclusion,
      runAttempt,
      headSha,
      runTitle,
      runPath,
      runEvent,
      runRepository,
      runId: confirmedRunId
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

  const records: DeploymentRecord[] = [];
  const first = ids[0] ? await resolveRecord(ids[0]) : undefined;
  if (first) {
    if (
      (first.state === "inactive" &&
        first.description === ABANDONED_DEPLOYMENT_DESCRIPTION) ||
      (first.workflow === "delete" && first.runConclusion === "success")
    )
      return null;
    if (
      first.state === "success" &&
      first.workflow === "deploy" &&
      first.runConclusion === "success"
    ) {
      const healthy = await decide(first);
      if (healthy && healthy !== "skip" && healthy.identity?.state === "known")
        return healthy;
    }
  }
  // A recovery marker must cover every duplicate record, including interleaved
  // runs. Only recovery paths need a complete, bounded history scan.
  for (let page = 2; more && page <= 20; page++) {
    more = await readIds(page);
    if (more && page === 20)
      throw new Error(
        "Deployment history exceeds the recovery read budget. Tracking was not changed."
      );
  }
  let stopHistory = false;
  for (
    let offset = 0;
    offset < ids.length;
    offset += dependencies.maxParallelRecords
  ) {
    const batch = await Promise.allSettled(
      ids
        .slice(offset, offset + dependencies.maxParallelRecords)
        .map((id) =>
          first?.id === id ? Promise.resolve(first) : resolveRecord(id)
        )
    );
    for (const result of batch) {
      if (result.status === "rejected") throw result.reason;
      const record = result.value;
      records.push(record);
      if (
        (record.state === "inactive" &&
          record.description === ABANDONED_DEPLOYMENT_DESCRIPTION) ||
        (record.workflow === "delete" && record.runConclusion === "success")
      ) {
        stopHistory = true;
        break;
      }
    }
    if (stopHistory) break;
  }
  const skipped = new Set<number>();
  for (const record of records) {
    const runId = deploymentRunId(repo, record.runUrl);
    if (runId && skipped.has(runId)) continue;
    const group =
      runId ?
        records.filter(
          (candidate) => deploymentRunId(repo, candidate.runUrl) === runId
        )
      : [];
    if (
      group.some(
        (candidate) =>
          candidate.workflow !== record.workflow ||
          candidate.runId !== record.runId ||
          candidate.runRepository?.toLowerCase() !==
            record.runRepository?.toLowerCase() ||
          candidate.runAttempt !== record.runAttempt ||
          candidate.headSha !== record.headSha ||
          candidate.runStatus !== record.runStatus ||
          candidate.runConclusion !== record.runConclusion
      )
    )
      throw new Error(
        "The workflow run changed while resolving deployment history. Refresh and retry."
      );
    const attempt = record.runAttempt;
    const recovery =
      (
        runId !== null &&
        attempt !== undefined &&
        record.headSha !== undefined &&
        record.runId === runId &&
        record.runRepository?.toLowerCase() === repo.toLowerCase()
      ) ?
        {
          runId,
          runAttempt: attempt,
          revision: cleanupRevision(repo, environment, runId, group),
          deploymentIds: group.map((candidate) => candidate.id),
          confirmation: "",
          canMarkCleanupComplete:
            record.runStatus === "completed" && Boolean(record.runConclusion)
        }
      : undefined;
    if (
      recovery &&
      group.every(
        (candidate) =>
          candidate.state === "inactive" &&
          candidate.description === cleanupMarker(recovery)
      )
    ) {
      skipped.add(recovery.runId);
      continue;
    }
    const deployment = await decide(record);
    if (deployment === "skip") continue;
    if (deployment && recovery) {
      recovery.confirmation = cleanupConfirmation(
        repo,
        environment,
        recovery.runId,
        recovery.runAttempt,
        deployment.app
      );
      recovery.canMarkCleanupComplete &&=
        deployment.identity?.state !== "unavailable" ||
        deployment.identity.readFailed !== true;
      deployment.recovery = recovery;
    }
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
