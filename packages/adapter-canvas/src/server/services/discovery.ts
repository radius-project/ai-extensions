import {
  remediationView,
  type RemediationView
} from "@radius-project/core/remediations";

export interface DiscoveryItem {
  id: string;
  name: string;
  resourceGroup?: string;
}

export interface DiscoveryResult {
  clusters: DiscoveryItem[];
  resourceGroups: DiscoveryItem[];
  namespaces: string[];
  vpcs: DiscoveryItem[];
  subnets: DiscoveryItem[];
  errors?: Record<string, string>;
  remediation?: RemediationView;
}

export interface DiscoveryRequest {
  subscriptionId?: string;
  tenantId?: string;
  provider?: string;
  resourceGroup?: string;
  cluster?: string;
}

export interface DiscoveryDependencies {
  runCli(
    command: string,
    args: string[],
    options: { timeout: number }
  ): Promise<string>;
  isUuid(value: unknown): boolean;
  createTemporaryKubeconfig(): {
    readonly path: string;
    remove(): void;
  };
}

const AZURE_RESOURCE_GROUP_PATTERN =
  /^(?=.{1,90}$)[A-Za-z0-9._()-]*[A-Za-z0-9_()-]$/;
const AKS_CLUSTER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9])?$/;

// One budget for every `az` query this service issues. On Windows the Azure CLI
// is an `az.cmd` batch shim that cmd.exe starts through a fresh Python
// interpreter, so a trivial call costs ~24s before it does any work. The old
// per-call budgets (20s for the credential fetch, 30s for the list queries) were
// set from Unix timings: 20s killed `az aks get-credentials` with SIGTERM and no
// output on every Windows run, which emptied the Namespace picker, and 30s left
// the list queries only ~6s of margin on the same measurement. 45s is ~1.9x the
// measured worst case, which absorbs a cold interpreter start on a loaded
// machine while still bounding each child process. These budgets are sequential:
// a selected-cluster request can wait at most 145s without a subscription context
// switch, or 155s with one, if every child exhausts its budget.
const AZURE_CLI_TIMEOUT_MS = 45000;

// The measured namespace listing completes in about 0.5s, so 10s retains ample
// headroom even when the Windows process adapter launches kubectl through cmd.exe.
const KUBECTL_TIMEOUT_MS = 10000;

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Markers that on their own prove the Azure CLI session must be re-established
// interactively. AADSTS530003 is deliberately absent: it means Conditional
// Access blocked token issuance, which a device-code login may not resolve, so
// its raw diagnostic stays more useful than a login prompt.
const AZURE_INTERACTION_MARKER =
  /\bAADSTS(?:50058|50072|50074|50076|50078|50079|50173|70043|700082)\b|\bStatus_InteractionRequired\b|\binteraction_required\b|Please run ['"]?az login['"]?|\bRefresh Token has expired\b/i;
// `invalid_grant` is a generic OAuth category that also appears in failures a
// login cannot fix, and can occur inside resource names, so it only classifies
// alongside an explicit re-authentication signal.
const AZURE_INVALID_GRANT = /\binvalid_grant\b/i;
const AZURE_REAUTH_CONTEXT =
  /re-?authenticat|\binteraction\b|multi-?factor|\bMFA\b|\bexpired\b|\brevoked\b|az login/i;
const AZURE_LOGIN_REQUIRED_MESSAGE =
  "Azure CLI sign-in is required to discover resources.";

// Returns the marker that classified the failure so the concise message can
// still name the underlying Azure code, or null when the raw detail is kept.
function azureInteractionMarker(detail: string): string | null {
  const match = AZURE_INTERACTION_MARKER.exec(detail);
  if (match) return match[0];
  if (AZURE_INVALID_GRANT.test(detail) && AZURE_REAUTH_CONTEXT.test(detail))
    return "invalid_grant";
  return null;
}

function recordAzureDiscoveryError(
  result: DiscoveryResult,
  facet: string,
  error: unknown,
  tenantId: unknown,
  prefix: string = ""
): void {
  const detail = `${prefix}${errorMessage(error)}`;
  result.errors = result.errors || {};
  const marker = azureInteractionMarker(detail);
  if (!marker) {
    result.errors[facet] = detail.slice(0, 800);
    return;
  }
  result.errors[facet] = `${AZURE_LOGIN_REQUIRED_MESSAGE} (${marker})`;
  result.remediation = remediationView("azure-cli-login", {
    tenantId,
    nextStep: "refresh-discovery"
  });
}

function discoveryItems(value: unknown): DiscoveryItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const fields = record(item);
    return {
      id: optionalString(fields.id),
      name: optionalString(fields.name),
      resourceGroup: optionalString(fields.resourceGroup)
    };
  });
}

