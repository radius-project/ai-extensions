import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GITHUB_API_VERSION,
  type GitHubJsonResponse
} from "../../../src/azure-oidc.js";
import type { AwsCommandResult } from "../../../src/server/services/aws-cli-session.js";
import {
  createAwsEnvironmentAccess,
  type AwsEnvironmentRemovalResult
} from "../../../src/server/services/aws-environment-access.js";
import {
  createSelectedNamespaceClaimsPorts,
  type NamespaceClaimsPorts
} from "../../../src/server/routes/create-environment-namespace-claims.js";
import type {
  AwsAccessRemovalRequest,
  AwsCleanupCluster,
  AwsCleanupGitHub,
  AwsCleanupKubernetes
} from "./aws-cloud-cleanup.js";
import type { LeakedClusterWorkload } from "./cloud-cleanup.js";
import {
  findNewWorkflowRunId,
  readWorkflowRunIds
} from "./workflow-run-discovery.js";

// The CLI-backed ports the AWS cleanup sweep runs on in CI: `gh` for GitHub,
// `kubectl` for the clusters, and the product's own deploy-role removal.

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { env?: Record<string, string>; timeoutMs?: number }
) => Promise<CommandResult>;

/** Run a CLI with an argv array, never a shell. Never throws. */
export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs ?? 120_000,
        env: { ...process.env, ...options.env }
      },
      (error, stdout, stderr) => {
        const code =
          !error ? 0
          : typeof error.code === "number" ? error.code
          : 1;
        resolve({
          code,
          stdout: stdout ?? "",
          stderr: stderr || (error && !stdout ? error.message : "")
        });
      }
    );
  });

export function httpStatus(result: CommandResult): number | null {
  const match = /\(HTTP (\d{3})\)|HTTP (\d{3}):/.exec(result.stderr);
  const status = match?.[1] ?? match?.[2];
  return status ? Number(status) : null;
}

function detail(result: CommandResult): string {
  return (result.stderr || result.stdout).trim() || `exit ${result.code}`;
}

