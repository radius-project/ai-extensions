import { describe, expect, it } from "vitest";
import radiusRelease from "./radius-release.json" with { type: "json" };
import { RADIUS_RELEASE_COMMIT, RADIUS_RELEASE_TAG } from "./radius-release.js";

describe("radius release pin", () => {
  it("exposes the tag and commit from radius-release.json", () => {
    expect(RADIUS_RELEASE_TAG).toBe(radiusRelease.tag);
    expect(RADIUS_RELEASE_COMMIT).toBe(radiusRelease.commit);
  });

  it("uses a release tag and a full commit SHA", () => {
    expect(RADIUS_RELEASE_TAG).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(RADIUS_RELEASE_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
});
