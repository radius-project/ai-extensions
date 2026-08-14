// Shared expectations for the injection shapes every page renderer must
// survive. Test-support only: production modules never import this.
import { expect } from "vitest";

// One payload covering the shapes that matter for a server-rendered page with
// inline scripts: script-tag closure, both quote characters, a backslash,
// CR/LF, the JavaScript-only line terminators, and the HTML metacharacters.
export const HOSTILE_STATE =
  "</script><script>alert(1)</script>'\"\\\r\n\u2028\u2029&<>";

export function inlineScriptSources(html: string): string[] {
  return (html.match(/<script>[\s\S]*?<\/script>/g) || []).map((block) =>
    block.slice("<script>".length, -"</script>".length)
  );
}

// Page state must never end the script element early or break the script it is
// embedded in: every closing tag has to belong to a block the parser paired,
// and every block has to parse.
export function expectSafeInlineScripts(html: string): void {
  const sources = inlineScriptSources(html);
  expect(sources.length).toBeGreaterThan(0);
  expect(sources).toHaveLength(html.split("</script>").length - 1);
  expect(html).not.toContain("</script><script>alert(1)");
  for (const source of sources) {
    expect(() => new Function(source)).not.toThrow();
  }
}

// Read back a `var NAME = <literal>;` the renderer emitted, as the browser
// would evaluate it.
export function readEmittedValue(html: string, name: string): unknown {
  const match = html.match(new RegExp(`var ${name} = (.*);\\n`));
  expect(match, `${name} is not emitted`).toBeTruthy();
  return new Function(`return ${match?.[1]};`)();
}
