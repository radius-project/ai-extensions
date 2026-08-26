// Pure classification of a failed `radius-verify-credentials` workflow run into
// one of the exception categories from
// `docs/design/2026-07-radius-copilot-app-exception-scenarios.md` (Part 4).
//
// The upstream verify workflow (radius-project/radius `verify-azure.yml` /
// `verify-aws.yml`) emits no structured result artifact: it signals only through
// the run conclusion, which step failed, and the step log / job summary. So the
// specific failure a user must act on — the cloud provider not trusting GitHub
// (4.3), the identity lacking permissions (4.4), or a cluster / cloud endpoint
// being unreachable (4.5) — is inferred here from the failed step names and the
// run log. The function is pure: it performs no I/O and never throws. When no
// category can be identified confidently it returns "generic" so a novel failure
// is surfaced with the existing generic message rather than mislabeled.

export type VerifyFailureCategory =
  | "oidc-trust"
  | "permissions"
  | "cluster-unreachable"
  | "cloud-unreachable"
  | "generic";

export type VerifyUnreachableComponent =
  "Kubernetes cluster" | "cloud provider";

export interface VerifyFailureStep {
  name?: string;
  conclusion?: string | null;
}

export interface VerifyFailureInput {
  // Steps whose conclusion was neither success nor skipped.
  failedSteps: readonly VerifyFailureStep[];
  // The run log text (may be empty when the jobs/log API was unavailable).
  log: string;
  // Non-empty when `explainOidcEnterpriseClaim` matched the OIDC enterprise-claim
  // rejection — a definitive trust-configuration signal.
  oidcHelp: string;
  // Non-empty when `explainNoSubscriptions` matched — login succeeded but the
  // identity has no RBAC that makes the subscription visible.
  noSubscriptionsHelp: string;
}

export interface VerifyFailureClassification {
  category: VerifyFailureCategory;
  component?: VerifyUnreachableComponent;
  missingPermissions?: string[];
  detail?: string;
}

const OIDC_STEP =
  /azure login|login\s*\(oidc\)|configure[\s-]aws[\s-]credentials|assume\s*role|assumerolewithwebidentity|\boidc\b/i;

const CLUSTER_STEP = /\b(aks|eks|cluster|kube(?:ctl|login|config)?)\b/i;

const CLOUD_ACCESS_STEP =
  /account show|get-caller-identity|caller identity|verify.*access|subscription/i;

const GHCR_STEP = /ghcr|package push|packages? push/i;

// Network / reachability failures — the endpoint could not be contacted at all,
// as opposed to being reached and rejecting the request on authorization.
const REACHABILITY =
  /could not connect|connection refused|connection timed out|connection reset|timed?\s*out|no such host|dial tcp|network is unreachable|i\/o timeout|temporary failure in name resolution|unable to connect to the server|tls handshake timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|getaddrinfo|server misbehaving|service unavailable|\b50[234]\b/i;

// Authorization failures — the endpoint was reached and refused the identity.
const AUTHORIZATION =
  /AuthorizationFailed|\bForbidden\b|not authorized|does not have authorization|insufficient privileges|role assignment|AccessDenied|UnauthorizedOperation|cannot (?:get|list|create|update|patch|delete) resource|\b401\b|\b403\b/i;

function matchesStep(
  steps: readonly VerifyFailureStep[],
  pattern: RegExp
): boolean {
  return steps.some((step) => pattern.test(String(step.name ?? "")));
}

// Extract the individual permission / action tokens a log mentions as missing,
// so the 4.4 message can list them. Best-effort and de-duplicated; returns an
// empty array when none are recognized.
export function extractMissingPermissions(log: string): string[] {
  if (!log) return [];
  const found = new Set<string>();
  // AWS-style actions: service:Action (e.g. eks:DescribeCluster, sts:AssumeRole).
  for (const m of log.matchAll(/\b([a-z0-9]+:[A-Z][A-Za-z0-9]+)\b/g)) {
    found.add(m[1]);
  }
  // Azure RBAC data-action verbs surfaced in AuthorizationFailed messages.
  for (const m of log.matchAll(
    /'(Microsoft\.[A-Za-z]+\/[A-Za-z/*]+(?:\/(?:read|write|action|delete))?)'/g
  )) {
    found.add(m[1]);
  }
  return [...found];
}

export function classifyVerifyFailure(
  input: VerifyFailureInput
): VerifyFailureClassification {
  const { failedSteps, log, oidcHelp, noSubscriptionsHelp } = input;
  const logText = log || "";

  // 1. Definitive trust signal: the OIDC token was rejected over its claims.
  if (oidcHelp) {
    return { category: "oidc-trust", detail: oidcHelp };
  }

  // 2. Login succeeded but the identity sees no subscription — an RBAC gap.
  if (noSubscriptionsHelp) {
    return {
      category: "permissions",
      detail: noSubscriptionsHelp,
      missingPermissions: extractMissingPermissions(logText)
    };
  }

  const hasReachability = REACHABILITY.test(logText);
  const hasAuthorization = AUTHORIZATION.test(logText);

  // 3. The Kubernetes-access step failed. Reaching the cluster and being refused
  //    is a permissions gap (4.4); not reaching it at all is unreachable (4.5).
  if (matchesStep(failedSteps, CLUSTER_STEP)) {
    if (hasAuthorization && !hasReachability) {
      return {
        category: "permissions",
        missingPermissions: extractMissingPermissions(logText)
      };
    }
    if (hasReachability) {
      return {
        category: "cluster-unreachable",
        component: "Kubernetes cluster"
      };
    }
    return { category: "generic" };
  }

  // 4. The OIDC / cloud-login step failed. Not reaching the provider is
  //    unreachable (4.5); reaching it and being rejected is a trust problem
  //    (4.3), since federation is what the login step establishes.
  if (matchesStep(failedSteps, OIDC_STEP)) {
    if (hasReachability) {
      return { category: "cloud-unreachable", component: "cloud provider" };
    }
    return { category: "oidc-trust" };
  }

  // 5. A post-login cloud access step failed: unreachable vs. denied.
  if (matchesStep(failedSteps, CLOUD_ACCESS_STEP)) {
    if (hasReachability && !hasAuthorization) {
      return { category: "cloud-unreachable", component: "cloud provider" };
    }
    if (hasAuthorization) {
      return {
        category: "permissions",
        missingPermissions: extractMissingPermissions(logText)
      };
    }
    return { category: "generic" };
  }

  // 6. The GHCR package-push check failed: the token cannot push the state
  //    package, which is a permissions gap the user resolves on the package.
  if (matchesStep(failedSteps, GHCR_STEP)) {
    return { category: "permissions" };
  }

  return { category: "generic" };
}
