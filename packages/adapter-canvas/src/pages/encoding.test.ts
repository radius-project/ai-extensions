import { describe, it, expect } from "vitest";
import { safeExternalHref } from "./encoding.js";

describe("safeExternalHref", () => {
  it("passes an ordinary https workflow URL through, escaped for the attribute", () => {
    expect(safeExternalHref("https://github.com/octo/app/actions/runs/1")).toBe(
      "https://github.com/octo/app/actions/runs/1"
    );
    expect(safeExternalHref("https://github.com/octo/app?a=1&b=2")).toBe(
      "https://github.com/octo/app?a=1&amp;b=2"
    );
    expect(safeExternalHref("http://localhost:3000/run")).toBe(
      "http://localhost:3000/run"
    );
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/relative/path",
    "not a url",
    "",
    "   "
  ])("refuses %s so it can never become an executable link", (value) => {
    expect(safeExternalHref(value)).toBe("");
  });

  it("refuses a non-string value", () => {
    expect(safeExternalHref(undefined)).toBe("");
    expect(safeExternalHref(null)).toBe("");
    expect(safeExternalHref({ href: "https://x" })).toBe("");
  });

  it("escapes an accepted URL so it cannot break out of the attribute", () => {
    const href = safeExternalHref(
      'https://example.com/"><img src=x onerror=alert(1)>'
    );
    expect(href).not.toContain('"');
    expect(href).not.toContain("<");
    expect(href.startsWith("https://example.com/")).toBe(true);
  });
});
