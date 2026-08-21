import type { ComputePlatform, PortalContext } from "./types.js";

const AZURE_PORTAL_BASE = "https://portal.azure.com/#";
function buildResourceGroupResourceListUrl(
  subscriptionId: string,
  resourceGroup: string
): string {
  return `${AZURE_PORTAL_BASE}@/resource/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/resources`;
}

function buildResourceUrl(armResourceId: string): string {
  return `${AZURE_PORTAL_BASE}@/resource${armResourceId}/overview`;
}

function normalizeAzureResourceType(resourceType: string): string {
  const trimmed = (resourceType || "").trim();
  if (!trimmed) return "";

  const noApiVersion = trimmed.split("@")[0].trim();
  if (!noApiVersion) return "";

  if (noApiVersion.startsWith("Microsoft.")) {
    return noApiVersion;
  }

  return "";
}

function normalizeArmResourceId(resourceRef: string): string {
  const trimmed = (resourceRef || "").trim();
  if (!trimmed) return "";

  const noQuery = trimmed.split("?")[0].trim();
  // Strip leading slashes before the prefix check so "//subscriptions/..." is handled.
  let start = 0;
  while (start < noQuery.length && noQuery[start] === "/") {
    start += 1;
  }
  const stripped = noQuery.slice(start);
  if (!stripped.toLowerCase().startsWith("subscriptions/")) return "";

  let end = stripped.length;
  while (end > 0 && stripped[end - 1] === "/") {
    end -= 1;
  }
  const normalized = `/${stripped.slice(0, end)}`;
  return normalized;
}

function isKubernetesResourceType(resourceType: string): boolean {
  const t = (resourceType || "").trim();
  if (!t) return false;

  return /^(apps|core|batch|autoscaling|networking\.k8s\.io|storage\.k8s\.io|rbac\.authorization\.k8s\.io|apiextensions\.k8s\.io)\//i.test(
    t
  );
}

export const azure: ComputePlatform = {
  id: "azure",
  displayName: "Azure",
  clusterServiceName: "AKS",

  portalUrl(resourceType: string, ctx: PortalContext): string {
    const rt = (resourceType || "").trim();
    const subscriptionId = ctx.subscriptionId;
    const resourceGroup = ctx.resourceGroup;
    const clusterName = (ctx.clusterName || "").trim();

    const armResourceId = normalizeArmResourceId(rt);
    if (armResourceId) {
      return buildResourceUrl(armResourceId);
    }

    const normalizedArmType = normalizeAzureResourceType(rt);
    if (normalizedArmType) {
      // Type-only values do not identify a concrete instance.
      return buildResourceGroupResourceListUrl(subscriptionId, resourceGroup);
    }

    // Radius resources often materialize to Kubernetes objects on AKS.
    if (isKubernetesResourceType(rt) || rt.startsWith("Radius.")) {
      if (clusterName) {
        const clusterId = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
        return buildResourceUrl(clusterId);
      }
      return buildResourceGroupResourceListUrl(subscriptionId, resourceGroup);
    }

    return buildResourceGroupResourceListUrl(subscriptionId, resourceGroup);
  }
};
