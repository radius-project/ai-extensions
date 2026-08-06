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

// plugins/radius/package.json ships to users without pnpm-workspace.yaml, so it
// cannot use "catalog:" and the two versions can silently drift apart.
describe("@github/copilot-sdk version pin", () => {
  it("declares the SDK in the workspace catalog", () => {
    expect(catalogVersion).toBeDefined();
  });

  it("pins an exact version rather than a floating range", () => {
    expect(catalogVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("pins the plugin manifest to the same version as the catalog", () => {
    expect(pluginManifest.dependencies?.[SDK]).toBe(catalogVersion);
  });

  it("resolves the canvas build's copy through the catalog", () => {
    expect(canvasManifest.devDependencies?.[SDK]).toBe("catalog:");
  });

  it("keeps the SDK external so the bundle uses the plugin's installed copy", () => {
    expect(buildScript).toMatch(
      /external:\s*\[[^\]]*"@github\/copilot-sdk"[^\]]*\]/
    );
  });
});
