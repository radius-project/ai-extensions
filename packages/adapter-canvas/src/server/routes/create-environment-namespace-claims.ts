// Seam 5 of the `POST /api/create-environment` slice: the namespace claim.
//
// Radius binds one environment to one Kubernetes namespace within a cluster.
// The wizard refuses a duplicate before submitting, but that check reads a
// listing the browser already holds: it is fast feedback, not an invariant. A
// listing that is still loading, that failed, or that went stale behind another
// panel all read as "no claims", and the browser is user-controlled besides.
//
// This module establishes the claims from GitHub at the moment of creation and
// fails closed. Anything that prevents reading them — the environment list, any
// environment's variables — refuses the request rather than admitting a
// creation whose collision would only surface when a later deployment failed.
//
// Identity is provider-specific and authoritative, because a cluster name alone
// is not a cluster. Two AKS clusters in different subscriptions, or two EKS
// clusters in different accounts or regions, can share a name and a namespace
// without sharing anything else.

import {
  classifyProvider,
  parseGitHubEnvironmentVariables
} from "../../provider-classification.js";

export interface NamespaceClaimant {
  readonly environment: string;
  readonly provider: string;
  readonly subscriptionId: string;
  readonly accountId: string;
  readonly region: string;
  readonly cluster: string;
  readonly namespace: string;
}

export interface NamespaceClaim {
  readonly provider: string;
  readonly subscriptionId: string;
  readonly accountId: string;
  readonly region: string;
  readonly cluster: string;
  readonly namespace: string;
  readonly excludeEnvironment: string;
}

export type NamespaceClaimsLookup =
  | { readonly ok: true; readonly claims: readonly NamespaceClaimant[] }
  | { readonly ok: false; readonly reason: string };

export interface NamespaceClaimsPorts {
  // Resolves the repository's environment names, or fails. A failure must not
  // be reported as an empty list: "no environments" and "could not ask" are
  // different answers and only one of them is safe to create against.
  listEnvironmentNames(
    repo: string
  ): Promise<
    { ok: true; names: readonly string[] } | { ok: false; reason: string }
  >;
  // Resolves one environment's GitHub variables as a name/value map, or fails.
  readEnvironmentVariables(
    repo: string,
    environment: string
  ): Promise<
    | { ok: true; variables: Record<string, string> }
    | {
        ok: false;
        reason: string;
      }
  >;
}

// The variables the publisher writes. `KUBERNETES_NAMESPACE` is what the
// generated deployment workflow reads; `RADIUS_NAMESPACE` is its superseded
// name, still honored so an environment created before the rename is not
// mistaken for one holding no namespace at all.
const MANAGED_VARIABLE = "RADIUS_MANAGED";
const NAMESPACE_VARIABLES = ["KUBERNETES_NAMESPACE", "RADIUS_NAMESPACE"];

// The namespace the deployment workflow resolves when the variable is absent or
// empty, as `vars.KUBERNETES_NAMESPACE || 'default'`. Two environments that
// both leave it unset therefore land on the same namespace and genuinely
// collide, so the comparison has to see them that way too.
export const DEFAULT_NAMESPACE = "default";

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function readNamespace(variables: Record<string, string>): string {
  for (const name of NAMESPACE_VARIABLES) {
    if (!Object.hasOwn(variables, name)) continue;
    return (variables[name] || "").trim() || DEFAULT_NAMESPACE;
  }
  return DEFAULT_NAMESPACE;
}

// What one environment's variables say about a namespace claim. "unmanaged" is
// an answer; "indeterminate" is the absence of one, and the two must never be
// collapsed. An environment Radius created but whose provider or cluster cannot
// be read might hold exactly the namespace being requested, so it has to stop
// the admission rather than quietly claim nothing.
export type ClaimantReading =
  | { readonly kind: "claim"; readonly claimant: NamespaceClaimant }
  | { readonly kind: "unmanaged" }
  | { readonly kind: "indeterminate"; readonly missing: string };

const CLUSTER_VARIABLE_BY_PROVIDER: Record<string, string> = {
  azure: "AZURE_AKS_CLUSTER_NAME",
  aws: "AWS_EKS_CLUSTER_NAME"
};

