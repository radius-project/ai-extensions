// The environment picker's repo-scoped listing cache.
//
// The listing itself is assembled from many `gh` calls, so it is slow enough
// that an environment can be deleted — by the delete route, or by the rollback
// or exit pass that removes what a setup created — while a listing for that
// repository is still being built. A plain map cannot express that: the
// in-flight listing finishes last and writes the removed environment back into
// the cache the deletion just emptied, and the picker then serves it, under
// whatever status its last verify run left behind, until the TTL runs out.
//
// So eviction is not a delete. Every invalidation also advances the
// repository's generation, and a listing that reads the generation when it
// starts can tell, before it caches anything, whether it is describing state
// that has since changed.

export interface CachedEnvironmentListing {
  at: number;
  payload: unknown;
}

export interface EnvironmentListingCache {
  get(repo: string): CachedEnvironmentListing | undefined;
  set(repo: string, entry: CachedEnvironmentListing): void;
  /**
   * Drop a repository's cached listing and mark every listing already in flight
   * for it as stale. This is the only eviction path.
   */
  invalidate(repo: string): void;
  clear(): void;
  /** How many times this repository's listing has been invalidated. */
  generation(repo: string): number;
}

export function createEnvironmentListingCache(): EnvironmentListingCache {
  const entries = new Map<string, CachedEnvironmentListing>();
  const generations = new Map<string, number>();
  let sequence = 0;
  let clearGeneration = 0;
  const generation = (repo: string): number =>
    generations.get(repo) ?? clearGeneration;
  return {
    get: (repo) => entries.get(repo),
    set: (repo, entry) => {
      entries.set(repo, entry);
    },
    invalidate: (repo) => {
      entries.delete(repo);
      generations.set(repo, ++sequence);
    },
    clear: () => {
      entries.clear();
      generations.clear();
      clearGeneration = ++sequence;
    },
    generation
  };
}
