// @ts-nocheck — verbatim-moved orchestration from the canvas monolith.
// Reaches the outside world only through the injected GitHub port; full
// strict-mode typing is deferred to a follow-up (see design doc Goal 5).
// Recipe resolution that needs GitHub access — discovers recipes in
// radius-project/resource-types-contrib and resolves a planned app's abstract
// resources to the concrete cloud/k8s resources each recipe deploys. Reaches
// GitHub only through the injected {@link GitHub} port; the pure recipe parsing
// helpers live in ./terraform, ./recipes. When no discovered recipe matches a
// resource type, resolution yields no outputs — custom-type recipes are handled
// by recipe packs at deploy time, not fabricated here.

import type { GitHub } from "../ports/index.js";
import { getPlatform } from "../platforms/index.js";
import { parseTerraformResources } from "./terraform.js";
import { parseRecipeResources } from "./recipes.js";

export async function loadRecipeResources(gh, recipePath, format) {
    const ghApiGetContent = (p) => gh.getContent(p);
    const ghApiListNames = (p) => gh.listNames(p);
    const files = await ghApiListNames(`/repos/radius-project/resource-types-contrib/contents/${recipePath}`);
    if (files.length === 0) return null;
    const mainFile = files.find(f => f.endsWith('.bicep') || f === 'main.tf') || files[0];
    const content = await ghApiGetContent(`/repos/radius-project/resource-types-contrib/contents/${recipePath}/${mainFile}`);
    if (!content) return null;
    const concreteResources = format === 'terraform'
        ? parseTerraformResources(content)
        : parseRecipeResources(content);
    return { format, content, concreteResources };
}

export async function fetchRecipesFromGitHub(gh, provider) {
    // resource-types-contrib structure: <Category>/<typeName>/recipes/<platform>/<format>/
    // Platforms: kubernetes, aws, azure
    // Format: bicep, terraform
    const platform = getPlatform(provider)?.recipePlatform || 'kubernetes';

    // Dynamically discover resource types from the repo tree
    const tree = await gh.treePaths('radius-project/resource-types-contrib', 'main');

    // Find all resource type directories that have recipe folders
    const recipePattern = /^([^/]+\/[^/]+)\/recipes\//;
    const discoveredTypes = new Set();
    for (const path of tree) {
        const match = path.match(recipePattern);
        if (match) discoveredTypes.add(match[1]);
    }

    // Build resource type list from discovered directories
    const resourceTypes = [...discoveredTypes].map(dir => {
        const typeName = dir.split('/').pop();
        const category = dir.split('/')[0];
        return { dir, type: `Radius.${category}/${typeName}` };
    });

    // Fallback to known types if tree fetch fails
    if (resourceTypes.length === 0) {
        const knownTypes = [
            { dir: 'Compute/containers', type: 'Radius.Compute/containers' },
            { dir: 'Compute/containerImages', type: 'Radius.Compute/containerImages' },
            { dir: 'Compute/routes', type: 'Radius.Compute/routes' },
            { dir: 'Compute/persistentVolumes', type: 'Radius.Compute/persistentVolumes' },
            { dir: 'Data/mySqlDatabases', type: 'Radius.Data/mySqlDatabases' },
            { dir: 'Data/postgreSqlDatabases', type: 'Radius.Data/postgreSqlDatabases' },
            { dir: 'Data/neo4jDatabases', type: 'Radius.Data/neo4jDatabases' },
            { dir: 'Security/secrets', type: 'Radius.Security/secrets' },
        ];
        resourceTypes.push(...knownTypes);
    }

    const recipes = [];
    for (const rt of resourceTypes) {
        // Try bicep first, then terraform
        for (const format of ['bicep', 'terraform']) {
            const recipePath = `${rt.dir}/recipes/${platform}/${format}`;
            const loaded = await loadRecipeResources(gh, recipePath, format);
            if (!loaded) continue;

            recipes.push({
                name: rt.dir.split('/').pop(),
                resourceType: rt.type,
                templateKind: format,
                templatePath: `ghcr.io/radius-project/resource-types-contrib/${recipePath}`,
                provider: platform,
                concreteResources: loaded.concreteResources
            });
            break; // Use first available format
        }
    }
    return recipes;
}

export async function resolveRecipeOutputs(gh, appResources, recipes, provider) {
    const resolved = [];

    // Normalize type: Applications.Core/containers -> Radius.Compute/containers, etc.
    function normalizeType(type) {
        const typeMap = {
            'Applications.Core/containers': 'Radius.Compute/containers',
            'Applications.Core/gateways': 'Radius.Networking/gateways',
            'Applications.Core/httpRoutes': 'Radius.Networking/routes',
            'Applications.Core/volumes': 'Radius.Compute/persistentVolumes',
            'Applications.Core/secretStores': 'Radius.Security/secrets',
            'Applications.Core/extenders': 'Radius.Core/extenders',
            'Applications.Datastores/sqlDatabases': 'Radius.Data/sqlDatabases',
            'Applications.Datastores/mongoDatabases': 'Radius.Data/mongoDatabases',
            'Applications.Datastores/redisCaches': 'Radius.Data/redisCaches',
            'Applications.Messaging/rabbitMQQueues': 'Radius.Messaging/rabbitMQQueues',
        };
        return typeMap[type] || type;
    }

    for (const appRes of appResources) {
        const rawType = appRes.type.split('@')[0];
        const baseType = normalizeType(rawType);

        // Match a real recipe discovered from resource-types-contrib by resource
        // type (try both normalized and raw). Recipe resolution for custom types
        // is owned by recipe packs at deploy time and the radius-app-bicep skill —
        // this modeling code no longer fabricates outputs when nothing matches.
        const matchingRecipe = recipes.find(r => r.resourceType === baseType) ||
                               recipes.find(r => r.resourceType === rawType);

        let outputResources = matchingRecipe?.concreteResources || [];

        // Annotate K8s Deployment nodes with managed service name (AKS/EKS)
        const k8sServiceName = getPlatform(provider)?.clusterServiceName || 'K8s';
        outputResources = outputResources.map(r => {
            if (r.type === 'apps/Deployment' && r.displayType && !r.displayType.includes('(')) {
                return { ...r, displayType: `${r.displayType} (${k8sServiceName})` };
            }
            return r;
        });

        // Build the planned resource entry
        const planned = {
            ...appRes,
            recipe: matchingRecipe ? {
                name: matchingRecipe.name,
                templateKind: matchingRecipe.templateKind,
                templatePath: matchingRecipe.templatePath,
            } : null,
            outputResources: outputResources,
        };
        resolved.push(planned);
    }
    return resolved;
}

