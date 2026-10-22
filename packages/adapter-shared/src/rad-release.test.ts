import { describe, expect, it } from "vitest";
import {
  RADIUS_EXTENSION_REGISTRY,
  radiusExtensionRefForRelease,
  radiusVersionFromExtensionRef
} from "./rad-release.js";

describe("radiusVersionFromExtensionRef", () => {
  it.each([
    ["a stable release", "v0.60.2", "0.60"],
    ["a prerelease", "v0.61.0-rc1", "0.61.0-rc1"],
    ["an edge build", "edge", "latest"]
  ])(
    "returns the version part of the reference for %s",
    (_label, release, expected) => {
      expect(
        radiusVersionFromExtensionRef(radiusExtensionRefForRelease(release))
      ).toBe(expected);
    }
  );

  it("ignores surrounding whitespace", () => {
    expect(
      radiusVersionFromExtensionRef(`  ${RADIUS_EXTENSION_REGISTRY}:0.60  `)
    ).toBe("0.60");
  });

  it.each([
    ["no reference", null],
    ["an undefined reference", undefined],
    ["a blank reference", "  "],
    ["a local package", "./radius.tgz"],
    ["another registry", "br:example.invalid/radius:0.60"],
    ["the registry without a separator", RADIUS_EXTENSION_REGISTRY]
  ])("returns nothing for %s", (_label, ref) => {
    expect(radiusVersionFromExtensionRef(ref)).toBe("");
  });
});
