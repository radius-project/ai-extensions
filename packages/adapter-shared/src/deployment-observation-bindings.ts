import {
  observeWorkflowRun,
  selectLatestWorkflowRunId,
  selectWorkflowRunId,
  type ListArtifacts,
  type DownloadArtifact
} from "@radius-project/core";
import {
  readWorkflowRun,
  readWorkflowLog,
  selectedWorkflowJson,
  type SelectedWorkflowExecutor,
  type WorkflowExecution,
  type WorkflowRunReadOptions,
  type WorkflowReadOptions,
  type WorkflowReadRequest,
  type WorkflowRunner
} from "./workflow-reads.js";
import {
  createWorkflowArtifactReader,
  createWorkflowArtifactReads,
  type WorkflowArtifactReaderOptions
} from "./workflow-artifacts.js";

export type DeploymentObservationExecutor = (
  command: string,
  args: string[],
  options: WorkflowReadOptions,
  callback: (
    error: { code?: string | number | null; message?: string } | null,
    stdout: string,
    stderr: string
  ) => void
) => unknown;

export interface DeploymentSelectedWorkflowExecutor extends SelectedWorkflowExecutor {
  verifyIdentity(): Promise<void>;
}

export function createDeploymentObservationBindings({
  execute,
  redactDiagnostic
}: {
  execute: DeploymentObservationExecutor;
  redactDiagnostic(value: string): string;
}) {
  const run: WorkflowRunner = (args, options) =>
    new Promise((resolve) => {
      execute("gh", args, options, (error, stdout, stderr) =>
        resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr })
      );
    });
  const artifactRun: WorkflowRunner = (args, options) =>
    new Promise((resolve) => {
      execute("gh", args, options, (error, stdout, stderr) =>
        resolve({
          code: error ? (error.code ?? 1) : 0,
          stdout,
          stderr: redactDiagnostic(stderr || error?.message || "")
        })
      );
    });
  const execution = (
    executor?: DeploymentSelectedWorkflowExecutor
  ): WorkflowExecution =>
    executor ?
      { mode: "selected", executor, prepare: () => executor.verifyIdentity() }
    : { mode: "ambient", run };

  function ghJson(
    args: string[],
    fallback: unknown = null,
    timeout = 15000
  ): Promise<unknown> {
    return new Promise((resolve) => {
      execute("gh", args, { timeout }, (error, stdout) => {
        if (error) {
          resolve(fallback);
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(fallback);
        }
      });
    });
  }

  async function latestWorkflowRunId(repo: string, workflowFile: string) {
    return selectLatestWorkflowRunId(
      await ghJson(
        [
          "run",
          "list",
          "--workflow=" + workflowFile,
          "--limit",
          "20",
          "--json",
          "databaseId,createdAt",
          "--repo",
          repo
        ],
        []
      )
    );
  }

  async function findWorkflowRun(
    repo: string,
    workflowFile: string,
    sinceMs: number,
    knownId?: number | string | null,
    executor?: DeploymentSelectedWorkflowExecutor,
    afterRunId?: number | string | null,
    correlationId?: string | null
  ): Promise<number | string | null> {
    if (knownId) return knownId;
    const fields =
      correlationId ?
        "databaseId,status,createdAt,displayTitle"
      : "databaseId,status,createdAt";
    const args = [
      "run",
      "list",
      "--workflow=" + workflowFile,
      "--limit",
      "5",
      "--json",
      fields,
      "--repo",
      repo
    ];
    const selected =
      executor ? await selectedWorkflowJson(executor, repo, args) : null;
    const runs =
      selected ?
        selected.state === "value" ?
          selected.value
        : []
      : await ghJson(args, []);
    return selectWorkflowRunId(runs, sinceMs, correlationId, afterRunId);
  }

  function getRunDetail(
    repo: string,
    runId: number | string,
    executor?: DeploymentSelectedWorkflowExecutor,
    request?: WorkflowReadRequest,
    options?: WorkflowRunReadOptions
  ) {
    return observeWorkflowRun(
      { repo, runId },
      {
        readRun: (targetRepo, targetRunId) =>
          readWorkflowRun(
            execution(executor),
            targetRepo,
            targetRunId,
            request,
            options
          )
      }
    );
  }

  function fetchRunLog(
    repo: string,
    runId: number | string,
    executor?: DeploymentSelectedWorkflowExecutor,
    request?: WorkflowReadRequest
  ) {
    return readWorkflowLog(execution(executor), repo, runId, request);
  }

  const listWorkflowArtifacts: ListArtifacts = (...args) =>
    createWorkflowArtifactReads(artifactRun).listWorkflowArtifacts(...args);
  const downloadWorkflowArtifact: DownloadArtifact = (...args) =>
    createWorkflowArtifactReads(artifactRun).downloadWorkflowArtifact(...args);

  function createDeployStatusReader(options: WorkflowArtifactReaderOptions) {
    return createWorkflowArtifactReader(
      {
        ...options,
        allowApplicationFallback: options.allowApplicationFallback ?? true
      },
      artifactRun
    );
  }

  return {
    ghJson,
    latestWorkflowRunId,
    findWorkflowRun,
    getRunDetail,
    fetchRunLog,
    listWorkflowArtifacts,
    downloadWorkflowArtifact,
    createDeployStatusReader
  };
}
