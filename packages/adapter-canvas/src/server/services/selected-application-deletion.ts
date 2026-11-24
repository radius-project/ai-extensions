import {
  createDeploymentObservationBindings,
  exactTerminalDeploymentRun,
  type ApplicationDeleteDispatchIdentity,
  type DeploymentCommandExecutor,
  type DeploymentObservationExecutor
} from "@radius-project/adapter-shared";
import {
  DELETE_APP_DISPATCHER_FILE,
  DELETE_FAILED_STATUS,
  canonicalDeletionRunUrl,
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

export interface GuardedDeletionAdmission {
  acquire(input: {
    executor: SelectedGhExecutor;
    target: ApplicationDeletionRequest;
    approvedRunId: number;
    dispatch: ApplicationDeleteDispatchIdentity;
    assertCurrent(): void;
  }): Promise<{
    repositoryId: number;
    release(): Promise<void>;
  }>;
}

export function createSelectedApplicationDeletion(ports: {
  createExecutor(login: string): Promise<SelectedGhExecutor>;
  createLookup(
    execute: DeploymentCommandExecutor & DeploymentObservationExecutor
  ): Pick<ApplicationDeletionDependencies, "resolveEnvDeployment">;
  deletion: ApplicationDeletionDependencies;
  awsEnabled: boolean;
  admission?: GuardedDeletionAdmission;
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
    const canonicalRun =
      approvedTarget.runUrl &&
      canonicalDeletionRunUrl(approvedTarget.repo, approvedTarget.runUrl);
    const approvedRun =
      canonicalRun && deploymentRunId(approvedTarget.repo, canonicalRun);
    if (!approvedTarget.deploymentId || !approvedRun)
      throw new Error(
        "Select an exact Radius deployment before confirming deletion."
      );
    approvedTarget.runUrl = canonicalRun;
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
        const lookup = ports.createLookup(execute);
        const resolveEnvDeployment: typeof lookup.resolveEnvDeployment = async (
          repo,
          environment,
          application
        ) => {
          const row = await lookup.resolveEnvDeployment(
            repo,
            environment,
            application
          );
          return (
            row && {
              ...row,
              runUrl: canonicalDeletionRunUrl(repo, row.runUrl) ?? row.runUrl
            }
          );
        };
        const reads = createDeploymentObservationBindings({
          execute,
          redactDiagnostic: executor.redact
        });
        const scope = createWorkflowObservationScope(
          reads.createDeployStatusReader
        );
        let verified: { branch: string; sha: string } | undefined;
        let dispatchIdentity: ApplicationDeleteDispatchIdentity | undefined;
        let persisted:
          Awaited<ReturnType<GuardedDeletionAdmission["acquire"]>> | undefined;
        try {
          return await requestApplicationDeletion(
            approvedTarget,
            {
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
                      reads.downloadWorkflowArtifact(
                        repo,
                        artifact,
                        read.context
                      )
                  },
                  selection
                );
              },
              async ensureWorkflowsCurrent(
                repo,
                environment,
                _provider,
                files
              ) {
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
                  current?.provider !== "azure" &&
                  !(ports.awsEnabled && current?.provider === "aws")
                )
                  throw new Error(
                    "Could not verify a supported provider for the selected deployment. No deletion was dispatched."
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
                const approvedRef = verified;
                let admitted = false;
                try {
                  return await executor.run(
                    [
                      ...args,
                      "-f",
                      `approved_deployment_id=${approvedTarget.deploymentId}`,
                      "-f",
                      `approved_run_id=${approvedRun}`,
                      "-f",
                      `approved_provider=${current.provider}`,
                      "--ref",
                      verified.branch
                    ],
                    {
                      timeout,
                      beforeExecute: async () => {
                        if (validateWorkspace && !(await validateWorkspace()))
                          throw new Error(
                            "The workspace changed before deletion."
                          );
                        assertCurrent();
                        if (ports.admission) {
                          if (!dispatchIdentity)
                            throw new Error(
                              "Could not identify the pending deletion dispatch."
                            );
                          persisted = await ports.admission.acquire({
                            executor,
                            target: approvedTarget,
                            approvedRunId: approvedRun,
                            dispatch: dispatchIdentity,
                            assertCurrent
                          });
                          try {
                            if (
                              (await readApplicationDeletionHistory(
                                executor,
                                historyTarget,
                                assertCurrent
                              )) !== approvedHistory ||
                              (await selectedGetDefaultBranch(
                                executor,
                                repo
                              )) !== approvedRef.branch ||
                              (await selectedGetBranchHeadSha(
                                executor,
                                repo,
                                approvedRef.branch
                              )) !== approvedRef.sha
                            )
                              throw new Error(
                                "GitHub state changed while reserving deletion. Confirm the deletion again."
                              );
                            if (
                              validateWorkspace &&
                              !(await validateWorkspace())
                            )
                              throw new Error(
                                "The workspace changed before deletion."
                              );
                            assertCurrent();
                          } catch (error) {
                            await persisted.release();
                            persisted = undefined;
                            throw error;
                          }
                        }
                        admitted = true;
                      }
                    }
                  );
                } catch (error) {
                  if (!admitted) throw error;
                  return { code: 1, stdout: "", stderr: "", timedOut: true };
                }
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
            },
            undefined,
            {
              captureIdentity(identity) {
                dispatchIdentity = identity;
              },
              observe(dispatch, release) {
                const { discoverRunUrl } = dispatch;
                if (!discoverRunUrl) return;
                void (async () => {
                  let runId: number | null = null;
                  for (let poll = 1; isCurrent(); poll++) {
                    try {
                      runId ??= deploymentRunId(
                        approvedTarget.repo,
                        await discoverRunUrl()
                      );
                      if (runId) {
                        const result = await executor.run(
                          [
                            "api",
                            `/repos/${approvedTarget.repo}/actions/runs/${runId}`
                          ],
                          { timeout: 10000, beforeExecute: assertCurrent }
                        );
                        if (result.code !== 0) throw new Error(result.stderr);
                        const run: unknown = JSON.parse(result.stdout);
                        if (
                          isCurrent() &&
                          exactTerminalDeploymentRun(run, {
                            repo: approvedTarget.repo,
                            runId,
                            workflow: DELETE_APP_DISPATCHER_FILE,
                            ...(persisted && dispatchIdentity ?
                              {
                                repositoryId: persisted.repositoryId,
                                title: `Radius - Delete ${approvedTarget.environment} [radius:v1 app=${approvedTarget.application}] ${dispatchIdentity.correlation}`
                              }
                            : {})
                          })
                        ) {
                          await persisted?.release();
                          release();
                          return;
                        }
                      }
                    } catch (error) {
                      ports.deletion.logError(
                        "[radius delete] Could not verify the dispatched workflow: " +
                          executor
                            .redact(executor.errorMessage(error))
                            .slice(0, 2000)
                      );
                    }
                    if ((!runId && poll >= 6) || !isCurrent()) return;
                    await new Promise<void>((resolve) => {
                      ports.deletion
                        .setTimer(resolve, poll < 6 ? 5000 : 30000)
                        .unref?.();
                    });
                  }
                })();
              }
            }
          );
        } finally {
          scope.stop();
        }
      }
    };
  };
}
