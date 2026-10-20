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
  // The two branches of a diff view resolve their status together. They share
  // one CLI launch rather than spawning one each.
  it("shares a read that is still in flight", async () => {
    const { read, readVersion } = reader(["0.61"]);

    await expect(Promise.all([read(), read()])).resolves.toEqual([
      "0.61",
      "0.61"
    ]);
    expect(readVersion).toHaveBeenCalledTimes(1);
  });

  // The managed CLI is shared by every plugin process on the machine, so
  // another session's load-time update can replace it after this one read it.
  // A kept answer would keep comparing models against the replaced CLI.
  it("reads again once a read has finished, so a CLI another session replaced is seen", async () => {
    const { read, readVersion } = reader(["0.60", "0.61"]);

    await expect(read()).resolves.toBe("0.60");
    await expect(read()).resolves.toBe("0.61");
    expect(readVersion).toHaveBeenCalledTimes(2);
  });

  it("reports an unknown version when the read fails, and reads again later", async () => {
    const { read } = reader([new Error("pull-request build"), "0.61"]);

    await expect(read()).resolves.toBe("");
    await expect(read()).resolves.toBe("0.61");
  });
});
