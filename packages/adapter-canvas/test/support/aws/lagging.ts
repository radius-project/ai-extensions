import type { FakeAws } from "./fake-aws.js";

/**
 * Makes `world.aws` eventually consistent for one kind of read: after a
 * `deleteVerb` call succeeds, the next `stale` calls of `readVerb` answer as
 * the last one before it did. `left()` is how many stale answers remain.
 */
export function lagging(
  world: { aws: FakeAws },
  deleteVerb: string,
  readVerb: string,
  stale: number
): { left: () => number } {
  const run = world.aws.run.bind(world.aws);
  let before: ReturnType<typeof run> | null = null;
  let remaining = 0;
  world.aws.run = (args) => {
    if (args[1] === readVerb && remaining > 0 && before) {
      remaining -= 1;
      return before;
    }
    const result = run(args);
    if (args[1] === readVerb) before = result;
    if (args[1] === deleteVerb && result.code === 0) remaining = stale;
    return result;
  };
  return { left: () => remaining };
}
