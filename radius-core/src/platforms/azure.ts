import type { ComputePlatform, OidcResult, PortalContext } from "./types.js";

const AZURE_PORTAL_BASE = "https://portal.azure.com/#";

function buildResourceGroupResourceListUrl(subscriptionId: string, resourceGroup: string): string {
  return `${AZURE_PORTAL_BASE}@/resource/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/resources`;
}

function buildResourceUrl(armResourceId: string): string {
  return `${AZURE_PORTAL_BASE}@/resource${armResourceId}/overview`;
}

function extractTypeFromArmId(value: string): string {
  const providersIndex = value.toLowerCase().indexOf("/providers/");
  if (providersIndex === -1) return "";

  const providerPath = value.slice(providersIndex + "/providers/".length).split("?")[0];
  const parts = providerPath.split("/").filter(Boolean);
  if (parts.length < 2) return "";

  const providerNamespace = parts[0];
  const typeParts: string[] = [];

  // ARM IDs alternate as type/name/type/name after the provider namespace.
  for (let i = 1; i < parts.length; i += 2) {
    typeParts.push(parts[i]);
  }

  return `${providerNamespace}/${typeParts.join("/")}`;
}

function normalizeAzureResourceType(resourceType: string): string {
  const trimmed = (resourceType || "").trim();
  if (!trimmed) return "";

  const noApiVersion = trimmed.split("@")[0].trim();
  if (!noApiVersion) return "";

  if (noApiVersion.toLowerCase().startsWith("/subscriptions/")) {
    return extractTypeFromArmId(noApiVersion);
  }

  if (noApiVersion.startsWith("Microsoft.")) {
    return noApiVersion;
  }

  return "";
}

function normalizeArmResourceId(resourceRef: string): string {
  const trimmed = (resourceRef || "").trim();
  if (!trimmed) return "";

  const noQuery = trimmed.split("?")[0].trim();
  if (!noQuery.toLowerCase().startsWith("/subscriptions/")) return "";

  const normalized = `/${noQuery.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  return normalized;
}

function isKubernetesResourceType(resourceType: string): boolean {
  const t = (resourceType || "").trim();
  if (!t) return false;

  return /^(apps|core|batch|autoscaling|networking\.k8s\.io|storage\.k8s\.io|rbac\.authorization\.k8s\.io|apiextensions\.k8s\.io)\//i.test(t);
}

export const azure: ComputePlatform = {
  id: "azure",
  displayName: "Azure",
  recipePlatform: "kubernetes",
  clusterServiceName: "AKS",
  supports: { oidc: true, portalUrl: true },

  generateOidc(data: any): OidcResult {
    return {
      message: "Azure OIDC configuration generated",
      output: `# Azure Federated Identity Configuration
# Run these commands to set up OIDC for GitHub Actions:

# 1. Set repository variables (these identifiers are not secret):
gh variable set AZURE_TENANT_ID --body "${data.tenantId || ""}"
gh variable set AZURE_SUBSCRIPTION_ID --body "${data.subscriptionId || ""}"
gh variable set AZURE_CLIENT_ID --body "${data.clientId || ""}"

# 2. Create federated credential (via Azure CLI):
az ad app federated-credential create \\
  --id ${data.clientId || "<CLIENT_ID>"} \\
  --parameters '{
    "name": "github-actions-oidc",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:OWNER/REPO:environment:production",
    "audiences": ["api://AzureADTokenExchange"]
  }'

# 3. Assign Contributor role on the subscription:
az role assignment create \\
  --assignee ${data.clientId || "<CLIENT_ID>"} \\
  --role "Contributor" \\
  --scope "/subscriptions/${data.subscriptionId || "<SUBSCRIPTION_ID>"}"
`,
    };
  },

  environmentSecrets(data: any) {
    return [
      { kind: "variable" as const, name: "AZURE_SUBSCRIPTION_ID", value: data.subscriptionId },
      { kind: "variable" as const, name: "AZURE_RESOURCE_GROUP", value: data.resourceGroup },
      { kind: "variable" as const, name: "AZURE_LOCATION", value: data.location },
    ];
  },

  portalUrl(resourceType: string, ctx: PortalContext): string {
    const subscriptionId = ctx.subscriptionId;
    const resourceGroup = ctx.resourceGroup;
    const clusterName = (ctx.clusterName || "").trim();

    const armResourceId = normalizeArmResourceId(resourceType);
    if (armResourceId) {
      return buildResourceUrl(armResourceId);
    }

    const normalizedArmType = normalizeAzureResourceType(resourceType);
    if (normalizedArmType) {
      // Type-only values do not identify a concrete instance.
      return buildResourceGroupResourceListUrl(subscriptionId, resourceGroup);
    }

    // Radius resources often materialize to Kubernetes objects on AKS.
    if (isKubernetesResourceType(resourceType) || resourceType.startsWith("Radius.")) {
      if (clusterName) {
        const clusterId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
        return buildResourceUrl(clusterId);
      }
      return buildResourceGroupResourceListUrl(subscriptionId, resourceGroup);
    }

    return buildResourceGroupResourceListUrl(subscriptionId, resourceGroup);
  },

  verifyWorkflowSteps: `
      - name: Azure Login (OIDC)
        uses: azure/login@v2
        with:
          client-id: \${{ vars.AZURE_CLIENT_ID }}
          tenant-id: \${{ vars.AZURE_TENANT_ID }}
          subscription-id: \${{ vars.AZURE_SUBSCRIPTION_ID }}

      - name: Verify Azure Credentials
        run: |
          az account show
          echo "✅ Azure OIDC login successful"

      - name: Set up kubelogin
        uses: azure/use-kubelogin@v1
        with:
          kubelogin-version: 'v0.1.4'

      - name: Verify AKS Access
        run: |
          az aks get-credentials --name "\${{ vars.AZURE_AKS_CLUSTER_NAME }}" --resource-group "\${{ vars.AZURE_RESOURCE_GROUP }}" --overwrite-existing
          kubelogin convert-kubeconfig -l azurecli
          kubectl cluster-info
          echo "✅ AKS cluster accessible"
`,
};
