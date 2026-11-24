import {
  createDeploymentObservationBindings,
  type DeploymentCommandExecutor,
  type DeploymentObservationExecutor
} from "@radius-project/adapter-shared";
import {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_FAILED_STATUS,
  deploymentIdentityRefusal,
  probeDeleteConflict,
  deploymentRunId,
  WORKFLOW_READ_LIMITS,
  type ApplicationDeletionRequest,
  type ApplicationDeletionResult
} from "@radius-project/core";
import {
  selectedFetchFileFromRepo,
  selectedGetBranchHeadSha,
  selectedGetDefaultBranch,
  type SelectedGhExecutor
} from "../../gh.js";
import { generateDeleteWorkflow } from "../../infra.js";
import {
  requestApplicationDeletion,
  type ApplicationDeletionDependencies
} from "./application-deletion.js";
import { createWorkflowObservationScope } from "./workflow-observation-scope.js";
import { readApplicationDeletionHistory } from "./application-deletion-history.js";

function normalizeDispatcherDefault(content: string): string {
  const fallback = /^        default: '([^'\r\n]+)'$/m.exec(content)?.[1];
  if (!fallback) return content;
  return content
    .replace(`        default: '${fallback}'`, "        default: '{{ENV}}'")
    .replaceAll(
      `\${{ inputs.environment || '${fallback}' }}`,
      "${{ inputs.environment || '{{ENV}}' }}"
    );
}

export interface PreparedApplicationDeletion {
  login: string;
  execute(
    validateWorkspace?: () => Promise<boolean>
  ): Promise<ApplicationDeletionResult>;
}

export interface PrepareApplicationDeletionInput {
  login: string;
  request: ApplicationDeletionRequest;
  isCurrent(): boolean;
}

