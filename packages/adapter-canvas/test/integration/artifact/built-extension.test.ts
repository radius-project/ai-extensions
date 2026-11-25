import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  type Dirent
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
import { RADIUS_SESSION_START_CONTEXT } from "../../../src/runtime/declarations.js";
import { createPluginUpdatePreferences } from "../../../src/runtime/plugin-update-preferences.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../../..");
const DIST = join(REPO_ROOT, ".artifacts", "radius");
const ARTIFACT_RELATIVE_PATH =
  "com.github.copilot/extensions/radius/extension.mjs";
const ARTIFACT = join(DIST, ...ARTIFACT_RELATIVE_PATH.split("/"));
const SOURCE_MAP = `${ARTIFACT}.map`;
const SOURCE_CHANGELOG = join(
  REPO_ROOT,
  "extensions",
  "radius",
  "CHANGELOG.md"
);
const SOURCE_PREVIEW = join(
  REPO_ROOT,
  "plugins",
  "radius",
  "assets",
  "preview.png"
);
const SOURCE_SKILLS = join(REPO_ROOT, "extensions", "radius", "skills");
const DIST_SKILLS = join(DIST, "skills");
const STAGE_SKILLS = [
  "radius-app-model",
  "radius-app-plan",
  "radius-app-complete"
] as const;
const SOURCE_REF = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPO_ROOT,
  encoding: "utf8"
}).trim();
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
    // A locally installed nested action package is never part of the artifact.
    if (entry.name === "node_modules") return [];
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

function relativeFilesUnder(root: string): string[] {
  return filesUnder(root)
    .map((filePath) => relative(root, filePath).replaceAll("\\", "/"))
    .sort();
}

function expectMatchingFile(source: string, destination: string): void {
  const expected = readFileSync(source);
  const actual = readFileSync(destination);
  expect(actual.equals(expected), destination).toBe(true);
}

