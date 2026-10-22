import { describe, expect, it } from "vitest";
import { compareRadiusVersions } from "./radius-version.js";

describe("compareRadiusVersions", () => {
  it.each([
    ["0.60", "0.61"],
    ["0.99", "0.100"],
    ["0.61", "1.0"],
    ["0.61.0-rc1", "0.61"],
    ["0.61.0-rc1", "0.61.0-rc2"],
    ["0.61.0-rc.2", "0.61.0-rc.10"],
    ["0.61.0-1", "0.61.0-rc"],
    ["0.61.0-rc", "0.61.0-rc.1"],
    ["0.61.0-rc1", "0.61.1-rc1"],
    ["0.60", "0.61.0-rc1"]
  ])("orders %s before %s", (older, newer) => {
    expect(compareRadiusVersions(older, newer)).toBeLessThan(0);
    expect(compareRadiusVersions(newer, older)).toBeGreaterThan(0);
  });

  it.each([
    ["0.60", "0.60"],
    [" 0.60 ", "0.60"],
    ["0.61.0-rc1", "0.61.0-rc1"]
  ])("treats %s and %s as the same Radius version", (a, b) => {
    expect(compareRadiusVersions(a, b)).toBe(0);
  });

  it.each([
    ["blank", ""],
    ["an edge build", "latest"],
    ["a full stable version", "0.60.2"],
    ["a leading v", "v0.60"],
    ["a leading zero", "0.060"],
    ["an empty prerelease identifier", "0.61.0-rc..1"],
    ["a registry reference", "br:biceptypes.azurecr.io/radius:0.60"]
  ])("cannot order %s", (_label, value) => {
    expect(compareRadiusVersions(value, "0.60")).toBeNull();
    expect(compareRadiusVersions("0.60", value)).toBeNull();
  });
});
