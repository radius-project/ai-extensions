import { randomBytes } from "node:crypto";
import { stateRegistryForEnvironment } from "@radius-project/core";
import type {
  GitHubAccountCoordinator,
  GitHubAccountRestoration
} from "./github-account-coordinator.js";
import type {
  SelectedGhCredentialSource,
  SelectedGhExecutor
} from "../../gh.js";

export type GitHubReadinessCheckState = "ready" | "missing" | "error";

export interface GitHubReadinessCheck {
  state: GitHubReadinessCheckState;
  detail: string;
}

export interface GitHubAccountReadiness {
  ready: boolean;
  login: string;
  credentialSource: SelectedGhCredentialSource | null;
  summary:
    "Ready to configure deployments" | "Additional GitHub access is required";
  checks: {
    repository: GitHubReadinessCheck;
    workflow: GitHubReadinessCheck;
    environment: GitHubReadinessCheck;
    packages: GitHubReadinessCheck;
    identity: GitHubReadinessCheck;
  };
  repair: string | null;
  restoration: GitHubAccountRestoration | null;
}

export interface GitHubAccountReadinessService {
  check(input: {
    instanceId: string;
    repo: string;
    environment: string;
    login: string;
  }): Promise<GitHubAccountReadiness>;
}

export interface GitHubPackageAccessProbeResult {
  ok: boolean;
  detail: string;
}

export interface GitHubAccountReadinessPorts {
  probePackageAccess(
    executor: SelectedGhExecutor,
    repo: string,
    environment: string
  ): Promise<GitHubPackageAccessProbeResult>;
}

