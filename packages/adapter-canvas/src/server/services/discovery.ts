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
}

export interface DiscoveryRequest {
  subscriptionId?: string;
  provider?: string;
}

export interface DiscoveryDependencies {
  runCli(
    command: string,
    args: string[],
    options: { timeout: number }
  ): Promise<string>;
  isUuid(value: unknown): boolean;
}

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

  // Reject a non-GUID subscriptionId before it reaches the az argv.
  // On Windows cliExec routes az through `cmd.exe /c` and libuv only
  // quotes args with whitespace, so "x&calc" would be split by cmd.exe
  // as a command separator. Empty is allowed (ambient CLI context).
  if (
    data.subscriptionId &&
    !dependencies.isUuid(String(data.subscriptionId).trim())
  ) {
    return {
      error: `Invalid subscriptionId "${data.subscriptionId}" (expected a GUID).`,
      clusters: [],
      resourceGroups: [],
      namespaces: ["default"],
      vpcs: [],
      subnets: []
    };
  }

  if (data.provider === "azure") {
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
        // with an explicit `--subscription` argument.
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
        { timeout: 30000 }
      );
      result.clusters = discoveryItems(JSON.parse(aksJson));
    } catch (e) {
      result.clusters = [];
      result.errors = result.errors || {};
      result.errors.clusters = errorMessage(e).slice(0, 800);
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
        { timeout: 30000 }
      );
      result.resourceGroups = discoveryItems(JSON.parse(rgJson));
    } catch (e) {
      result.resourceGroups = [];
      result.errors = result.errors || {};
      result.errors.resourceGroups = errorMessage(e).slice(0, 800);
    }
    // If we got a cluster, try to get namespaces from it
    if (result.clusters.length > 0) {
      try {
        const rg =
          result.resourceGroups.length > 0 ? result.resourceGroups[0].id : "";
        const clusterName = result.clusters[0].id;
        if (rg && clusterName) {
          await dependencies.runCli(
            "az",
            [
              "aks",
              "get-credentials",
              "--name",
              clusterName,
              "--resource-group",
              rg,
              "--overwrite-existing"
            ],
            { timeout: 20000 }
          );
          const nsJson = await dependencies.runCli(
            "kubectl",
            ["get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}"],
            { timeout: 10000 }
          );
          result.namespaces = nsJson
            .replace(/"/g, "")
            .split(" ")
            .filter(Boolean);
        } else {
          result.namespaces = ["default", "kube-system", "radius-system"];
        }
      } catch {
        result.namespaces = ["default", "kube-system", "radius-system"];
      }
    } else {
      result.namespaces = ["default", "kube-system", "radius-system"];
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
