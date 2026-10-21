import { buildEnvironmentSuffix } from "./platforms/oidc-subject.js";
import {
  buildServicePrincipalObjectIdArgs,
  buildSignedInUserObjectIdArgs,
  isUuid,
  parseCallerIdentity,
  resolveOidcSubject,
  type CallerIdentity,
  type GitHubJsonRunner
} from "./platforms/setup-azure-identity.js";
import type { AzureAppCreateContinuation } from "./setup-azure-continuation.js";
import type { ProviderMutationCommandResult } from "./setup-azure-recovery.js";

export interface AzureAccountIdentity {
  subscriptionId: string;
  tenantId: string;
  callerIdentity: CallerIdentity;
}

export function parseAzureAccountIdentity(
  stdout: string
): AzureAccountIdentity | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const account = parsed as {
      id?: unknown;
      tenantId?: unknown;
      user?: unknown;
    };
    if (
      typeof account.id !== "string" ||
      (account.tenantId !== undefined && typeof account.tenantId !== "string")
    )
      return null;
    return {
      subscriptionId: account.id.trim(),
      tenantId:
        typeof account.tenantId === "string" ? account.tenantId.trim() : "",
      callerIdentity: parseCallerIdentity(JSON.stringify(account.user ?? null))
    };
  } catch {
    return null;
  }
}

export async function continuationMatchesLiveContext(
  continuation: AzureAppCreateContinuation,
  targetRepo: string,
  environment: string,
  ports: {
    runAz(args: string[]): Promise<ProviderMutationCommandResult>;
    runGitHubJson: GitHubJsonRunner;
    deepEqual(left: unknown, right: unknown): boolean;
  }
): Promise<boolean> {
  const accountResult = await ports.runAz([
    "account",
    "show",
    "--output",
    "json"
  ]);
  if (accountResult.code !== 0 && accountResult.code !== "0") return false;
  const account = parseAzureAccountIdentity(accountResult.stdout);
  if (
    !account ||
    account.subscriptionId.toLowerCase() !==
      continuation.resolved.subscriptionId ||
    account.tenantId.toLowerCase() !== continuation.resolved.tenantId ||
    !ports.deepEqual(
      account.callerIdentity,
      continuation.resolved.callerIdentity
    ) ||
    account.callerIdentity.kind === "unsupported"
  )
    return false;

  const callerResult = await ports.runAz(
    account.callerIdentity.kind === "servicePrincipal" ?
      buildServicePrincipalObjectIdArgs({ appId: account.callerIdentity.appId })
    : buildSignedInUserObjectIdArgs()
  );
  const callerObjectId = callerResult.stdout.trim().toLowerCase();
  if (
    (callerResult.code !== 0 && callerResult.code !== "0") ||
    !isUuid(callerObjectId) ||
    callerObjectId !== continuation.resolved.callerObjectId
  )
    return false;

  try {
    const oidcSuffix = buildEnvironmentSuffix(environment);
    const oidc = await resolveOidcSubject(
      { targetRepo, envName: environment, suffix: oidcSuffix },
      ports.runGitHubJson
    );
    return (
      oidcSuffix === continuation.resolved.oidcSuffix &&
      ports.deepEqual(oidc, continuation.resolved.oidc)
    );
  } catch {
    return false;
  }
}
