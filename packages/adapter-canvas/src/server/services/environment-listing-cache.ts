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
//
// The deployments listing has the same race with a deploy or delete dispatch,
// so it uses this cache too.

export interface CachedEnvironmentListing {
  at: number;
  payload: unknown;
}

export interface EnvironmentListingCache {
  get(repo: string): CachedEnvironmentListing | undefined;
  set(repo: string, entry: CachedEnvironmentListing): void;
  clear(): void;
  /**
   * Drop a repository's cached listing and mark every listing already in flight
   * for it as stale. This is the only eviction path.
   */
  invalidate(repo: string): void;
  /** How many times this repository's listing has been invalidated. */
  generation(repo: string): number;
}

export function createEnvironmentListingCache(): EnvironmentListingCache {
  const entries = new Map<string, CachedEnvironmentListing>();
  const generations = new Map<string, number>();
  // A clear has to reach a listing for a repository the cache has never seen,
  // so it advances every repository's generation at once rather than only the
  // ones it can name.
  let clears = 0;
  const invalidations = (repo: string): number => generations.get(repo) ?? 0;
  const generation = (repo: string): number => clears + invalidations(repo);
  return {
    get: (repo) => entries.get(repo),
    set: (repo, entry) => {
      entries.set(repo, entry);
    },
    invalidate: (repo) => {
      entries.delete(repo);
      generations.set(repo, invalidations(repo) + 1);
    },
    clear: () => {
      entries.clear();
      clears += 1;
    },
    generation
  };
}
