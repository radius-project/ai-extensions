/**
 * Maps `items` through `map` with at most `limit` calls in flight, and returns
 * the results in input order. The first rejection rejects the whole call.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await map(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
