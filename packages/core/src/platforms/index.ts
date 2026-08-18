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

// Placeholder deep-link context. See generatePortalUrl below: no live source
// populates a real subscription, resource group, or region today.
const PLACEHOLDER_SUBSCRIPTION_ID = "00000000-0000-0000-0000-000000000000";
const PLACEHOLDER_RESOURCE_GROUP = "radius-rg";
const PLACEHOLDER_REGION = "us-east-1";

/** Look up a registered compute platform by id, or undefined if unknown. */
export function getPlatform(id: string): ComputePlatform | undefined {
  return REGISTRY[id];
}

/** All registered compute platforms. */
export function listPlatforms(): ComputePlatform[] {
  return Object.values(REGISTRY);
}

/**
 * Cloud-portal deep link for a deployed resource.
 *
 * The link is built from a fixed placeholder context (subscription, resource
 * group, region). Nothing populates a real context today: the canvas state
 * fields this once read were only ever written by the OIDC bootstrap route,
 * which has been removed. Restoring real deep links requires a live source for
 * that context, not a state read.
 */
export function generatePortalUrl(
  resourceType: string,
  provider: string
): string {
  const platform = getPlatform(provider);
  if (!platform) return "";
  return platform.portalUrl(resourceType, {
    subscriptionId: PLACEHOLDER_SUBSCRIPTION_ID,
    resourceGroup: PLACEHOLDER_RESOURCE_GROUP,
    region: PLACEHOLDER_REGION,
    clusterName: ""
  });
}