export function createSelectedApplicationDeletion(ports: {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  createLookup(
    execute: DeploymentCommandExecutor & DeploymentObservationExecutor
  ): Pick<ApplicationDeletionDependencies, "resolveEnvDeployment">;
  deletion: ApplicationDeletionDependencies;
  awsEnabled: boolean;
}) {
  return async function prepare({
    login,
    request,
    isCurrent
  }: PrepareApplicationDeletionInput): Promise<PreparedApplicationDeletion> {
    const approvedTarget = { ...request };
    if (!/^[A-Za-z0-9-]+(?:\[bot\])?$/.test(login))
      throw new Error(
        "A valid GitHub login is required before confirming deletion."
      );
    const approvedRun =
      approvedTarget.runUrl &&
      deploymentRunId(approvedTarget.repo, approvedTarget.runUrl);
    if (!approvedTarget.deploymentId || !approvedRun)
      throw new Error(
        "Select an exact Radius deployment before confirming deletion."
      );
    const assertCurrent = () => {
      if (!isCurrent())
        throw new Error("Application deletion authorization expired.");
    };
    const verify = async () => {
      assertCurrent();
      const executor = await ports.createExecutor(login);
      if (executor.login !== login)
        throw new Error(
          "The acting GitHub account does not match the selected account."
        );
      await executor.verifyIdentity();
      assertCurrent();
      return executor;
    };
    const selected = await verify();
    const { credentialSource } = selected;
    const historyTarget = {
      repo: approvedTarget.repo,
      environment: approvedTarget.environment,
      deploymentId: approvedTarget.deploymentId,
      runId: approvedRun
    };
    const approvedHistory = await readApplicationDeletionHistory(
      selected,
      historyTarget,
      assertCurrent
    );
    let consumed = false;
    return {
      login,
      async execute(validateWorkspace) {
        if (consumed)
          throw new Error(
            "Application deletion confirmation was already used."
          );
        consumed = true;
        const executor = await verify();
        if (executor.credentialSource !== credentialSource)
          throw new Error(
            "The acting GitHub credential changed. Confirm the deletion again."
          );
        const execute: DeploymentCommandExecutor &
          DeploymentObservationExecutor = (
          command,
          args,
          options,
          callback
        ) => {
          if (command !== "gh")
            throw new Error(
              "Application deletion only uses the selected GitHub executor."
            );
          void executor
            .run(args, { ...options, beforeExecute: assertCurrent })
            .then(
              (result) =>
                callback(
                  result.code === 0 ?
                    null
                  : { code: result.code, message: result.stderr },
                  result.stdout,
                  result.stderr
                ),
              (error: unknown) =>
                callback(
                  { code: 1, message: executor.errorMessage(error) },
                  "",
                  ""
                )
            );
          return {};
        };
        const { resolveEnvDeployment } = ports.createLookup(execute);
        const reads = createDeploymentObservationBindings({
          execute,
          redactDiagnostic: executor.redact
        });
        const scope = createWorkflowObservationScope(
          reads.createDeployStatusReader
        );
        let verified: { branch: string; sha: string } | undefined;
        try {
          return await requestApplicationDeletion(approvedTarget, {
            ...ports.deletion,
            resolveEnvDeployment,
            async probeDeleteConflict(target, _instance, selection) {
              const read = scope.observe(
                undefined,
                WORKFLOW_READ_LIMITS.deleteConflictMs
              );
              return probeDeleteConflict(
                target,
                {
                  resolveEnvDeployment,
                  listArtifacts: (repo, runId) =>
                    reads.listWorkflowArtifacts(
                      repo,
                      runId,
                      undefined,
                      read.context
                    ),
                  downloadArtifact: (repo, artifact) =>
                    reads.downloadWorkflowArtifact(repo, artifact, read.context)
                },
                selection
              );
            },
            async ensureWorkflowsCurrent(repo, environment, _provider, files) {
              const branch = await selectedGetDefaultBranch(executor, repo);
              if (!branch)
                throw new Error(
                  "Could not determine the default branch for workflow verification."
                );
              const sha = await selectedGetBranchHeadSha(
                executor,
                repo,
                branch
              );
              if (!/^[A-Fa-f0-9]{40}$/.test(sha))
                throw new Error(
                  "Could not verify the default branch revision."
                );
              const templates = await generateDeleteWorkflow(environment, {
                includeAws: ports.awsEnabled,
                readTemplate: (repo, path, ref) =>
                  selectedFetchFileFromRepo(executor, repo, path, ref)
              });
              for (const file of files) {
                const path = `.github/workflows/${file}`;
                const expected = templates[file];
                const actual = await selectedFetchFileFromRepo(
                  executor,
                  repo,
                  path,
                  sha
                );
                const matches =
                  (
                    file === DELETE_APP_DISPATCHER_FILE &&
                    actual !== null &&
                    expected
                  ) ?
                    normalizeDispatcherDefault(actual) ===
                    normalizeDispatcherDefault(expected)
                  : actual === expected;
                if (!expected || !matches)
                  throw new Error(
                    `${file} is missing or outdated on "${branch}". Update the Radius workflows before deleting.`
                  );
              }
              verified = { branch, sha };
              return { created: [], failed: [] };
            },
            readProcessEnv: () => ({}),
            async runGh(args, timeout = 20000) {
              const repo = approvedTarget.repo;
              const current = await resolveEnvDeployment(
                repo,
                approvedTarget.environment,
                approvedTarget.application
              );
              if (
                deploymentIdentityRefusal(
                  current,
                  approvedTarget.application,
                  approvedTarget
                ) ||
                (current &&
                  ports.deletion.deploymentStatusBlocksMutation(
                    current.status
                  )) ||
                (approvedTarget.force &&
                  current?.status !== DELETE_FAILED_STATUS)
              )
                throw new Error(
                  "The deployment changed before dispatch. Refresh the listing and confirm again."
                );
              if (
                (await readApplicationDeletionHistory(
                  executor,
                  historyTarget,
                  assertCurrent
                )) !== approvedHistory
              )
                throw new Error(
                  "GitHub deployment history changed after confirmation. Confirm the deletion again."
                );
              if (
                !verified ||
                (await selectedGetDefaultBranch(executor, repo)) !==
                  verified.branch ||
                (await selectedGetBranchHeadSha(
                  executor,
                  repo,
                  verified.branch
                )) !== verified.sha
              )
                throw new Error(
                  "The default branch changed after workflow verification. Confirm the deletion again."
                );
              return executor.run(
                [
                  ...args,
                  "-f",
                  `approved_deployment_id=${approvedTarget.deploymentId}`,
                  "-f",
                  `approved_run_id=${approvedRun}`,
                  "--ref",
                  verified.branch
                ],
                {
                  timeout,
                  beforeExecute: async () => {
                    if (validateWorkspace && !(await validateWorkspace()))
                      throw new Error("The workspace changed before deletion.");
                    assertCurrent();
                  }
                }
              );
            },
            findWorkflowRun: (repo, file, since, known, correlation) =>
              reads.findWorkflowRun(
                repo,
                file,
                since,
                known,
                undefined,
                undefined,
                correlation
              ),
            logError: (message) =>
              ports.deletion.logError(executor.redact(message))
          });
        } finally {
          scope.stop();
        }
      }
    };
  };
}
