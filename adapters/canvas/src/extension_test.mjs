import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./extension.mjs", import.meta.url),
  "utf8"
);
const serverSource = readFileSync(
  new URL("./server.mjs", import.meta.url),
  "utf8"
);

describe("render_graph action", () => {
  it("marks successful empty graphs as loaded", () => {
    const handler = source.match(
      /name: "render_graph",[\s\S]*?name: "render_graph_diff"/
    )?.[0];
    expect(handler).toContain("entry.state.graphLoaded = true");
    expect(handler).toMatch(
      /filterGraphVisualizationResources\(\s*ctx\.input\.resources\s*\)/
    );
  });
});

describe("default canvas page", () => {
  // The default's value and its graph-page invariant are asserted behaviorally in
  // hooks_test.mjs against the real export. These only pin the wiring, which
  // can't be reached at runtime: extension.mjs runs joinSession() at import time
  // and server.mjs's page router is not exported.
  it("resolves both the canvas open handler and the HTTP page router from the shared default", () => {
    expect(source).toContain(
      "const page = ctx.input?.page || DEFAULT_CANVAS_PAGE"
    );
    expect(serverSource).toContain(
      "requestedPage || entry?.page || DEFAULT_CANVAS_PAGE"
    );
  });

  it("sources the default from hooks.mjs so the page vocabulary has a single owner", () => {
    expect(source).toMatch(
      /import \{[^}]*DEFAULT_CANVAS_PAGE[^}]*\} from "\.\/hooks\.mjs"/
    );
    expect(serverSource).toMatch(
      /import \{[^}]*DEFAULT_CANVAS_PAGE[^}]*\} from "\.\/hooks\.mjs"/
    );
  });
});

describe("automatic graph diff", () => {
  it("only records errors for the current diff request", () => {
    expect(source).toMatch(
      /isCurrentSourceRefToken\(\s*entry\.state,\s*"diff",\s*sourceRefContext\.token\s*\)/
    );
  });
});
