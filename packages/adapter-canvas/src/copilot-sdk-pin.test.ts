import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SDK = "@github/copilot-sdk";
const repoRoot = new URL("../../../", import.meta.url);

const workspaceYaml = readFileSync(
  new URL("pnpm-workspace.yaml", repoRoot),
  "utf8"
);
const pluginManifest = JSON.parse(
  readFileSync(new URL("extensions/radius/package.json", repoRoot), "utf8")
) as { dependencies?: Record<string, string> };
const canvasManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { devDependencies?: Record<string, string> };
const buildScript = readFileSync(
  new URL("../build.mjs", import.meta.url),
  "utf8"
);

const catalogVersion = workspaceYaml.match(
  /^\s*"@github\/copilot-sdk":\s*(\S+)\s*$/m
)?.[1];

// The plugin manifest ships to users without pnpm-workspace.yaml, so "catalog:"
// is meaningless once installed. The catalog stays the single source of truth
// and build.mjs bakes the real version into dist/package.json when assembling.
describe("@github/copilot-sdk version pin", () => {
  it("declares the SDK in the workspace catalog", () => {
    expect(catalogVersion).toBeDefined();
  });

  it("pins an exact version rather than a floating range", () => {
    expect(catalogVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("sources the plugin manifest's version from the catalog", () => {
    expect(pluginManifest.dependencies?.[SDK]).toBe("catalog:");
  });

  it("resolves the canvas build's copy through the catalog", () => {
    expect(canvasManifest.devDependencies?.[SDK]).toBe("catalog:");
  });

  it("resolves catalog specifiers when assembling the shipped manifest", () => {
    expect(buildScript).toContain("resolveCatalogSpecifiers");
    expect(buildScript).toMatch(/"catalog:"/);
  });

  it("keeps the SDK external so the bundle uses the plugin's installed copy", () => {
    expect(buildScript).toMatch(
      /external:\s*\[[^\]]*"@github\/copilot-sdk"[^\]]*\]/
    );
  });

  // The handoff turns rely on MessageOptions.displayPrompt to keep an internal
  // repair prompt from rendering as a message the user appears to have typed
  // (#209). A pin that predates the field would silently restore that bug, so
  // assert it against the installed types rather than trusting the version.
  it("resolves to an SDK whose MessageOptions supports displayPrompt", () => {
    // Resolve the installed package root from its entry point rather than a
    // hardcoded node_modules path, so pnpm's virtual store layout doesn't
    // matter. The entry sits under dist/ (ESM) or dist/cjs/ (CJS).
    const entry = createRequire(import.meta.url).resolve("@github/copilot-sdk");
    const packageRoot = entry.slice(
      0,
      entry.lastIndexOf(`${sep}dist${sep}`) + 1
    );
    const messageOptions = readFileSync(
      join(packageRoot, "dist", "types.d.ts"),
      "utf8"
    ).match(/export interface MessageOptions \{[\s\S]*?\n\}/)?.[0];
    expect(messageOptions).toBeDefined();
    expect(messageOptions).toMatch(/displayPrompt\?:\s*string/);
  });
});
