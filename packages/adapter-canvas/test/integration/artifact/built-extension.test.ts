import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  runArtifactSmoke,
  type ArtifactSmokeResult,
  type ArtifactRegistrationSnapshot
} from "../../support/artifact/harness.js";
import {
  BROWSER_ENTRY_NAMES,
  compileBrowserEntry,
  compileBrowserStyle
} from "../../../src/browser/build.js";
import { browserEntryMarker } from "../../../src/browser/scripts.js";

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
  let smoke: ArtifactSmokeResult;

  beforeAll(async () => {
    assertCurrentArtifact();
    smoke = await runArtifactSmoke(ARTIFACT);
  }, 30_000);

  it("registers the retained SDK surface exactly once and shuts down cleanly", () => {
    expect(smoke.registration).toEqual(EXPECTED_REGISTRATION);
    expect(smoke.closeCount).toBe(1);
    // `extension.ts` deliberately swallows uncaughtException/unhandledRejection
    // and reports them only on stderr. The harness already requires exit code 0;
    // here we require graceful shutdown and reject crash-shaped diagnostics
    // without coupling ART to unrelated benign startup warnings.
    const stderrLines = smoke.stderr
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
  });

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
        // The page renderers are owned by focused modules under src/pages/.
        expect.stringMatching(
          /packages\/adapter-canvas\/src\/pages\/shell\.ts$/
        ),
        expect.stringMatching(
          /packages\/adapter-canvas\/src\/pages\/environment-page\.ts$/
        ),
        expect.stringMatching(
          /packages\/adapter-canvas\/src\/browser\/scripts\.ts$/
        ),
        expect.stringMatching(/packages\/adapter-canvas\/src\/skill\.ts$/)
      ])
    );
    expect(
      normalizedSources.some(
        (source) => source.includes("/skills/") && source.endsWith(".md")
      )
    ).toBe(false);
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
    expect(bundle).not.toContain("unpkg.com");
    expect(bundle).not.toContain("fetchVendorScript");
    expect(bundle).not.toContain("vendorCache");
    expect(bundle).not.toContain("readVendorAssets");
    expect(bundle).not.toContain("react/umd/react.production.min.js");
    expect(normalizedSources).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/packages\/adapter-canvas\/src\/client\.ts$/)
      ])
    );

    expect(
      readdirSync(DIST)
        .filter((name) => name.endsWith(".mjs"))
        .sort()
    ).toEqual(["extension.mjs"]);
    const packagedPaths = [
      "package.json",
      "plugin.json",
      "README.md",
      "THIRD-PARTY-NOTICES.txt",
      "skills/radius-app-bicep/SKILL.md",
      "skills/radius-app-bicep/references/custom-resource-types.md",
      "skills/radius-app-bicep/scripts/show-radius-type.mjs",
      "skills/radius-app-graph/references/source-code-references.md"
    ];
    if (existsSync(SOURCE_CHANGELOG)) packagedPaths.push("CHANGELOG.md");
    for (const packagedPath of packagedPaths) {
      expect(existsSync(join(DIST, ...packagedPath.split("/")))).toBe(true);
    }
    const radiusTypeResolver = readFileSync(
      join(
        DIST,
        "skills",
        "radius-app-bicep",
        "scripts",
        "show-radius-type.mjs"
      ),
      "utf8"
    );
    expect(radiusTypeResolver).not.toContain("@radius-project/adapter-shared");
    expect(radiusTypeResolver).not.toContain("packages/adapter-shared");
    expect(radiusTypeResolver).toContain("Managed Radius version query");
    // The installed plugin has no workspace packages beside it, so every
    // surviving import must be a Node builtin or the script fails at runtime.
    const specifiers = [
      ...radiusTypeResolver.matchAll(/\bfrom\s*"([^"]+)"/gu)
    ].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^node:/u);
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
    // plugin.json is the manifest the host reads, so a published build must not
    // advertise a different version from the package it ships.
    expect(builtPlugin.version).toBe(builtPackage.version);
    expect(readFileSync(join(DIST, "README.md"), "utf8")).toBe(
      readFileSync(join(REPO_ROOT, "plugins", "radius", "README.md"), "utf8")
    );
    for (const sourceSkill of filesUnder(
      join(REPO_ROOT, "plugins", "radius", "skills")
    )) {
      const relative = sourceSkill.slice(
        join(REPO_ROOT, "plugins", "radius").length + 1
      );
      if (
        relative.replaceAll("\\", "/") ===
        "skills/radius-app-bicep/scripts/show-radius-type.mjs"
      ) {
        continue;
      }
      expect(readFileSync(join(DIST, relative), "utf8")).toBe(
        readFileSync(sourceSkill, "utf8")
      );
    }
    const notices = readFileSync(join(DIST, "THIRD-PARTY-NOTICES.txt"), "utf8");
    for (const marker of [
      "===== react@19.2.8 =====",
      "===== react-dom@19.2.8 =====",
      "===== reactflow@11.11.4 =====",
      "===== dagre@0.8.5 =====",
      "===== @reactflow/core@11.11.4 =====",
      "===== graphlib@2.1.8 =====",
      "===== lodash@4.18.1 ====="
    ]) {
      expect(notices).toContain(marker);
    }
  });

  it("packages each page module exactly once", () => {
    assertCurrentArtifact();
    const bundle = readFileSync(ARTIFACT, "utf8");
    const sourceMap = JSON.parse(readFileSync(SOURCE_MAP, "utf8")) as {
      sources: string[];
    };
    const normalizedSources = sourceMap.sources.map((source) =>
      source.replaceAll("\\", "/")
    );
    const pageModules = [
      "pages/browser-state-ids.ts",
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
      "pages/deploying-page.ts"
    ];
    for (const pageModule of pageModules) {
      expect(
        normalizedSources.filter((source) =>
          source.endsWith(`packages/adapter-canvas/src/${pageModule}`)
        ),
        pageModule
      ).toHaveLength(1);
    }

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

  it("embeds compiled browser entries and ships no compiler or runtime asset", () => {
    assertCurrentArtifact();
    const bundle = readFileSync(ARTIFACT, "utf8");
    const sourceMap = JSON.parse(readFileSync(SOURCE_MAP, "utf8")) as {
      sources: string[];
    };
    const normalizedSources = sourceMap.sources.map((source) =>
      source.replaceAll("\\", "/")
    );
    const browserSources = normalizedSources.filter((source) =>
      source.includes("packages/adapter-canvas/src/browser/")
    );

    expect(BROWSER_ENTRY_NAMES).toEqual([
      "graph",
      "delete-dialog",
      "pane-navigation",
      "heartbeat",
      "operation-chip",
      "graph-chip",
      "deploy-result-page",
      "environment-page",
      "deploying-page",
      "graph-page",
      "planned-graph-page",
      "graph-diff-page",
      "deployed-graph-page"
    ]);
    expect(
      normalizedSources.some((source) =>
        /\/pages\/(?:environment|deploying)\/client-/.test(source)
      )
    ).toBe(false);
    expect(browserSources).toHaveLength(2);
    expect(browserSources).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /packages\/adapter-canvas\/src\/browser\/generated\.ts$/
        ),
        expect.stringMatching(
          /packages\/adapter-canvas\/src\/browser\/scripts\.ts$/
        )
      ])
    );
    for (const source of [
      "browser/build.ts",
      "browser/context.ts",
      "browser/heartbeat.ts",
      "browser/registry.ts",
      "browser/entries/heartbeat.ts"
    ]) {
      expect(
        normalizedSources.filter((entry) =>
          entry.endsWith(`packages/adapter-canvas/src/${source}`)
        ),
        source
      ).toHaveLength(0);
    }

    expect(bundle).not.toMatch(/from\s*["']esbuild["']/);
    expect(bundle).not.toMatch(/require\(\s*["']esbuild["']\s*\)/);
    expect(bundle.split("Radius heartbeat recovery failed.").length - 1).toBe(
      1
    );
    expect(bundle.split("// radius:browser-entry").length - 1).toBe(1);
    expect(bundle).not.toMatch(/["'][^"']*\/browser\/entries\/[^"']*\.js["']/);

    const marker = browserEntryMarker("heartbeat");
    const expectedTag = `<script>\n${marker}\n${compileBrowserEntry(
      "heartbeat"
    )}\n</script>`;
    expect(smoke.renderedPage.split(marker)).toHaveLength(2);
    expect(smoke.renderedPage).toContain(expectedTag);
    for (const name of ["graph", "graph-chip"] as const) {
      const entryMarker = browserEntryMarker(name);
      expect(smoke.renderedPage.split(`\n${entryMarker}\n`)).toHaveLength(2);
      expect(smoke.renderedPage).toContain(
        `<script>\n${entryMarker}\n${compileBrowserEntry(name)}\n</script>`
      );
    }
    expect(smoke.renderedPage).not.toMatch(/<script[^>]+src=/);
  });

  it("renders the native esbuild graph bundle and stylesheet exactly once under blocked network", () => {
    assertCurrentArtifact();
    const script = compileBrowserEntry("graph");
    const style = compileBrowserStyle("graph");
    expect(style).toContain(".react-flow");
    expect(smoke.renderedPage.split(script)).toHaveLength(2);
    expect(smoke.renderedPage.split(style)).toHaveLength(2);
    expect(smoke.renderedPage.indexOf(style)).toBeLessThan(
      smoke.renderedPage.indexOf("--rad-brand: #da4c2a;")
    );
  });

  it("installs the third-party notices beside the local extension", () => {
    const installDir = mkdtempSync(join(tmpdir(), "radius-canvas-install-"));
    const installPath = join(installDir, "extension.mjs");
    try {
      execFileSync(process.execPath, ["build.mjs", "--install"], {
        cwd: join(REPO_ROOT, "packages", "adapter-canvas"),
        env: {
          ...process.env,
          RADIUS_CANVAS_INSTALL_PATH: installPath
        },
        stdio: "pipe"
      });

      expect(
        readFileSync(join(installDir, "THIRD-PARTY-NOTICES.txt"), "utf8")
      ).toBe(readFileSync(join(DIST, "THIRD-PARTY-NOTICES.txt"), "utf8"));
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  it("installs every skill file, not just the scripts", () => {
    const installDir = mkdtempSync(join(tmpdir(), "radius-canvas-install-"));
    const installPath = join(installDir, "extension.mjs");
    try {
      // Seed a file that no longer exists upstream. A merging copy would leave
      // it behind for the agent to read.
      const staleDir = join(installDir, "skills", "radius-app-graph");
      mkdirSync(staleDir, { recursive: true });
      writeFileSync(join(staleDir, "REMOVED.md"), "stale", "utf8");

      execFileSync(process.execPath, ["build.mjs", "--install"], {
        cwd: join(REPO_ROOT, "packages", "adapter-canvas"),
        env: { ...process.env, RADIUS_CANVAS_INSTALL_PATH: installPath },
        stdio: "pipe"
      });

      // SKILL.md and its references are the instructions the agent follows, so
      // an install that refreshes only the bundle runs stale guidance against a
      // fresh extension.
      const skillsRoot = join(DIST, "skills");
      const skillFiles = filesUnder(skillsRoot);
      expect(skillFiles.some((path) => path.endsWith("SKILL.md"))).toBe(true);
      for (const source of skillFiles) {
        const relative = source.slice(skillsRoot.length + 1);
        const installed = join(installDir, "skills", relative);
        expect(existsSync(installed)).toBe(true);
        expect(readFileSync(installed, "utf8")).toBe(
          readFileSync(source, "utf8")
        );
      }
      expect(existsSync(join(staleDir, "REMOVED.md"))).toBe(false);
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });
});
