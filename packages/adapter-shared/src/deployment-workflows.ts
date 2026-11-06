import {
  DEPLOY_DISPATCHER_FILE,
  deployWorkflowFiles,
  requireCurrentAwsWorkflows,
  synchronizeWorkflowCandidates,
  type WorkflowCandidate,
  type WorkflowCommitFailure,
  type WorkflowEnvironmentProvider
} from "@radius-project/core";
import {
  createDeploymentTemplates,
  type DeploymentTemplatePorts
} from "./deployment-templates.js";

export interface DeploymentWorkflowPorts extends DeploymentTemplatePorts {
  ghOrThrow(args: string[], timeout?: number): Promise<string>;
  readFile(repo: string, path: string, branch: string): Promise<string | null>;
  defaultBranch(repo: string): Promise<string | null>;
  branchHead(repo: string, branch: string): Promise<string | null>;
  commitFile(
    repo: string,
    path: string,
    content: string,
    branch: string,
    message: string
  ): Promise<boolean>;
  environmentProvider(
    repo: string,
    environment: string
  ): Promise<WorkflowEnvironmentProvider>;
  reportDiagnostic(message: string): void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createDeploymentWorkflows(
  includeAws: boolean,
  ports: DeploymentWorkflowPorts
) {
  const generate = createDeploymentTemplates(ports);
  const files = deployWorkflowFiles(includeAws);
  async function ensureOnBranch(
    repo: string,
    branch: string,
    environment: string,
    log: (message: string) => void,
    onWorkflowWritten: (file: string) => void
  ): Promise<void> {
    if (!repo || !branch) return;
    const presence = await Promise.all(
      files.map(async (file) => {
        try {
          return !!(
            await ports.ghOrThrow(
              [
                "api",
                `/repos/${repo}/contents/.github/workflows/${file}?ref=${encodeURIComponent(branch)}`,
                "--jq",
                ".sha"
              ],
              15000
            )
          ).trim();
        } catch {
          // Preserve the preflight presence probe; publication surfaces write failures.
          return false;
        }
      })
    );
    const missing = files.filter((_, index) => !presence[index]);
    if (missing.length === 0) return;
    log(
      `Publishing deploy workflow(s) to branch "${branch}": ${missing.join(", ")}`
    );
    const generated = await generate(environment, ".radius/app.bicep", {
      includeAws
    });
    for (const file of missing) {
      if (
        await ports.commitFile(
          repo,
          `.github/workflows/${file}`,
          generated[file],
          branch,
          `Add Radius deploy workflow (${file}) to ${branch} for worktree-consistent deploy`
        )
      )
        onWorkflowWritten(file);
    }
  }

  async function ensureCurrent(
    repo: string,
    environment: string,
    provider: string,
    only: string[],
    workingBranch = ""
  ): Promise<{
    created: string[];
    updated: string[];
    failed: WorkflowCommitFailure[];
  }> {
    let result: {
      created: string[];
      updated: string[];
      failed: WorkflowCommitFailure[];
    } = {
      created: [],
      updated: [],
      failed: []
    };
    if (!repo || !environment || only.length === 0) return result;
    const log = (message: string) =>
      ports.reportDiagnostic(`[radius workflow-presync] ${repo}: ${message}`);
    try {
      const defaultBranch = await ports.defaultBranch(repo);
      if (!defaultBranch)
        throw new Error(
          "Could not determine the default branch for deployment workflow synchronization."
        );
      const branches = [
        ...new Set([defaultBranch, workingBranch.trim()].filter(Boolean))
      ];
      const generated = await generate(environment, ".radius/app.bicep", {
        includeAws
      });
      const selected = new Set(only.map((file) => file.split("/").pop()));
      const candidates = new Map<string, WorkflowCandidate[]>();
      for (const [file, content] of Object.entries(generated)) {
        if (selected.has(file))
          candidates.set(`.github/workflows/${file}`, [
            { content, provider: null, environment: null }
          ]);
      }
      const synced = await synchronizeWorkflowCandidates(
        {
          repo,
          branches,
          candidates,
          dispatcherProviders: new Map([
            [DEPLOY_DISPATCHER_FILE, files.slice(1)]
          ]),
          createMissing: true
        },
        {
          readFile: ports.readFile,
          branchExists: async (repository, branch) =>
            !!(await ports.branchHead(repository, branch)),
          commitFile: ports.commitFile,
          log,
          errorMessage
        }
      );
      if (synced.updated.length || synced.created.length)
        log(
          `${[...synced.updated, ...synced.created].join(", ")} before dispatch`
        );
      result = {
        created: [
          ...new Set([...synced.created, ...(synced.registrationPending ?? [])])
        ],
        updated: synced.updated,
        failed: synced.failed
      };
    } catch (error) {
      // Azure retains its logged best-effort sync; AWS additionally requires readback below.
      log(errorMessage(error));
    }
    if (includeAws) {
      await requireCurrentAwsWorkflows(
        { provider, files: only, workingBranch },
        {
          environmentProvider: () =>
            ports.environmentProvider(repo, environment),
          defaultBranch: () => ports.defaultBranch(repo),
          templates: () =>
            generate(environment, ".radius/app.bicep", { includeAws }),
          readFile: (path, branch) => ports.readFile(repo, path, branch),
          errorMessage
        }
      );
    }
    return result;
  }
  return { files, generate, ensureOnBranch, ensureCurrent };
}
