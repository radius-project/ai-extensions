// Build pipeline for the Radius Canvas extension.
//
// Bundles the TypeScript/ESM source under packages/adapter-canvas/src (which
// imports the UI-agnostic TypeScript core from packages/core) into the single
// runtime-loadable artifact the Copilot canvas loader runs, and assembles the
// complete installable plugin around it:
//
//   .artifacts/radius/
//
// marketplace.json points installs at that directory, so everything the plugin
// needs (manifest, skills, canvas bundle) must be inside it.
//
// The Copilot SDK is marked external so its auto-resolved import is preserved in
// the output (the loader resolves @github/copilot-sdk at runtime).

import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  dirname,
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const yamlBrowserEntry = resolve(
  dirname(fileURLToPath(import.meta.resolve("yaml"))),
  "../browser/index.js"
);

// .node-version is the one place the supported Node major is declared; deriving
// the compile target from it keeps them from drifting apart.
const target = `node${readFileSync(join(repoRoot, ".node-version"), "utf8").trim()}`;

const isWatch = process.argv.includes("--watch");
// --install copies the build output into the locally installed extension dir the
// host loads. It does NOT arm any auto hot-reload: the installed extension is
// user-scoped and shared by every session on this machine, so restarting it on a
// rebuild would tear down ALL sessions (they'd appear to "constantly stop"). New
// code is instead picked up when a session next starts a fresh process. A
// developer who explicitly wants hot-reload for a given process can set
// RADIUS_CANVAS_DEV=1 (see src/extension.ts); it is intentionally not enabled by
// an on-disk sentinel, which would persist and re-enable the destructive behavior
// for everyone.
const isInstall = process.argv.includes("--install");

const pluginDir = join(repoRoot, "plugins", "radius");
const extensionDir = join(repoRoot, "extensions", "radius");
// Assembled here, then published at both accepted plugin roots. It cannot be
// assembled in place: tracked source lives at each published path.
const distDir = join(repoRoot, ".artifacts", "radius");
const outfile = join(distDir, "extension.mjs");
const radiusTypeResolver = join(
  extensionDir,
  "skills",
  "radius-app-bicep",
  "scripts",
  "show-radius-type.mjs"
);

// Tracked source the assembled plugin is built from, keyed by the directory that
// owns it: the manifest is plugin source, everything else is extension source.
// node_modules is a pnpm workspace symlink and never shipped.
const pluginSources = [
  [pluginDir, "plugin.json"],
  [pluginDir, "README.md"],
  [extensionDir, "package.json"],
  [extensionDir, "skills"],
  [extensionDir, "assets"]
];

// CHANGELOG.md is written by `changeset version`, so it exists in a release
// build but not in a plain local one.
const optionalPluginSources = [[extensionDir, "CHANGELOG.md"]];

// esbuild refuses a file it has no loader for, so an unlisted extension added
// to the plugin tree fails the build instead of silently not shipping.
const pluginAssetLoaders = {
  ".json": "copy",
  ".md": "copy",
  ".mjs": "copy",
  ".png": "copy"
};

// CI stamps an edge version (e.g. 0.1.0-edge-0b33186) so a published
// build is distinguishable from a release. A local build leaves the version in
// the source manifests alone.
const stampedVersion = process.env.PLUGIN_VERSION?.trim();
const SOURCE_SHA = /^[0-9a-f]{40}$/;
// A build with no resolvable source commit cannot pin anything, so it stays
// unstamped and every release validator rejects it.
const DEVELOPMENT_REF = "main";
const sourceRef = resolveSourceRef();

function resolveSourceRef() {
  const explicit = process.env.RADIUS_SOURCE_REF?.trim();
  if (explicit) {
    if (!SOURCE_SHA.test(explicit)) {
      throw new Error(
        `RADIUS_SOURCE_REF must be the full source commit SHA, got ${JSON.stringify(explicit)}.`
      );
    }
    return explicit;
  }
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (SOURCE_SHA.test(head)) return head;
  } catch {
    // Building outside a checkout, e.g. from a source archive or a fixture.
  }
  return DEVELOPMENT_REF;
}

