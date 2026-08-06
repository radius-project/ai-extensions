// Opt-in live drift test. Fetches the CURRENT recipe packs from
// radius-project/resource-types-contrib and asserts every entry still resolves to
// a concrete resource — i.e. the curated SOURCE_CONCRETE_MAP has not fallen out of
// sync with upstream. This hits the network and depends on an external repo's
// moving `main`, so it is NOT part of the default hermetic suite: it only runs
// when RUN_LIVE_PACK_TESTS is set (e.g. locally or in a scheduled job), never in
// normal CI. Day-to-day drift is caught at runtime by the plan route's
// unmapped-recipe diagnostic; the frozen-fixture test guards parser regressions.
import { describe, it, expect } from "vitest";
import {
  parseRecipePack,
  deriveConcreteResource,
  recipePackPathForProvider,
  RECIPE_PACK_REPO,
  RECIPE_PACK_REF
} from "./recipe-pack.js";

const LIVE = !!process.env.RUN_LIVE_PACK_TESTS;

async function fetchLivePack(provider: string): Promise<string> {
  const url = `https://raw.githubusercontent.com/${RECIPE_PACK_REPO}/${RECIPE_PACK_REF}/${recipePackPathForProvider(provider)}`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return res.text();
}

describe.skipIf(!LIVE)(
  "live recipe packs (opt-in: set RUN_LIVE_PACK_TESTS)",
  () => {
    it.each([{ provider: "azure" }, { provider: "kubernetes" }])(
      "maps every entry in the current $provider pack",
      async ({ provider }) => {
        const entries = parseRecipePack(await fetchLivePack(provider));

        // Sanity: the parser must find entries in a real pack.
        expect(entries.length).toBeGreaterThan(0);

        const unresolved = entries
          .filter((e) => deriveConcreteResource(e.source, provider) === null)
          .map((e) => `${e.resourceType} (${e.source})`);

        // A non-empty list means upstream added or changed a recipe source that the
        // curated map does not cover — update SOURCE_CONCRETE_MAP (and the committed
        // fixtures) to match.
        expect(
          unresolved,
          `${provider}: ${entries.length} entries, ${unresolved.length} unmapped: ${unresolved.join(", ")}`
        ).toEqual([]);
      },
      30_000
    );
  }
);
