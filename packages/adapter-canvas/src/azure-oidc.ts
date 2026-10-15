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

export interface DiscoveryData {
  clusters?: unknown[];
  resourceGroups?: unknown[];
  vpcs?: unknown[];
  subnets?: unknown[];
  error?: string;
  errors?: Record<string, string>;
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

export function discoverStatusText(
  data: DiscoveryData = {},
  provider: "azure" | "aws" = "azure"
): string {
  const errs = data.errors || {};
  if (provider === "aws") {
    const errMsg =
      data.error || errs.vpcs || errs.clusters || errs.subnets || "";
    if (errMsg) return "Discovery failed: " + errMsg;
    return `Found ${(data.clusters || []).length} cluster(s), ${
      (data.vpcs || []).length
    } VPC(s)`;
  }
  const errMsg =
    data.error || errs.resourceGroups || errs.clusters || errs.namespaces || "";
  if (errMsg) return "Discovery failed: " + errMsg;
  return `Found ${(data.clusters || []).length} cluster(s), ${
    (data.resourceGroups || []).length
  } resource group(s)`;
}
