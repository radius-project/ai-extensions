import type { ComputePlatform, OidcResult, PortalContext } from "./types.js";

const AZURE_PORTAL_BASE = "https://portal.azure.com/#";
function buildResourceGroupResourceListUrl(subscriptionId: string, resourceGroup: string): string {
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

  return /^(apps|core|batch|autoscaling|networking\.k8s\.io|storage\.k8s\.io|rbac\.authorization\.k8s\.io|apiextensions\.k8s\.io)\//i.test(t);
}

export const azure: ComputePlatform = {
  id: "azure",
  displayName: "Azure",
  recipePlatform: "kubernetes",
  clusterServiceName: "AKS",
  supports: { oidc: true, portalUrl: true },

  generateOidc(data: any): OidcResult {
    const d = data || {};
    return {
      message: "Azure OIDC configuration generated",
      output: `# Azure Federated Identity Configuration
# Run these commands to set up OIDC for GitHub Actions:

# 1. Set repository variables (these identifiers are not secret):
gh variable set AZURE_TENANT_ID --body "${d.tenantId || ""}"
gh variable set AZURE_SUBSCRIPTION_ID --body "${d.subscriptionId || ""}"
gh variable set AZURE_CLIENT_ID --body "${d.clientId || ""}"

# 2. Create federated credential (via Azure CLI):
az ad app federated-credential create \\
  --id ${d.clientId || "<CLIENT_ID>"} \\
  --parameters '{
    "name": "github-actions-oidc",
    "issuer": "https://token.actions.githubusercontent.com",
    "subject": "repo:OWNER/REPO:environment:production",
    "audiences": ["api://AzureADTokenExchange"]
  }'

# 3. Assign Contributor role on the subscription:
az role assignment create \\
  --assignee ${d.clientId || "<CLIENT_ID>"} \\
  --role "Contributor" \\
  --scope "/subscriptions/${d.subscriptionId || "<SUBSCRIPTION_ID>"}"
`,
    };
  },

  environmentSecrets(data: any) {
    const d = data || {};
    return [
      { kind: "variable" as const, name: "AZURE_SUBSCRIPTION_ID", value: d.subscriptionId },
      { kind: "variable" as const, name: "AZURE_RESOURCE_GROUP", value: d.resourceGroup },
      { kind: "variable" as const, name: "AZURE_LOCATION", value: d.location },
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
          az aks get-credentials --name "\${{ vars.RADIUS_K8S_CLUSTER }}" --resource-group "\${{ vars.AZURE_RESOURCE_GROUP }}" --overwrite-existing
          kubelogin convert-kubeconfig -l azurecli
          kubectl cluster-info
          echo "✅ AKS cluster accessible"
`,
  deployClusterAuthSteps: `
      - name: Azure Login (OIDC)
        uses: azure/login@v2
        with:
          client-id: \${{ vars.AZURE_CLIENT_ID }}
          tenant-id: \${{ vars.AZURE_TENANT_ID }}
          subscription-id: \${{ vars.AZURE_SUBSCRIPTION_ID }}

      - name: Capture target AKS kubeconfig (static admin credentials)
        run: |
          az aks get-credentials \\
            --name "\${{ vars.RADIUS_K8S_CLUSTER }}" \\
            --resource-group "\${{ vars.AZURE_RESOURCE_GROUP }}" \\
            --admin --overwrite-existing --file /tmp/target-kubeconfig
          echo "TARGET_KUBECONFIG=/tmp/target-kubeconfig" >> "\$GITHUB_ENV"
          # Provision cloud data services in the same region as the target cluster.
          TARGET_REGION=\$(az aks show --name "\${{ vars.RADIUS_K8S_CLUSTER }}" --resource-group "\${{ vars.AZURE_RESOURCE_GROUP }}" --query location -o tsv)
          echo "TARGET_REGION=\$TARGET_REGION" >> "\$GITHUB_ENV"
`,
  radCredentialRegister: `rad credential register azure wi --client-id "\${{ vars.AZURE_CLIENT_ID }}" --tenant-id "\${{ vars.AZURE_TENANT_ID }}"
          rad env update "\${{ env.RADIUS_ENV }}" --azure-subscription-id "\${{ vars.AZURE_SUBSCRIPTION_ID }}" --azure-resource-group "\${{ vars.AZURE_RESOURCE_GROUP }}"`,
  recipeAuthEnv: `,{\\"name\\":\\"ARM_CLIENT_ID\\",\\"value\\":\\"\${{ vars.AZURE_CLIENT_ID }}\\"},{\\"name\\":\\"ARM_TENANT_ID\\",\\"value\\":\\"\${{ vars.AZURE_TENANT_ID }}\\"},{\\"name\\":\\"ARM_SUBSCRIPTION_ID\\",\\"value\\":\\"\${{ vars.AZURE_SUBSCRIPTION_ID }}\\"},{\\"name\\":\\"ARM_USE_OIDC\\",\\"value\\":\\"true\\"},{\\"name\\":\\"ARM_OIDC_REQUEST_URL\\",\\"value\\":\\"\$ACTIONS_ID_TOKEN_REQUEST_URL\\"},{\\"name\\":\\"ARM_OIDC_REQUEST_TOKEN\\",\\"value\\":\\"\$ACTIONS_ID_TOKEN_REQUEST_TOKEN\\"}`,
  dbRecipeRegister: `          # Database: managed Azure MySQL Flexible Server (azure/terraform recipe)
          rad recipe register default \\
            --resource-type "Radius.Data/mySqlDatabases" \\
            --template-kind terraform \\
            --template-path "git::https://github.com/radius-project/resource-types-contrib.git//Data/mySqlDatabases/recipes/azure/terraform?ref=\${{ env.RESOURCE_TYPES_CONTRIB_REF }}" \\
            --parameters azure_subscription_id="\${{ vars.AZURE_SUBSCRIPTION_ID }}" \\
            --parameters resourceGroupName="\${{ vars.AZURE_RESOURCE_GROUP }}" \\
            --parameters location="\$TARGET_REGION" \\
            --environment "\${{ env.RADIUS_ENV }}"`,
};
