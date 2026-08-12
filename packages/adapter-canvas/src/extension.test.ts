import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./extension.ts", import.meta.url), "utf8");

// RU-20: this file (the esbuild composition root) is the ONLY place that may
// call joinSession, and it must do so exactly once. Everything else — the
// canvas/tools/hooks construction — is delegated to createRadiusExtension, so
// this file is a thin dependency-wiring + process-lifecycle shell with no
// inline action/tool declarations of its own.
describe("RU-20: extension.ts is a thin joinSession composition root", () => {
  it("calls joinSession exactly once", () => {
    const matches = source.match(/joinSession\s*\(/g) || [];
    expect(matches).toHaveLength(1);
  });

  it("imports the testable runtime bootstrap seam", () => {
    expect(source).toMatch(
      /import \{ bootstrapRadiusExtension \} from ["']\.\/runtime\/bootstrap\.js["']/
    );
  });

  it("invokes the runtime bootstrap exactly once", () => {
    const matches = source.match(/bootstrapRadiusExtension\(/g) || [];
    expect(matches).toHaveLength(1);
  });

  it("does not inline any of the 6 action or 10 tool declarations (they live in runtime/declarations.ts)", () => {
    expect(source).not.toContain('name: "render_graph"');
    expect(source).not.toContain('name: "radius_deploy"');
  });

  it("does not import the canvas/tools factories directly (only the composed extension factory)", () => {
    expect(source).not.toMatch(
      /from ["']\.\/runtime\/create-radius-canvas\.js["']/
    );
    expect(source).not.toMatch(
      /from ["']\.\/runtime\/create-radius-tools\.js["']/
    );
  });
});
