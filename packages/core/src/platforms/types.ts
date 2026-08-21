// Compute-platform abstraction for the Radius Canvas product.
//
// Each supported deployment target (Azure, AWS, …) implements ComputePlatform.
// The interface owns platform identity, the managed-cluster label, and portal
// deep-links, so those need no provider branching at the call site. Workflow
// selection is not behind this interface — the verify/deploy workflow modules
// still resolve provider-specific fragments themselves.

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
