export interface InspectedEnvironment {
  name: string;
  provider: string;
  status: string;
  webUrl: string;
  credentialProfile: string;
  config: Record<string, string>;
}

export type EnvironmentInspection =
  | { kind: "listed"; environments: InspectedEnvironment[]; hadRows: boolean }
  | { kind: "unavailable"; error: string };

// The GitHub environment variables that hold what the creation form asks for,
// mapped to the form's own field names. Everything else the environment stores
// is either derived from the credential profile or internal Radius state.
// Each field lists its variable names in precedence order.
//
// The namespace is written as KUBERNETES_NAMESPACE, which is the name the
// generated deployment workflow reads. RADIUS_NAMESPACE is still accepted so an
// environment created before that rename keeps reporting the namespace it
// actually holds; reading only the current name would make every such
// environment look as though it had none.
//
// Precedence is decided by whether a variable exists, not by whether it holds a
// value. The workflow resolves an empty variable itself, as
// `vars.KUBERNETES_NAMESPACE || 'default'`, so once the current variable exists
// it is authoritative even when empty. Falling through to a stale legacy value
// there would report a namespace deployment does not use, and Edit would save
// that reported value back and move the environment.
const NAMESPACE_VARIABLES = [
  "KUBERNETES_NAMESPACE",
  "RADIUS_NAMESPACE"
] as const;
const AZURE_CONFIG_VARIABLES = {
  resourceGroup: ["AZURE_RESOURCE_GROUP"],
  cluster: ["AZURE_AKS_CLUSTER_NAME"],
  namespace: NAMESPACE_VARIABLES,
  // The account the cluster name is scoped to. Reported so the wizard can tell
  // two same-named clusters apart when it checks whether a namespace is already
  // claimed, rather than refusing a legitimate environment on a name collision.
  subscriptionId: ["AZURE_SUBSCRIPTION_ID"],
  // The cluster's own resource group, which scopes the cluster name within the
  // subscription. Reported for the same reason, and kept separate from
  // `resourceGroup` above, which is the application's.
  clusterResourceGroup: ["AZURE_AKS_RESOURCE_GROUP"]
} as const;
const AWS_CONFIG_VARIABLES = {
  cluster: ["AWS_EKS_CLUSTER_NAME"],
  namespace: NAMESPACE_VARIABLES,
  vpcId: ["RADIUS_VPC_ID"],
  subnetIds: ["RADIUS_SUBNET_IDS"],
  accountId: ["AWS_ACCOUNT_ID"],
  region: ["AWS_REGION"]
} as const;

export function applyVerificationBypass(
  status: string,
  matchedRunId: string,
  marker: string | undefined
): string {
  return status === "failed" && matchedRunId !== "" && marker === matchedRunId ?
      "bypassed"
    : status;
}

export function inspectedEnvironmentConfig(
  vars: Record<string, string>,
  provider: string
): Record<string, string> {
  const config: Record<string, string> = {};
  for (const [key, variables] of Object.entries(
    provider === "aws" ? AWS_CONFIG_VARIABLES : AZURE_CONFIG_VARIABLES
  )) {
    for (const variable of variables) {
      if (!Object.hasOwn(vars, variable)) continue;
      // The variable exists, so it decides this field. An empty value
      // still reports nothing, exactly as before, but it stops the
      // fallback instead of deferring to a superseded name.
      const value = vars[variable];
      if (value) config[key] = value;
      break;
    }
  }
  return config;
}
