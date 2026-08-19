import { describe, expect, it } from "vitest";
import { APP_BICEP_HASH_ALGORITHM, hashAppBicep } from "./app-bicep-hash.js";

// These assertions moved here with the hash itself. `@radius-project/core` is
// compiled into the browser bundle through its package barrel, so it cannot
// import `node:crypto`; core keeps the normalization and injects this hasher.

describe("hashAppBicep", () => {
  const MODEL =
    "resource app 'Radius.Core/applications@2025-08-01-preview' = {}";

  it("produces a stable algorithm-prefixed digest", () => {
    expect(hashAppBicep(MODEL)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(hashAppBicep(MODEL)).toBe(hashAppBicep(MODEL));
  });

  it("ignores checkout artifacts but not content differences", () => {
    expect(hashAppBicep("a\r\nb\n")).toBe(hashAppBicep("a\nb"));
    expect(hashAppBicep("a\nb  ")).toBe(hashAppBicep("a\nb"));
    expect(hashAppBicep("a\nb")).not.toBe(hashAppBicep("a\nc"));
  });

  it("names the algorithm it prefixes", () => {
    expect(hashAppBicep(MODEL).startsWith(`${APP_BICEP_HASH_ALGORITHM}:`)).toBe(
      true
    );
  });
});
