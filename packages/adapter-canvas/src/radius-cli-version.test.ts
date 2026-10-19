import { describe, expect, it, vi } from "vitest";
import { createRadiusCliVersionReader } from "./radius-cli-version.js";

function reader(results: Array<string | Error>) {
  const readVersion = vi.fn(async () => {
    const next = results.shift();
    if (next === undefined) throw new Error("unexpected extra read");
    if (next instanceof Error) throw next;
    return next;
  });
  return { read: createRadiusCliVersionReader(readVersion), readVersion };
}

describe("createRadiusCliVersionReader", () => {
  // The managed CLI only changes when the plugin loads, so one answer serves
  // every graph open after it. Concurrent opens share the one read in flight.
  it("reads the CLI once per plugin load", async () => {
    const { read, readVersion } = reader(["0.61"]);

    const [first, second] = await Promise.all([read(), read()]);
    const third = await read();

    expect([first, second, third]).toEqual(["0.61", "0.61", "0.61"]);
    expect(readVersion).toHaveBeenCalledTimes(1);
  });

  // Unknown skips the check, so it must not be kept: a CLI that was missing on
  // the first open may be there on the next one.
  it.each([
    ["the release maps to no Radius version", ""],
    ["the read fails", new Error("pull-request build")]
  ])(
    "reports an unknown version and reads again later when %s",
    async (_label, failure) => {
      const { read, readVersion } = reader([failure, "0.61"]);

      await expect(read()).resolves.toBe("");
      await expect(read()).resolves.toBe("0.61");
      expect(readVersion).toHaveBeenCalledTimes(2);
    }
  );
});