function writeThirdPartyNotices(inputs) {
  const packages = new Map();
  for (const input of inputs) {
    if (!/(?:^|[\\/])node_modules[\\/]/.test(input)) continue;
    let current = dirname(input);
    let manifest;
    while (true) {
      const manifestPath = join(current, "package.json");
      if (existsSync(manifestPath)) {
        const candidate = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (candidate.name && candidate.version) {
          manifest = candidate;
          break;
        }
      }
      const parent = dirname(current);
      if (parent === current) {
        throw new Error(`Unable to locate package metadata for "${input}".`);
      }
      current = parent;
    }
    const key = `${manifest.name}@${manifest.version}`;
    if (packages.has(key)) continue;
    packages.set(key, {
      manifest,
      root: current
    });
  }
  if (packages.size === 0) {
    throw new Error("The bundles contained no third-party package inputs.");
  }

  const notices = [...packages.values()]
    .sort((a, b) => {
      const left = `${a.manifest.name}\0${a.manifest.version}`;
      const right = `${b.manifest.name}\0${b.manifest.version}`;
      return (
        left < right ? -1
        : left > right ? 1
        : 0
      );
    })
    .map(({ manifest, root }) => {
      const licensePath = [
        "LICENSE",
        "LICENSE.md",
        "LICENSE.txt",
        "license",
        "license.md"
      ]
        .map((name) => join(root, name))
        .find(existsSync);
      if (!licensePath) {
        throw new Error(
          `Missing license file for bundled dependency ${manifest.name}@${manifest.version} in ${root}.`
        );
      }
      return `===== ${manifest.name}@${manifest.version} =====\n\n${readFileSync(licensePath, "utf8").trim()}`;
    });
  writeFileSync(
    join(distDir, "THIRD-PARTY-NOTICES.txt"),
    `${notices.join("\n\n")}\n`
  );
}

// esbuild globs are POSIX-style and match files, so a directory has to become a
// recursive pattern.
function pluginAssetEntryPoint(from) {
  const pattern = from.split(sep).join("/");
  return statSync(from).isDirectory() ? `${pattern}/**/*` : pattern;
}

async function assembleDist(bundleInputs) {
  const byRoot = new Map();
  const stage = (root, entry, required) => {
    const from = join(root, entry);
    if (!existsSync(from)) {
      if (required) throw new Error(`Missing required plugin source: ${from}`);
      return;
    }
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push(pluginAssetEntryPoint(from));
  };
  for (const [root, entry] of pluginSources) stage(root, entry, true);
  for (const [root, entry] of optionalPluginSources) stage(root, entry, false);

  // The copy loader reproduces each file verbatim, so the same tool that emits
  // the bundle also lays out the rest of the assembled plugin. One pass per
  // source root, because outbase is what maps a source path onto the output.
  for (const [root, entryPoints] of byRoot) {
    await esbuild.build({
      entryPoints,
      outbase: root,
      outdir: distDir,
      loader: pluginAssetLoaders,
      logLevel: "silent"
    });
  }
  copyFileSync(join(repoRoot, "LICENSE"), join(distDir, "LICENSE"));
  copyExtensionAssets();

  const distPackage = join(distDir, "package.json");
  stripRepositoryScripts(distPackage);
  resolveCatalogSpecifiers(distPackage);
  stampVersion(distPackage, stampedVersion);
  stampSourceRef(distPackage);
  writeCanvasCompatibilityEntryPoint(distPackage);
  // The manifest the host reads must advertise the version the package ships,
  // including when a rebuild runs without PLUGIN_VERSION.
  const distManifest = join(distDir, "plugin.json");
  stampVersion(
    distManifest,
    JSON.parse(readFileSync(distPackage, "utf8")).version
  );
  const resolverBuild = await esbuild.build({
    entryPoints: [radiusTypeResolver],
    outfile: join(
      distDir,
      "skills",
      "radius-app-bicep",
      "scripts",
      "show-radius-type.mjs"
    ),
    bundle: true,
    format: "esm",
    platform: "node",
    target,
    charset: "utf8",
    metafile: true,
    legalComments: "none",
    logLevel: "silent",
    banner: {
      js: "// AUTO-GENERATED by packages/adapter-canvas/build.mjs — do not edit by hand."
    }
  });
  writeThirdPartyNotices([
    ...bundleInputs,
    ...browserBundleInputs,
    ...Object.keys(resolverBuild.metafile.inputs)
  ]);
}