export function claimantFromVariables(
  environment: string,
  variables: Record<string, string>
): ClaimantReading {
  // Environments this extension did not create are not Radius environments and
  // hold no Radius namespace claim. Presence is the marker, matching how the
  // listing route decides the same question: a tag that exists with an empty
  // value still marks a managed environment, and dropping it here would hide a
  // real claim and admit the duplicate.
  if (!Object.hasOwn(variables, MANAGED_VARIABLE)) return { kind: "unmanaged" };
  // The repository's single source of truth for this question, keyed off the
  // canonical variable each provider always writes. Inferring the provider from
  // the cluster name instead would disagree with the listing and the delete
  // flow about the same environment.
  const provider = classifyProvider(variables);
  if (provider === "") {
    return { kind: "indeterminate", missing: "its cloud provider" };
  }
  const cluster = (
    variables[CLUSTER_VARIABLE_BY_PROVIDER[provider]] ?? ""
  ).trim();
  if (cluster === "") {
    return { kind: "indeterminate", missing: "its cluster" };
  }
  return {
    kind: "claim",
    claimant: {
      environment,
      provider,
      subscriptionId: variables.AZURE_SUBSCRIPTION_ID || "",
      accountId: variables.AWS_ACCOUNT_ID || "",
      region: variables.AWS_REGION || "",
      cluster,
      namespace: readNamespace(variables)
    }
  };
}

// True when both sides name the same physical cluster. Azure adds the
// subscription, AWS the account and region.
//
// An account either side did not record cannot distinguish anything, so it is
// not treated as a difference: two clusters that share a name are held to be
// the same cluster until something proves otherwise. That is the fail-closed
// direction for an authoritative gate — the cost is refusing a legitimate
// environment with a message naming the holder, where the opposite would admit
// a duplicate whose collision surfaces only when a deployment fails.
function sameCluster(
  claimant: NamespaceClaimant,
  claim: NamespaceClaim
): boolean {
  if (normalize(claimant.cluster) !== normalize(claim.cluster)) return false;
  const scopes: ReadonlyArray<readonly [string, string]> =
    normalize(claim.provider) === "aws" ?
      [
        [normalize(claimant.accountId), normalize(claim.accountId)],
        [normalize(claimant.region), normalize(claim.region)]
      ]
    : [[normalize(claimant.subscriptionId), normalize(claim.subscriptionId)]];
  return scopes.every(
    ([held, requested]) => held === "" || requested === "" || held === requested
  );
}

export function findNamespaceClaimConflict(
  claimants: readonly NamespaceClaimant[],
  claim: NamespaceClaim
): NamespaceClaimant | null {
  const namespace = normalize(claim.namespace) || DEFAULT_NAMESPACE;
  const cluster = normalize(claim.cluster);
  if (cluster === "") return null;
  const excluded = normalize(claim.excludeEnvironment);
  return (
    claimants.find((claimant) => {
      // The environment being saved always holds its own namespace; that is
      // the state being preserved, not a collision with someone else.
      if (excluded !== "" && normalize(claimant.environment) === excluded) {
        return false;
      }
      if (normalize(claimant.provider) !== normalize(claim.provider)) {
        return false;
      }
      if (normalize(claimant.namespace) !== namespace) return false;
      return sameCluster(claimant, claim);
    }) ?? null
  );
}

export interface NamespaceClaimsCliExec {
  (
    command: string,
    args: string[],
    options: { timeout: number },
    callback: (
      error: (Error & { code?: string | number | null }) | null,
      stdout: string,
      stderr: string
    ) => void
  ): unknown;
}

// The `gh`-backed implementation of the ports above. It lives here rather than
// at the composition root so the failure translation and the line parsing are
// testable: both decide whether the admission can be made at all.
export function createGhNamespaceClaimsPorts(
  cliExec: NamespaceClaimsCliExec,
  timeout = 12000
): NamespaceClaimsPorts {
  return claimsPortsFrom(
    (args) =>
      new Promise((resolve) => {
        cliExec("gh", args, { timeout }, (error, stdout, stderr) => {
          if (error) {
            resolve({
              ok: false,
              reason: (stderr || error.message || "").trim() || "gh failed."
            });
            return;
          }
          resolve({ ok: true, stdout: stdout || "" });
        });
      })
  );
}

export interface NamespaceClaimsRunner {
  run(
    args: string[],
    options?: { timeout?: number }
  ): Promise<{ code: string | number; stdout: string; stderr: string }>;
}

