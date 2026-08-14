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
import {
  runArtifactSmoke,
  type ArtifactRegistrationSnapshot
} from "../../support/artifact/harness.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../../..");
const DIST = join(REPO_ROOT, "plugins", "radius", "dist");
const ARTIFACT = join(DIST, "extension.mjs");
const SOURCE_MAP = `${ARTIFACT}.map`;
const SOURCE_CHANGELOG = join(REPO_ROOT, "plugins", "radius", "CHANGELOG.md");
// Independent reviewed oracle: unlike importing the live declaration builders,
// this fixture changes only when a contract update is deliberately accepted.
const EXPECTED_REGISTRATION = JSON.parse(
  readFileSync(
    new URL("../../fixtures/artifact-registration.json", import.meta.url),
    "utf8"
  )
) as ArtifactRegistrationSnapshot;

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
    ...(existsSync(SOURCE_CHANGELOG) ? [SOURCE_CHANGELOG] : []),
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

    expect(result.registration).toEqual(EXPECTED_REGISTRATION);
    expect(result.closeCount).toBe(1);
    // `extension.ts` deliberately swallows uncaughtException/unhandledRejection
    // and reports them only on stderr. The harness already requires exit code 0;
    // here we require graceful shutdown and reject crash-shaped diagnostics
    // without coupling ART to unrelated benign startup warnings.
    const stderrLines = result.stderr
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "");
    expect(stderrLines).toContain(
      "[radius] received SIGTERM; shutting down 0 canvas server(s)..."
    );
    expect(stderrLines).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /uncaughtException|unhandledRejection|ECONNREFUSED|(?:^|\s)Error:/i
        )
      ])
    );
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
        // The page renderers are owned by src/pages/; src/pages.ts is only a
        // behaviour-free re-export facade, so the bundler forwards through it.
        expect.stringMatching(
          /packages\/adapter-canvas\/src\/pages\/shell\.ts$/
        ),
        expect.stringMatching(
          /packages\/adapter-canvas\/src\/pages\/environment-page\.ts$/
        ),
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
    expect(bundle).not.toContain("RADIUS_CANVAS_TEST_SKIP_VENDOR_PREFETCH");

    expect(
      readdirSync(DIST)
        .filter((name) => name.endsWith(".mjs"))
        .sort()
    ).toEqual(["extension.mjs"]);
    const packagedPaths = [
      "package.json",
      "plugin.json",
      "README.md",
      "skills/radius-app-bicep/SKILL.md",
      "skills/radius-app-bicep/references/custom-resource-types.md",
      "skills/radius-app-graph/references/source-code-references.md"
    ];
    if (existsSync(SOURCE_CHANGELOG)) packagedPaths.push("CHANGELOG.md");
    for (const packagedPath of packagedPaths) {
      expect(existsSync(join(DIST, ...packagedPath.split("/")))).toBe(true);
    }
    if (existsSync(SOURCE_CHANGELOG)) {
      expect(readFileSync(join(DIST, "CHANGELOG.md"), "utf8")).toBe(
        readFileSync(SOURCE_CHANGELOG, "utf8")
      );
    } else {
      expect(existsSync(join(DIST, "CHANGELOG.md"))).toBe(false);
    }

    const sourcePackage = JSON.parse(
      readFileSync(join(REPO_ROOT, "plugins", "radius", "package.json"), "utf8")
    ) as Record<string, unknown>;
    const builtPackage = JSON.parse(
      readFileSync(join(DIST, "package.json"), "utf8")
    ) as Record<string, unknown>;
    const workspace = readFileSync(
      join(REPO_ROOT, "pnpm-workspace.yaml"),
      "utf8"
    );
    const catalogBlock =
      workspace.match(/^catalog:\n((?:[ \t]+.*\n|\n)*)/m)?.[1] ?? "";
    const catalog = Object.fromEntries(
      catalogBlock.split("\n").flatMap((line) => {
        if (line.trim().startsWith("#")) return [];
        const entry = line.match(/^\s+"?([^":#\s]+)"?:\s*(\S+)\s*$/);
        return entry ? [[entry[1], entry[2]]] : [];
      })
    );
    const expectedPackage = structuredClone(sourcePackage);
    expectedPackage.version = builtPackage.version;
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies"
    ]) {
      const dependencies = expectedPackage[section];
      if (!dependencies || typeof dependencies !== "object") continue;
      for (const [name, specifier] of Object.entries(
        dependencies as Record<string, unknown>
      )) {
        if (specifier !== "catalog:") continue;
        expect(catalog[name], `${section}.${name}`).toBeTypeOf("string");
        (dependencies as Record<string, unknown>)[name] = catalog[name];
      }
    }
    expect(builtPackage.version).toEqual(expect.any(String));
    expect(builtPackage).toEqual(expectedPackage);

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

  it("packages the extracted page modules behind the forwarding facade exactly once", () => {
    assertCurrentArtifact();
    const bundle = readFileSync(ARTIFACT, "utf8");
    const sourceMap = JSON.parse(readFileSync(SOURCE_MAP, "utf8")) as {
      sources: string[];
    };
    const normalizedSources = sourceMap.sources.map((source) =>
      source.replaceAll("\\", "/")
    );
    const pageModules = [
      "pages/browser-function.ts",
      "pages/encoding.ts",
      "pages/shell-styles.ts",
      "pages/shell.ts",
      "pages/graph-header.ts",
      "pages/graph-page.ts",
      "pages/planned-graph-page.ts",
      "pages/fragments.ts",
      "pages/graph-diff-page.ts",
      "pages/deployed-graph-page.ts",
      "pages/environment-page.ts",
      "pages/environment/environments-pane.ts",
      "pages/environment/credentials-pane.ts",
      "pages/environment/client-environments.ts",
      "pages/environment/client-operations.ts",
      "pages/environment/client-profiles.ts",
      "pages/environment/client-discovery.ts",
      "pages/environment/client-credentials.ts",
      "pages/deploying-page.ts",
      "pages/deploying/client-deployments.ts"
    ];
    for (const pageModule of pageModules) {
      expect(
        normalizedSources.filter((source) =>
          source.endsWith(`packages/adapter-canvas/src/${pageModule}`)
        ),
        pageModule
      ).toHaveLength(1);
    }

    // The compatibility facade holds no behaviour, so the bundler resolves its
    // re-exports to the owning modules and contributes no module of its own.
    // Logic added to src/pages.ts would show up here.
    expect(
      normalizedSources.filter((source) =>
        source.endsWith("packages/adapter-canvas/src/pages.ts")
      )
    ).toHaveLength(0);
    // oidcPage is reachable only through the facade — no route renders it — so
    // the bundler drops it. It stays exported for compatibility and is covered
    // by its collocated unit tests.
    expect(
      normalizedSources.filter((source) =>
        source.endsWith("packages/adapter-canvas/src/pages/oidc-page.ts")
      )
    ).toHaveLength(0);

    // Splitting the renderers must not duplicate page text in the artifact: the
    // shell stylesheet and the fragments shared by several pages stay
    // single-sourced through their owning module.
    for (const marker of [
      'id="graph-diff-subtitle"',
      'id="deploy-delete-modal"',
      "--rad-brand: #da4c2a;"
    ]) {
      expect(bundle.split(marker).length - 1, marker).toBe(1);
    }

    // Page modules are bundled into the single artifact, never imported or
    // fetched at runtime.
    expect(bundle).not.toMatch(/import\(\s*["'][^"']*pages\//);
    expect(bundle).not.toMatch(/from\s*["']\.[^"']*pages[^"']*["']/);
  });
});
