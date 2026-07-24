// Recipe-pack parsing and concrete-resource derivation. Pure: no I/O — the
// GitHub-fetching orchestration that feeds these helpers lives in
// ./recipe-resolver (behind the injected GitHub port).
//
// Under the recipe-pack model, the planned graph resolves each abstract Radius
// resource to the concrete cloud/k8s resource its recipe deploys. The authority
// for that mapping is the *default recipe pack* committed in
// radius-project/resource-types-contrib (recipepack/<provider>/*.bicep), NOT the
// individual recipe files under <Category>/<type>/recipes/. A pack declares a
// `Radius.Core/recipePacks` resource whose `recipes` map keys each Radius type to
// a recipe { kind, source }. The pack does not enumerate the concrete resources a
// recipe deploys — those live inside the recipe — so we derive ONE primary
// concrete resource per entry from its `source` via the curated map below.

export const RECIPE_PACK_REPO = "radius-project/resource-types-contrib";
export const RECIPE_PACK_REF = "main";

// Provider → committed recipe-pack file. Azure downloads the `azure-avm` pack;
// AWS's real pack is generated inline at deploy time, so for modeling it (and any
// plain Kubernetes environment) uses the committed kubernetes default pack.
const PROVIDER_PACK_PATH: Record<string, string> = {
  azure: "recipepack/azure/aks-recipepack.bicep",
  aws: "recipepack/kubernetes/default-recipepack.bicep",
  kubernetes: "recipepack/kubernetes/default-recipepack.bicep",
};

export function recipePackPathForProvider(provider: string): string {
  return PROVIDER_PACK_PATH[provider] || PROVIDER_PACK_PATH.kubernetes;
}

// GitHub contents API path for a provider's default recipe pack file.
export function recipePackContentPath(provider: string): string {
  return `/repos/${RECIPE_PACK_REPO}/contents/${recipePackPathForProvider(provider)}?ref=${RECIPE_PACK_REF}`;
}

// One concrete resource derived from a recipe-pack entry's source.
export interface ConcreteResource {
  name: string;
  type: string;
  displayType: string;
  provider: string;
  apiVersion: string;
}

// A single recipe-pack entry: a Radius resource type mapped to a recipe.
export interface RecipePackEntry {
  resourceType: string;
  kind: string;
  source: string;
}

// Curated map: normalized recipe source → the primary concrete resource its
// recipe deploys. Seeded from the two committed packs (azure/aks-recipepack.bicep
// and kubernetes/default-recipepack.bicep). Azure Verified Modules map 1:1 to an
// ARM resource type; Kubernetes recipes map to their primary workload/object (the
// supporting Secret/Service/etc. a recipe also creates are not modeled here).
// Keys are the source with the registry prefix and version tag stripped — see
// normalizeRecipeSource.
const SOURCE_CONCRETE_MAP: Record<string, { type: string; displayType: string; provider: string }> = {
  // Azure Verified Modules (avm/res/<service>/<resource>) → ARM types.
  "avm/res/cache/redis-enterprise": { type: "Microsoft.Cache/redisEnterprise", displayType: "Azure Cache for Redis Enterprise", provider: "azure" },
  "avm/res/cognitive-services/account": { type: "Microsoft.CognitiveServices/accounts", displayType: "Azure AI Services", provider: "azure" },
  "avm/res/search/search-service": { type: "Microsoft.Search/searchServices", displayType: "Azure AI Search", provider: "azure" },
  "avm/res/document-db/database-account": { type: "Microsoft.DocumentDB/databaseAccounts", displayType: "Azure Cosmos DB", provider: "azure" },
  "avm/res/db-for-my-sql/flexible-server": { type: "Microsoft.DBforMySQL/flexibleServers", displayType: "Azure Database for MySQL", provider: "azure" },
  "avm/res/db-for-postgre-sql/flexible-server": { type: "Microsoft.DBforPostgreSQL/flexibleServers", displayType: "Azure Database for PostgreSQL", provider: "azure" },
  "avm/res/sql/server": { type: "Microsoft.Sql/servers", displayType: "Azure SQL Server", provider: "azure" },
  "avm/res/service-bus/namespace": { type: "Microsoft.ServiceBus/namespaces", displayType: "Azure Service Bus", provider: "azure" },
  "avm/res/event-hub/namespace": { type: "Microsoft.EventHub/namespaces", displayType: "Azure Event Hubs", provider: "azure" },
  "avm/res/storage/storage-account": { type: "Microsoft.Storage/storageAccounts", displayType: "Azure Storage Account", provider: "azure" },
  // Kubernetes recipes (ghcr.io/radius-project/kube-recipes/<name>) → primary K8s object.
  "kube-recipes/containers": { type: "apps/Deployment", displayType: "Deployment", provider: "kubernetes" },
  "kube-recipes/mysqldatabases": { type: "apps/Deployment", displayType: "Deployment", provider: "kubernetes" },
  "kube-recipes/rediscaches": { type: "apps/Deployment", displayType: "Deployment", provider: "kubernetes" },
  "kube-recipes/persistentvolumes": { type: "core/PersistentVolumeClaim", displayType: "PersistentVolumeClaim", provider: "kubernetes" },
  "kube-recipes/secrets": { type: "core/Secret", displayType: "Secret", provider: "kubernetes" },
  "kube-recipes/routes": { type: "gateway.networking.k8s.io/HTTPRoute", displayType: "HTTPRoute", provider: "kubernetes" },
  "kube-recipes/containerimages": { type: "batch/Job", displayType: "Image Build Job", provider: "kubernetes" },
};