function parse(result: CommandResult, what: string): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${what} did not return JSON.`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ?
      (value as Record<string, unknown>)
    : null;
}

export interface GhCleanupOptions {
  readonly repository: string;
  readonly defaultBranch: string;
  // Runs `gh <args>`. `packages` selects the token that can delete packages.
  gh(args: readonly string[], packages?: boolean): Promise<CommandResult>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

// How long a delete-application run may take: its RDS delete alone can take
// 15 minutes.
export const APPLICATION_DELETE_TIMEOUT_MS = 60 * 60 * 1000;
const RUN_DISCOVERY_ATTEMPTS = 24;
const RUN_POLL_MS = 15 * 1000;
const GONE_ATTEMPTS = 12;
const GONE_POLL_MS = 5 * 1000;

/** The sweep's GitHub port over `gh`, for the fixture repository. */
export function createGhCleanupGitHub(
  options: GhCleanupOptions
): AwsCleanupGitHub {
  const { repository: repo, gh } = options;
  const owner = repo.split("/")[0] ?? "";
  let packagesBase: Promise<string> | null = null;

  async function api(
    args: readonly string[],
    what: string,
    packages = false
  ): Promise<unknown> {
    const result = await gh(["api", ...args], packages);
    if (result.code !== 0) throw new Error(`${what}: ${detail(result)}`);
    return parse(result, what);
  }

  // Confirm `path` answers 404, polling while GitHub catches up.
  async function confirmGone(
    path: string,
    what: string,
    packages = false
  ): Promise<void> {
    for (let attempt = 0; attempt < GONE_ATTEMPTS; attempt += 1) {
      const result = await gh(["api", path], packages);
      if (result.code !== 0) {
        if (httpStatus(result) === 404) return;
        throw new Error(`Checking that ${what} is gone: ${detail(result)}`);
      }
      await options.sleep(GONE_POLL_MS);
    }
    throw new Error(`${what} is still there after it was deleted.`);
  }

  function base(): Promise<string> {
    packagesBase ??= api(
      [`users/${owner}`],
      `Reading GitHub account ${owner}`,
      true
    ).then((account) =>
      asRecord(account)?.type === "Organization" ?
        `orgs/${owner}`
      : `users/${owner}`
    );
    return packagesBase;
  }

  async function runIds(): Promise<ReadonlySet<string>> {
    const result = await gh([
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      "delete-application.yml",
      "--event",
      "workflow_dispatch",
      "--limit",
      "100",
      "--json",
      "databaseId"
    ]);
    if (result.code !== 0)
      throw new Error(`Listing delete-application.yml runs: ${detail(result)}`);
    return readWorkflowRunIds(parse(result, "gh run list"));
  }

  return {
    listEnvironments: () =>
      api(
        ["--paginate", "--slurp", `repos/${repo}/environments?per_page=100`],
        `Listing environments in ${repo}`
      ),

    async readEnvironmentVariables(environment) {
      const pages = await api(
        [
          "--paginate",
          "--slurp",
          `repos/${repo}/environments/${encodeURIComponent(environment)}/variables?per_page=30`
        ],
        `Reading the variables of ${environment}`
      );
      const variables: Record<string, string> = {};
      for (const page of Array.isArray(pages) ? pages : []) {
        const list = asRecord(page)?.variables;
        if (!Array.isArray(list))
          throw new Error(
            `GitHub returned no variables list for ${environment}.`
          );
        for (const entry of list) {
          const item = asRecord(entry);
          if (typeof item?.name === "string")
            variables[item.name] =
              typeof item.value === "string" ? item.value : "";
        }
      }
      return variables;
    },

    async deleteApplication(environment, application) {
      const before = await runIds();
      const dispatch = await gh([
        "workflow",
        "run",
        "delete-application.yml",
        "--repo",
        repo,
        "--ref",
        options.defaultBranch,
        "-f",
        `environment=${environment}`,
        "-f",
        `application=${application}`
      ]);
      if (dispatch.code !== 0)
        throw new Error(
          `Could not dispatch delete-application.yml (${detail(dispatch)}). Check that it exists on ${options.defaultBranch}.`
        );
      let runId: string | undefined;
      for (
        let attempt = 0;
        attempt < RUN_DISCOVERY_ATTEMPTS && !runId;
        attempt += 1
      ) {
        await options.sleep(GONE_POLL_MS);
        runId = findNewWorkflowRunId(before, await runIds());
      }
      if (!runId)
        throw new Error("The delete-application.yml run never appeared.");
      const deadline = options.now() + APPLICATION_DELETE_TIMEOUT_MS;
      for (;;) {
        const view = await gh([
          "run",
          "view",
          runId,
          "--repo",
          repo,
          "--json",
          "status,conclusion"
        ]);
        if (view.code !== 0)
          throw new Error(`Reading run ${runId}: ${detail(view)}`);
        const run = asRecord(parse(view, "gh run view"));
        if (run?.status === "completed") {
          if (run.conclusion === "success") return;
          throw new Error(
            `delete-application.yml run ${runId} ended ${String(run.conclusion)}.`
          );
        }
        if (options.now() >= deadline)
          throw new Error(
            `delete-application.yml run ${runId} did not finish in time.`
          );
        await options.sleep(RUN_POLL_MS);
      }
    },

    listDeployments: () =>
      api(
        ["--paginate", "--slurp", `repos/${repo}/deployments?per_page=100`],
        `Listing deployments in ${repo}`
      ),

    async deleteDeployment(id) {
      const path = `repos/${repo}/deployments/${id}`;
      // GitHub refuses to delete an active deployment.
      const deactivate = await gh([
        "api",
        "--method",
        "POST",
        `${path}/statuses`,
        "-f",
        "state=inactive"
      ]);
      if (deactivate.code !== 0 && httpStatus(deactivate) !== 404)
        throw new Error(`Deactivating deployment ${id}: ${detail(deactivate)}`);
      const remove = await gh(["api", "--method", "DELETE", path]);
      if (remove.code !== 0 && httpStatus(remove) !== 404)
        throw new Error(`Deleting deployment ${id}: ${detail(remove)}`);
      await confirmGone(path, `Deployment ${id}`);
    },

    async listPackages() {
      return api(
        [
          "--paginate",
          "--slurp",
          `${await base()}/packages?package_type=container`
        ],
        `Listing ${owner}'s container packages`,
        true
      );
    },

    async deletePackage(name) {
      const path = `${await base()}/packages/container/${encodeURIComponent(name)}`;
      const read = await gh(["api", path], true);
      if (read.code !== 0) {
        if (httpStatus(read) === 404) return "absent";
        throw new Error(`Reading GHCR package ${name}: ${detail(read)}`);
      }
      const item = asRecord(parse(read, `GHCR package ${name}`));
      const visibility = item?.visibility;
      const linked = asRecord(item?.repository)?.full_name;
      if (visibility !== "private" && visibility !== "internal")
        throw new Error(
          `Refusing GHCR package ${name}, whose visibility is ${String(visibility ?? "unknown")}.`
        );
      if (
        typeof linked === "string" &&
        linked.toLowerCase() !== repo.toLowerCase()
      )
        throw new Error(`Refusing GHCR package ${name}, linked to ${linked}.`);
      const remove = await gh(["api", "--method", "DELETE", path], true);
      if (remove.code !== 0 && httpStatus(remove) !== 404)
        throw new Error(`Deleting GHCR package ${name}: ${detail(remove)}`);
      await confirmGone(path, `GHCR package ${name}`, true);
      return "deleted";
    },

    async deleteEnvironment(environment) {
      const path = `repos/${repo}/environments/${encodeURIComponent(environment)}`;
      const remove = await gh(["api", "--method", "DELETE", path]);
      if (remove.code !== 0 && httpStatus(remove) !== 404)
        throw new Error(
          `Deleting GitHub environment ${environment}: ${detail(remove)}`
        );
      await confirmGone(path, `GitHub environment ${environment}`);
    }
  };
}

