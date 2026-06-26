import type { ComputePlatform, OidcResult, PortalContext } from "./types.js";

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

# 1. Set repository secrets:
gh secret set AZURE_TENANT_ID --body "${data.tenantId || ""}"
gh secret set AZURE_SUBSCRIPTION_ID --body "${data.subscriptionId || ""}"
gh secret set AZURE_CLIENT_ID --body "${data.clientId || ""}"

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
      { kind: "secret" as const, name: "AZURE_SUBSCRIPTION_ID", value: data.subscriptionId },
      { kind: "secret" as const, name: "AZURE_RESOURCE_GROUP", value: data.resourceGroup },
      { kind: "secret" as const, name: "AZURE_LOCATION", value: data.location },
    ];
  },

  portalUrl(resourceType: string, ctx: PortalContext): string {
    const subscriptionId = ctx.subscriptionId;
    const resourceGroup = ctx.resourceGroup;
        const azureBase = 'https://portal.azure.com/#@/resource';
        const rg = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers`;

        if (resourceType.includes('DBforPostgreSQL') || resourceType.includes('PostgreSQL Flexible Server')) {
            return `${azureBase}${rg}/Microsoft.DBforPostgreSQL/flexibleServers/radius-postgres/overview`;
        }
        if (resourceType.includes('DBforMySQL') || resourceType.includes('MySQL Flexible Server')) {
            return `${azureBase}${rg}/Microsoft.DBforMySQL/flexibleServers/radius-mysql/overview`;
        }
        if (resourceType.includes('Cache/redis') || resourceType.includes('Cache for Redis')) {
            return `${azureBase}${rg}/Microsoft.Cache/redis/radius-redis/overview`;
        }
        if (resourceType.includes('DocumentDB') || resourceType.includes('Cosmos DB')) {
            return `${azureBase}${rg}/Microsoft.DocumentDB/databaseAccounts/radius-cosmos/overview`;
        }
        if (resourceType.includes('KeyVault') || resourceType.includes('Key Vault')) {
            return `${azureBase}${rg}/Microsoft.KeyVault/vaults/radius-kv/overview`;
        }
        if (resourceType.includes('ContainerRegistry') || resourceType.includes('Container Registry')) {
            return `${azureBase}${rg}/Microsoft.ContainerRegistry/registries/radiusacr/overview`;
        }
        if (resourceType.includes('applicationGateways') || resourceType.includes('Application Gateway')) {
            return `${azureBase}${rg}/Microsoft.Network/applicationGateways/radius-appgw/overview`;
        }
        if (resourceType.includes('Compute/disks') || resourceType.includes('Managed Disk')) {
            return `${azureBase}${rg}/Microsoft.Compute/disks/radius-disk/overview`;
        }
        // K8s resources link to AKS cluster
        if (resourceType.includes('apps/Deployment') || resourceType.includes('core/Service') || resourceType.includes('Ingress') || resourceType.includes('PersistentVolume')) {
            return `${azureBase}${rg}/Microsoft.ContainerService/managedClusters/radius-aks/overview`;
        }
    return "";
  },

  verifyWorkflowSteps: `
      - name: Azure Login (OIDC)
        uses: azure/login@v2
        with:
          client-id: \${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: \${{ secrets.AZURE_TENANT_ID }}
          subscription-id: \${{ secrets.AZURE_SUBSCRIPTION_ID }}

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
          client-id: \${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: \${{ secrets.AZURE_TENANT_ID }}
          subscription-id: \${{ secrets.AZURE_SUBSCRIPTION_ID }}

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
  radCredentialRegister: `rad credential register azure sp --client-id "\${{ secrets.AZURE_CLIENT_ID }}" --client-secret "\${{ secrets.RADIUS_CLIENT_SECRET }}" --tenant-id "\${{ secrets.AZURE_TENANT_ID }}"
          rad env update "\${{ env.RADIUS_ENV }}" --azure-subscription-id "\${{ secrets.AZURE_SUBSCRIPTION_ID }}" --azure-resource-group "\${{ vars.AZURE_RESOURCE_GROUP }}"`,
  recipeAuthEnv: `,{\\"name\\":\\"ARM_CLIENT_ID\\",\\"value\\":\\"\${{ secrets.AZURE_CLIENT_ID }}\\"},{\\"name\\":\\"ARM_TENANT_ID\\",\\"value\\":\\"\${{ secrets.AZURE_TENANT_ID }}\\"},{\\"name\\":\\"ARM_SUBSCRIPTION_ID\\",\\"value\\":\\"\${{ secrets.AZURE_SUBSCRIPTION_ID }}\\"},{\\"name\\":\\"ARM_USE_OIDC\\",\\"value\\":\\"true\\"},{\\"name\\":\\"ARM_OIDC_REQUEST_URL\\",\\"value\\":\\"\$ACTIONS_ID_TOKEN_REQUEST_URL\\"},{\\"name\\":\\"ARM_OIDC_REQUEST_TOKEN\\",\\"value\\":\\"\$ACTIONS_ID_TOKEN_REQUEST_TOKEN\\"}`,
  dbRecipeRegister: `          # Database: managed Azure MySQL Flexible Server (azure/terraform recipe)
          rad recipe register default \\
            --resource-type "Radius.Data/mySqlDatabases" \\
            --template-kind terraform \\
            --template-path "git::https://github.com/radius-project/resource-types-contrib.git//Data/mySqlDatabases/recipes/azure/terraform?ref=\${{ env.RESOURCE_TYPES_CONTRIB_REF }}" \\
            --parameters azure_subscription_id="\${{ secrets.AZURE_SUBSCRIPTION_ID }}" \\
            --parameters resourceGroupName="\${{ vars.AZURE_RESOURCE_GROUP }}" \\
            --parameters location="\$TARGET_REGION" \\
            --environment "\${{ env.RADIUS_ENV }}"`,
};
