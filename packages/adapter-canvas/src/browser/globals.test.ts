import { describe, expect, it } from "vitest";
import {
  PAGE_REGISTRY_GLOBAL,
  publishBrowserGlobals,
  readBrowserGlobal
} from "./globals.js";

describe("intended browser globals", () => {
  it("publishes exactly the allowlisted names", () => {
    const scope: Record<string, unknown> = { existing: true };
    publishBrowserGlobals(scope, { [PAGE_REGISTRY_GLOBAL]: { id: 1 } }, [
      PAGE_REGISTRY_GLOBAL
    ]);
    expect(Object.keys(scope).sort()).toEqual([
      "existing",
      PAGE_REGISTRY_GLOBAL
    ]);
    expect(readBrowserGlobal(scope, PAGE_REGISTRY_GLOBAL)).toEqual({ id: 1 });
  });

  it("rejects a non-object scope or any allowlist mismatch", () => {
    expect(() => publishBrowserGlobals(null, {}, [])).toThrow(
      "Radius browser globals need a global object."
    );
    expect(() => publishBrowserGlobals({}, { unexpected: true }, [])).toThrow(
      "Radius browser globals must publish exactly: ."
    );
    expect(() => publishBrowserGlobals({}, {}, ["missing"])).toThrow(
      "Radius browser globals must publish exactly: missing."
    );
    expect(readBrowserGlobal(null, "value")).toBeUndefined();
  });
});