// Every Radius-rendered kind the label rule reclaims. Jobs are the connection
// probes, which carry the app's Radius labels.
const WORKLOAD_KINDS =
  "deployments,statefulsets,daemonsets,jobs,services,horizontalpodautoscalers";

export interface KubectlCleanupOptions {
  run: CommandRunner;
  // A directory for the clusters' kubeconfig files.
  directory(): Promise<string>;
}

/** The sweep's Kubernetes port over `kubectl`, signed in through `aws eks`. */
export function createKubectlCleanupKubernetes(
  options: KubectlCleanupOptions
): AwsCleanupKubernetes {
  const configs = new Map<string, Promise<string>>();

  function kubeconfig(cluster: AwsCleanupCluster): Promise<string> {
    const key = `${cluster.region}/${cluster.name}`;
    let config = configs.get(key);
    if (!config) {
      config = (async () => {
        const file = path.join(
          await options.directory(),
          `${cluster.region}-${cluster.name}.kubeconfig`
        );
        const result = await options.run("aws", [
          "eks",
          "update-kubeconfig",
          "--region",
          cluster.region,
          "--name",
          cluster.name,
          "--kubeconfig",
          file
        ]);
        if (result.code !== 0)
          throw new Error(
            `Could not sign in to cluster ${cluster.name}: ${detail(result)}`
          );
        return file;
      })();
      // A failed sign-in is tried again by the next call.
      config.catch(() => configs.delete(key));
      configs.set(key, config);
    }
    return config;
  }

  async function kubectl(
    cluster: AwsCleanupCluster,
    args: readonly string[]
  ): Promise<CommandResult> {
    return options.run("kubectl", [
      "--kubeconfig",
      await kubeconfig(cluster),
      ...args
    ]);
  }

  return {
    async listWorkloads(cluster) {
      const result = await kubectl(cluster, [
        "get",
        WORKLOAD_KINDS,
        "--all-namespaces",
        "--selector",
        "radapp.io/environment",
        "--request-timeout=60s",
        "--output",
        "json"
      ]);
      if (result.code !== 0)
        throw new Error(
          `Listing workloads on ${cluster.name}: ${detail(result)}`
        );
      return parse(result, "kubectl get");
    },

    async deleteWorkload(cluster, workload: LeakedClusterWorkload) {
      const result = await kubectl(cluster, [
        "delete",
        `${workload.kind.toLowerCase()}/${workload.name}`,
        "--namespace",
        workload.namespace,
        "--ignore-not-found",
        "--request-timeout=60s"
      ]);
      if (result.code !== 0) throw new Error(detail(result));
    },

    async namespaceExists(cluster, namespace) {
      const result = await kubectl(cluster, [
        "get",
        "namespace",
        namespace,
        "--ignore-not-found",
        "--output",
        "name",
        "--request-timeout=30s"
      ]);
      if (result.code !== 0)
        throw new Error(`Reading namespace ${namespace}: ${detail(result)}`);
      return result.stdout.trim() !== "";
    },

    async deleteNamespace(cluster, namespace) {
      const result = await kubectl(cluster, [
        "delete",
        "namespace",
        namespace,
        "--ignore-not-found",
        "--wait=false",
        "--request-timeout=60s"
      ]);
      if (result.code !== 0) throw new Error(detail(result));
    }
  };
}

