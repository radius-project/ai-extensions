export {
  type OidcError,
  type OwnedAppRegistration,
  type AppSelectionInput,
  type RadiusAppProvenanceInput,
  type RadiusAppProvenance,
  type RadiusAppOwnershipDecision,
  type FederatedCredential,
  type GitHubJsonPayload,
  type GitHubJsonResponse,
  type GitHubJsonRunner,
  type FetchGitHubJsonOptions,
  type ResolveOidcSubjectInput,
  type ResolveOidcSubjectResult,
  findLegacyMutableCredentialName,
  REPO_SLUG_RE,
  UUID_RE,
  AKS_CLUSTER_NAME_RE,
  RESOURCE_GROUP_NAME_RE,
  GITHUB_API_VERSION,
  RADIUS_MANAGED_APP_TAG,
  RADIUS_REPO_APP_TAG_PREFIX,
  RADIUS_ENVIRONMENT_APP_TAG_PREFIX,
  RADIUS_OPERATION_APP_TAG_PREFIX,
  isUuid,
  isValidRepoSlug,
  isAksClusterName,
  isResourceGroupName,
  oidcError,
  buildAppCreateArgs,
  type CallerIdentity,
  buildSignedInUserObjectIdArgs,
  buildServicePrincipalObjectIdArgs,
  parseCallerIdentity,
  buildAppOwnerAddArgs,
  buildAppOwnerListArgs,
  isAppOwnerAlreadyAssignedError,
  parseDirectoryObjectIds,
  buildRadiusAppProvenanceTags,
  buildAppTagPatchArgs,
  buildAppTagShowArgs,
  parseAppTags,
  parseRadiusAppProvenanceTags,
  isRadiusProvenanceMatch,
  decideRadiusAppOwnership,
  missingRequiredAppTags,
  buildAppDeleteArgs,
  buildFederatedCredentialListArgs,
  buildFederatedCredentialDeleteArgs,
  type AzureFederatedCredential,
  parseFederatedCredentials,
  federatedCredentialListUnreadable,
  selectEnvironmentFederatedCredentials,
  decideAppSelection,
  parseServedReposFromSubjects,
  validateAppRegistrationName,
  selectMissingFederatedCredentials,
  isAzResourceNotFound,
  decideExistingClientId,
  SERVICE_MANAGEMENT_REFERENCE_ERROR_IDS,
  isServiceManagementReferenceError,
  fetchGitHubJson,
  resolveOidcSubject
} from "@radius-project/core/platforms";
import type { AwsCliErrorKind } from "@radius-project/core/platforms";

export interface DiscoveryData {
  clusters?: unknown[];
  resourceGroups?: unknown[];
  vpcs?: unknown[];
  subnets?: unknown[];
  error?: string;
  errors?: Record<string, string>;
  // AWS only: the AWS CLI error kind of each list that failed.
  errorKinds?: Partial<Record<string, AwsCliErrorKind>>;
}

export function formatServesReposLabel(
  list: readonly string[] | null | undefined
): string {
  if (!Array.isArray(list) || list.length === 0) return "";
  if (list.length <= 3) return "Serves: " + list.join(", ");
  return (
    "Serves: " +
    list.slice(0, 3).join(", ") +
    " +" +
    (list.length - 3) +
    " more"
  );
}

const AWS_SESSION_ENDED_TEXT =
  "The AWS CLI session ended during discovery. Sign in, then select Refresh.";

function clusterListFailureText(
  kind: string | undefined,
  message: string,
  region: string
): string {
  if (kind === "credentials") {
    return "The AWS CLI has no valid session. Sign in, then select Refresh.";
  }
  if (kind === "rejected") {
    return `AWS rejected the credentials in ${region}. The region may not be enabled for this account, or the credentials may not be valid.`;
  }
  if (kind === "denied") {
    return "The signed-in identity can't list EKS clusters (eks:ListClusters).";
  }
  return `Can't list EKS clusters: ${message}`;
}

function clusterRecords(data: DiscoveryData): Record<string, unknown>[] {
  return (data.clusters || []).filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item)
  );
}

// One sentence for the cluster list, then one for a failed subnet list. A list
// that failed because the AWS CLI session ended shares one session sentence.
// Route-table, VPC, zone, and namespace failures stay out of this line. A
// route-table failure shows a warning under the subnets. A VPC failure shows a
// note under the VPC ID, and a namespace failure shows a note under the
// namespace list of common names. Zone kinds fall back to the zone names.
function awsDiscoverStatusText(data: DiscoveryData, region: string): string {
  if (data.error) return "Discovery failed: " + data.error;
  const errs = data.errors || {};
  const kinds = data.errorKinds || {};
  if (kinds.clusters !== undefined || errs.clusters !== undefined) {
    return clusterListFailureText(kinds.clusters, errs.clusters || "", region);
  }
  const clusters = clusterRecords(data);
  const usable = clusters.filter((cluster) => cluster.usable === true).length;
  const sentences = [
    clusters.length === 0 ?
      `No EKS clusters in ${region}.`
    : `Found ${clusters.length} EKS cluster${clusters.length === 1 ? "" : "s"} in ${region}.`
  ];
  if (usable < clusters.length) {
    sentences.push(
      usable === 0 ? "None can be used." : `${usable} can be used.`
    );
  }
  if (kinds.subnets === "denied") {
    sentences.push(
      "The signed-in identity can't list subnets (ec2:DescribeSubnets)."
    );
  } else if (errs.subnets !== undefined && kinds.subnets !== "credentials") {
    sentences.push(`Can't list subnets: ${errs.subnets}`);
  }
  const sessionEnded =
    Object.values(kinds).includes("credentials") ||
    clusters.some((cluster) => cluster.describeErrorKind === "credentials");
  if (sessionEnded) sentences.push(AWS_SESSION_ENDED_TEXT);
  return sentences.join(" ");
}

export function discoverStatusText(
  data: DiscoveryData = {},
  provider: "azure" | "aws" = "azure",
  region = ""
): string {
  if (provider === "aws") return awsDiscoverStatusText(data, region);
  const errs = data.errors || {};
  const errMsg =
    data.error || errs.resourceGroups || errs.clusters || errs.namespaces || "";
  if (errMsg) return "Discovery failed: " + errMsg;
  return `Found ${(data.clusters || []).length} cluster(s), ${
    (data.resourceGroups || []).length
  } resource group(s)`;
}
