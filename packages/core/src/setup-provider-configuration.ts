export const AWS_TRUST_SUBJECTS_VARIABLE = "AWS_TRUST_SUBJECTS";

export interface SetupProviderConfigurationInput {
  clientId?: string;
  tenantId?: string;
  subscriptionId?: string;
  resourceGroup?: string;
  clusterResourceGroup?: string;
  cluster?: string;
  location?: string;
  namespace?: string;
  roleArn?: string;
  region?: string;
  accountId?: string;
  vpcId?: string;
  subnetIds?: string;
  // AWS only: the GitHub OIDC subjects setup added to the role's trust.
  trustSubjects?: readonly string[];
}

export interface SetupProviderCredentialPorts {
  azureCredential(): {
    clientId?: unknown;
    tenantId?: unknown;
    subscriptionId?: unknown;
  };
  awsCredential(): { region?: unknown; accountId?: unknown };
  optionalString(value: unknown): string;
}

export interface SetupProviderCredentialStatus {
  provider: "azure" | "aws";
  credentialsComplete: boolean;
}

export type SetupProviderConfigurationEvent =
  | { kind: "configuration-started" }
  | { kind: "azure-values-configured"; count: number }
  | { kind: "credentials-missing"; provider: "azure" | "aws" }
  | { kind: "azure-role-guidance"; assignee: string; scope: string };

export interface SetupProviderConfigurationPorts extends SetupProviderCredentialPorts {
  setEnvironmentVariable(name: string, value: unknown): Promise<boolean>;
  report(event: SetupProviderConfigurationEvent): void;
}

export function cloudCredentialsComplete(
  provider: string,
  creds: {
    clientId?: string;
    tenantId?: string;
    subscriptionId?: string;
    roleArn?: string;
  }
): boolean {
  if (provider === "azure") {
    return !!(creds.clientId && creds.tenantId && creds.subscriptionId);
  }
  return !!creds.roleArn;
}

export function setupProviderCredentialStatus(
  provider: string,
  data: SetupProviderConfigurationInput,
  ports: SetupProviderCredentialPorts
): SetupProviderCredentialStatus {
  if (provider === "azure") {
    const azureCreds = ports.azureCredential();
    return {
      provider: "azure",
      credentialsComplete: cloudCredentialsComplete("azure", {
        clientId: data.clientId || ports.optionalString(azureCreds.clientId),
        tenantId: data.tenantId || ports.optionalString(azureCreds.tenantId),
        subscriptionId:
          data.subscriptionId || ports.optionalString(azureCreds.subscriptionId)
      })
    };
  }
  return {
    provider: "aws",
    credentialsComplete: cloudCredentialsComplete("aws", {
      roleArn: data.roleArn || ""
    })
  };
}

export function azureRoleScope(
  subscriptionId: string,
  resourceGroup?: string
): string {
  const rg = (resourceGroup || "").trim();
  return rg ?
      `/subscriptions/${subscriptionId}/resourceGroups/${rg}`
    : `/subscriptions/${subscriptionId}`;
}

export async function applySetupProviderConfiguration(
  provider: string,
  data: SetupProviderConfigurationInput,
  ports: SetupProviderConfigurationPorts
): Promise<SetupProviderCredentialStatus> {
  ports.report({ kind: "configuration-started" });
  // Preserve legacy read order, including the independent readiness read.
  const azureCreds = ports.azureCredential();
  const awsCreds = ports.awsCredential();
  const status = setupProviderCredentialStatus(provider, data, ports);

  if (provider === "azure") {
    const clientId = data.clientId || ports.optionalString(azureCreds.clientId);
    const tenantId = data.tenantId || ports.optionalString(azureCreds.tenantId);
    const subscriptionId =
      data.subscriptionId || ports.optionalString(azureCreds.subscriptionId);
    const rg = data.resourceGroup || "";
    const clusterRg = data.clusterResourceGroup || "";
    const k8s = data.cluster || "";

    await ports.setEnvironmentVariable("AZURE_CLIENT_ID", clientId);
    await ports.setEnvironmentVariable("AZURE_TENANT_ID", tenantId);
    await ports.setEnvironmentVariable("AZURE_SUBSCRIPTION_ID", subscriptionId);
    await ports.setEnvironmentVariable("AZURE_RESOURCE_GROUP", rg);
    await ports.setEnvironmentVariable("AZURE_AKS_CLUSTER_NAME", k8s);
    await ports.setEnvironmentVariable("AZURE_AKS_RESOURCE_GROUP", clusterRg);
    await ports.setEnvironmentVariable("AZURE_LOCATION", data.location);
    await ports.setEnvironmentVariable("KUBERNETES_NAMESPACE", data.namespace);

    ports.report({
      kind: "azure-values-configured",
      count: [
        clientId,
        tenantId,
        subscriptionId,
        rg,
        k8s,
        clusterRg,
        data.location,
        data.namespace
      ].filter(Boolean).length
    });
    if (!status.credentialsComplete) {
      ports.report({ kind: "credentials-missing", provider: "azure" });
    } else {
      ports.report({
        kind: "azure-role-guidance",
        assignee: clientId,
        scope: azureRoleScope(subscriptionId, rg)
      });
    }
    return status;
  }

  const roleArn = data.roleArn || "";
  const region =
    data.region || ports.optionalString(awsCreds.region) || "us-east-1";
  const accountId = data.accountId || ports.optionalString(awsCreds.accountId);
  const k8s = data.cluster || "";

  await ports.setEnvironmentVariable("AWS_ROLE_ARN", roleArn);
  await ports.setEnvironmentVariable("AWS_REGION", region);
  await ports.setEnvironmentVariable("AWS_ACCOUNT_ID", accountId);
  await ports.setEnvironmentVariable("AWS_EKS_CLUSTER_NAME", k8s);
  await ports.setEnvironmentVariable("RADIUS_VPC_ID", data.vpcId);
  await ports.setEnvironmentVariable("RADIUS_SUBNET_IDS", data.subnetIds);
  await ports.setEnvironmentVariable("KUBERNETES_NAMESPACE", data.namespace);
  // The exact subjects setup trusted, so environment deletion removes those even
  // after the repository is renamed.
  if (data.trustSubjects && data.trustSubjects.length > 0) {
    await ports.setEnvironmentVariable(
      AWS_TRUST_SUBJECTS_VARIABLE,
      JSON.stringify(data.trustSubjects)
    );
  }
  if (!status.credentialsComplete) {
    ports.report({ kind: "credentials-missing", provider: "aws" });
  }
  return status;
}
