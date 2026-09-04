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
// run log.
//
// The step names below are the *exact* contracts emitted by those workflows:
//   verify-azure.yml: Azure Login (OIDC) / Wait for Azure subscription /
//     Verify Azure Credentials / Set up kubelogin / Verify AKS Access /
//     Verify GHCR package push permission
//   verify-aws.yml:   Configure AWS Credentials / Verify AWS Credentials /
//     Verify EKS Access / Verify GHCR package push permission
//
// A failed step name only tells us *where* verification stopped; it is never on
// its own enough to conclude *why*. Because the bypassable categories
// (permissions / cluster-unreachable / cloud-unreachable) let a user create the
// environment before the problem is fixed, we only assign one when the log
// carries definitive, category-specific evidence (a reachability failure, an
// authorization denial, or an OIDC-trust rejection). Otherwise the result is
// "generic" — non-bypassable — so an ambiguous or operational failure is
// surfaced rather than mislabeled as a bypassable one. The function is pure: it
// performs no I/O and never throws.

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

// Exact production step contracts from verify-azure.yml / verify-aws.yml. A
// failed step selects which evidence gate to apply; it never classifies alone.

// Federation / login step — where OIDC trust is established.
const LOGIN_STEP =
  /azure login|login\s*\(oidc\)|configure\s+aws\s+credentials|assume\s*role/i;

// Post-login credential / subscription check — identity is authenticated but
// may lack the RBAC to see the subscription or act as itself.
const CREDENTIAL_STEP =
  /verify\s+(?:azure|aws)\s+credentials|wait\s+for\s+azure\s+subscription/i;

// Kubernetes cluster access step.
const CLUSTER_STEP = /verify\s+(?:aks|eks)\s+access|kubelogin|\b(?:aks|eks)\b/i;

// GHCR state-package push permission step.
const GHCR_STEP = /ghcr|package\s*push/i;

// Network / reachability failures — the endpoint could not be contacted at all,
// as opposed to being reached and rejecting the request on authorization.
const REACHABILITY =
  /could not connect|connection refused|connection timed out|connection reset|timed?\s*out|no such host|dial tcp|network is unreachable|i\/o timeout|temporary failure in name resolution|unable to connect to the server|tls handshake timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|getaddrinfo|server misbehaving|service unavailable|\b50[234]\b/i;

// Authorization failures — the endpoint was reached and refused the identity.
const AUTHORIZATION =
  /AuthorizationFailed|\bForbidden\b|not authorized|does not have authorization|insufficient privileges|role assignment|AccessDenied|UnauthorizedOperation|cannot (?:get|list|create|update|patch|delete) resource|\b401\b|\b403\b/i;

// Definitive OIDC-trust rejections — the provider reached GitHub's federation
// but refused the token over its claims (subject / audience / federated
// credential). Distinct from a generic authorization denial.
const TRUST_EVIDENCE =
  /assumerolewithwebidentity|not authorized to perform sts:assumerole|AADSTS7\d{5}|no matching federated identity|federated\s+(?:identity\s+)?credential|no OpenID ?Connect provider|invalid_client|(?:subject|audience)\s+claim/i;

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
  const hasTrustEvidence = TRUST_EVIDENCE.test(logText);

  // 3. The federation / login step failed. Not reaching the provider is
  //    unreachable (4.5); a token rejected over its claims is a trust problem
  //    (4.3). Without either signal we cannot claim a bypassable cause, so the
  //    failure stays generic rather than being assumed a trust gap.
  if (matchesStep(failedSteps, LOGIN_STEP)) {
    if (hasReachability) {
      return { category: "cloud-unreachable", component: "cloud provider" };
    }
    if (hasTrustEvidence) {
      return { category: "oidc-trust" };
    }
    return { category: "generic" };
  }

  // 4. A post-login credential / subscription check failed. Reaching the
  //    provider and being refused is a permissions gap (4.4); not reaching it is
  //    unreachable (4.5); anything else is generic. Reachability wins when both
  //    appear, mirroring the cluster-step branch below: a log carrying both a
  //    timeout and an authorization line is far more likely a transient outage
  //    than a genuine RBAC gap, and mislabeling it "permissions" would invite
  //    the user to bypass a problem they cannot actually fix.
  if (matchesStep(failedSteps, CREDENTIAL_STEP)) {
    if (hasReachability) {
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

  // 5. The Kubernetes-access step failed. Not reaching the cluster is
  //    unreachable (4.5); reaching it and being refused is a permissions gap
  //    (4.4). Reachability wins when both appear.
  if (matchesStep(failedSteps, CLUSTER_STEP)) {
    if (hasReachability) {
      return {
        category: "cluster-unreachable",
        component: "Kubernetes cluster"
      };
    }
    if (hasAuthorization) {
      return {
        category: "permissions",
        missingPermissions: extractMissingPermissions(logText)
      };
    }
    return { category: "generic" };
  }

  // 6. The GHCR package-push check failed. Only a definitive authorization
  //    denial is the bypassable permissions gap (4.4); a registry outage or any
  //    other cause stays generic so an operational failure is not mislabeled as
  //    a permissions problem the user is asked to bypass.
  if (matchesStep(failedSteps, GHCR_STEP)) {
    if (hasAuthorization) {
      return { category: "permissions" };
    }
    return { category: "generic" };
  }

  return { category: "generic" };
}