/** `runGitHubJson` for the product's removal, over `gh api`. */
export function ghJsonRunner(
  gh: (args: readonly string[]) => Promise<CommandResult>
): (apiPath: string) => Promise<GitHubJsonResponse> {
  return async (apiPath) => {
    const result = await gh([
      "api",
      apiPath.replace(/^\//, ""),
      "-H",
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`
    ]);
    if (result.code !== 0)
      return {
        ok: false,
        status: httpStatus(result),
        json: null,
        stderr: detail(result)
      };
    const json = asRecord(parse(result, `gh api ${apiPath}`));
    return { ok: true, status: 200, json, stderr: "" };
  };
}

function unexpected(name: string): never {
  throw new Error(`The cleanup sweep does not use ${name}.`);
}

export interface AccessRemovalOptions {
  readonly repository: string;
  runAws(args: string[]): Promise<AwsCommandResult>;
  runGitHubJson(apiPath: string): Promise<GitHubJsonResponse>;
  environments: NamespaceClaimsPorts;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

/**
 * The product's deploy-role removal, `createAwsEnvironmentAccess().remove()`,
 * composed for the fixture repository. Removal uses none of the operation
 * store's hooks, so each one refuses to run.
 */
export function createAwsCleanupAccessRemoval(
  options: AccessRemovalOptions
): (request: AwsAccessRemovalRequest) => Promise<AwsEnvironmentRemovalResult> {
  const access = createAwsEnvironmentAccess<never>({
    runAws: options.runAws,
    runGitHubJson: (apiPath) => options.runGitHubJson(apiPath),
    environments: options.environments,
    sleep: options.sleep,
    now: options.now,
    isStopRequested: () => unexpected("isStopRequested"),
    // No Radius operation shares the fixture with the sweep, so it knows of
    // none that stopped. A lock is removable only by its age.
    isStoppedOperation: () => false,
    operationId: () => unexpected("operationId"),
    operations: {
      getContext: () => unexpected("operations"),
      enterStage: () => unexpected("operations"),
      setStageState: () => unexpected("operations"),
      addLegacyStep: () => unexpected("operations"),
      setContext: () => unexpected("operations"),
      touch: () => unexpected("operations")
    },
    store: { persist: async () => unexpected("store") },
    stageAuthorizeIdentity: "",
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  });
  let repoId: Promise<number> | null = null;
  return async (request) => {
    repoId ??= options
      .runGitHubJson(`/repos/${options.repository}`)
      .then((response) => {
        const id = Number(response.json?.id);
        if (!response.ok || !Number.isSafeInteger(id) || id <= 0)
          throw new Error(
            `Could not read the ID of ${options.repository} (${response.stderr || `HTTP ${response.status ?? "unknown"}`}).`
          );
        return id;
      });
    repoId.catch(() => {
      repoId = null;
    });
    return access.remove({
      repo: options.repository,
      repoId: await repoId,
      environment: request.environment,
      roleArn: request.roleArn,
      trustSubjects: request.trustSubjects,
      region: request.region,
      cluster: request.cluster,
      operationId: request.operationId,
      waiting: request.waiting,
      whileLocked: (removal) => request.whileLocked(removal)
    });
  };
}

/** Namespace-claim reads for the product's removal, over `gh`. */
export function ghNamespaceClaims(
  gh: (args: readonly string[]) => Promise<CommandResult>
): NamespaceClaimsPorts {
  return createSelectedNamespaceClaimsPorts({ run: (args) => gh(args) });
}

/** A temporary directory, made once. */
export function temporaryDirectory(prefix: string): () => Promise<string> {
  let directory: Promise<string> | null = null;
  return () => (directory ??= mkdtemp(path.join(tmpdir(), prefix)));
}
