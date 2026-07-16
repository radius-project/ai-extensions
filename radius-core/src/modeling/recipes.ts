// Recipe parsing, resource-type mapping, and the canonical Radius-type → concrete
// resource map. All pure: the GitHub-fetching recipe orchestration lives in the
// adapter (and will move behind the GitHub port in a later phase); these are the
// deterministic helpers it composes.

// Map resource type to Radius namespace
export function mapFileToResourceType(baseName: string): string {
  const typeMap: Record<string, string> = {
    containers: "Radius.Compute/containers",
    containerImages: "Radius.Compute/containerImages",
    routes: "Radius.Compute/routes",
    persistentVolumes: "Radius.Compute/persistentVolumes",
    mySqlDatabases: "Radius.Data/mySqlDatabases",
    postgreSqlDatabases: "Radius.Data/postgreSqlDatabases",
    neo4jDatabases: "Radius.Data/neo4jDatabases",
    redisCaches: "Radius.Data/redisCaches",
    sqlDatabases: "Radius.Data/sqlDatabases",
    mongoDatabases: "Radius.Data/mongoDatabases",
    secrets: "Radius.Security/secrets",
    applications: "Radius.Core/applications",
    gateways: "Radius.Networking/gateways",
    rabbitMQQueues: "Radius.Messaging/rabbitMQQueues",
    stateStores: "Radius.Dapr/stateStores",
    pubSubBrokers: "Radius.Dapr/pubSubBrokers",
  };
  return typeMap[baseName] || `Radius.Core/${baseName}`;
}

// Built-in (legacy un-grouped) Kubernetes API groups that appear without a
// dotted DNS suffix in Radius/Bicep recipe types (e.g. apps/Deployment).
const K8S_CORE_GROUPS = new Set([
  "apps", "core", "batch", "extensions", "policy", "autoscaling", "networking", "rbac", "storage",
]);

// True when a Bicep resource-type group segment denotes a Kubernetes API group.
// Covers both the short built-in groups (apps, core, batch, …) and the dotted
// DNS-style groups such as networking.k8s.io or rbac.authorization.k8s.io.
function isKubernetesGroup(group: string): boolean {
  return K8S_CORE_GROUPS.has(group) || group.endsWith("k8s.io") || group.endsWith("kubernetes.io");
}

// Parse a recipe bicep file to extract concrete resource declarations
export function parseRecipeResources(content: string): any[] {
  const resources: any[] = [];
  // Match resource declarations: resource <name> '<type>' = { ... }
  const resourceRegex = /resource\s+(\w+)\s+'([^']+)'/g;
  let match;
  while ((match = resourceRegex.exec(content)) !== null) {
    const symName = match[1];
    const fullType = match[2];
    // Skip 'existing' resources - they reference pre-existing infra
    const lineStart = content.lastIndexOf("\n", match.index);
    const lineEnd = content.indexOf("\n", match.index + match[0].length);
    const fullLine = content.substring(lineStart, lineEnd > -1 ? lineEnd : undefined);
    if (fullLine.includes(" existing")) continue;

    // Parse the type - could be ARM type (Microsoft.Cache/redis@2022-06-01),
    // AWS type (AWS.MemoryDB/Cluster@default), or K8s type (apps/Deployment@v1)
    const typeParts = fullType.split("@");
    const resourceType = typeParts[0];
    const apiVersion = typeParts[1] || "";

    // Determine provider category
    let providerCategory = "cloud";
    if (resourceType.startsWith("AWS.")) providerCategory = "aws";
    else if (resourceType.startsWith("Microsoft.")) providerCategory = "azure";
    else if (resourceType.includes("/") && isKubernetesGroup(resourceType.split("/")[0])) providerCategory = "kubernetes";

    resources.push({
      name: symName,
      type: resourceType,
      apiVersion: apiVersion,
      provider: providerCategory,
      displayType: formatResourceType(resourceType),
    });
  }
  return resources;
}

// Format resource type for display
export function formatResourceType(type: string): string {
  if (type.startsWith("Microsoft.")) {
    const parts = type.split("/");
    const service = parts[0].replace("Microsoft.", "");
    const resource = parts[1] || "";
    return `Azure ${service}/${resource}`;
  }
  if (type.startsWith("AWS.")) {
    return type.replace("AWS.", "AWS ").replace("/", " ");
  }
  if (type.startsWith("apps/") || type.startsWith("core/") || type.startsWith("batch/")) {
    const parts = type.split("/");
    return `K8s ${parts[1] || parts[0]}`;
  }
  return type;
}

// Map Radius type to its directory path in resource-types-contrib
export function radiusTypeToContribDir(radiusType: string): string | null {
  // Radius.Compute/containers -> Compute/containers
  // Radius.Data/mySqlDatabases -> Data/mySqlDatabases
  const parts = radiusType.split("/");
  if (parts.length !== 2) return null;
  const namespace = parts[0].replace("Radius.", "");
  const typeName = parts[1];
  return `${namespace}/${typeName}`;
}
