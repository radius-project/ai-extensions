import type { ComputePlatform } from "./types.js";
import { azure } from "./azure.js";
import { aws } from "./aws.js";

export type {
  ComputePlatform,
  OidcResult,
  PortalContext,
  SecretSpec,
  PlatformCapabilities
} from "./types.js";
export { azure } from "./azure.js";
export { aws } from "./aws.js";
export {
  buildOidcSubject,
  buildEnvironmentSuffix,
  buildFederatedCredentialName
} from "./oidc-subject.js";
export type {
  OidcSubjectConfig,
  BuildOidcSubjectInput
} from "./oidc-subject.js";

const REGISTRY: Record<string, ComputePlatform> = {
  [azure.id]: azure,
  [aws.id]: aws
};

/** Look up a registered compute platform by id, or undefined if unknown. */
export function getPlatform(id: string): ComputePlatform | undefined {
  return REGISTRY[id];
}

/** All registered compute platforms. */
export function listPlatforms(): ComputePlatform[] {
  return Object.values(REGISTRY);
}

/**
 * Cloud-portal deep link for a deployed resource. Preserves the historical
 * default context (placeholder subscription/resource-group/region) so links are
 * still well-formed before real credentials are captured.
 */
export function generatePortalUrl(
  resourceType: string,
  provider: string,
  state: any
): string {
  const subscriptionId =
    state?.oidcAzure?.subscriptionId || "00000000-0000-0000-0000-000000000000";
  const resourceGroup =
    state?.deployParams?.resourceGroup ||
    state?.azureResourceGroup ||
    "radius-rg";
  const region = state?.oidcAws?.region || "us-east-1";
  const clusterName =
    state?.deployParams?.cluster ||
    state?.radiusK8sCluster ||
    state?.k8sCluster ||
    "";
  const platform = getPlatform(provider);
  if (!platform) return "";
  return platform.portalUrl(resourceType, {
    subscriptionId,
    resourceGroup,
    region,
    clusterName
  });
}
