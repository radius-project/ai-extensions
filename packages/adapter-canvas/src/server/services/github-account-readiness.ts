import { randomBytes } from "node:crypto";
import { stateRegistryForEnvironment } from "@radius-project/core";
import {
  BARE_GH_COMMAND_PRESENTATION,
  presentedRemediationView,
  type GhCommandPresentation
} from "../../gh-command-display.js";
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
  /**
   * The structured form of `repair` when the fix is a command Radius knows how
   * to run. `repair` stays as prose for the cases that are not a command (a
   * missing repository grant, a failed account restoration), so the two are
   * not redundant.
   */
  repairRemediation: { id: string; params: Record<string, string> } | null;
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

export interface GitHubAccountReadinessServiceOptions {
  ports?: GitHubAccountReadinessPorts;
  ghCommandPresentation?: GhCommandPresentation;
}

interface PackageTokenResponse {
  ok: boolean;
  status?: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}

type PackageTokenFetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  }
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
  fetchToken: PackageTokenFetch = fetch,
  timeoutMs = 15000
): Promise<GitHubPackageAccessProbeResult> {
  const signal = AbortSignal.timeout(timeoutMs);
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
        },
        signal
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
        },
        signal
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
      headers: { Authorization: `Bearer ${token}` },
      signal
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

interface RepairGuidance {
  readonly repair: string | null;
  readonly remediation: { id: string; params: Record<string, string> } | null;
}

function repairGuidance(
  login: string,
  needsWorkflow: boolean,
  needsPackages: boolean,
  repositoryReady: boolean,
  ghCommandPresentation: GhCommandPresentation
): RepairGuidance {
  const requiredPermissions: string[] = [];
  const refreshScopes: string[] = [];
  if (needsWorkflow) {
    requiredPermissions.push("workflow");
    refreshScopes.push("workflow");
  }
  if (needsPackages) {
    requiredPermissions.push("write:packages");
    refreshScopes.push("read:packages", "write:packages");
  }
  if (refreshScopes.length > 0) {
    const permissions =
      requiredPermissions.length === 1 ?
        `the ${requiredPermissions[0]} permission`
      : `the ${requiredPermissions.join(" and ")} permissions`;
    // Derive the command from the remediation registry rather than writing it
    // out here. Hand-built copies drift from what the Copy/Run buttons offer,
    // and they miss registry-wide rules -- most recently the switch to one
    // command per line, because `&&` will not parse in Windows PowerShell 5.1.
    const fix = presentedRemediationView(
      "github-account-scopes",
      {
        login,
        ...(needsWorkflow ? { workflow: "true" } : {}),
        ...(needsPackages ? { packages: "true" } : {})
      },
      ghCommandPresentation
    );
    return fix.runnable ?
        {
          repair: `The account @${login} needs ${permissions} to proceed. In the terminal, run:\n${fix.command}\n${fix.warning}`,
          remediation: { id: fix.id, params: { ...fix.params } }
        }
      : {
          repair: `The account @${login} needs ${permissions} to proceed. Grant the missing scopes with GitHub CLI, or select an account that already has them.${
            ghCommandPresentation.installationNote ?
              ` ${ghCommandPresentation.installationNote}`
            : ""
          }`,
          remediation: null
        };
  }
  if (!repositoryReady) {
    return {
      repair: `Grant @${login} repository administrator access, or select an account that can administer this repository.`,
      remediation: null
    };
  }
  return { repair: null, remediation: null };
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
  options: GitHubAccountReadinessServiceOptions = {}
): GitHubAccountReadinessService {
  const ports = options.ports || {
    probePackageAccess: (executor, repo, environment) =>
      probeGhcrPackageWriteAccess(executor, repo, environment)
  };
  const ghCommandPresentation =
    options.ghCommandPresentation || BARE_GH_COMMAND_PRESENTATION;
  return {
    async check({ instanceId, repo, environment, login }) {
      try {
        const lease = await coordinator.withSelectedAccount(
          login,
          { instanceId },
          async (executor) => {
            const repository = await inspectRepository(executor, repo);
            const workflowReady = hasScope(executor, "workflow");
            const hasPackagesScope = hasScope(executor, "write:packages");
            const packageAccess =
              repository.ready && workflowReady && hasPackagesScope ?
                await ports.probePackageAccess(executor, repo, environment)
              : null;
            const packagesReady = packageAccess?.ok === true;
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
                  readyCheck(
                    packageAccess?.detail ||
                      "GitHub Packages granted pull and push access."
                  )
                : failedCheck(
                    !hasPackagesScope ?
                      `@${executor.login} is missing GitHub Packages write access.`
                    : !repository.ready ?
                      "GitHub Packages access was not checked because repository administration is not ready."
                    : !workflowReady ?
                      "GitHub Packages access was not checked because workflow access is not ready."
                    : packageAccess?.detail ||
                      "GitHub Packages push access is missing."
                  )
            };
            const ready = repository.ready && workflowReady && packagesReady;
            return {
              ready,
              checks,
              needsWorkflow: !workflowReady,
              needsPackages:
                !hasPackagesScope || (packageAccess !== null && !packagesReady),
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
              ghCommandPresentation
            )
          : {
              repair: lease.restoration.guidance,
              remediation: null
            };
        return {
          ready,
          login: lease.selectedLogin,
          credentialSource: lease.credentialSource,
          summary:
            ready ?
              "Ready to configure deployments"
            : "Additional GitHub access is required",
          checks,
          repair: repair.repair,
          repairRemediation: repair.remediation,
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
          repairRemediation: null,
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

  const prune = (instanceId?: string): void => {
    const timestamp = now();
    for (const [handle, record] of handles) {
      if (
        record.expiresAt <= timestamp ||
        (instanceId !== undefined && record.instanceId === instanceId)
      ) {
        handles.delete(handle);
      }
    }
  };

  const mint: GitHubSelectionHandleStore["mint"] = (input) => {
    prune();
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
    prune(instanceId);
    const generation = (generations.get(instanceId) || 0) + 1;
    generations.set(instanceId, generation);
    return generation;
  };

  return { begin, mint, claim };
}