// The plugin package declares its own `build` script so CI can build any plugin
// by name, but that script is meaningless outside this workspace.
function stripRepositoryScripts(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.scripts;
  delete manifest.devDependencies;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// The complete workflow contract ships beside extension.mjs so a released
// plugin contains the exact templates, actions and scripts it was built with.
function copyExtensionAssets() {
  const sourceDir = join(repoRoot, ".github", "extension");
  const targetDir = join(distDir, "workflows");
  if (!existsSync(sourceDir)) {
    throw new Error(`Missing required extension assets: ${sourceDir}`);
  }
  // A nested action package may have been installed locally; only the tracked
  // workflow contract is part of the release.
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (from) => basename(from) !== "node_modules"
  });
}

function writeCanvasCompatibilityEntryPoint(packagePath) {
  const extensionDir = join(distDir, "extensions", "radius");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(
    join(extensionDir, "extension.mjs"),
    '// AUTO-GENERATED by packages/adapter-canvas/build.mjs — do not edit by hand.\nexport * from "../../extension.mjs";\n'
  );
  copyFileSync(packagePath, join(extensionDir, "package.json"));
}

function stampVersion(manifestPath, version) {
  if (!version) return;
  const raw = readFileSync(manifestPath, "utf8");
  // Non-global: only the top-level "version" key, never a dependency range.
  const versionKey = /("version":\s*")[^"]*(")/;
  if (!versionKey.test(raw)) {
    throw new Error(`${manifestPath} has no "version" field to stamp.`);
  }
  // A no-op replace is fine: `changeset version` may already have written this
  // exact version into the source manifest.
  const next = raw.replace(versionKey, `$1${version}$2`);
  if (next !== raw) writeFileSync(manifestPath, next);
}

function stampSourceRef(manifestPath) {
  if (sourceRef === DEVELOPMENT_REF) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.radiusSourceRef = sourceRef;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

// The shipped manifest is read outside this workspace, where pnpm's "catalog:"
// protocol means nothing, so bake the real versions in when assembling dist/.
function resolveCatalogSpecifiers(manifestPath) {
  const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const block = workspace.match(/^catalog:\n((?:[ \t]+.*\n|\n)*)/m)?.[1] ?? "";
  const catalog = {};
  for (const line of block.split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const entry = line.match(/^\s+"?([^":#\s]+)"?:\s*(\S+)\s*$/);
    if (entry) catalog[entry[1]] = entry[2];
  }

  const raw = readFileSync(manifestPath, "utf8");
  const resolved = raw.replace(
    /("([^"]+)":\s*")catalog:(")/g,
    (_match, prefix, name, suffix) => {
      const version = catalog[name];
      if (!version) {
        throw new Error(
          `${name} uses "catalog:" but pnpm-workspace.yaml has no catalog entry for it.`
        );
      }
      return `${prefix}${version}${suffix}`;
    }
  );
  if (resolved !== raw) writeFileSync(manifestPath, resolved);
}

// Where the extension is installed locally. Override with RADIUS_CANVAS_INSTALL_PATH.
// The host loads this canvas as the "radius" extension (see extensions/radius/package.json),
// so install into that directory — not a separate "radius-canvas" dir the host never loads.
const installPath =
  process.env.RADIUS_CANVAS_INSTALL_PATH ||
  join(homedir(), ".copilot", "extensions", "radius", "extension.mjs");

function installToLocal() {
  try {
    const skillFrom = join(distDir, "skills", "radius-app-bicep");
    const sourceReferencesFrom = join(
      distDir,
      "skills",
      "radius-app-bicep",
      "references",
      "source-code-references.md"
    );
    for (const requiredAsset of [skillFrom, sourceReferencesFrom]) {
      if (!existsSync(requiredAsset)) {
        throw new Error(
          `Missing required local-install asset: ${requiredAsset}`
        );
      }
    }

    const installDir = dirname(installPath);
    mkdirSync(installDir, { recursive: true });
    // Write atomically: copy to a temp file in the same dir, then rename over the
    // target. rename() is atomic on the same filesystem, so a watcher never
    // observes a half-written file (which would import as a truncated module and
    // crash a respawned process with no clean error).
    for (const suffix of ["", ".map"]) {
      const from = `${outfile}${suffix}`;
      if (!existsSync(from)) continue;
      const to = `${installPath}${suffix}`;
      const tmp = `${to}.tmp-${process.pid}`;
      copyFileSync(from, tmp);
      renameSync(tmp, to);
    }
    const noticesFrom = join(distDir, "THIRD-PARTY-NOTICES.txt");
    const noticesTo = join(installDir, "THIRD-PARTY-NOTICES.txt");
    const noticesTmp = `${noticesTo}.tmp-${process.pid}`;
    copyFileSync(noticesFrom, noticesTmp);
    renameSync(noticesTmp, noticesTo);
    // Copy the whole skills tree rather than naming files one at a time, so a
    // skill, reference, or script added later is installed without touching
    // this list. SKILL.md and its references are the instructions the agent
    // actually follows, so installing only the scripts leaves a dev install
    // running stale guidance against a fresh bundle. The handoff accepts a
    // skill directory only when SKILL.md, its validation script, and its
    // cross-skill reference are present, then tries the other supported
    // locations before reporting that no usable skill exists.
    const skillsFrom = join(distDir, "skills");
    if (existsSync(skillsFrom)) {
      const skillsTo = join(installDir, "skills");
      const tmp = `${skillsTo}.tmp-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      cpSync(skillsFrom, tmp, { recursive: true });
      rmSync(skillsTo, { recursive: true, force: true });
      renameSync(tmp, skillsTo);
    }
    // The plugin manifest carries the version recorded in each origin record.
    // Without it a dev install resolves no version and the generator-drift
    // check silently does nothing.
    const manifestFrom = join(distDir, "package.json");
    if (existsSync(manifestFrom)) {
      const manifestTo = join(installDir, "package.json");
      const tmp = `${manifestTo}.tmp-${process.pid}`;
      copyFileSync(manifestFrom, tmp);
      renameSync(tmp, manifestTo);
    }
    // Replace the whole workflow contract so removed actions and scripts cannot
    // survive beside a freshly installed extension.
    const workflowsFrom = join(distDir, "workflows");
    if (existsSync(workflowsFrom)) {
      const workflowsTo = join(installDir, "workflows");
      const tmp = `${workflowsTo}.tmp-${process.pid}`;
      rmSync(tmp, { recursive: true, force: true });
      cpSync(workflowsFrom, tmp, { recursive: true });
      rmSync(workflowsTo, { recursive: true, force: true });
      renameSync(tmp, workflowsTo);
    }
    // Remove any legacy `.dev-reload` sentinel from older installs so it can't
    // keep the (now opt-in) self-reloader armed on this machine.
    try {
      const sentinel = join(installDir, ".dev-reload");
      if (existsSync(sentinel)) rmSync(sentinel);
    } catch {
      /* best-effort cleanup */
    }
    console.log(`[canvas] installed → ${installPath}`);
  } catch (e) {
    console.error(`[canvas] install copy failed: ${e?.message || e}`);
    throw e;
  }
}

// dist/ is rebuilt from scratch on every run, then refreshed after each rebuild
// so watch mode keeps it complete. Installing stays watch-only; a one-shot
// install uses the trailing call below, so the file is written exactly once
// (a double write would trigger two watcher events in any dev process).
const finalizePlugin = {
  name: "finalize-dist",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      await assembleDist(Object.keys(result.metafile?.inputs ?? {}));
      if (isInstall && isWatch) installToLocal();
    });
  }
};

const browserDir = join(__dirname, "src", "browser");
let browserCompilerRevision = 0;
let browserBundleInputs = [];

function browserSourceFiles(directory = browserDir) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) return browserSourceFiles(child);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ?
        [child]
      : [];
  });
}

// Replace the development compiler-backed module with literal payloads. The
// browser entries remain byte-identical, but the shipped Node artifact contains
// neither esbuild nor a runtime import or request for extension-owned assets.
const browserBundlePlugin = {
  name: "inline-browser-bundles",
  setup(build) {
    build.onLoad(
      { filter: /[\\/]src[\\/]browser[\\/]generated\.ts$/ },
      async () => {
        const compilerUrl = new URL("./src/browser/build.ts", import.meta.url);
        compilerUrl.searchParams.set(
          "revision",
          String(browserCompilerRevision++)
        );
        const { BROWSER_ENTRY_NAMES, compileAllBrowserBundles } = await import(
          compilerUrl.href
        );
        const bundles = compileAllBrowserBundles();
        browserBundleInputs = [
          ...new Set(Object.values(bundles).flatMap((bundle) => bundle.inputs))
        ];
        const payloads = Object.fromEntries(
          Object.entries(bundles).map(([name, bundle]) => [
            name,
            { script: bundle.script, style: bundle.style }
          ])
        );
        return {
          contents: `// AUTO-GENERATED at build time from packages/adapter-canvas/src/browser/entries.
export const BROWSER_ENTRY_NAMES = ${JSON.stringify(BROWSER_ENTRY_NAMES)};
const BROWSER_BUNDLES = ${JSON.stringify(payloads)};
export function loadBrowserScript(name) {
  const bundle = BROWSER_BUNDLES[name];
  if (bundle === undefined) {
    throw new Error(\`Unknown browser entry "\${name}".\`);
  }
  return bundle.script;
}
export function loadBrowserStyle(name) {
  const bundle = BROWSER_BUNDLES[name];
  if (bundle === undefined) {
    throw new Error(\`Unknown browser entry "\${name}".\`);
  }
  return bundle.style;
}
`,
          loader: "js",
          watchFiles: [
            ...new Set([...browserSourceFiles(), ...browserBundleInputs])
          ]
        };
      }
    );
  }
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [
    join(repoRoot, "packages", "adapter-canvas", "src", "extension.ts")
  ],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target,
  define: {
    "process.env.RADIUS_SOURCE_REF": JSON.stringify(sourceRef),
    "process.env.RADIUS_DELETE_REF": JSON.stringify(sourceRef)
  },
  // yaml's Node entry is CommonJS and leaves a dynamic require("process") in
  // the ESM bundle. Its browser entry is equivalent pure ESM parser code.
  alias: { yaml: yamlBrowserEntry },
  // The runtime is known to be Node, so emit UTF-8 rather than \uXXXX escapes.
  charset: "utf8",
  minify: true,
  // Node does not honour source maps unless the host process was started with
  // --enable-source-maps, so keep function names readable in stack traces
  // regardless. Costs ~12 KB.
  keepNames: true,
  sourcemap: true,
  metafile: true,
  // The SDK is resolved by the loader at runtime — never bundle it.
  external: ["@github/copilot-sdk", "@github/copilot-sdk/extension"],
  legalComments: "none",
  logLevel: "info",
  banner: {
    js: "// AUTO-GENERATED by packages/adapter-canvas/build.mjs — do not edit by hand.\n// Source: packages/adapter-canvas/src + packages/core. Run `pnpm run build:canvas`."
  },
  plugins: [browserBundlePlugin, finalizePlugin]
};

// The output root is wiped on every build, so it must never be a directory that
// also holds tracked source: a stale path constant would delete real work.
function trackedFilesUnderDist() {
  // Git pathspecs are repository-relative. An absolute one can match nothing on
  // some Git and platform combinations, which would silently disarm the guard.
  const within = relative(repoRoot, distDir);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    throw new Error(
      `Refusing to wipe ${distDir}: it must be a directory inside ${repoRoot}.`
    );
  }
  // `literal` keeps a path containing glob characters from being read as a
  // pattern; `top` anchors it to the repository root rather than the cwd.
  const pathspec = `:(top,literal)${within.split(sep).join("/")}`;
  const gitMarker = join(repoRoot, ".git");
  if (!lstatSync(gitMarker, { throwIfNoEntry: false })) return [];
  try {
    const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
    if (inside !== "true") {
      throw new Error(`git reported ${JSON.stringify(inside)}`);
    }
  } catch (error) {
    throw new Error(
      `Refusing to wipe ${distDir}: unable to verify tracked files in ${repoRoot}.`,
      { cause: error }
    );
  }
  return execFileSync("git", ["ls-files", "-z", "--", pathspec], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  })
    .split("\0")
    .filter(Boolean);
}

function resetDistDir() {
  const tracked = trackedFilesUnderDist();
  if (tracked.length > 0) {
    throw new Error(
      `Refusing to wipe ${distDir}: it contains ${tracked.length} tracked file(s), starting with ${tracked[0]}.`
    );
  }
  rmSync(distDir, { recursive: true, force: true });
}

resetDistDir();

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[canvas] watching for changes…");
} else {
  await esbuild.build(options);
  console.log(
    `[canvas] built ${relative(repoRoot, distDir).split(sep).join("/")}`
  );
  if (isInstall) installToLocal();
}
