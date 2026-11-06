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
import { parse } from "yaml";

function workflowRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid deployment workflow contract.");
  return Object.fromEntries(Object.entries(value));
}

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
  async function verifyAppFileInput(
    repo: string,
    branch: string
  ): Promise<void> {
    const readWorkflow = async (file: string) => {
      const source = await ports.readFile(
        repo,
        `.github/workflows/${file}`,
        branch
      );
      if (!source?.trim())
        throw new Error(`Cannot read ${file} on "${branch}".`);
      const workflow = workflowRecord(parse(source));
      const trigger =
        file === DEPLOY_DISPATCHER_FILE ? "workflow_dispatch" : "workflow_call";
      const input = workflowRecord(
        workflowRecord(
          workflowRecord(workflowRecord(workflow.on)[trigger]).inputs
        ).app_file
      );
      if (input.type !== "string")
        throw new Error(
          `${file} must accept the string app_file input. Update the Radius workflows.`
        );
      return workflow;
    };
    const dispatcher = await readWorkflow(DEPLOY_DISPATCHER_FILE);
    const jobs = Object.values(workflowRecord(dispatcher.jobs)).map(
      workflowRecord
    );
    for (const file of files.slice(1)) {
      const routes = jobs.filter(
        (job) => job.uses === `./.github/workflows/${file}`
      );
      if (
        !routes.length ||
        routes.some(
          (job) =>
            workflowRecord(job.with).app_file !== "${{ inputs.app_file }}"
        )
      )
        throw new Error(`The dispatcher must forward app_file to ${file}.`);
      const provider = await readWorkflow(file);
      const effective = workflowRecord(provider.env).APP_FILE;
      if (
        typeof effective !== "string" ||
        !/^\$\{\{\s*inputs\.app_file\s*\|\|\s*'[A-Za-z0-9._/-]+'\s*\}\}$/.test(
          effective
        )
      )
        throw new Error(`${file} must use app_file as its effective APP_FILE.`);
      const providerJobs = Object.values(workflowRecord(provider.jobs)).map(
        workflowRecord
      );
      let consumes = false;
      for (const job of providerJobs) {
        if (job.env && "APP_FILE" in workflowRecord(job.env))
          throw new Error(`${file} overrides APP_FILE at job scope.`);
        if (!Array.isArray(job.steps)) continue;
        for (const value of job.steps) {
          const step = workflowRecord(value);
          if (step.env && "APP_FILE" in workflowRecord(step.env))
            throw new Error(`${file} overrides APP_FILE at step scope.`);
          if (
            typeof step.uses === "string" &&
            step.uses.startsWith(
              "radius-project/ai-extensions/.github/extension/actions/run-rad-commands@"
            )
          ) {
            if (workflowRecord(step.with)["app-file"] !== "${{ env.APP_FILE }}")
              throw new Error(
                `${file} must pass APP_FILE to the command runner.`
              );
            consumes = true;
          }
        }
      }
      if (!consumes)
        throw new Error(`${file} has no model-aware command runner.`);
    }
  }
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
  return { files, generate, ensureOnBranch, ensureCurrent, verifyAppFileInput };
}
