import { describe, expect, it } from "vitest";
import { mapWithLimit } from "./map-with-limit.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("mapWithLimit", () => {
  it("returns results in input order even when calls finish out of order", async () => {
    const gates = [0, 1, 2, 3, 4].map(() => gate());
    const results = mapWithLimit([0, 1, 2, 3, 4], 2, async (item) => {
      await gates[item].opened;
      return item * 2;
    });
    for (const { open } of [...gates].reverse()) open();
    expect(await results).toEqual([0, 2, 4, 6, 8]);
  });

  it("never runs more calls at once than the limit", async () => {
    const release = gate();
    const threeStarted = gate();
    let running = 0;
    let peak = 0;
    const done = mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      if (running === 3) threeStarted.open();
      await release.opened;
      running -= 1;
    });
    await threeStarted.opened;
    release.open();
    await done;
    expect(peak).toBe(3);
  });

  it("returns an empty list without calling map", async () => {
    const results = await mapWithLimit([], 4, async () => {
      throw new Error("map must not be called");
    });
    expect(results).toEqual([]);
  });

  it("rejects with the first failure", async () => {
    await expect(
      mapWithLimit([1, 2], 4, async (item) => {
        if (item === 2) throw new Error("read failed");
        return item;
      })
    ).rejects.toThrow("read failed");
  });
});
