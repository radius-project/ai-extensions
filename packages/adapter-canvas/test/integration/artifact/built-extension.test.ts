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
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
const DIST = join(REPO_ROOT, ".artifacts", "radius");
const ARTIFACT = join(DIST, "extension.mjs");
const SOURCE_MAP = `${ARTIFACT}.map`;
const SOURCE_CHANGELOG = join(
  REPO_ROOT,
  "extensions",
  "radius",
  "CHANGELOG.md"
);
const SOURCE_SKILL = join(
  REPO_ROOT,
  "extensions",
  "radius",
  "skills",
  "radius-app-bicep"
);
const DIST_SKILL = join(DIST, "skills", "radius-app-bicep");
const SOURCE_CODE_REFERENCE = join(
  REPO_ROOT,
  "extensions",
  "radius",
  "skills",
  "radius-app-graph",
  "references",
  "source-code-references.md"
);
const DIST_CODE_REFERENCE = join(
  DIST,
  "skills",
  "radius-app-graph",
  "references",
  "source-code-references.md"
);
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
  for (const packageName of ["adapter-shared", "core"]) {
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
  cpSync(
    join(sourceExtensionDir, "assets"),
    join(workspaceExtensionDir, "assets"),
    { recursive: true }
  );
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
    ...filesUnder(join(REPO_ROOT, "extensions", "radius", "assets")),
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
    ).toEqual(["extension.mjs"]);
    expect(existsSync(join(DIST, "extensions"))).toBe(false);
    const packagedPaths = [
      "package.json",
      "plugin.json",
      "README.md",
      "LICENSE",
      "THIRD-PARTY-NOTICES.txt",
      "assets/preview.png",
      "skills/radius-app-bicep/SKILL.md",
      "skills/radius-app-bicep/references/custom-resource-types.md",
      "skills/radius-app-bicep/scripts/show-radius-type.mjs",
      "skills/radius-app-bicep/scripts/validate-bicep.mjs",
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
    expect({ ...builtPlugin, version: sourcePlugin.version }).toEqual(
      sourcePlugin
    );
    // plugin.json is the manifest the host reads, so a published build must not
    // advertise a different version from the package it ships.
    expect(builtPlugin.version).toBe(builtPackage.version);
    expect(readFileSync(join(DIST, "README.md"), "utf8")).toBe(
      readFileSync(join(REPO_ROOT, "plugins", "radius", "README.md"), "utf8")
    );
    expect(readFileSync(join(DIST, "LICENSE"), "utf8")).toBe(
      readFileSync(join(REPO_ROOT, "LICENSE"), "utf8")
    );
    for (const sourceSkill of filesUnder(
      join(REPO_ROOT, "extensions", "radius", "skills")
    )) {
      const relative = sourceSkill.slice(
        join(REPO_ROOT, "extensions", "radius").length + 1
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
    expect(relativeFilesUnder(DIST_SKILL)).toEqual(
      relativeFilesUnder(SOURCE_SKILL)
    );
    expectMatchingFile(SOURCE_CODE_REFERENCE, DIST_CODE_REFERENCE);
    const notices = readFileSync(join(DIST, "THIRD-PARTY-NOTICES.txt"), "utf8");
    for (const marker of [
      "===== react@19.2.8 =====",
      "===== react-dom@19.2.8 =====",
      "===== reactflow@11.11.4 =====",
      "===== dagre@0.8.5 =====",
      "===== @reactflow/core@11.11.4 =====",
      "===== graphlib@2.1.8 =====",
      "===== lodash@4.18.1 =====",
      "===== yaml@2.9.0 ====="
    ]) {
      expect(notices).toContain(marker);
    }
  });

  it("packages the managed-secret modeling contract in executable examples and platform rules", () => {
    assertCurrentArtifact();
    const readGuidance = (relativePath: string): string =>
      readFileSync(join(DIST_SKILL, relativePath), "utf8");
    const bicepBlocks = filesUnder(DIST_SKILL)
      .filter((path) => path.endsWith(".md"))
      .flatMap((path) => [
        ...readFileSync(path, "utf8").matchAll(
          /```bicep\r?\n([\s\S]*?)\r?\n```/gu
        )
      ])
      .map((match) => match[1]);

    const todoExample = readGuidance("references/todo-list-app-example.md");
    const mysqlExample = bicepBlocks.find(
      (block) =>
        block.includes("resource mysqlCredentials 'Radius.Security/secrets") &&
        block.includes("source: mysql.id") &&
        block.includes("source: mysqlCredentials.id")
    );
    expect(mysqlExample).toBeDefined();
    expect(mysqlExample).toMatch(/password:\s*\{\s*value:\s*password\s*\}/u);
    expect(mysqlExample).toMatch(
      /mysql:\s*\{\s*source:\s*mysql\.id\s*\}\s*mysqlSecret:\s*\{\s*source:\s*mysqlCredentials\.id/u
    );
    expect(todoExample).toMatch(
      /MYSQL_PASSWORD:\s*\{\s*valueFrom:\s*\{\s*secretKeyRef:\s*\{\s*secretName:\s*mysqlClientCredentials\.name\s*key:\s*'password'/u
    );
    expect(todoExample).toContain(
      "The same `mysqlPassword` parameter supplies the MySQL resource's schema-defined sensitive input"
    );
    expect(todoExample).toContain(
      "no authored-Secret connection migration is implied"
    );

    const connectionGuidance = readGuidance(
      "references/connection-conventions.md"
    );
    const structureGuidance = readGuidance(
      "references/bicep-structure-rules.md"
    );
    const runtimeGuidance = readGuidance("references/runtime-contract.md");
    const skillGuidance = readGuidance("SKILL.md");
    const redisExample = bicepBlocks.find(
      (block) =>
        block.includes("redis:") && block.includes("source: redisCache.id")
    );
    expect(redisExample).toBeDefined();
    expect(redisExample).not.toMatch(
      /Radius\.Security\/secrets|properties\.secrets\.name/u
    );
    expect(connectionGuidance).toContain(
      "If the Redis Recipe declares `url` in `result.secrets`, the connection injects secret-backed `CONNECTION_REDIS_URL`"
    );
    expect(connectionGuidance).toContain(
      "If the supplied compatibility context does not explicitly establish support, preserve or use the existing schema-supported wiring"
    );
    expect(connectionGuidance).toContain(
      "Do not automatically rewrite an existing working `app.bicep`"
    );
    expect(connectionGuidance).toContain(
      "Azure Container Instances (ACI) behavior is unchanged and must not use this Kubernetes projection"
    );
    expect(connectionGuidance).toContain(
      "An explicit `env` entry wins over a generated variable with the same name"
    );
    expect(connectionGuidance).toContain(
      "Set `disableDefaultEnvVars: true` on a connection only when all generated variables from that connection must be suppressed"
    );
    expect(skillGuidance).toContain(
      "`postgresSecret` becomes `POSTGRESSECRET`"
    );
    // This artifact-boundary test verifies the packaged semantic guidance only.
    // The repo has no deterministic seam that executes the prompt-driven skill
    // or evaluates its generated Bicep; https://github.com/radius-project/ai-extensions/issues/685 tracks that evaluation harness.
    for (const guidance of [
      skillGuidance,
      connectionGuidance,
      runtimeGuidance
    ]) {
      expect(guidance).toContain(
        "Do not execute `rad`, fetch versions or Recipe metadata, or visit external links to discover compatibility"
      );
      expect(guidance).not.toContain("rad version --output json");
      expect(guidance).not.toContain("rad recipe show");
    }
    expect(skillGuidance).toContain(
      'the required managed `show-radius-type.mjs` result for `Radius.Compute/containers` has `recipe.status: "available"` and its returned `recipe.definition` identifies the Kubernetes Container Recipe'
    );
    expect(connectionGuidance).toContain(
      "Support is established when `recipe.status` is `available` and the returned `recipe.definition` identifies the Kubernetes Container Recipe"
    );
    expect(runtimeGuidance).toContain(
      "For the managed-default profile, Recipe inspection means reading the complete `recipe.definition` already returned by the required `show-radius-type.mjs` batch"
    );
    expect(skillGuidance).toContain(
      "The skill handoff itself and a resolved resource schema alone do not establish runtime projection support"
    );
    expect(connectionGuidance).toContain(
      "The skill handoff itself and a resolved resource schema alone are insufficient"
    );
    expect(skillGuidance).toContain(
      "If the Recipe is absent, unavailable, unresolved, or not the Kubernetes Container Recipe, preserve schema-supported `env`, `secretKeyRef`, `envFrom`, native variables, or equivalent explicit wiring"
    );
    expect(skillGuidance).toContain(
      "`<CONNECTION>` is the uppercased connection map key without separator insertion"
    );
    expect(connectionGuidance).toContain(
      "`<CONNECTION>` is the uppercased connection map key without separator insertion"
    );
    expect(skillGuidance).toContain(
      "`<SECRETKEY>` is the uppercased authored Secret data key or Recipe `result.secrets` key"
    );
    expect(connectionGuidance).toContain(
      "a secret suffix is the uppercased authored data key or Recipe `result.secrets` key"
    );
    expect(skillGuidance).toContain(
      "The Kubernetes Container Recipe applies generated ordinary and secret-backed `CONNECTION_*` variables to both regular containers and init containers under the same precedence, disabling, and collision rules"
    );
    expect(connectionGuidance).toContain(
      "Generated ordinary and secret-backed `CONNECTION_*` variables apply to both regular containers and init containers under the same precedence, disabling, and collision rules"
    );
    expect(skillGuidance).toContain(
      "Do not migrate a working `app.bicep` without explicit user intent"
    );
    expect(connectionGuidance).toContain(
      "Do not automatically rewrite an existing working `app.bicep`"
    );
    expect(skillGuidance).toContain(
      "An authored `Radius.Security/secrets` connection uses `<secret>.id` and projects its declared data keys"
    );
    expect(connectionGuidance).toContain(
      "A connection to an authored `Radius.Security/secrets` resource uses `<secret>.id` and projects its declared data keys"
    );
    expect(skillGuidance).toContain(
      "A producer connection uses `<producer>.id` and may project ordinary properties plus keys declared by the Recipe in `result.secrets`"
    );
    expect(connectionGuidance).toContain(
      "A connection to a producer uses `<producer>.id` and may project ordinary resource properties plus secret-backed keys declared by the Recipe in `result.secrets`"
    );
    for (const guidance of [skillGuidance, connectionGuidance]) {
      expect(guidance).toContain(
        "Automatic secret-backed `CONNECTION_*` projection is Kubernetes Container Recipe behavior only"
      );
      expect(guidance).toContain("<secret>.id");
      expect(guidance).toContain("<producer>.id");
      expect(guidance).toContain("`result.secrets`");
      expect(guidance).toContain("`<producer>.properties.secrets.name`");
      expect(guidance).toContain("`properties.secrets.id` does not exist");
      expect(guidance).toContain(
        "An explicit `env` entry wins over a generated variable"
      );
      expect(guidance).toContain(
        "`disableDefaultEnvVars: true` suppresses all generated variables for that connection"
      );
      expect(guidance).toContain(
        "When an ordinary projected property and a managed secret-derived value normalize to the same generated name, the managed secret value wins"
      );
      expect(guidance).toContain(
        "When two secret-derived values normalize to the same generated name, fail rather than choose silently"
      );
      expect(guidance).not.toMatch(
        /Normalized generated-name collisions fail|Generated names that collide after normalization fail/u
      );
      expect(guidance).toContain("Developer-owned credentials");
      expect(guidance).toMatch(
        /generated by a Recipe[\s\S]*`result\.secrets`/u
      );
      expect(guidance).toContain(
        "Azure Container Instances (ACI) behavior is unchanged and must not use this Kubernetes projection"
      );
      expect(guidance).not.toMatch(
        /github\.com\/radius-project\/(?:radius|resource-types-contrib)\/(?:pull|issues)\//u
      );
    }
    expect(readGuidance("references/secrets-handling.md")).toContain(
      "`CONNECTION_MYSQLSECRET_PASSWORD`"
    );
    for (const guidance of [
      connectionGuidance,
      structureGuidance,
      runtimeGuidance,
      readGuidance("references/secrets-handling.md")
    ]) {
      expect(guidance).toContain("`@secure()`");
      expect(guidance).toContain("`env.value`");
      expect(guidance).toMatch(/explicit|legacy/u);
      expect(guidance).toContain("fallback");
      expect(guidance).toContain("generated Pod specification");
    }
    for (const guidance of [
      connectionGuidance,
      structureGuidance,
      runtimeGuidance
    ]) {
      expect(guidance).toMatch(
        /secretKeyRef[^\n]*<secret>\.name[^\n]*(?:native variable|compatibility fallback)/u
      );
    }

    const literalCredentialAssignment =
      /^\s*(?:[A-Za-z][A-Za-z0-9]*_)*(?:accessKey|apiKey|clientSecret|connectionString|password|secretKey|token)\s*:\s*(?:['"]|\{\s*value:\s*['"])/imu;
    expect("MYSQL_PASSWORD: { value: 'unsafe-example' }").toMatch(
      literalCredentialAssignment
    );
    expect("APP_PASSWORD_POLICY: { value: 'strict' }").not.toMatch(
      literalCredentialAssignment
    );
    expect(bicepBlocks.length).toBeGreaterThan(0);
    for (const block of bicepBlocks) {
      expect(block).not.toMatch(literalCredentialAssignment);
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

      const managedFiles = [
        "extension.mjs",
        "extension.mjs.map",
        "THIRD-PARTY-NOTICES.txt",
        "package.json",
        ...relativeFilesUnder(join(DIST, "workflows")).map(
          (filePath) => `workflows/${filePath}`
        ),
        ...relativeFilesUnder(join(DIST, "skills")).map(
          (filePath) => `skills/${filePath}`
        )
      ];
      for (const managedFile of managedFiles) {
        expectMatchingFile(
          join(DIST, ...managedFile.split("/")),
          join(installDir, ...managedFile.split("/"))
        );
      }
      expect(readFileSync(unrelatedRootFile, "utf8")).toBe("keep root\n");
      expect(existsSync(staleWorkflow)).toBe(false);
      expect(existsSync(staleSkill)).toBe(false);
    } finally {
      rmSync(installDir, { recursive: true, force: true });
    }
  });

  it.each([
    {
      asset: "radius-app-bicep skill",
      missingAsset: ["radius-app-bicep"],
      expectedError: "Could not resolve",
      expectedPath: "show-radius-type.mjs"
    },
    {
      asset: "app-graph source reference",
      missingAsset: [
        "radius-app-graph",
        "references",
        "source-code-references.md"
      ],
      expectedError:
        "[canvas] install copy failed: Missing required local-install asset:",
      expectedPath: "source-code-references.md"
    }
  ])(
    "fails before installing when the $asset is absent",
    ({ missingAsset, expectedError, expectedPath }) => {
      const workspaceRoot = mkdtempSync(
        join(tmpdir(), "radius-canvas-missing-install-asset-")
      );
      const installDir = join(workspaceRoot, "installed");
      const installPath = join(installDir, "extension.mjs");
      try {
        const buildDirectory = prepareBuildWorkspace(
          workspaceRoot,
          missingAsset
        );
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
        expect(result.stderr).toContain(expectedError);
        expect(result.stderr).toContain(expectedPath);
        expect(result.stdout).not.toContain("[canvas] installed");
        expect(existsSync(installDir)).toBe(false);
      } finally {
        rmSync(workspaceRoot, { recursive: true, force: true });
      }
    }
  );

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
