import type { ComputePlatform, OidcResult, PortalContext } from "./types.js";
import { buildEnvironmentSuffix } from "./oidc-subject.js";

const AZURE_PORTAL_BASE = "https://portal.azure.com/#";
function buildResourceGroupResourceListUrl(
  subscriptionId: string,
  resourceGroup: string
): string {
  return `${AZURE_PORTAL_BASE}@/resource/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/resources`;
}

function buildResourceUrl(armResourceId: string): string {
  return `${AZURE_PORTAL_BASE}@/resource${armResourceId}/overview`;
}

function normalizeAzureResourceType(resourceType: string): string {
  const trimmed = (resourceType || "").trim();
  if (!trimmed) return "";

  const noApiVersion = trimmed.split("@")[0].trim();
  if (!noApiVersion) return "";

  if (noApiVersion.startsWith("Microsoft.")) {
    return noApiVersion;
  }

  return "";
}

function normalizeArmResourceId(resourceRef: string): string {
  const trimmed = (resourceRef || "").trim();
  if (!trimmed) return "";

  const noQuery = trimmed.split("?")[0].trim();
  // Strip leading slashes before the prefix check so "//subscriptions/..." is handled.
  let start = 0;
  while (start < noQuery.length && noQuery[start] === "/") {
    start += 1;
  }
  const stripped = noQuery.slice(start);
  if (!stripped.toLowerCase().startsWith("subscriptions/")) return "";

  let end = stripped.length;
  while (end > 0 && stripped[end - 1] === "/") {
    end -= 1;
  }
  const normalized = `/${stripped.slice(0, end)}`;
  return normalized;
}

function isKubernetesResourceType(resourceType: string): boolean {
  const t = (resourceType || "").trim();
  if (!t) return false;

  return /^(apps|core|batch|autoscaling|networking\.k8s\.io|storage\.k8s\.io|rbac\.authorization\.k8s\.io|apiextensions\.k8s\.io)\//i.test(
    t
  );
}

export const azure: ComputePlatform = {
  id: "azure",
  displayName: "Azure",
  recipePlatform: "kubernetes",
  clusterServiceName: "AKS",
  supports: { oidc: true, portalUrl: true },

  generateOidc(data: any): OidcResult {
    const d = data || {};
    const repoSlug = d.repoFullName || d.repo || "OWNER/REPO";
    const envName = d.environment || "production";
    // Default (mutable) GitHub subject. NOTE: orgs/repos can customize the OIDC
    // subject, and GitHub's immutable-subject rollout can change even the
    // default to `repo:{owner}@<ownerId>/{repo}@<repoId>:...`. The auto-setup
    // path (/api/azure-auto-setup) queries the customization API and derives the
    // exact subject (creating both default forms when undetermined); this manual
    // script uses the common default and warns below.
    const subject = `repo:${repoSlug}:${buildEnvironmentSuffix(envName)}`;
    return {
      message: "Azure OIDC configuration generated",
      output: `# Azure Federated Identity Configuration
# Run these commands to set up OIDC for GitHub Actions:

# 1. Set repository variables (these identifiers are not secret):
gh variable set AZURE_TENANT_ID --body "${d.tenantId || ""}"
gh variable set AZURE_SUBSCRIPTION_ID --body "${d.subscriptionId || ""}"
gh variable set AZURE_CLIENT_ID --body "${d.clientId || ""}"

# NOTE (enterprise/Corpnet tenants): if you create the App Registration
# yourself, tenant policy may require a Service Management Reference — add
#   --service-management-reference <SERVICE_MANAGEMENT_REFERENCE>
# to \`az ad app create\` (for Microsoft-internal tenants this is your Service
# Tree ID GUID), otherwise it fails with "ServiceManagementReference field is
# required".

# NOTE (OIDC subject): if your org/repo customizes the Actions OIDC subject, or
# your repo uses GitHub's immutable subject, the "subject" below must match what
# GitHub actually mints (GET /repos/${repoSlug}/actions/oidc/customization/sub).
# A mismatch fails deploy-time login with AADSTS700213.

# 2. Create federated credential (via Azure CLI):
az ad app federated-credential create \\
  --id ${d.clientId || "<CLIENT_ID>"} \\
  --parameters '{
    "name": "github-actions-oidc",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "${subject}",
    "audiences": ["api://AzureADTokenExchange"]
  }'

# 3. Assign Contributor role on the subscription:
az role assignment create \\
  --assignee ${d.clientId || "<CLIENT_ID>"} \\
  --role "Contributor" \\
  --scope "/subscriptions/${d.subscriptionId || "<SUBSCRIPTION_ID>"}"
`
    };
  },

  environmentSecrets(data: any) {
    const d = data || {};
    return [
      {
        kind: "variable" as const,
        name: "AZURE_SUBSCRIPTION_ID",
        value: d.subscriptionId
      },
      {
        kind: "variable" as const,
        name: "AZURE_RESOURCE_GROUP",
        value: d.resourceGroup
      },
      { kind: "variable" as const, name: "AZURE_LOCATION", value: d.location }
    ];
  },

  portalUrl(resourceType: string, ctx: PortalContext): string {
    const rt = (resourceType || "").trim();
    const subscriptionId = ctx.subscriptionId;
    const resourceGroup = ctx.resourceGroup;
    const clusterName = (ctx.clusterName || "").trim();

    const armResourceId = normalizeArmResourceId(rt);
    if (armResourceId) {
      return buildResourceUrl(armResourceId);
    }

    const normalizedArmType = normalizeAzureResourceType(rt);
    if (normalizedArmType) {
      // Type-only values do not identify a concrete instance.
      return buildResourceGroupResourceListUrl(subscriptionId, resourceGroup);
    }

    // Radius resources often materialize to Kubernetes objects on AKS.
    if (isKubernetesResourceType(rt) || rt.startsWith("Radius.")) {
      if (clusterName) {
        const clusterId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
        return buildResourceUrl(clusterId);
      }
      return buildResourceGroupResourceListUrl(subscriptionId, resourceGroup);
    }

    return buildResourceGroupResourceListUrl(subscriptionId, resourceGroup);
  }
};
