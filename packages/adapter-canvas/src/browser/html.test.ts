import { describe, expect, it } from "vitest";
import { browserCssMaskUrl, escapeBrowserHtml } from "./html.js";

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

describe("browserCssMaskUrl", () => {
  it("leaves an ordinary data or http url byte-identical", () => {
    expect(browserCssMaskUrl("data:image/svg+xml,%3Csvg%3E")).toBe(
      'url("data:image/svg+xml,%3Csvg%3E")'
    );
    expect(browserCssMaskUrl("https://x/i.svg?a=1&b=2")).toBe(
      'url("https://x/i.svg?a=1&b=2")'
    );
  });

  it("percent-encodes everything that could close the url or the declaration", () => {
    expect(browserCssMaskUrl(`a") ;b:red;--x:url('\\`)).toBe(
      'url("a%22%29%20%3Bb:red%3B--x:url%28%27%5C")'
    );
  });

  it("renders non-strings as text", () => {
    expect(browserCssMaskUrl(null)).toBe('url("null")');
  });
});
