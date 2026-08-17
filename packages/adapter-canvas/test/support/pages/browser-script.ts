// Shared support for exercising the browser functions a page renderer emits.
// The scripts live inside the rendered HTML, so a test compiles the function it
// cares about with fake DOM, network and timer ports. Test-support only:
// production modules never import this.
import { expect } from "vitest";

// Pull one top-level `function name(...) { ... }` out of a rendered page by
// brace matching, so a harness compiles exactly that function.
export function extractBrowserFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

export interface FakeStatus {
  className: string;
  innerHTML: string;
  textContent: string;
  style: { display: string };
}

export interface FetchCall {
  url: string;
  body: unknown;
}

export function createFakeStatus(): FakeStatus {
  return {
    className: "",
    innerHTML: "",
    textContent: "",
    style: { display: "none" }
  };
}
