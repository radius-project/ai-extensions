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
    else if (resourceType.includes("/") && (resourceType.startsWith("apps/") || resourceType.startsWith("core/") || resourceType.startsWith("batch/"))) providerCategory = "kubernetes";

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

// ─── Canonical Radius type → concrete resource map ───────────────────────────
// Single source of truth for how each Radius resource type maps to concrete
// cloud/k8s resources per provider. Both the schema-based inference path
// (inferResourcesFromSchema) and the static-fallback path
// (generateRecipeFromStaticMappings) derive from this map so the same Radius
// type always resolves to the same concrete resources regardless of which
// path produced it.
const K8S_CONTAINER_RESOURCES = [
  { name: "deployment", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Deployment" },
  { name: "service", type: "core/Service", provider: "kubernetes", displayType: "K8s Service" },
];
const K8S_NEO4J_RESOURCES = [
  { name: "neo4j", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Neo4j Deployment" },
  { name: "neo4jSvc", type: "core/Service", provider: "kubernetes", displayType: "K8s Neo4j Service" },
];
export const CANONICAL_RESOURCE_MAP: Record<string, any> = {
  "Radius.Compute/containers": {
    azure: K8S_CONTAINER_RESOURCES,
    aws: K8S_CONTAINER_RESOURCES,
  },
  "Radius.Compute/containerImages": {
    azure: [{ name: "acr", type: "Microsoft.ContainerRegistry/registries", provider: "azure", displayType: "Azure Container Registry" }],
    aws: [{ name: "ecr", type: "aws_ecr_repository", provider: "aws", displayType: "AWS ECR Repository" }],
  },
  "Radius.Compute/persistentVolumes": {
    azure: [
      { name: "disk", type: "Microsoft.Compute/disks", provider: "azure", displayType: "Azure Managed Disk" },
      { name: "pv", type: "core/PersistentVolume", provider: "kubernetes", displayType: "K8s PersistentVolume" },
    ],
    aws: [
      { name: "ebsVolume", type: "aws_ebs_volume", provider: "aws", displayType: "AWS EBS Volume" },
      { name: "pv", type: "core/PersistentVolume", provider: "kubernetes", displayType: "K8s PersistentVolume" },
    ],
  },
  "Radius.Compute/routes": {
    azure: [
      { name: "ingress", type: "networking.k8s.io/Ingress", provider: "kubernetes", displayType: "K8s Ingress" },
      { name: "appGateway", type: "Microsoft.Network/applicationGateways", provider: "azure", displayType: "Azure Application Gateway" },
    ],
    aws: [
      { name: "ingress", type: "networking.k8s.io/Ingress", provider: "kubernetes", displayType: "K8s Ingress" },
      { name: "alb", type: "aws_lb", provider: "aws", displayType: "AWS Application Load Balancer" },
    ],
  },
  "Radius.Data/mySqlDatabases": {
    azure: [
      { name: "mysqlServer", type: "Microsoft.DBforMySQL/flexibleServers", provider: "azure", displayType: "Azure MySQL Flexible Server" },
      { name: "database", type: "Microsoft.DBforMySQL/flexibleServers/databases", provider: "azure", displayType: "Azure MySQL Database" },
    ],
    aws: [
      { name: "rdsInstance", type: "aws_db_instance", provider: "aws", displayType: "AWS RDS MySQL Instance" },
      { name: "subnetGroup", type: "aws_db_subnet_group", provider: "aws", displayType: "AWS DB Subnet Group" },
      { name: "securityGroup", type: "aws_security_group", provider: "aws", displayType: "AWS Security Group" },
    ],
  },
  "Radius.Data/postgreSqlDatabases": {
    azure: [
      { name: "pgServer", type: "Microsoft.DBforPostgreSQL/flexibleServers", provider: "azure", displayType: "Azure PostgreSQL Flexible Server" },
      { name: "database", type: "Microsoft.DBforPostgreSQL/flexibleServers/databases", provider: "azure", displayType: "Azure PostgreSQL Database" },
    ],
    aws: [
      { name: "rdsInstance", type: "aws_db_instance", provider: "aws", displayType: "AWS RDS PostgreSQL Instance" },
      { name: "subnetGroup", type: "aws_db_subnet_group", provider: "aws", displayType: "AWS DB Subnet Group" },
      { name: "securityGroup", type: "aws_security_group", provider: "aws", displayType: "AWS Security Group" },
    ],
  },
  "Radius.Data/sqlDatabases": {
    azure: [
      { name: "sqlServer", type: "Microsoft.Sql/servers", provider: "azure", displayType: "Azure SQL Server" },
      { name: "database", type: "Microsoft.Sql/servers/databases", provider: "azure", displayType: "Azure SQL Database" },
    ],
    aws: [
      { name: "rdsInstance", type: "aws_db_instance", provider: "aws", displayType: "AWS RDS Instance" },
      { name: "subnetGroup", type: "aws_db_subnet_group", provider: "aws", displayType: "AWS DB Subnet Group" },
      { name: "securityGroup", type: "aws_security_group", provider: "aws", displayType: "AWS Security Group" },
    ],
  },
  "Radius.Data/redisCaches": {
    azure: [
      { name: "redis", type: "apps/Deployment", provider: "kubernetes", displayType: "K8s Redis Deployment" },
      { name: "redisSvc", type: "core/Service", provider: "kubernetes", displayType: "K8s Redis Service" },
    ],
    aws: [
      { name: "elasticache", type: "aws_elasticache_replication_group", provider: "aws", displayType: "AWS ElastiCache Redis" },
      { name: "subnetGroup", type: "aws_elasticache_subnet_group", provider: "aws", displayType: "AWS ElastiCache Subnet Group" },
    ],
  },
  "Radius.Data/mongoDatabases": {
    azure: [{ name: "cosmosDb", type: "Microsoft.DocumentDB/databaseAccounts", provider: "azure", displayType: "Azure Cosmos DB" }],
    aws: [{ name: "documentDb", type: "aws_docdb_cluster", provider: "aws", displayType: "AWS DocumentDB Cluster" }],
  },
  "Radius.Data/neo4jDatabases": {
    azure: K8S_NEO4J_RESOURCES,
    aws: K8S_NEO4J_RESOURCES,
  },
  "Radius.Messaging/rabbitMQQueues": {
    azure: [
      { name: "serviceBus", type: "Microsoft.ServiceBus/namespaces", provider: "azure", displayType: "Azure Service Bus" },
      { name: "queue", type: "Microsoft.ServiceBus/namespaces/queues", provider: "azure", displayType: "Azure Service Bus Queue" },
    ],
    aws: [{ name: "sqsQueue", type: "aws_sqs_queue", provider: "aws", displayType: "AWS SQS Queue" }],
  },
  "Radius.Security/secrets": {
    azure: [
      { name: "keyVault", type: "Microsoft.KeyVault/vaults", provider: "azure", displayType: "Azure Key Vault" },
      { name: "secret", type: "Microsoft.KeyVault/vaults/secrets", provider: "azure", displayType: "Azure Key Vault Secret" },
    ],
    aws: [
      { name: "secret", type: "aws_secretsmanager_secret", provider: "aws", displayType: "AWS Secrets Manager" },
      { name: "secretVersion", type: "aws_secretsmanager_secret_version", provider: "aws", displayType: "AWS Secret Version" },
    ],
  },
};

// Categorize an arbitrary Radius type name (+ optional schema description) to a
// canonical CANONICAL_RESOURCE_MAP key. Used by the schema-inference path when
// the exact Radius type isn't a direct key in the map.
export function categorizeToCanonicalType(typeName: string, description = ""): string | null {
  const lt = (typeName || "").toLowerCase();
  const d = (description || "").toLowerCase();
  if (lt.includes("mysql")) return "Radius.Data/mySqlDatabases";
  if (lt.includes("postgres")) return "Radius.Data/postgreSqlDatabases";
  if (lt.includes("redis") || d.includes("cache")) return "Radius.Data/redisCaches";
  if (lt.includes("mongo") || d.includes("cosmos")) return "Radius.Data/mongoDatabases";
  if (lt.includes("neo4j")) return "Radius.Data/neo4jDatabases";
  if (lt.includes("rabbit") || lt.includes("amqp")) return "Radius.Messaging/rabbitMQQueues";
  if (lt.includes("secret")) return "Radius.Security/secrets";
  if (lt.includes("sql")) return "Radius.Data/sqlDatabases";
  if (lt.includes("image")) return "Radius.Compute/containerImages";
  if (lt.includes("container")) return "Radius.Compute/containers";
  if (lt.includes("route") || lt.includes("gateway")) return "Radius.Compute/routes";
  if (lt.includes("volume") || lt.includes("persistent")) return "Radius.Compute/persistentVolumes";
  return null;
}

// Resolve the concrete resources for a Radius type + provider from the canonical
// map. Prefers an exact type match, then falls back to name/description-based
// categorization. Returns [] when nothing matches.
export function resolveCanonicalResources(radiusType: string, provider: string, description = ""): any[] {
  const p = provider === "aws" ? "aws" : "azure";
  const typeName = (radiusType || "").split("/").pop() || "";
  const key = CANONICAL_RESOURCE_MAP[radiusType] ? radiusType : categorizeToCanonicalType(typeName, description);
  if (key && CANONICAL_RESOURCE_MAP[key]) return CANONICAL_RESOURCE_MAP[key][p] || [];
  return [];
}

// Infer concrete cloud resources from a resource-types-contrib YAML schema
export function inferResourcesFromSchema(schemaYaml: string, radiusType: string, provider: string): any[] {
  // Parse description from YAML for hints about what gets deployed
  const descMatch = schemaYaml.match(/description:\s*\|?\s*\n([\s\S]*?)(?=\n\s*apiVersions:|\n\s*types:)/);
  const description = descMatch ? descMatch[1].toLowerCase() : "";
  return resolveCanonicalResources(radiusType, provider, description);
}

// Static fallback mappings (used only when resource-types-contrib is unreachable)
export function generateRecipeFromStaticMappings(radiusType: string, provider: string): any[] {
  const resolved = resolveCanonicalResources(radiusType, provider);
  if (resolved.length > 0) return resolved;
  const typeName = radiusType.split("/").pop();
  return [{ name: "resource", type: typeName, provider: "cloud", displayType: typeName }];
}