// Enumerates the cloud resources the Environment page offers as choices. This
// service owns provider selection, CLI orchestration, fallback policy, result
// projection, and per-facet errors; the route adapter owns only HTTP concerns.
export async function discoverResources(
  data: DiscoveryRequest,
  dependencies: DiscoveryDependencies
): Promise<DiscoveryResult | (DiscoveryResult & { error: string })> {
  const result: DiscoveryResult = {
    clusters: [],
    resourceGroups: [],
    namespaces: [],
    vpcs: [],
    subnets: []
  };

  // Reject a non-GUID subscriptionId before it reaches the az argv. The Windows
  // process adapter quotes argv values, but this remains the domain boundary and
  // defense in depth. Empty is allowed for the ambient CLI context.
  if (
    data.subscriptionId &&
    !dependencies.isUuid(String(data.subscriptionId).trim())
  ) {
    return {
      error: `Invalid subscriptionId "${data.subscriptionId}" (expected a GUID).`,
      clusters: [],
      resourceGroups: [],
      namespaces: [],
      vpcs: [],
      subnets: []
    };
  }

  if (data.provider === "azure") {
    const resourceGroup = optionalString(data.resourceGroup).trim();
    const cluster = optionalString(data.cluster).trim();
    const invalidTarget =
      (
        resourceGroup !== "" &&
        !AZURE_RESOURCE_GROUP_PATTERN.test(resourceGroup)
      ) ?
        "Invalid Azure resource group name."
      : cluster !== "" && !AKS_CLUSTER_PATTERN.test(cluster) ?
        "Invalid AKS cluster name."
      : "";
    if (invalidTarget !== "") {
      return {
        error: invalidTarget,
        clusters: [],
        resourceGroups: [],
        namespaces: [],
        vpcs: [],
        subnets: []
      };
    }
    // Set tenant/subscription context before querying
    if (data.subscriptionId) {
      try {
        await dependencies.runCli(
          "az",
          ["account", "set", "--subscription", data.subscriptionId],
          { timeout: 10000 }
        );
      } catch {
        // Best-effort: an unselectable subscription still gets queried below
        // with an explicit `--subscription` argument. Deliberately keeps its own
        // short budget rather than AZURE_CLI_TIMEOUT_MS, because its failure is
        // already handled and a longer wait would only delay the real queries.
      }
    }
    const subArgs =
      data.subscriptionId ? ["--subscription", data.subscriptionId] : [];
    try {
      const aksJson = await dependencies.runCli(
        "az",
        [
          "aks",
          "list",
          "--query",
          "[].{id:name, name:name, resourceGroup:resourceGroup}",
          "-o",
          "json",
          ...subArgs
        ],
        { timeout: AZURE_CLI_TIMEOUT_MS }
      );
      result.clusters = discoveryItems(JSON.parse(aksJson));
    } catch (e) {
      result.clusters = [];
      recordAzureDiscoveryError(result, "clusters", e, data.tenantId);
    }
    try {
      const rgJson = await dependencies.runCli(
        "az",
        [
          "group",
          "list",
          "--query",
          "[].{id:name, name:name}",
          "-o",
          "json",
          ...subArgs
        ],
        { timeout: AZURE_CLI_TIMEOUT_MS }
      );
      result.resourceGroups = discoveryItems(JSON.parse(rgJson));
    } catch (e) {
      result.resourceGroups = [];
      recordAzureDiscoveryError(result, "resourceGroups", e, data.tenantId);
    }
    if (resourceGroup && cluster) {
      const kubeconfig = dependencies.createTemporaryKubeconfig();
      // Name the step unconditionally. The runner currently flattens process
      // failures into Error, so this service cannot distinguish a timeout from
      // authentication, authorization, connectivity, or target lookup failures.
      let failedStep = "az aks get-credentials failed";
      try {
        await dependencies.runCli(
          "az",
          [
            "aks",
            "get-credentials",
            "--name",
            cluster,
            "--resource-group",
            resourceGroup,
            "--file",
            kubeconfig.path,
            "--overwrite-existing",
            ...subArgs
          ],
          { timeout: AZURE_CLI_TIMEOUT_MS }
        );
        failedStep = "kubectl get namespaces failed";
        const nsJson = await dependencies.runCli(
          "kubectl",
          [
            "--kubeconfig",
            kubeconfig.path,
            "get",
            "namespaces",
            "-o",
            "jsonpath={.items[*].metadata.name}"
          ],
          { timeout: KUBECTL_TIMEOUT_MS }
        );
        result.namespaces = nsJson.replace(/"/g, "").split(" ").filter(Boolean);
      } catch (e) {
        result.namespaces = [];
        recordAzureDiscoveryError(
          result,
          "namespaces",
          e,
          data.tenantId,
          `${failedStep}: `
        );
      } finally {
        kubeconfig.remove();
      }
    }
  } else {
    try {
      const eksJson = await dependencies.runCli(
        "aws",
        ["eks", "list-clusters", "--query", "clusters", "--output", "json"],
        { timeout: 15000 }
      );
      const clusterNames: unknown = JSON.parse(eksJson);
      result.clusters =
        Array.isArray(clusterNames) ?
          clusterNames
            .filter((name): name is string => typeof name === "string")
            .map((name) => ({ id: name, name }))
        : [];
    } catch (e) {
      result.clusters = [];
      result.errors = result.errors || {};
      result.errors.clusters = errorMessage(e).slice(0, 800);
    }
    try {
      const vpcJson = await dependencies.runCli(
        "aws",
        [
          "ec2",
          "describe-vpcs",
          "--query",
          "Vpcs[].{id:VpcId, name:VpcId}",
          "--output",
          "json"
        ],
        { timeout: 15000 }
      );
      result.vpcs = discoveryItems(JSON.parse(vpcJson));
    } catch (e) {
      result.vpcs = [];
      result.errors = result.errors || {};
      result.errors.vpcs = errorMessage(e).slice(0, 800);
    }
    try {
      const subnetJson = await dependencies.runCli(
        "aws",
        [
          "ec2",
          "describe-subnets",
          "--query",
          "Subnets[].{id:SubnetId, name:SubnetId}",
          "--output",
          "json"
        ],
        { timeout: 15000 }
      );
      result.subnets = discoveryItems(JSON.parse(subnetJson));
    } catch (e) {
      result.subnets = [];
      result.errors = result.errors || {};
      result.errors.subnets = errorMessage(e).slice(0, 800);
    }
    result.namespaces = ["default", "kube-system", "radius-system"];
  }

  return result;
}