// Resolves a dependency the way the bundler does from `fromRoot` and returns
// the installed package root, so notice expectations follow the lockfile.
function installedPackageRoot(fromRoot: string, name: string): string {
  let directory = dirname(
    createRequire(join(fromRoot, "package.json")).resolve(name)
  );
  for (;;) {
    const manifestPath = join(directory, "package.json");
    if (
      existsSync(manifestPath) &&
      (JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown })
        .name === name
    ) {
      return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Unable to locate the installed ${name} package.`);
    }
    directory = parent;
  }
}

function bundledNoticeMarker(root: string): string {
  const { name, version } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8")
  ) as { name: string; version: string };
  return `===== ${name}@${version} =====`;
}

function prepareBuildWorkspace(
  workspaceRoot: string,
  missingAsset: readonly string[] = []
): string {
  for (const entry of [".node-version", "pnpm-workspace.yaml"]) {
    copyFileSync(join(REPO_ROOT, entry), join(workspaceRoot, entry));
  }

  const sourceAdapter = join(REPO_ROOT, "packages", "adapter-canvas");
  const workspaceAdapter = join(workspaceRoot, "packages", "adapter-canvas");
  mkdirSync(workspaceAdapter, { recursive: true });
  for (const entry of ["build.mjs", "package.json"]) {
    copyFileSync(join(sourceAdapter, entry), join(workspaceAdapter, entry));
  }
  cpSync(join(sourceAdapter, "src"), join(workspaceAdapter, "src"), {
    recursive: true
  });
  symlinkSync(
    join(REPO_ROOT, "node_modules"),
    join(workspaceRoot, "node_modules"),
    "junction"
  );
  symlinkSync(
    join(sourceAdapter, "node_modules"),
    join(workspaceAdapter, "node_modules"),
    "junction"
  );
  for (const packageName of ["adapter-shared", "core", "graph-react"]) {
    symlinkSync(
      join(REPO_ROOT, "packages", packageName),
      join(workspaceRoot, "packages", packageName),
      "junction"
    );
  }
  copyFileSync(join(REPO_ROOT, "LICENSE"), join(workspaceRoot, "LICENSE"));

  const sourcePlugin = join(REPO_ROOT, "plugins", "radius");
  const workspacePlugin = join(workspaceRoot, "plugins", "radius");
  const sourceExtensionDir = join(REPO_ROOT, "extensions", "radius");
  const workspaceExtensionDir = join(workspaceRoot, "extensions", "radius");
  mkdirSync(workspacePlugin, { recursive: true });
  mkdirSync(workspaceExtensionDir, { recursive: true });
  for (const entry of ["plugin.json", "README.md"]) {
    copyFileSync(join(sourcePlugin, entry), join(workspacePlugin, entry));
  }
  copyFileSync(
    join(sourceExtensionDir, "package.json"),
    join(workspaceExtensionDir, "package.json")
  );
  cpSync(
    join(sourceExtensionDir, "skills"),
    join(workspaceExtensionDir, "skills"),
    { recursive: true }
  );
  cpSync(join(sourcePlugin, "assets"), join(workspacePlugin, "assets"), {
    recursive: true
  });
  if (missingAsset.length > 0) {
    rmSync(join(workspaceExtensionDir, "skills", ...missingAsset), {
      recursive: true
    });
  }

  // The complete workflow contract is a required plugin artifact input.
  const sourceExtension = join(REPO_ROOT, ".github", "extension");
  const workspaceExtension = join(workspaceRoot, ".github", "extension");
  cpSync(sourceExtension, workspaceExtension, { recursive: true });

  return workspaceAdapter;
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
    join(REPO_ROOT, "extensions", "radius", "package.json"),
    join(REPO_ROOT, "plugins", "radius", "plugin.json"),
    join(REPO_ROOT, "plugins", "radius", "README.md"),
    ...(existsSync(SOURCE_CHANGELOG) ? [SOURCE_CHANGELOG] : []),
    ...filesUnder(join(REPO_ROOT, "extensions", "radius", "skills")),
    ...filesUnder(join(REPO_ROOT, "plugins", "radius", "assets")),
    ...filesUnder(join(REPO_ROOT, ".github", "extension"))
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

describe("JSONC module compatibility", () => {
  it.each(["playwright.config.ts", "playwright.visual.config.ts"])(
    "loads production sources during native %s discovery",
    (config) => {
      const result = spawnSync(
        process.execPath,
        [
          createRequire(import.meta.url).resolve("@playwright/test/cli"),
          "test",
          "--config",
          join(REPO_ROOT, "packages", "adapter-canvas", config),
          "--list",
          "--reporter=line"
        ],
        { cwd: REPO_ROOT, encoding: "utf8", timeout: 15_000 }
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/Total: [1-9]\d* tests in [1-9]\d* files?/);
    }
  );

  it("stages and compiles JSONC configuration through the production Node bundle", () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "radius-canvas-jsonc-bundle-")
    );
    try {
      const buildDirectory = prepareBuildWorkspace(workspaceRoot);
      writeFileSync(
        join(buildDirectory, "src", "extension.ts"),
        'export { stageGraphArtifacts } from "@radius-project/adapter-shared";\n' +
          'export { writeBicepCompileConfig } from "../../adapter-shared/src/rad.js";\n'
      );
      const built = spawnSync(process.execPath, ["build.mjs"], {
        cwd: buildDirectory,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, RADIUS_SOURCE_REF: SOURCE_REF }
      });
      expect(built.error).toBeUndefined();
      expect(built.status, built.stderr).toBe(0);

      const artifact = pathToFileURL(
        join(workspaceRoot, ".artifacts", "radius", ARTIFACT_RELATIVE_PATH)
      ).href;
      const config = `{
        // Keep repository configuration and trailing commas.
        "extensions": { "radius": "br:registry.example/radius:v1", },
        "analyzers": { "core": { "enabled": false, }, },
      }`;
      const executed = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import assert from "node:assert/strict";
            import fs from "node:fs";
            import path from "node:path";
            import { stageGraphArtifacts, writeBicepCompileConfig } from ${JSON.stringify(artifact)};
            const config = ${JSON.stringify(config)};
            const staged = await stageGraphArtifacts({
              status: "present",
              content: "model",
              source: {
                kind: "github",
                repo: "owner/repository",
                ref: "feature",
                revision: "a".repeat(40),
                definitionPath: ".radius/app.bicep"
              }
            }, {
              readBytes: async () => ({ status: "present", bytes: Buffer.from(config) }),
              stagingRoot: ".",
              redactDiagnostic: (message) => message
            });
            try {
              assert.equal(fs.readFileSync(path.join(staged.dir, "bicepconfig.json"), "utf8"), config);
              const compiled = writeBicepCompileConfig(".", staged.dir);
              assert.equal(compiled.extensions.radius, "br:registry.example/radius:v1");
              assert.deepEqual(compiled.analyzers, { core: { enabled: false } });
              assert.equal(compiled.experimentalFeaturesEnabled.extensibility, true);
            } finally {
              await staged.dispose();
            }
          `
        ],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          timeout: 5_000,
          env: {
            ...process.env,
            HOME: workspaceRoot,
            USERPROFILE: workspaceRoot
          }
        }
      );
      expect(executed.error).toBeUndefined();
      expect(executed.status, executed.stderr).toBe(0);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("P0-C built Radius extension artifact", () => {
  let smoke: ArtifactSmokeResult;

  beforeAll(async () => {
    assertCurrentArtifact();
    smoke = await runArtifactSmoke(ARTIFACT, 20_000, DIST);
  }, 30_000);

  it("wires readiness admission and settlement through the shipped registered setup tool", async () => {
    const result = await runArtifactSmoke(ARTIFACT, 20_000, DIST, "readiness");
    expect(result.readiness).toEqual({
      code: "github-account-stopped",
      calls: ["GET"]
    });
    expect(result.exitCode).toBe(0);
    expect(result.closeCount).toBe(1);
    expect(result.stderr).not.toMatch(
      /unhandledRejection|uncaughtException|shutdown incomplete/
    );
  });

  it.each([
    "readiness-restoration-failed",
    "readiness-external-change"
  ] as const)(
    "runs the composition-root restoration diagnostic exactly once for %s",
    async (behavior) => {
      const result = await runArtifactSmoke(ARTIFACT, 20_000, DIST, behavior);
      expect(result.readiness).toEqual({
        code: "github-account-stopped",
        calls: ["GET"]
      });
      expect(result.closeCount).toBe(1);
      expect(result.exitCode).toBe(
        behavior === "readiness-restoration-failed" ? 1 : 0
      );
      const diagnostics = result.stderr
        .split(/\r?\n/)
        .filter((line) => line.startsWith("[radius readiness]"));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain("original-account");
      expect(result.stderr).not.toContain("fixture-value");
      expect(
        result.stderr.includes(
          "Radius setup drain failed: GitHub account restoration failed"
        )
      ).toBe(behavior === "readiness-restoration-failed");
      expect(result.stderr).not.toMatch(/unhandledRejection|uncaughtException/);
    }
  );
  it.each(["hung-session", "failed-session"] as const)(
    "exits nonzero on incomplete %s teardown despite repeated signals",
    async (behavior) => {
      const failed = await runArtifactSmoke(ARTIFACT, 20_000, DIST, behavior);
      expect(failed.exitCode).toBe(1);
      expect(failed.closeCount).toBe(1);
      expect(failed.stderr).toContain(
        behavior === "hung-session" ?
          "Radius session teardown incomplete after 2000ms"
        : "session teardown error: Controlled session teardown failure"
      );
      expect(failed.stderr).not.toMatch(/unhandledRejection|uncaughtException/);
    }
  );

  it("registers the retained SDK surface exactly once and shuts down cleanly", () => {
    expect(smoke.registration).toEqual(EXPECTED_REGISTRATION);
    expect(smoke.closeCount).toBe(1);
    expect(smoke.pluginUpdateEvents).toEqual([
      {
        stage: "approval",
        detail:
          "Update radius@radius-plugins to the latest version available from this marketplace? Installed changes will load in a new session; this session keeps its current code. After any answer, including cancellation, Radius waits 7 days before asking again for this marketplace."
      },
      { stage: "update", detail: "radius@radius-plugins" }
    ]);
    expect(smoke.exitCode).toBe(0);
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

  it.each(["decline", "unavailable"] as const)(
    "leaves the shipped plugin unchanged when approval is %s",
    async (approval) => {
      const result = await runArtifactSmoke(
        ARTIFACT,
        20_000,
        DIST,
        "clean",
        approval
      );
      expect(result.pluginUpdateEvents.map((event) => event.stage)).toEqual(
        approval === "decline" ? ["approval"] : []
      );
      expect(result.registration).toEqual(EXPECTED_REGISTRATION);
      expect(result.closeCount).toBe(1);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toMatch(
        /unhandledRejection|uncaughtException|shutdown incomplete/
      );
      if (approval === "unavailable") {
        expect(result.stderr).toContain(
          "Radius skipped its plugin update request"
        );
        expect(result.stderr).not.toContain(
          "could not complete its plugin update"
        );
      }
    }
  );

  it.each(["decline", "approve"] as const)(
    "retains the cooldown after %s across processes and workspaces, then expires it",
    async (answer) => {
      const profile = mkdtempSync(join(tmpdir(), "radius-artifact-profile-"));
      try {
        const first = await runArtifactSmoke(
          ARTIFACT,
          20_000,
          DIST,
          "clean",
          answer,
          profile
        );
        expect(first.pluginUpdateEvents.map((event) => event.stage)).toEqual([
          ...(answer === "approve" ? ["approval", "update"] : ["approval"])
        ]);
        expect(first.exitCode).toBe(0);
        const preferences = createPluginUpdatePreferences(
          join(profile, ".copilot", "radius", "plugin-update-responses")
        );
        expect(
          await preferences.lastAnsweredAt("radius-plugins")
        ).toBeGreaterThan(0);
        const next = await runArtifactSmoke(
          ARTIFACT,
          20_000,
          DIST,
          "clean",
          "approve",
          profile
        );
        expect(next.pluginUpdateEvents).toEqual([]);
        expect(next.registration).toEqual(EXPECTED_REGISTRATION);
        expect(next.exitCode).toBe(0);
        expect(next.closeCount).toBe(1);
        await preferences.rememberAnswer(
          "radius-plugins",
          Date.now() - 7 * 24 * 60 * 60 * 1000
        );
        const expired = await runArtifactSmoke(
          ARTIFACT,
          20_000,
          DIST,
          "clean",
          "decline",
          profile
        );
        expect(expired.pluginUpdateEvents.map((event) => event.stage)).toEqual([
          "approval"
        ]);
        expect(expired.exitCode).toBe(0);
        expect(expired.closeCount).toBe(1);
      } finally {
        rmSync(profile, { recursive: true, force: true });
      }
    }
  );
  it("registers flat object tool parameters without provider-rejected root unions", () => {
    for (const tool of smoke.registration.tools) {
      expect(tool.parameters).toMatchObject({
        type: "object",
        properties: expect.any(Object)
      });
      expect(tool.parameters.properties).not.toEqual({});
      for (const keyword of ["oneOf", "anyOf", "allOf", "enum", "not"])
        expect(tool.parameters).not.toHaveProperty(keyword);
    }
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
    expect(bundle).toContain(SOURCE_REF);
    expect(bundle).not.toContain("RADIUS_SOURCE_REF");
    expect(normalizedSources).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/packages\/adapter-canvas\/src\/client\.ts$/)
      ])
    );

    expect(
      readdirSync(DIST)
        .filter((name) => name.endsWith(".mjs"))
        .sort()
    ).toEqual([]);
    const packagedPaths = [
      "package.json",
      "plugin.json",
      "README.md",
      "LICENSE",
      "THIRD-PARTY-NOTICES.txt",
      "assets/preview.png",
      ARTIFACT_RELATIVE_PATH,
      `${ARTIFACT_RELATIVE_PATH}.map`,
      "skills/radius-app-model/SKILL.md",
      "skills/radius-app-model/references/example.bicep",
      "skills/radius-app-model/references/custom-types.md",
      "skills/radius-app-model/scripts/common.mjs",
      "skills/radius-app-model/scripts/model.mjs",
      "skills/radius-app-model/scripts/types.mjs",
      "skills/radius-app-plan/SKILL.md",
      "skills/radius-app-plan/references/custom-recipes.md",
      "skills/radius-app-plan/scripts/common.mjs",
      "skills/radius-app-plan/scripts/plan.mjs",
      "skills/radius-app-complete/SKILL.md",
      "skills/radius-app-complete/references/wiring.md",
      "skills/radius-app-complete/scripts/common.mjs",
      "skills/radius-app-complete/scripts/complete.mjs",
      "skills/radius-app-complete/scripts/recipe.mjs",
      "skills/radius-app-complete/scripts/types.mjs",
      "skills/radius-report-issue/SKILL.md",
      "skills/radius-report-issue/references/bug-report.md"
    ];
    if (existsSync(SOURCE_CHANGELOG)) packagedPaths.push("CHANGELOG.md");
    for (const packagedPath of packagedPaths) {
      expect(
        existsSync(join(DIST, ...packagedPath.split("/"))),
        packagedPath
      ).toBe(true);
    }
    expectMatchingFile(SOURCE_PREVIEW, join(DIST, "assets", "preview.png"));
    // The installed plugin has no workspace packages beside it, so a skill
    // script may import only Node built-ins and the scripts packaged with it.
    const packagedScripts = filesUnder(DIST_SKILLS).filter((path) =>
      path.endsWith(".mjs")
    );
    expect(packagedScripts.length).toBeGreaterThan(0);
    for (const script of packagedScripts) {
      for (const [, specifier] of readFileSync(script, "utf8").matchAll(
        /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/gu
      )) {
        if (specifier.startsWith("node:")) continue;
        expect(specifier, script).toMatch(/^\.\/[\w-]+\.mjs$/u);
        expect(existsSync(join(dirname(script), specifier)), script).toBe(true);
      }
    }
    if (existsSync(SOURCE_CHANGELOG)) {
      expect(readFileSync(join(DIST, "CHANGELOG.md"), "utf8")).toBe(
        readFileSync(SOURCE_CHANGELOG, "utf8")
      );
    } else {
      expect(existsSync(join(DIST, "CHANGELOG.md"))).toBe(false);
    }

    const sourceExtension = join(REPO_ROOT, ".github", "extension");
    const bundledExtension = join(DIST, "workflows");
    expect(relativeFilesUnder(bundledExtension)).toEqual(
      relativeFilesUnder(sourceExtension)
    );
    for (const asset of relativeFilesUnder(sourceExtension)) {
      expectMatchingFile(
        join(sourceExtension, asset),
        join(bundledExtension, asset)
      );
    }

    const sourcePackage = JSON.parse(
      readFileSync(
        join(REPO_ROOT, "extensions", "radius", "package.json"),
        "utf8"
      )
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
    expectedPackage.radiusSourceRef = SOURCE_REF;
    // Repository-only scripts do not ship: the installed plugin cannot run them.
    delete expectedPackage.scripts;
    delete expectedPackage.devDependencies;
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
    const expectedPlugin = structuredClone(sourcePlugin);
    expectedPlugin.version = builtPlugin.version;
    expect(builtPlugin).toEqual(expectedPlugin);
    // plugin.json is the manifest the host reads, so a published build must not
    // advertise a different version from the package it ships.
    expect(builtPlugin.version).toBe(builtPackage.version);
    expect(readFileSync(join(DIST, "README.md"), "utf8")).toBe(
      readFileSync(join(REPO_ROOT, "plugins", "radius", "README.md"), "utf8")
    );
    expect(readFileSync(join(DIST, "LICENSE"), "utf8")).toBe(
      readFileSync(join(REPO_ROOT, "LICENSE"), "utf8")
    );
    // Skill files ship verbatim, so the packaged skills tree is the source tree.
    expect(relativeFilesUnder(DIST_SKILLS)).toEqual(
      relativeFilesUnder(SOURCE_SKILLS)
    );
    for (const skillFile of relativeFilesUnder(SOURCE_SKILLS)) {
      expectMatchingFile(
        join(SOURCE_SKILLS, skillFile),
        join(DIST_SKILLS, skillFile)
      );
    }
    const notices = readFileSync(join(DIST, "THIRD-PARTY-NOTICES.txt"), "utf8");
    const canvasRoot = join(REPO_ROOT, "packages", "adapter-canvas");
    const graphRoot = join(REPO_ROOT, "packages", "graph-react");
    const flow = installedPackageRoot(graphRoot, "@xyflow/react");
    const dagre = installedPackageRoot(graphRoot, "dagre");
    const graphlib = installedPackageRoot(dagre, "graphlib");
    for (const root of [
      installedPackageRoot(canvasRoot, "react"),
      installedPackageRoot(canvasRoot, "react-dom"),
      flow,
      installedPackageRoot(flow, "@xyflow/system"),
      dagre,
      graphlib,
      installedPackageRoot(graphlib, "lodash"),
      installedPackageRoot(canvasRoot, "yaml")
    ]) {
      expect(notices).toContain(bundledNoticeMarker(root));
    }
    expect(notices).not.toContain("===== reactflow@");
    expect(notices).not.toContain("===== @reactflow/");
  });

  it("keeps continuation and missing-model ownership consistent across shipped graph instructions", () => {
    assertCurrentArtifact();
    const bundle = readFileSync(ARTIFACT, "utf8");
    const graphGuidance = readFileSync(
      join(DIST, "skills", "radius-app-graph", "SKILL.md"),
      "utf8"
    );
    const continuation =
      "Continue with any other part of the user's request, or end the turn.";
    const stopReferenceCheck =
      "stop the reference check without waiting or retrying";

    expect(bundle).toContain(continuation);
    expect(bundle).toContain(stopReferenceCheck);
    for (const guidance of [RADIUS_SESSION_START_CONTEXT, graphGuidance]) {
      expect(guidance).toContain(continuation);
      expect(guidance).toContain(stopReferenceCheck);
      expect(guidance).not.toMatch(
        /(?<!or )\bend (?:the current|the) turn\b/iu
      );
      expect(guidance).toMatch(
        /do not start missing-model generation independently/iu
      );
      expect(guidance).toMatch(/canvas[^\n]*authoring handoff/iu);
    }
    expect(graphGuidance).toContain(
      "run the `radius-app-model` skill on the existing model"
    );
  });

  it("packages the graph skill's fail-closed guidance for rad failures", () => {
    assertCurrentArtifact();
    const graphGuidance = readFileSync(
      join(DIST_SKILLS, "radius-app-graph", "SKILL.md"),
      "utf8"
    );

    expect(graphGuidance).toMatch(
      /never (?:download|install).*(?:rename|back up).*(?:delete|replace) a `rad` binary/isu
    );
    expect(graphGuidance).toMatch(
      /never change or unset `RADIUS_RAD_BINARY` or `RADIUS_RAD_SKIP_VERSION_CHECK`/iu
    );
    expect(graphGuidance).toMatch(
      /never search.*PATH.*\.rad\/bin.*fallback/isu
    );
  });

  // The handoff tells the agent to use skillBase as <skill-dir> and to run the
  // scripts with nodeCommand instead of node. A script command in another form
  // escapes that substitution and runs without the Node.js the canvas resolved.
  it.each(STAGE_SKILLS)(
    "packages %s script commands in the form the handoff runs with its resolved Node",
    (skill) => {
      assertCurrentArtifact();
      const guidance = readFileSync(
        join(DIST_SKILLS, skill, "SKILL.md"),
        "utf8"
      );
      const commands = [
        ...guidance.matchAll(/`([^`\n]*scripts\/[^`\n]*\.mjs[^`\n]*)`/gu)
      ].map(([, command]) => command);

      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command).toMatch(
          /^node <skill-dir>\/scripts\/[\w-]+\.mjs(?: |$)/u
        );
      }
    }
  );

  it("starts and aborts a staged run with the packaged Stage 1 script", () => {
    assertCurrentArtifact();
    const workspace = mkdtempSync(join(tmpdir(), "radius-packaged-model-"));
    const runModel = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          join(DIST_SKILLS, "radius-app-model", "scripts", "model.mjs"),
          ...args
        ],
        { cwd: workspace, encoding: "utf8", timeout: 10_000 }
      );
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: workspace });
      const radiusDir = join(workspace, ".radius");

      const begun = runModel("begin");
      expect(begun.status, begun.stderr).toBe(0);
      const runs = readdirSync(radiusDir).filter((name) =>
        name.startsWith(".staging-")
      );
      expect(runs).toHaveLength(1);

      const aborted = runModel("abort", join(radiusDir, runs[0]));
      expect(aborted.status, aborted.stderr).toBe(0);
      expect(readdirSync(radiusDir)).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
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
      "pages/page-state.ts",
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
      "deploy-chip",
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

  it("installs every managed file without deleting unrelated root files", () => {
    const installDir = mkdtempSync(join(tmpdir(), "radius-canvas-install-"));
    const installPath = join(installDir, "extension.mjs");
    const unrelatedRootFile = join(installDir, "unrelated-root.txt");
    const staleWorkflow = join(installDir, "workflows", "removed.yml");
    const staleSkill = join(
      installDir,
      "skills",
      "radius-app-graph",
      "REMOVED.md"
    );
    try {
      writeFileSync(unrelatedRootFile, "keep root\n");
      mkdirSync(dirname(staleWorkflow), { recursive: true });
      writeFileSync(staleWorkflow, "stale\n");
      mkdirSync(dirname(staleSkill), { recursive: true });
      writeFileSync(staleSkill, "stale\n");

      execFileSync(process.execPath, ["build.mjs", "--install"], {
        cwd: join(REPO_ROOT, "packages", "adapter-canvas"),
        env: {
          ...process.env,
          RADIUS_CANVAS_INSTALL_PATH: installPath
        },
        stdio: "pipe"
      });

      const managedFiles: Array<readonly [string, string]> = [
        [ARTIFACT_RELATIVE_PATH, "extension.mjs"],
        [`${ARTIFACT_RELATIVE_PATH}.map`, "extension.mjs.map"],
        ["THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"],
        ...relativeFilesUnder(join(DIST, "workflows")).map(
          (filePath) =>
            [`workflows/${filePath}`, `workflows/${filePath}`] as const
        ),
        ...relativeFilesUnder(join(DIST, "skills")).map(
          (filePath) => [`skills/${filePath}`, `skills/${filePath}`] as const
        )
      ];
      for (const [source, installed] of managedFiles) {
        expectMatchingFile(
          join(DIST, ...source.split("/")),
          join(installDir, ...installed.split("/"))
        );
      }
      const builtPackage = JSON.parse(
        readFileSync(join(DIST, "package.json"), "utf8")
      ) as Record<string, unknown>;
      expect(
        JSON.parse(readFileSync(join(installDir, "package.json"), "utf8"))
      ).toEqual({ ...builtPackage, main: "extension.mjs" });
      expect(readFileSync(unrelatedRootFile, "utf8")).toBe("keep root\n");
      expect(existsSync(staleWorkflow)).toBe(false);
      expect(existsSync(staleSkill)).toBe(false);
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  it("builds and installs from an isolated workspace with all required assets", () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "radius-canvas-complete-install-assets-")
    );
    const installDir = join(workspaceRoot, "installed");
    const installPath = join(installDir, "extension.mjs");
    try {
      const buildDirectory = prepareBuildWorkspace(workspaceRoot);
      const result = spawnSync(process.execPath, ["build.mjs", "--install"], {
        cwd: buildDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          RADIUS_SOURCE_REF: SOURCE_REF,
          RADIUS_CANVAS_INSTALL_PATH: installPath
        }
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("[canvas] installed");
      expect(existsSync(installPath)).toBe(true);
      for (const skill of STAGE_SKILLS) {
        expectMatchingFile(
          join(SOURCE_SKILLS, skill, "SKILL.md"),
          join(installDir, "skills", skill, "SKILL.md")
        );
      }
      expect(existsSync(join(workspaceRoot, ".artifacts", "radius"))).toBe(
        true
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("fails before installing when a stage skill's SKILL.md is absent", () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "radius-canvas-missing-install-asset-")
    );
    const installDir = join(workspaceRoot, "installed");
    const installPath = join(installDir, "extension.mjs");
    try {
      const buildDirectory = prepareBuildWorkspace(workspaceRoot, [
        "radius-app-model",
        "SKILL.md"
      ]);
      const result = spawnSync(process.execPath, ["build.mjs", "--install"], {
        cwd: buildDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          RADIUS_SOURCE_REF: SOURCE_REF,
          RADIUS_CANVAS_INSTALL_PATH: installPath
        }
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "[canvas] install copy failed: Missing required local-install asset:"
      );
      expect(result.stderr).toContain(join("radius-app-model", "SKILL.md"));
      expect(result.stdout).not.toContain("[canvas] installed");
      expect(existsSync(installDir)).toBe(false);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["Git is unavailable", true],
    ["checkout metadata is invalid", false]
  ])("preserves build output when %s", (_condition, hideGit) => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "radius-canvas-unverified-checkout-")
    );
    const sentinel = join(workspaceRoot, ".artifacts", "radius", "keep.txt");
    try {
      const buildDirectory = prepareBuildWorkspace(workspaceRoot);
      mkdirSync(join(workspaceRoot, ".git"));
      mkdirSync(dirname(sentinel), { recursive: true });
      writeFileSync(sentinel, "keep\n");
      const environment =
        hideGit ?
          Object.fromEntries(
            Object.entries(process.env).filter(
              ([name]) => name.toUpperCase() !== "PATH"
            )
          )
        : { ...process.env };
      if (hideGit) environment.PATH = join(workspaceRoot, "missing-bin");

      const result = spawnSync(process.execPath, ["build.mjs"], {
        cwd: buildDirectory,
        encoding: "utf8",
        env: { ...environment, RADIUS_SOURCE_REF: SOURCE_REF }
      });

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unable to verify tracked files");
      expect(readFileSync(sentinel, "utf8")).toBe("keep\n");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects a mutable source ref before building", () => {
    const workspaceRoot = mkdtempSync(
      join(tmpdir(), "radius-canvas-mutable-source-")
    );
    try {
      const buildDirectory = prepareBuildWorkspace(workspaceRoot);
      const result = spawnSync(process.execPath, ["build.mjs"], {
        cwd: buildDirectory,
        encoding: "utf8",
        env: { ...process.env, RADIUS_SOURCE_REF: "main" }
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "RADIUS_SOURCE_REF must be the full source commit SHA"
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
