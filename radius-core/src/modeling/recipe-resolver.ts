// @ts-nocheck — verbatim-moved orchestration from the canvas monolith.
// Reaches the outside world only through the injected GitHub port; full
// strict-mode typing is deferred to a follow-up (see design doc Goal 5).
// Recipe resolution that needs GitHub access — reads the default recipe pack in
// radius-project/resource-types-contrib and resolves a planned app's abstract
// resources to the concrete cloud/k8s resource each recipe deploys. Reaches
// GitHub only through the injected {@link GitHub} port; the pure recipe-pack
// parsing/derivation helpers live in ./recipe-pack. When the pack has no recipe
// for a resource type, resolution yields no outputs — custom-type recipes are
// handled by recipe packs at deploy time, not fabricated here.

import type { GitHub } from "../ports/index.js";
import { getPlatform } from "../platforms/index.js";
import {
    parseRecipePack,
    deriveConcreteResource,
    recipePackContentPath,
} from "./recipe-pack.js";

// Fetch the provider's default recipe pack and resolve each entry to the primary
// concrete resource its recipe deploys. Replaces the legacy per-recipe tree walk:
// instead of discovering and parsing individual recipe files under
// <Category>/<type>/recipes/, we read the single authoritative recipe-pack file
// (recipe-packs/<provider>/*.bicep) that the deploy skill treats as canonical.
export async function fetchRecipePack(gh, provider) {
    const content = await gh.getContent(recipePackContentPath(provider));
    if (!content) return [];

    const entries = parseRecipePack(content);
    const recipes = [];
    for (const entry of entries) {
        const concrete = deriveConcreteResource(entry.source, provider);
        recipes.push({
            name: entry.resourceType.split('/').pop(),
            resourceType: entry.resourceType,
            templateKind: entry.kind,
            templatePath: entry.source,
            provider: concrete?.provider || provider,
            concreteResources: concrete ? [concrete] : [],
        });
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
            'Applications.Datastores/sqlDatabases': 'Radius.Data/sqlServerDatabases',
            'Applications.Datastores/mongoDatabases': 'Radius.Data/mongoDatabases',
            'Applications.Datastores/redisCaches': 'Radius.Data/redisCaches',
            'Applications.Messaging/rabbitMQQueues': 'Radius.Messaging/rabbitMQ',
        };
        return typeMap[type] || type;
    }

    for (const appRes of appResources) {
        const rawType = appRes.type.split('@')[0];
        const baseType = normalizeType(rawType);

        // Match a recipe from the default recipe pack by resource type (try both
        // normalized and raw). Recipe resolution for custom/unlisted types is
        // owned by recipe packs at deploy time and the radius-app-modeling skill —
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
