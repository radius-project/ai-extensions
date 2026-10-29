import { describe, expect, it } from "vitest";
import { mapWithLimit } from "./map-with-limit.js";

describe("mapWithLimit", () => {
  it("returns results in input order even when calls finish out of order", async () => {
    const delays = [30, 0, 10, 0, 20];
    const results = await mapWithLimit(delays, 2, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return delay * 2;
    });
    expect(results).toEqual([60, 0, 20, 0, 40]);
  });

  it("never runs more calls at once than the limit", async () => {
    let running = 0;
    let peak = 0;
    await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
    });
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
