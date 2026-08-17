import { describe, expect, it } from "vitest";
import { escapeBrowserHtml } from "./html.js";

describe("escapeBrowserHtml", () => {
  it("neutralizes every character that can change HTML parsing", () => {
    expect(escapeBrowserHtml(`<img src=x onerror="y">&'`)).toBe(
      "&lt;img src=x onerror=&quot;y&quot;&gt;&amp;&#39;"
    );
  });

  it("escapes ampersands before other characters and renders non-strings as text", () => {
    expect(escapeBrowserHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeBrowserHtml(null)).toBe("null");
    expect(escapeBrowserHtml(undefined)).toBe("undefined");
    expect(escapeBrowserHtml(5)).toBe("5");
  });
});