// Normalize a recipe `source` OCI reference to its lookup key: strip the registry
// host, the leading `bicep/` module namespace Azure uses, and the `:version` tag.
//   mcr.microsoft.com/bicep/avm/res/cache/redis-enterprise:0.5.1 -> avm/res/cache/redis-enterprise
//   ghcr.io/radius-project/kube-recipes/containers:latest        -> kube-recipes/containers
export function normalizeRecipeSource(source: string): string {
  if (!source) return "";
  let s = source.trim();
  // Drop an OCI digest (`@sha256:...`) first so it isn't mistaken for a tag.
  const at = s.indexOf("@");
  if (at !== -1) s = s.slice(0, at);
  // Drop version tag (the last ':' segment that is not part of a URL scheme).
  const lastColon = s.lastIndexOf(":");
  if (lastColon > s.lastIndexOf("/")) s = s.slice(0, lastColon);
  // Anchor on the recognized module namespaces regardless of registry host.
  const avmIdx = s.indexOf("avm/res/");
  if (avmIdx !== -1) return s.slice(avmIdx);
  const kubeIdx = s.indexOf("kube-recipes/");
  if (kubeIdx !== -1) return s.slice(kubeIdx);
  return s;
}

// Derive the primary concrete resource a recipe-pack entry deploys, or null when
// the source is unrecognized (unknown recipes yield no fabricated output).
export function deriveConcreteResource(source: string): ConcreteResource | null {
  const key = normalizeRecipeSource(source);
  const hit = SOURCE_CONCRETE_MAP[key];
  if (!hit) return null;
  const leaf = hit.type.split("/").pop() || hit.type;
  const withLowerInitialism = leaf.replace(/^[A-Z]+(?=[A-Z][a-z])/, (m) => m.toLowerCase());
  const name = withLowerInitialism.charAt(0).toLowerCase() + withLowerInitialism.slice(1);
  return {
    name,
    type: hit.type,
    displayType: hit.displayType,
    provider: hit.provider,
    apiVersion: "",
  };
}

// Parse the `recipes` map of a recipe-pack bicep file into its entries. Each entry
// looks like:
//   'Radius.Data/mySqlDatabases': {
//     kind: 'bicep'
//     source: 'ghcr.io/radius-project/kube-recipes/mysqldatabases:latest'
//     parameters: { ... }   // optional, ignored
//   }
export function parseRecipePack(content: string): RecipePackEntry[] {
  if (!content) return [];
  const entries: RecipePackEntry[] = [];
  const entryRegex = /'(Radius\.[A-Za-z0-9]+\/[A-Za-z0-9]+)'\s*:\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = entryRegex.exec(content)) !== null) {
    const resourceType = match[1];
    let kind: string | null = null;
    let source: string | null = null;

    let i = entryRegex.lastIndex;
    let depth = 1;
    let lineStart = i;
    for (; i < content.length && depth > 0; i++) {
      const ch = content[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;

      if (ch === "\n" || i === content.length - 1) {
        if (depth === 1) {
          const line = content.slice(lineStart, i + 1);
          kind ??= line.match(/\bkind\s*:\s*'([^']+)'/)?.[1] ?? null;
          source ??= line.match(/\bsource\s*:\s*'([^']+)'/)?.[1] ?? null;
        }
        lineStart = i + 1;
      }
    }

    if (!source) continue;
    entries.push({ resourceType, kind: kind || "bicep", source });
  }

  return entries;
}