interface PackageTokenResponse {
  ok: boolean;
  status?: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

type PackageTokenFetch = (
  url: string,
  init: { method?: string; headers: Record<string, string> }
) => Promise<PackageTokenResponse>;

interface RepositoryResponse {
  permissions?: {
    admin?: unknown;
  };
}

export async function probeGhcrPackageWriteAccess(
  executor: SelectedGhExecutor,
  repo: string,
  environment: string,
  fetchToken: PackageTokenFetch = fetch
): Promise<GitHubPackageAccessProbeResult> {
  let packagePath: string;
  try {
    packagePath = stateRegistryForEnvironment(repo, environment).replace(
      /^ghcr\.io\//,
      ""
    );
  } catch {
    return { ok: false, detail: "The GHCR package owner is invalid." };
  }
  const credentials = executor.packageCredentials();
  let response: PackageTokenResponse;
  try {
    response = await fetchToken(
      `https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(
        `repository:${packagePath}:pull,push`
      )}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(
            `${credentials.username}:${credentials.token}`,
            "utf8"
          ).toString("base64")}`
        }
      }
    );
  } catch {
    return {
      ok: false,
      detail: "GitHub Packages authorization could not be verified."
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      detail: "GitHub Packages rejected the selected account."
    };
  }
  let token = "";
  try {
    const body = await response.json();
    if (typeof body === "object" && body !== null) {
      const value =
        Reflect.get(body, "token") ?? Reflect.get(body, "access_token");
      if (typeof value === "string") token = value;
    }
    if (!token) throw new Error("missing registry token");
  } catch {
    return {
      ok: false,
      detail: "GitHub Packages returned an invalid authorization response."
    };
  }
  let uploadLocation: string;
  try {
    const uploadResponse = await fetchToken(
      `https://ghcr.io/v2/${packagePath}/blobs/uploads/`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`
        }
      }
    );
    if (!uploadResponse.ok && uploadResponse.status !== 202) {
      return {
        ok: false,
        detail:
          "GitHub Packages did not grant push access to the selected account."
      };
    }
    const location = uploadResponse.headers?.get("location") || "";
    const resolved = new URL(location, "https://ghcr.io");
    if (
      !location ||
      resolved.protocol !== "https:" ||
      resolved.hostname !== "ghcr.io"
    ) {
      return {
        ok: false,
        detail:
          "GitHub Packages granted an upload session that Radius could not safely clean up."
      };
    }
    uploadLocation = resolved.href;
  } catch {
    return {
      ok: false,
      detail: "GitHub Packages authorization could not be verified."
    };
  }
  try {
    const cleanup = await fetchToken(uploadLocation, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!cleanup.ok && cleanup.status !== 404 && cleanup.status !== 405) {
      return {
        ok: true,
        detail:
          "GitHub Packages accepted push authorization. The empty upload session could not be cancelled and will expire without creating a package artifact."
      };
    }
  } catch {
    return {
      ok: true,
      detail:
        "GitHub Packages accepted push authorization. The empty upload session could not be cancelled and will expire without creating a package artifact."
    };
  }
  return {
    ok: true,
    detail: "GitHub Packages accepted push authorization for the state package."
  };
}

function failedCheck(detail: string): GitHubReadinessCheck {
  return { state: "missing", detail };
}

function errorCheck(detail: string): GitHubReadinessCheck {
  return { state: "error", detail };
}

function readyCheck(detail: string): GitHubReadinessCheck {
  return { state: "ready", detail };
}

function hasScope(executor: SelectedGhExecutor, scope: string): boolean {
  return executor.scopes.includes(scope);
}

function repairGuidance(
  login: string,
  needsWorkflow: boolean,
  needsPackages: boolean,
  repositoryReady: boolean,
  originalLogin: string | null
): string | null {
  const scopes: string[] = [];
  if (needsWorkflow) scopes.push("workflow");
  if (needsPackages) scopes.push("read:packages", "write:packages");
  if (scopes.length > 0) {
    const refresh = `gh auth refresh --hostname github.com --scopes ${scopes.join(
      ","
    )}`;
    if (originalLogin && originalLogin !== login) {
      return `GitHub CLI can refresh only the active account. This temporarily changes the machine-wide account: gh auth switch --hostname github.com --user ${login} && ${refresh} && gh auth switch --hostname github.com --user ${originalLogin}`;
    }
    return `Run "${refresh}" while @${login} is the active GitHub CLI account. GitHub CLI cannot refresh an inactive account.`;
  }
  if (!repositoryReady) {
    return `Grant @${login} repository administrator access, or select an account that can administer this repository.`;
  }
  return null;
}

async function inspectRepository(
  executor: SelectedGhExecutor,
  repo: string
): Promise<{
  repository: GitHubReadinessCheck;
  environment: GitHubReadinessCheck;
  ready: boolean;
}> {
  const response = await executor.run(["api", `repos/${repo}`], {
    timeout: 15000
  });
  if (response.code !== 0) {
    const detail =
      (response.stderr || response.stdout).trim() ||
      `@${executor.login} could not access ${repo}.`;
    const check = errorCheck(detail);
    return { repository: check, environment: check, ready: false };
  }
  let parsed: RepositoryResponse;
  try {
    parsed = JSON.parse(response.stdout) as RepositoryResponse;
  } catch {
    const check = errorCheck(
      "GitHub returned an invalid repository permission response."
    );
    return { repository: check, environment: check, ready: false };
  }
  const canAdmin = parsed.permissions?.admin === true;
  if (!canAdmin) {
    return {
      repository: failedCheck(
        `@${executor.login} can access ${repo} but cannot administer it.`
      ),
      environment: failedCheck(
        `@${executor.login} cannot configure GitHub Environments for ${repo}.`
      ),
      ready: false
    };
  }
  return {
    repository: readyCheck(`@${executor.login} can administer ${repo}.`),
    environment: readyCheck(
      `@${executor.login} can configure GitHub Environments for ${repo}.`
    ),
    ready: true
  };
}

export function createGitHubAccountReadinessService(
  coordinator: GitHubAccountCoordinator,
  ports: GitHubAccountReadinessPorts = {
    probePackageAccess: (executor, repo, environment) =>
      probeGhcrPackageWriteAccess(executor, repo, environment)
  }
): GitHubAccountReadinessService {
  return {
    async check({ instanceId, repo, environment, login }) {
      try {
        const lease = await coordinator.withSelectedAccount(
          login,
          { instanceId },
          async (executor) => {
            const repository = await inspectRepository(executor, repo);
            const workflowReady = hasScope(executor, "workflow");
            const packageAccess = await ports.probePackageAccess(
              executor,
              repo,
              environment
            );
            const packagesReady =
              hasScope(executor, "write:packages") && packageAccess.ok;
            const checks: GitHubAccountReadiness["checks"] = {
              identity: readyCheck(
                `Pinned GitHub commands resolve exactly to @${executor.login}.`
              ),
              repository: repository.repository,
              workflow:
                workflowReady ?
                  readyCheck(
                    "Workflow publication and dispatch access is available."
                  )
                : failedCheck(`@${executor.login} is missing workflow access.`),
              environment: repository.environment,
              packages:
                packagesReady ?
                  readyCheck(packageAccess.detail)
                : failedCheck(
                    !hasScope(executor, "write:packages") ?
                      `@${executor.login} is missing GitHub Packages write access.`
                    : packageAccess.detail
                  )
            };
            const ready = repository.ready && workflowReady && packagesReady;
            return {
              ready,
              checks,
              needsWorkflow: !workflowReady,
              needsPackages: !packagesReady,
              repositoryReady: repository.ready
            };
          },
          3000
        );
        const restorationReady =
          lease.restoration.state === "not_required" ||
          lease.restoration.state === "restored";
        const checks =
          restorationReady ?
            lease.value.checks
          : {
              ...lease.value.checks,
              identity: errorCheck(
                lease.restoration.guidance ||
                  "Radius could not restore the original GitHub CLI account."
              )
            };
        const ready = lease.value.ready && restorationReady;
        const repair =
          restorationReady ?
            repairGuidance(
              lease.selectedLogin,
              lease.value.needsWorkflow,
              lease.value.needsPackages,
              lease.value.repositoryReady,
              lease.restoration.originalLogin
            )
          : lease.restoration.guidance;
        return {
          ready,
          login: lease.selectedLogin,
          credentialSource: lease.credentialSource,
          summary:
            ready ?
              "Ready to configure deployments"
            : "Additional GitHub access is required",
          checks,
          repair,
          restoration: lease.restoration
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const check = errorCheck(detail);
        return {
          ready: false,
          login,
          credentialSource: null,
          summary: "Additional GitHub access is required",
          checks: {
            identity: check,
            repository: check,
            workflow: check,
            environment: check,
            packages: check
          },
          repair: null,
          restoration: null
        };
      }
    }
  };
}

interface SelectionHandle {
  handle: string;
  instanceId: string;
  repo: string;
  environment: string;
  login: string;
  credentialSource: SelectedGhCredentialSource;
  generation: number;
  expiresAt: number;
  claimed: boolean;
}

export type SelectionHandleClaim =
  | {
      ok: true;
      login: string;
      credentialSource: SelectedGhCredentialSource;
      commit(): void;
      release(): void;
    }
  | {
      ok: false;
      error:
        "missing" | "unknown" | "expired" | "stale" | "binding" | "claimed";
    };

export interface GitHubSelectionHandleStore {
  begin(instanceId: string): number;
  mint(input: {
    instanceId: string;
    repo: string;
    environment: string;
    login: string;
    credentialSource: SelectedGhCredentialSource;
    generation: number;
  }): { handle: string; expiresAt: number } | null;
  claim(input: {
    instanceId: string;
    repo: string;
    environment: string;
    handle: string;
  }): SelectionHandleClaim;
}

export function createGitHubSelectionHandleStore(
  options: { now?: () => number; ttlMs?: number } = {}
): GitHubSelectionHandleStore {
  const now = options.now || Date.now;
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;
  const handles = new Map<string, SelectionHandle>();
  const generations = new Map<string, number>();

  const mint: GitHubSelectionHandleStore["mint"] = (input) => {
    if (generations.get(input.instanceId) !== input.generation) return null;
    const handle = randomBytes(32).toString("base64url");
    const expiresAt = now() + ttlMs;
    handles.set(handle, {
      ...input,
      handle,
      expiresAt,
      claimed: false
    });
    return { handle, expiresAt };
  };

  const claim: GitHubSelectionHandleStore["claim"] = ({
    instanceId,
    repo,
    environment,
    handle
  }) => {
    if (!handle) return { ok: false, error: "missing" };
    const record = handles.get(handle);
    if (!record) return { ok: false, error: "unknown" };
    if (record.expiresAt <= now()) {
      handles.delete(handle);
      return { ok: false, error: "expired" };
    }
    if (
      record.instanceId !== instanceId ||
      record.repo !== repo ||
      record.environment !== environment
    ) {
      return { ok: false, error: "binding" };
    }
    if (record.generation !== generations.get(instanceId)) {
      handles.delete(handle);
      return { ok: false, error: "stale" };
    }
    if (record.claimed) return { ok: false, error: "claimed" };
    record.claimed = true;
    let settled = false;
    return {
      ok: true,
      login: record.login,
      credentialSource: record.credentialSource,
      commit() {
        if (settled) return;
        settled = true;
        handles.delete(handle);
      },
      release() {
        if (settled) return;
        settled = true;
        record.claimed = false;
      }
    };
  };

  const begin = (instanceId: string): number => {
    const generation = (generations.get(instanceId) || 0) + 1;
    generations.set(instanceId, generation);
    return generation;
  };

  return { begin, mint, claim };
}
