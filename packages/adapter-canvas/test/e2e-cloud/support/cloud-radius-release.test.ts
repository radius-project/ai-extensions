import { describe, expect, it, vi } from "vitest";
import { configureCloudRadiusRelease } from "./cloud-radius-release.js";

const RELEASE = {
  tag: "v0.63.0-rc.1",
  commit: "a".repeat(40),
  checksum: "b".repeat(64)
};

describe("configureCloudRadiusRelease", () => {
  it.each([undefined, ""])(
    "keeps the pin when release is %s",
    async (release) => {
      const runGh = vi.fn(() => {
        throw new Error("No GitHub write is expected.");
      });
      await configureCloudRadiusRelease(
        { runGh },
        "fixture/repo",
        "radtest-example",
        release
      );
      expect(runGh).not.toHaveBeenCalled();
    }
  );

  it.each(["v0.62.0", "v0.63.0-rc.1"])(
    "sets %s only on the owned test environment, including after recreation",
    async (tag) => {
      const release = JSON.stringify({ ...RELEASE, tag });
      const runGh = vi.fn(async () => ({
        code: 0,
        stdout: "",
        stderr: ""
      }));
      for (let creation = 0; creation < 2; creation++) {
        await configureCloudRadiusRelease(
          { runGh },
          "fixture/repo",
          "radtest-example",
          release
        );
      }
      expect(runGh).toHaveBeenCalledTimes(2);
      expect(runGh).toHaveBeenLastCalledWith([
        "api",
        "--method",
        "POST",
        "repos/fixture/repo/environments/radtest-example/variables",
        "-f",
        "name=RADIUS_RELEASE_OVERRIDE",
        "-f",
        `value=${release}`
      ]);
    }
  );

  it.each([
    "not-json",
    "null",
    "[]",
    "{}",
    JSON.stringify({ tag: RELEASE.tag }),
    JSON.stringify({ tag: RELEASE.tag, commit: RELEASE.commit }),
    ...[
      { tag: "edge" },
      { tag: "v0.63.0;echo bad" },
      { tag: "v0.63.0-rc.1\n" },
      { tag: 63 },
      { commit: "a".repeat(39) },
      { commit: "z".repeat(40) },
      { commit: 1 },
      { checksum: "b".repeat(63) },
      { checksum: "z".repeat(64) },
      { checksum: 1 }
    ].map((override) => JSON.stringify({ ...RELEASE, ...override }))
  ])("rejects malformed metadata before writing: %s", async (release) => {
    const runGh = vi.fn(() => {
      throw new Error("Invalid metadata must not reach GitHub.");
    });
    await expect(
      configureCloudRadiusRelease(
        { runGh },
        "fixture/repo",
        "radtest-example",
        release
      )
    ).rejects.toThrow();
    expect(runGh).not.toHaveBeenCalled();
  });

  it("reports a rejected environment variable write", async () => {
    const runGh = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "HTTP 403: environment variables denied"
    }));
    await expect(
      configureCloudRadiusRelease(
        { runGh },
        "fixture/repo",
        "radtest-example",
        JSON.stringify(RELEASE)
      )
    ).rejects.toThrow(/HTTP 403: environment variables denied/u);
  });

  it("preserves a command transport failure", async () => {
    const failure = new Error("gh could not start");
    const runGh = vi.fn(async () => {
      throw failure;
    });
    await expect(
      configureCloudRadiusRelease(
        { runGh },
        "fixture/repo",
        "radtest-example",
        JSON.stringify(RELEASE)
      )
    ).rejects.toBe(failure);
  });
});