// Ports backed by the GitHub account pinned to this operation. The claim read
// is authoritative, so it has to run as the account the customer selected and
// that readiness already passed for. Running as whatever ambient `gh` account
// the process happens to have would refuse a creation the selected account
// could have proven safe, and would be a different identity from the one every
// other step of the setup uses.
export function createSelectedNamespaceClaimsPorts(
  executor: NamespaceClaimsRunner,
  timeout = 12000
): NamespaceClaimsPorts {
  const run = async (
    args: string[]
  ): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> => {
    try {
      const result = await executor.run(args, { timeout });
      if (result.code !== 0 && result.code !== "0") {
        return {
          ok: false,
          reason: (result.stderr || result.stdout || "").trim() || "gh failed."
        };
      }
      return { ok: true, stdout: result.stdout || "" };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "gh failed."
      };
    }
  };
  return claimsPortsFrom(run);
}

function claimsPortsFrom(
  run: (
    args: string[]
  ) => Promise<{ ok: true; stdout: string } | { ok: false; reason: string }>
): NamespaceClaimsPorts {
  return {
    async listEnvironmentNames(repo) {
      const result = await run([
        "api",
        "--paginate",
        `/repos/${repo}/environments?per_page=100`,
        "--jq",
        ".environments[].name"
      ]);
      if (!result.ok) {
        return {
          ok: false,
          reason:
            result.reason === "gh failed." ?
              "the environment list could not be read."
            : result.reason
        };
      }
      // Split on `\r?\n`, for the same reason the shared variable parser does:
      // `gh` stdout is consumed verbatim and a Windows host terminates lines
      // with CRLF, which would otherwise leave a stray carriage return on the
      // last environment's name.
      return {
        ok: true,
        names: result.stdout
          .split(/\r?\n/)
          .map((name) => name.trim())
          .filter(Boolean)
      };
    },
    async readEnvironmentVariables(repo, environment) {
      // Paginated: a decision made on a truncated page could miss the very
      // variables that establish a claim, and this gate must fail closed rather
      // than decide on partial data.
      const result = await run([
        "api",
        "--paginate",
        `/repos/${repo}/environments/${encodeURIComponent(
          environment
        )}/variables?per_page=100`,
        "--jq",
        '.variables[] | .name + "\\t" + (.value // "")'
      ]);
      if (!result.ok) {
        return {
          ok: false,
          reason:
            result.reason === "gh failed." ?
              `the variables for environment "${environment}" could not be read.`
            : result.reason
        };
      }
      // The repository's shared parser, which already splits on `\r?\n` so a
      // CRLF stdout cannot corrupt the last variable's value.
      return {
        ok: true,
        variables: parseGitHubEnvironmentVariables(result.stdout)
      };
    }
  };
}

// How many environment-variable reads may be in flight at once. The admission
// boundary sits in front of every create, and a repository with many
// environments would otherwise fan out one `gh` call per environment at once,
// which invites secondary rate limiting on exactly the path that fails closed
// when a read fails. Reads still resolve into name order, so which failure is
// reported does not depend on which call happens to return first.
const CLAIM_READ_CONCURRENCY = 4;

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await map(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

export async function loadNamespaceClaims(
  repo: string,
  ports: NamespaceClaimsPorts
): Promise<NamespaceClaimsLookup> {
  const names = await ports.listEnvironmentNames(repo);
  if (!names.ok) return { ok: false, reason: names.reason };
  const reads = await mapWithLimit(
    names.names,
    CLAIM_READ_CONCURRENCY,
    async (name) => ({
      name,
      result: await ports.readEnvironmentVariables(repo, name)
    })
  );
  const claims: NamespaceClaimant[] = [];
  for (const { name, result } of reads) {
    // One unreadable environment is enough to make the answer unknown: the
    // namespace being claimed could be exactly the one it holds.
    if (!result.ok) return { ok: false, reason: result.reason };
    const reading = claimantFromVariables(name, result.variables);
    if (reading.kind === "indeterminate") {
      return {
        ok: false,
        reason: `environment "${name}" does not record ${reading.missing}.`
      };
    }
    if (reading.kind === "claim") claims.push(reading.claimant);
  }
  return { ok: true, claims };
}
