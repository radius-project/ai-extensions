import { describe, expect, it } from "vitest";
import {
  deterministicProviderUuid,
  setupIdentityEqual
} from "./setup-identity-bindings.js";

describe("setup identity Node bindings", () => {
  it.each([
    ["", "e3b0c442-98fc-5c14-9afb-f4c8996fb924"],
    [
      "operation\0principal\0Contributor\0/subscriptions/test/resourceGroups/group",
      "87d6ceb6-c466-5add-b8da-7bf7a1d9675a"
    ],
    ["café", "850f7dc4-3910-5f89-8f88-79c0ed26fe69"]
  ])("preserves the deterministic provider UUID for %j", (seed, expected) => {
    expect(deterministicProviderUuid(seed)).toBe(expected);
  });

  it("uses strict structural equality rather than normalized JSON", () => {
    expect(setupIdentityEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(setupIdentityEqual({ a: undefined }, {})).toBe(false);
    expect(setupIdentityEqual(-0, 0)).toBe(false);
    expect(setupIdentityEqual(NaN, NaN)).toBe(true);
    expect(setupIdentityEqual(["repo", "workflow"], ["workflow", "repo"])).toBe(
      false
    );
    expect(
      setupIdentityEqual(Object.assign(Object.create(null), { a: 1 }), { a: 1 })
    ).toBe(false);
  });
});
