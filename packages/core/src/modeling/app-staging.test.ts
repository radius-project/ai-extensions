import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STAGING_DIR_PREFIX, isStagingDirName } from "./app-staging.js";

describe("isStagingDirName", () => {
  it.each([
    [`${STAGING_DIR_PREFIX}abc`, true],
    [STAGING_DIR_PREFIX, false],
    ["staging-abc", false],
    [".radius", false],
    [undefined, false]
  ])("%s -> %s", (name, expected) => {
    expect(isStagingDirName(name)).toBe(expected);
  });

  it("matches the prefix that the skills' scripts write", () => {
    const common = readFileSync(
      new URL(
        "../../../../extensions/radius/skills/radius-app-model/scripts/common.mjs",
        import.meta.url
      ),
      "utf8"
    );
    expect(common).toContain(`const STAGING_PREFIX = "${STAGING_DIR_PREFIX}";`);
  });
});
