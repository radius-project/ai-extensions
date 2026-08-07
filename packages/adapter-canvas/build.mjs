// Build pipeline for the Radius Canvas extension.
//
// Bundles the TypeScript/ESM source under packages/adapter-canvas/src (which
// imports the UI-agnostic TypeScript core from packages/core) into the single
// runtime-loadable artifact the Copilot canvas loader runs, and assembles the
// complete installable plugin around it:
//
//   plugins/radius/dist/
//
// marketplace.json points installs at that directory, so everything the plugin
// needs (manifest, skills, canvas bundle) must be inside it.
//
// The Copilot SDK is marked external so its auto-resolved import is preserved in
// the output (the loader resolves @github/copilot-sdk at runtime).

import * as esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

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
const distDir = join(pluginDir, "dist");
const outfile = join(distDir, "extension.mjs");

// Tracked plugin sources that must sit beside the bundle for dist/ to be a
// complete plugin. node_modules is a pnpm workspace symlink and never shipped.
const pluginSources = ["plugin.json", "package.json", "README.md", "skills"];

// CI stamps an edge version (e.g. 0.1.1-edge.42.g2dd94f4) so a published build
// is distinguishable from the release it was cut after. A local build leaves the
// version in the source manifests alone.
const stampedVersion = process.env.PLUGIN_VERSION?.trim();

function assembleDist() {
  for (const entry of pluginSources) {
    cpSync(join(pluginDir, entry), join(distDir, entry), { recursive: true });
  }
  resolveCatalogSpecifiers(join(distDir, "package.json"));
  for (const manifest of ["package.json", "plugin.json"]) {
    stampVersion(join(distDir, manifest));
  }
}

function stampVersion(manifestPath) {
  if (!stampedVersion) return;
  const raw = readFileSync(manifestPath, "utf8");
  // Non-global: only the top-level "version" key, never a dependency range.
  const next = raw.replace(/("version":\s*")[^"]*(")/, `$1${stampedVersion}$2`);
  if (next === raw) {
    throw new Error(`${manifestPath} has no "version" field to stamp.`);
  }
  writeFileSync(manifestPath, next);
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
// The host loads this canvas as the "radius" extension (see plugins/radius/package.json),
// so install into that directory — not a separate "radius-canvas" dir the host never loads.
const installPath =
  process.env.RADIUS_CANVAS_INSTALL_PATH ||
  join(homedir(), ".copilot", "extensions", "radius", "extension.mjs");

function installToLocal() {
  try {
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
  }
}

// dist/ is rebuilt from scratch on every run, then refreshed after each rebuild
// so watch mode keeps it complete. Installing stays watch-only; a one-shot
// install uses the trailing call below, so the file is written exactly once
// (a double write would trigger two watcher events in any dev process).
const finalizePlugin = {
  name: "finalize-dist",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      assembleDist();
      if (isInstall && isWatch) installToLocal();
    });
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
  // The runtime is known to be Node, so emit UTF-8 rather than \uXXXX escapes.
  charset: "utf8",
  minify: true,
  // Node does not honour source maps unless the host process was started with
  // --enable-source-maps, so keep function names readable in stack traces
  // regardless. Costs ~12 KB.
  keepNames: true,
  sourcemap: true,
  // The SDK is resolved by the loader at runtime — never bundle it.
  external: ["@github/copilot-sdk", "@github/copilot-sdk/extension"],
  // Inline the radius-app-bicep skill Markdown (SKILL.md + references) as text
  // so the extension ships the authoritative skill content even when installed
  // without the sibling plugins/radius/skills/ tree. See src/skill.ts.
  loader: { ".md": "text" },
  legalComments: "none",
  logLevel: "info",
  banner: {
    js: "// AUTO-GENERATED by packages/adapter-canvas/build.mjs — do not edit by hand.\n// Source: packages/adapter-canvas/src + packages/core. Run `pnpm run build:canvas`."
  },
  plugins: [finalizePlugin]
};

rmSync(distDir, { recursive: true, force: true });

if (isWatch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[canvas] watching for changes…");
} else {
  await esbuild.build(options);
  console.log("[canvas] built plugins/radius/dist");
  if (isInstall) installToLocal();
}
