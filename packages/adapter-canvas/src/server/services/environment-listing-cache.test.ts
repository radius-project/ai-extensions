import { describe, expect, it } from "vitest";
import { createEnvironmentListingCache } from "./environment-listing-cache.js";

// The cache exists to make the picker snappy; the generation exists to keep it
// honest. A rollback that deletes an environment while a listing for that
// repository is still being assembled must win, or the picker hands the
// customer back the environment the rollback just removed.

describe("createEnvironmentListingCache", () => {
  it("stores and returns a repository's listing", () => {
    const cache = createEnvironmentListingCache();
    const entry = { at: 10, payload: { environments: [{ name: "dev" }] } };

    cache.set("octo/app", entry);

    expect(cache.get("octo/app")).toBe(entry);
    expect(cache.get("octo/other")).toBeUndefined();
  });

  it("starts every repository at generation zero", () => {
    const cache = createEnvironmentListingCache();
    expect(cache.generation("octo/app")).toBe(0);
    expect(cache.generation("")).toBe(0);
  });

  it("drops the entry and advances the generation on invalidation", () => {
    const cache = createEnvironmentListingCache();
    cache.set("octo/app", { at: 0, payload: { environments: [] } });

    cache.invalidate("octo/app");

    expect(cache.get("octo/app")).toBeUndefined();
    expect(cache.generation("octo/app")).toBe(1);

    cache.invalidate("octo/app");
    expect(cache.generation("octo/app")).toBe(2);
  });

  it("advances the generation of a repository that has nothing cached", () => {
    const cache = createEnvironmentListingCache();

    // The deletion can land before the listing that started first ever
    // finished, so there is nothing to evict — but the listing still has to
    // learn that it is describing state that has changed.
    cache.invalidate("octo/app");

    expect(cache.generation("octo/app")).toBe(1);
  });

  it("keeps repositories independent", () => {
    const cache = createEnvironmentListingCache();
    cache.set("octo/app", { at: 1, payload: { environments: [] } });
    cache.set("octo/other", { at: 2, payload: { environments: [] } });

    cache.invalidate("octo/app");

    expect(cache.get("octo/other")).toEqual({
      at: 2,
      payload: { environments: [] }
    });
    expect(cache.generation("octo/other")).toBe(0);
  });

  it("lets a later listing replace an entry without touching the generation", () => {
    const cache = createEnvironmentListingCache();
    cache.set("octo/app", { at: 1, payload: { environments: [] } });

    cache.set("octo/app", {
      at: 5,
      payload: { environments: [{ name: "dev" }] }
    });

    expect(cache.get("octo/app")).toEqual({
      at: 5,
      payload: { environments: [{ name: "dev" }] }
    });
    expect(cache.generation("octo/app")).toBe(0);
  });

  it("tells a listing that started before an invalidation that it is stale", () => {
    const cache = createEnvironmentListingCache();
    const repo = "octo/app";

    const startedAt = cache.generation(repo);
    cache.invalidate(repo);

    expect(cache.generation(repo)).not.toBe(startedAt);
    expect(cache.get(repo)).toBeUndefined();
  });

  it("tells an uninterrupted listing that it may cache what it read", () => {
    const cache = createEnvironmentListingCache();
    const repo = "octo/app";

    const startedAt = cache.generation(repo);
    cache.set(repo, { at: 9, payload: { environments: [] } });

    expect(cache.generation(repo)).toBe(startedAt);
    expect(cache.get(repo)).toEqual({ at: 9, payload: { environments: [] } });
  });
});
