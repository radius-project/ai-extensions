import { describe, expect, it } from "vitest";
import { queryValue } from "./query.js";

describe("queryValue", () => {
  it("reads a value with or without a leading question mark", () => {
    expect(queryValue("?app=shop", "app")).toBe("shop");
    expect(queryValue("app=shop", "app")).toBe("shop");
  });

  it("returns an empty string when the key is absent or the query is empty", () => {
    expect(queryValue("?app=shop", "env")).toBe("");
    expect(queryValue("", "app")).toBe("");
    expect(queryValue("?", "app")).toBe("");
  });

  it("decodes percent escapes and plus-encoded spaces in the value", () => {
    expect(queryValue("?env=my%20env", "env")).toBe("my env");
    expect(queryValue("?env=my+env", "env")).toBe("my env");
    expect(queryValue("?env=a%2Fb", "env")).toBe("a/b");
  });

  it("decodes the key before matching", () => {
    expect(queryValue("?my%20key=value", "my key")).toBe("value");
  });

  it("returns an empty string for a key present without a value", () => {
    expect(queryValue("?app", "app")).toBe("");
    expect(queryValue("?app=", "app")).toBe("");
  });

  it("reads the first occurrence when a key repeats", () => {
    expect(queryValue("?app=first&app=second", "app")).toBe("first");
  });

  it("skips earlier pairs to find a later key", () => {
    expect(queryValue("?a=1&b=2&c=3", "c")).toBe("3");
  });

  // The regression these pin: decodeURIComponent throws URIError on a
  // malformed escape. These reads happen after beginEntry has claimed the
  // entry key and before the teardown is returned, and runBrowserEntry does
  // not wrap install(), so a throw escapes the compiled entry IIFE with the
  // claim held and leaves the page permanently unbindable.
  it("falls back to the raw text when a value has a malformed escape", () => {
    expect(queryValue("?application=%", "application")).toBe("%");
    expect(queryValue("?application=%E0%A4%A", "application")).toBe("%E0%A4%A");
    expect(queryValue("?new=1&name=%", "new")).toBe("1");
    expect(queryValue("?new=1&name=%", "name")).toBe("%");
  });

  it("falls back to the raw text when a key has a malformed escape", () => {
    expect(queryValue("?%=1&app=shop", "app")).toBe("shop");
    expect(queryValue("?%=1", "%")).toBe("1");
  });

  it("never throws on hostile query strings", () => {
    const hostile = ["?%", "?%&%", "?=%", "?a=%C0", "?%ZZ=%ZZ", "?app=%&env=%"];
    for (const search of hostile) {
      expect(() => queryValue(search, "app")).not.toThrow();
    }
  });
});
