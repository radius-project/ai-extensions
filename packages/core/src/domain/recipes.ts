import { parseResourceId } from "./resource-id.js";
import type {
  EnvironmentProperties,
  RecipePackProperties,
  Resource
} from "./resources.js";

export interface DisplayRecipe {
  recipePack: string;
  type: string;
  kind: string;
  source: string;
}

/** Resolves supplied packs only; hosts own loading and report missing packs. */
export function aggregateRecipes(
  environment: Partial<Pick<EnvironmentProperties, "recipes" | "recipePacks">>,
  packsById: Readonly<Record<string, Resource<RecipePackProperties>>>
): DisplayRecipe[] {
  const rows: DisplayRecipe[] = [];
  for (const [type, recipes] of Object.entries(environment.recipes ?? {})) {
    for (const recipe of Object.values(recipes)) {
      rows.push({
        recipePack: "",
        type,
        kind: recipe.templateKind,
        source: recipe.templatePath
      });
    }
  }
  const packs = new Map(
    Object.entries(packsById).map(([id, pack]) => [id.toLowerCase(), pack])
  );
  for (const id of environment.recipePacks ?? []) {
    const pack = packs.get(id.toLowerCase());
    if (!pack) continue;
    for (const [type, recipe] of Object.entries(pack.properties.recipes)) {
      rows.push({
        recipePack: parseResourceId(pack.id)?.name ?? pack.name,
        type,
        kind: recipe.kind,
        source: recipe.source
      });
    }
  }
  return rows;
}
