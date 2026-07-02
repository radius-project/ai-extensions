// Compute-platform abstraction for the Radius Canvas product.
//
// Each supported deployment target (Azure, AWS, …) implements ComputePlatform.
// All provider-specific behavior — OIDC bootstrap, portal deep-links, and the
// provider-gated fragments injected into the verify/deploy GitHub Actions
// workflows — lives behind this interface so adding a platform never requires
// touching the workflow templates or UI adapters.

export interface OidcResult {
  message: string;
  output: string;
}

/** A GitHub Actions secret or variable to set on a deploy environment. */
export interface SecretSpec {
  kind: "secret" | "variable";
  name: string;
  value: string;
}

/**
 * Optional feature flags so platforms that don't yet implement every capability
 * can be registered without stubbing — the UI/route layer degrades gracefully
 * (hides a button, skips a step) instead of crashing. See design §5.4.
 */
export interface PlatformCapabilities {
  oidc: boolean;
  portalUrl: boolean;
}

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

  /** resource-types-contrib platform key for recipe lookups (kubernetes/aws). */
  readonly recipePlatform: string;
  /** Managed-cluster label used to annotate K8s nodes (e.g. "AKS"/"EKS"). */
  readonly clusterServiceName: string;
  /** Which optional capabilities this platform implements (design §5.4). */
  readonly supports: PlatformCapabilities;

  /** Generate the OIDC bootstrap instructions for the given credential input. */
  generateOidc(data: any): OidcResult;

  /** GitHub Actions secrets/variables to set when creating a deploy environment. */
  environmentSecrets(data: any): SecretSpec[];

  /** Cloud-portal deep link for a deployed resource, or "" when unknown. */
  portalUrl(resourceType: string, ctx: PortalContext): string;

  // ----- GitHub Actions workflow fragments (verbatim YAML / shell) -----
  /** Steps injected into the credential-verification workflow. */
  readonly verifyWorkflowSteps: string;
  /** Steps that authenticate to the target cluster in the deploy workflow. */
  readonly deployClusterAuthSteps: string;
  /** `rad credential register` + `rad env update` lines for this platform. */
  readonly radCredentialRegister: string;
  /** Extra env injected into dynamic-rp so recipes can auth to the cloud. */
  readonly recipeAuthEnv: string;
  /** `rad recipe register` block for the managed database on this platform. */
  readonly dbRecipeRegister: string;
}
