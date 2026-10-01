import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "./external-url.js";

describe("safeExternalUrl", () => {
  it("keeps an absolute https URL and normalizes it", () => {
    expect(safeExternalUrl("https://github.com/o/r/actions/runs/1")).toBe(
      "https://github.com/o/r/actions/runs/1"
    );
    expect(safeExternalUrl("https://github.com")).toBe("https://github.com/");
  });

  it.each([
    ["an http URL", "http://github.com/o/r"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a file URL", "file:///etc/passwd"],
    ["a relative path", "/?page=deploying"],
    ["an empty string", ""],
    ["a bare word", "github.com"]
  ])("refuses %s", (_name, url) => {
    expect(safeExternalUrl(url)).toBe("");
  });
});
