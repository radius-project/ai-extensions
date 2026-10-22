import type { GitHubEnvironmentReadResult } from "./setup-github-environment.js";

export interface SetupPackageCredentialFacts {
  username: string;
  source: "keyring" | "injected-token";
  scopes?: readonly string[];
}

export interface SetupPackageAccount {
  login: string;
  hasWorkflow: boolean;
  hasPackages: boolean;
  switchable: boolean;
  acting: boolean;
}

export interface SetupPackageIdentity {
  actingLogin: string;
  displayLogin: string;
  mismatch: boolean;
  actingHasWorkflow: boolean;
  actingHasPackages: boolean;
  packagesLogin: string;
  packagesHasWrite: boolean;
  packagesCredentialSource: "keyring" | "injected-token" | "unavailable";
  reason: string;
  accounts: SetupPackageAccount[];
}

export function selectedSetupPackageIdentity(
  credentials: SetupPackageCredentialFacts,
  selected: { login: string; scopes: readonly string[] }
): SetupPackageIdentity {
  const packageHasWrite =
    credentials.scopes?.includes("write:packages") ??
    (credentials.username === selected.login &&
      selected.scopes.includes("write:packages"));
  return {
    actingLogin: selected.login,
    displayLogin: selected.login,
    mismatch: false,
    actingHasWorkflow: selected.scopes.includes("workflow"),
    actingHasPackages: selected.scopes.includes("write:packages"),
    packagesLogin: credentials.username,
    packagesHasWrite: packageHasWrite,
    packagesCredentialSource: credentials.source,
    reason: "selected-account-executor",
    accounts: [
      {
        login: credentials.username,
        hasWorkflow:
          credentials.username === selected.login &&
          selected.scopes.includes("workflow"),
        hasPackages: packageHasWrite,
        switchable: credentials.source === "keyring",
        acting: credentials.username === selected.login
      }
    ]
  };
}

export function assessSetupPackageWriteAccess(
  credentials: SetupPackageCredentialFacts,
  identity: SetupPackageIdentity
):
  | { kind: "allowed"; login: string }
  | { kind: "identity-missing" }
  | { kind: "scope-required"; login: string } {
  const login = (credentials.username || "").trim();
  if (!login) return { kind: "identity-missing" };
  const account = identity.accounts.find((a) => a.login === login);
  const hasPackages =
    (
      identity.packagesLogin === login &&
      identity.packagesCredentialSource === credentials.source
    ) ?
      identity.packagesHasWrite
    : account ? account.hasPackages
    : identity.actingLogin === login ? identity.actingHasPackages
    : false;
  return { kind: hasPackages ? "allowed" : "scope-required", login };
}

export interface SetupRepositoryProbe {
  path(repo: string): string;
  permission: string;
}

export type SetupRepositoryAccess =
  | { kind: "allowed" | "ambiguous" }
  | { kind: "app-denied"; login: string; permission?: string }
  | {
      kind: "account-denied";
      login: string;
      readFailed: boolean;
      permissions: Record<string, unknown> | null;
    };

export async function preflightSetupRepository(
  repo: string,
  ports: {
    read(path: string): Promise<GitHubEnvironmentReadResult>;
    fallbackLogin(): Promise<string>;
    isAppLogin(login: string): boolean;
    probes: readonly SetupRepositoryProbe[];
    optionalString(value: unknown): string;
    record(value: unknown): Record<string, unknown>;
  }
): Promise<SetupRepositoryAccess> {
  const who = await ports.read("user");
  const login =
    who.ok ?
      ports.optionalString(ports.record(who.json).login)
    : await ports.fallbackLogin();
  const res = await ports.read(`repos/${repo}`);
  let readFailed = false;
  let permissions: Record<string, unknown> | null = null;
  if (res.ok) {
    const value = ports.record(res.json).permissions;
    permissions =
      value && typeof value === "object" ? ports.record(value) : null;
  } else if (res.status === 404) {
    readFailed = true;
  } else {
    return { kind: "ambiguous" };
  }
  if (ports.isAppLogin(login)) {
    if (readFailed) return { kind: "app-denied", login };
    for (const probe of ports.probes) {
      const result = await ports.read(probe.path(repo));
      if (result.ok) continue;
      if (result.status === 403 || result.status === 404) {
        return { kind: "app-denied", login, permission: probe.permission };
      }
      return { kind: "ambiguous" };
    }
    return { kind: "allowed" };
  }
  if (!readFailed && permissions?.admin === true) return { kind: "allowed" };
  return { kind: "account-denied", login, readFailed, permissions };
}
