import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runArtifactSmoke } from "../../support/artifact/harness.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../../..");
const DIST = join(REPO_ROOT, "plugins", "radius", "dist");
const ARTIFACT = join(DIST, "extension.mjs");
const SOURCE_MAP = `${ARTIFACT}.map`;

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry: Dirent) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

function assertCurrentArtifact(): void {
  if (!existsSync(ARTIFACT) || !existsSync(SOURCE_MAP)) {
    throw new Error(
      "Built Radius artifact is missing. Run `pnpm run build` before `pnpm run test:integration:artifact`."
    );
  }
  const productionInputs = [
    join(REPO_ROOT, ".node-version"),
    join(REPO_ROOT, "package.json"),
    join(REPO_ROOT, "pnpm-lock.yaml"),
    join(REPO_ROOT, "pnpm-workspace.yaml"),
    join(REPO_ROOT, "packages", "adapter-canvas", "build.mjs"),
    join(REPO_ROOT, "packages", "adapter-canvas", "package.json"),
    join(REPO_ROOT, "packages", "adapter-shared", "package.json"),
    join(REPO_ROOT, "packages", "core", "package.json"),
    ...filesUnder(join(REPO_ROOT, "packages", "adapter-canvas", "src")).filter(
      (path) => !path.endsWith(".test.ts")
    ),
    ...filesUnder(join(REPO_ROOT, "packages", "adapter-shared", "src")).filter(
      (path) => !path.endsWith(".test.ts")
    ),
    ...filesUnder(join(REPO_ROOT, "packages", "core", "src")).filter(
      (path) => !path.endsWith(".test.ts")
    ),
    join(REPO_ROOT, "plugins", "radius", "package.json"),
    join(REPO_ROOT, "plugins", "radius", "plugin.json"),
    join(REPO_ROOT, "plugins", "radius", "README.md"),
    ...filesUnder(join(REPO_ROOT, "plugins", "radius", "skills"))
  ];
  const newestInput = Math.max(
    ...productionInputs.map((path) => statSync(path).mtimeMs)
  );
  if (
    statSync(ARTIFACT).mtimeMs < newestInput ||
    statSync(SOURCE_MAP).mtimeMs < newestInput
  ) {
    throw new Error(
      "Built Radius artifact is stale. Run `pnpm run build` immediately before the artifact smoke suite."
    );
  }
}

describe("P0-C built Radius extension artifact", () => {
  it("registers the retained SDK surface exactly once and shuts down cleanly", async () => {
    assertCurrentArtifact();
    const result = await runArtifactSmoke(ARTIFACT);

    expect(result.registration).toMatchObject({
      joinCount: 1,
      canvas: {
        id: "radius",
        displayName: "Radius",
        description:
          "Application modeling and deployment: configure cloud credentials, generate app.bicep, visualize application graphs, view PR diffs, and create deployment environments.",
        hasOpen: true,
        hasOnClose: true,
        actionNames: [
          "configure_oidc",
          "render_graph",
          "render_graph_diff",
          "create_environment",
          "get_graph_resources",
          "update_source_refs"
        ]
      },
      hooks: ["onPreToolUse", "onSessionStart"],
      bundledSkill: {
        hasSkill: true,
        hasCustomTypes: true,
        hasSourceReferences: true
      }
    });
    expect(result.registration.tools.map(({ name }) => name)).toEqual([
      "radius_configure_oidc",
      "radius_generate_app",
      "radius_render_graph",
      "radius_render_graph_diff",
      "radius_generate_pr_diff_markdown",
      "radius_create_environment",
      "radius_publish_custom_type_extension",
      "radius_publish_recipe",
      "radius_deploy",
      "radius_deploy_status"
    ]);
    expect(result.closeCount).toBe(1);
  }, 30_000);

  it("keeps the SDK external and packages production modules and skill assets only", () => {
    assertCurrentArtifact();
    const bundle = readFileSync(ARTIFACT, "utf8");
    const sourceMap = JSON.parse(readFileSync(SOURCE_MAP, "utf8")) as {
      sources: string[];
    };
    const normalizedSources = sourceMap.sources.map((source) =>
      source.replaceAll("\\", "/")
    );

    expect(bundle).toMatch(/from\s*["']@github\/copilot-sdk\/extension["']/);
    expect(normalizedSources).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /packages\/adapter-canvas\/src\/runtime\/bootstrap\.ts$/
        ),
        expect.stringMatching(/packages\/adapter-canvas\/src\/server\.ts$/),
        expect.stringMatching(/packages\/adapter-canvas\/src\/pages\.ts$/),
        expect.stringMatching(/packages\/adapter-canvas\/src\/client\.ts$/),
        expect.stringMatching(/packages\/adapter-canvas\/src\/skill\.ts$/),
        expect.stringMatching(/skills\/radius-app-bicep\/SKILL\.md$/),
        expect.stringMatching(
          /skills\/radius-app-bicep\/references\/custom-resource-types\.md$/
        ),
        expect.stringMatching(
          /skills\/radius-app-graph\/references\/source-code-references\.md$/
        )
      ])
    );
    expect(
      normalizedSources.some(
        (source) =>
          source.includes("/test/") ||
          source.endsWith(".test.ts") ||
          source.includes("node_modules/vitest")
      )
    ).toBe(false);
    expect(bundle).not.toContain("packages/adapter-canvas/test/support");

    expect(
      readdirSync(DIST)
        .filter((name) => name.endsWith(".mjs"))
        .sort()
    ).toEqual(["extension.mjs"]);
    for (const packagedPath of [
      "package.json",
      "plugin.json",
      "README.md",
      "skills/radius-app-bicep/SKILL.md",
      "skills/radius-app-bicep/references/custom-resource-types.md",
      "skills/radius-app-graph/references/source-code-references.md"
    ]) {
      expect(existsSync(join(DIST, ...packagedPath.split("/")))).toBe(true);
    }
    expect(readFileSync(join(DIST, "package.json"), "utf8")).not.toContain(
      "catalog:"
    );
    const sourcePlugin = JSON.parse(
      readFileSync(join(REPO_ROOT, "plugins", "radius", "plugin.json"), "utf8")
    ) as Record<string, unknown>;
    const builtPlugin = JSON.parse(
      readFileSync(join(DIST, "plugin.json"), "utf8")
    ) as Record<string, unknown>;
    expect({ ...builtPlugin, version: sourcePlugin.version }).toEqual(
      sourcePlugin
    );
    expect(builtPlugin.version).toEqual(expect.any(String));
    expect(readFileSync(join(DIST, "README.md"), "utf8")).toBe(
      readFileSync(join(REPO_ROOT, "plugins", "radius", "README.md"), "utf8")
    );
    for (const sourceSkill of filesUnder(
      join(REPO_ROOT, "plugins", "radius", "skills")
    )) {
      const relative = sourceSkill.slice(
        join(REPO_ROOT, "plugins", "radius").length + 1
      );
      expect(readFileSync(join(DIST, relative), "utf8")).toBe(
        readFileSync(sourceSkill, "utf8")
      );
    }
  });
});
