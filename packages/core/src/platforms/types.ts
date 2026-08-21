// Compute-platform abstraction for the Radius Canvas product.
//
// Each supported deployment target (Azure, AWS, …) implements ComputePlatform.
// All provider-specific behavior — portal deep-links and the provider-gated
// fragments injected into the verify/deploy GitHub Actions workflows — lives
// behind this interface so adding a platform never requires touching the
// workflow templates or UI adapters.

/** Inputs used to build cloud-portal deep links for a deployed resource. */
export interface PortalContext {
  subscriptionId: string;
  resourceGroup: string;
  region: string;
  clusterName?: string;
}

export interface ComputePlatform {
  /** Stable identifier used in the UI and persisted state (e.g. "azure"). */
  readonly id: string;
  /** Human-readable name (e.g. "Azure"). */
  readonly displayName: string;

  /** Managed-cluster label used to annotate K8s nodes (e.g. "AKS"/"EKS"). */
  readonly clusterServiceName: string;

  /** Cloud-portal deep link for a deployed resource, or "" when unknown. */
  portalUrl(resourceType: string, ctx: PortalContext): string;
}
