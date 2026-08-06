import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SDK = "@github/copilot-sdk";
const repoRoot = new URL("../../../", import.meta.url);

const workspaceYaml = readFileSync(
  new URL("pnpm-workspace.yaml", repoRoot),
  "utf8"
);
const pluginManifest = JSON.parse(
  readFileSync(new URL("plugins/radius/package.json", repoRoot), "utf8")
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
});
