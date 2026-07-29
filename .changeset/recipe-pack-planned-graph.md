---
"@radius-project/core": minor
"@radius-project/canvas": patch
---

Derive the planned graph's concrete resources from the default recipe pack instead of individual recipe files.

The planned application graph previously discovered concrete resource types by walking `radius-project/resource-types-contrib` for every `<Category>/<type>/recipes/<platform>/<format>` directory and parsing each recipe's `main.bicep`/`main.tf`. That per-recipe search is wrong under the recipe-pack model: the authoritative mapping of a Radius resource type to the recipe that provisions it lives in the provider's **default recipe pack** (`recipe-packs/<provider>/*.bicep`), which the deploy skill treats as canonical.

`fetchRecipesFromGitHub`/`loadRecipeResources` and the individual-recipe parsers (`radius-core/src/modeling/recipes.ts`, `terraform.ts`) are removed and replaced by `fetchRecipePack`, which reads a single recipe-pack file (Azure downloads `recipe-packs/azure/aks-recipepack.bicep`; AWS and Kubernetes use `recipe-packs/kubernetes/default-recipepack.bicep`), parses its `recipes` map, and derives one primary concrete resource per entry from the recipe `source` via a curated, documented map (Azure Verified Module → ARM type; `kube-recipes/*` → its primary Kubernetes object). `resolveRecipeOutputs` is unchanged, so planned nodes keep showing a concrete resolved type. Unlisted/custom types yield no fabricated outputs — they are provisioned by recipe packs at deploy time.

On an Azure environment a container now resolves to the AKS managed cluster (`Microsoft.ContainerService/managedClusters`) it runs on rather than the Kubernetes `Deployment` the shared `kube-recipes/containers` recipe emits, via a provider-scoped source override. On Kubernetes (and any non-Azure provider) the container still resolves to `apps/Deployment`.

In the canvas graph, clicking a node's three-dots button now toggles its details popup — a second click on the same node's button closes the popup instead of reopening it.
