import { describe, it, expect } from "vitest";
import { inlineJson, inlineJsString, safeExternalHref } from "./encoding.js";

// Evaluate an emitted single-quoted literal the way a browser would, so the
// assertions are about what the script actually sees rather than about the
// escape sequence used to get there.
function evaluateJsString(encoded: string): unknown {
  return new Function(`return '${encoded}';`)();
}

function evaluateJsLiteral(encoded: string): unknown {
  return new Function(`return ${encoded};`)();
}

const HOSTILE = "</script><script>alert(1)</script>'\"\\\r\n\u2028\u2029&<>";

describe("inlineJsString", () => {
  it.each([
    "octo/app",
    "feature/x",
    "main",
    "radius-deploy-octo-app",
    "azure",
    "prod-1",
    "release_2.0",
    ""
  ])("leaves the ordinary value %s untouched", (value) => {
    expect(inlineJsString(value)).toBe(value);
  });

  it("round-trips a hostile value through the emitted literal unchanged", () => {
    expect(evaluateJsString(inlineJsString(HOSTILE))).toBe(HOSTILE);
  });

  it("cannot close the enclosing script element", () => {
    const encoded = inlineJsString("</script><script>alert(1)</script>");
    expect(encoded).not.toContain("</script");
    expect(encoded).not.toContain("<");
    expect(evaluateJsString(encoded)).toBe(
      "</script><script>alert(1)</script>"
    );
  });

  it("cannot open an HTML comment that would swallow the rest of the script", () => {
    const encoded = inlineJsString("<!--");
    expect(encoded).not.toContain("<!--");
    expect(evaluateJsString(encoded)).toBe("<!--");
  });

  it.each([
    ["backslash", "a\\b"],
    ["single quote", "it's"],
    ["double quote", 'say "hi"'],
    ["newline", "line1\nline2"],
    ["carriage return", "line1\r\nline2"],
    ["tab", "a\tb"],
    ["ampersand", "a&b"],
    ["null byte", "a\u0000b"],
    ["line separator", "a\u2028b"],
    ["paragraph separator", "a\u2029b"]
  ])(
    "keeps the literal parseable for a value containing a %s",
    (_name, value) => {
      const encoded = inlineJsString(value);
      expect(encoded).not.toMatch(/(^|[^\\])'/);
      expect(encoded).not.toMatch(/[\n\r\u2028\u2029]/);
      expect(evaluateJsString(encoded)).toBe(value);
    }
  );

  it("treats a missing value as the empty string", () => {
    expect(inlineJsString(undefined)).toBe("");
    expect(inlineJsString(null)).toBe("");
  });

  it("stringifies a non-string value rather than emitting a broken literal", () => {
    expect(inlineJsString(42)).toBe("42");
    expect(inlineJsString(false)).toBe("false");
  });

  it("is not HTML escaping", () => {
    // HTML entities are meaningless inside a JavaScript string: escaping this
    // way would change the value the client compares against.
    expect(inlineJsString("a&b")).not.toContain("&amp;");
    expect(evaluateJsString(inlineJsString("a&b"))).toBe("a&b");
  });
});

describe("inlineJson", () => {
  it.each([
    [{ id: "app/web", name: "web", connections: [] }],
    [["main", "feature/x"]],
    [{ nested: { count: 2, flag: true, missing: null } }],
    [""],
    ["main"]
  ])("matches JSON.stringify for safe value %#", (value) => {
    expect(inlineJson(value)).toBe(JSON.stringify(value));
  });

  it("round-trips hostile resource state through the emitted literal", () => {
    const resources = [{ id: HOSTILE, name: HOSTILE, connections: [] }];
    const encoded = inlineJson(resources);
    expect(encoded).not.toContain("</script");
    expect(encoded).not.toContain("<");
    expect(evaluateJsLiteral(encoded)).toEqual(resources);
  });

  it("escapes the JavaScript line terminators JSON leaves raw", () => {
    const encoded = inlineJson({ text: "a\u2028b\u2029c" });
    expect(encoded).not.toMatch(/[\u2028\u2029]/);
    expect(evaluateJsLiteral(encoded)).toEqual({ text: "a\u2028b\u2029c" });
  });

  it("emits a parseable literal for a value JSON cannot represent", () => {
    expect(inlineJson(undefined)).toBe("null");
    expect(evaluateJsLiteral(inlineJson(undefined))).toBeNull();
  });
});

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
