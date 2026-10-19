import { describe, expect, it, vi } from "vitest";
import { createRadiusCliVersionReader } from "./radius-cli-version.js";

const RAD = "/home/user/.radius/ai-extensions/bin/rad";

function reader(refs: Array<string | null | Error>) {
  const resolveRadPath = vi.fn(async () => RAD);
  const resolveExtensionRef = vi.fn(async (radPath: string) => {
    expect(radPath).toBe(RAD);
    const next = refs.shift();
    if (next === undefined) throw new Error("unexpected extra read");
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    read: createRadiusCliVersionReader({ resolveRadPath, resolveExtensionRef }),
    resolveRadPath,
    resolveExtensionRef
  };
}

describe("createRadiusCliVersionReader", () => {
  it.each([
    ["a stable release", "br:biceptypes.azurecr.io/radius:0.61", "0.61"],
    [
      "a prerelease",
      "br:biceptypes.azurecr.io/radius:0.62.0-rc1",
      "0.62.0-rc1"
    ],
    [
      "an authorized edge build",
      "br:biceptypes.azurecr.io/radius:latest",
      "latest"
    ]
  ])("reads the Radius version of %s", async (_label, ref, expected) => {
    const { read } = reader([ref]);

    await expect(read()).resolves.toBe(expected);
  });

  // The managed CLI only changes when the plugin loads, so one answer serves
  // every graph open after it. Concurrent opens share the one read in flight.
  it("reads the CLI once per plugin load", async () => {
    const { read, resolveRadPath, resolveExtensionRef } = reader([
      "br:biceptypes.azurecr.io/radius:0.61"
    ]);

    const [first, second] = await Promise.all([read(), read()]);
    const third = await read();

    expect([first, second, third]).toEqual(["0.61", "0.61", "0.61"]);
    expect(resolveRadPath).toHaveBeenCalledTimes(1);
    expect(resolveExtensionRef).toHaveBeenCalledTimes(1);
  });

  // Unknown skips the check, so it must not be kept: a CLI that was missing on
  // the first open may be there on the next one.
  it.each([
    ["the release cannot be mapped", null],
    ["the release is refused", new Error("pull-request build")],
    ["the reference is not in the Radius registry", "./radius.tgz"]
  ])(
    "reports an unknown version and reads again later when %s",
    async (_label, failure) => {
      const { read, resolveExtensionRef } = reader([
        failure,
        "br:biceptypes.azurecr.io/radius:0.61"
      ]);

      await expect(read()).resolves.toBe("");
      await expect(read()).resolves.toBe("0.61");
      expect(resolveExtensionRef).toHaveBeenCalledTimes(2);
    }
  );

  it("reports an unknown version when no rad binary can be resolved", async () => {
    const resolveExtensionRef = vi.fn();
    const read = createRadiusCliVersionReader({
      resolveRadPath: async () => {
        throw new Error("download failed");
      },
      resolveExtensionRef
    });

    await expect(read()).resolves.toBe("");
    expect(resolveExtensionRef).not.toHaveBeenCalled();
  });
});
