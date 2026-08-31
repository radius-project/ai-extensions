// The plugin registry: the one place that knows which plugins this monorepo
// ships and what every published ref for them is called.
//
// Plugins are discovered, not configured. A directory under `plugins/` becomes
// shippable when package.json and plugin.json agree on its ref-safe name and it
// has a README and a `test:artifact` script. Adding such a directory is enough
// for the release workflows to pick it up.
//
// Naming convention, applied uniformly so a second plugin can never collide
// with the first:
//
//   <plugin>@<version>            source tag (Changesets creates this one)
//   <plugin>/v<version>           artifact tag on the orphan install commit
//   releases/<plugin>/v<version>  versioned orphan branch for that version
//   releases/<plugin>/<channel>   rolling install branch (edge, latest)
//   <plugin>@<channel>            rolling tag on that branch
//
// Usage:
//   node scripts/plugins.mjs                    print every plugin name
//   node scripts/plugins.mjs --json             the same names as a JSON array,
//                                               for a GitHub Actions matrix
//   node scripts/plugins.mjs --env <plugin> [--version <v>] [--channel <c>]
//                                               KEY=value lines for $GITHUB_ENV

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PLUGINS_DIR = "plugins";
const CHANNELS = ["edge", "latest"];
const PLUGIN_NAME = /^[a-z0-9][a-z0-9.-]*[a-z0-9]$|^[a-z0-9]$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function describe(name) {
  const dir = `${PLUGINS_DIR}/${name}`;
  return {
    name,
    dir,
    distDir: `${dir}/dist`,
    packageFile: `${dir}/package.json`,
    manifestFile: `${dir}/plugin.json`,
    changelogFile: `${dir}/CHANGELOG.md`,
    readmeFile: `${dir}/README.md`
  };
}

/** Every plugin in the workspace, ordered by name so output is stable. */
export function listPlugins() {
  const root = join(repoRoot, PLUGINS_DIR);
  if (!existsSync(root)) fail(`no plugins found under ${PLUGINS_DIR}/`);
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => describe(entry.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const plugins = [];

  for (const plugin of candidates) {
    const hasPackage = existsSync(join(repoRoot, plugin.packageFile));
    const hasManifest = existsSync(join(repoRoot, plugin.manifestFile));
    if (!hasPackage && !hasManifest) continue;
    if (!hasPackage || !hasManifest) {
      fail(`${plugin.dir} must contain both package.json and plugin.json`);
    }
    if (!existsSync(join(repoRoot, plugin.readmeFile))) {
      fail(`${plugin.dir} must contain README.md`);
    }
    if (
      !PLUGIN_NAME.test(plugin.name) ||
      plugin.name.includes("..") ||
      plugin.name.includes("--")
    ) {
      fail(`${plugin.dir} is not a safe plugin/ref name`);
    }

    let packageJson;
    let manifested;
    try {
      packageJson = JSON.parse(
        readFileSync(join(repoRoot, plugin.packageFile), "utf8")
      );
      manifested = JSON.parse(
        readFileSync(join(repoRoot, plugin.manifestFile), "utf8")
      ).name;
    } catch (error) {
      fail(`${plugin.dir} has invalid JSON: ${error.message}`);
    }
    if (packageJson.name !== plugin.name || manifested !== plugin.name) {
      fail(
        `${plugin.dir} must be named "${plugin.name}" in package.json and plugin.json`
      );
    }
    if (
      typeof packageJson.scripts?.["test:artifact"] !== "string" ||
      packageJson.scripts["test:artifact"].trim() === ""
    ) {
      fail(`${plugin.packageFile} must define scripts.test:artifact`);
    }
    plugins.push(plugin);
  }

  if (plugins.length === 0) fail(`no plugins found under ${PLUGINS_DIR}/`);
  return plugins;
}

/**
 * Resolves the plugin a command applies to. While the repo ships exactly one,
 * naming it is optional; the moment a second appears every caller must say
 * which one it means rather than silently acting on the wrong plugin.
 */
export function requirePlugin(name) {
  const plugins = listPlugins();
  // GitHub Actions passes an unset input through as an empty string.
  if (name === undefined || name === "") {
    if (plugins.length === 1) return plugins[0];
    fail(
      `--plugin is required; this repo ships ${plugins.map((p) => p.name).join(", ")}`
    );
  }
  const plugin = plugins.find((p) => p.name === name);
  if (!plugin) fail(`no plugin named "${name}" under ${PLUGINS_DIR}/`);
  return plugin;
}

/** Resolve a caller-supplied JSON matrix, or all plugins when it is empty. */
export function selectPluginNames(plugins, requestedJson) {
  if (requestedJson === undefined || requestedJson === "") {
    return plugins.map((plugin) => plugin.name);
  }

  let requested;
  try {
    requested = JSON.parse(requestedJson);
  } catch (error) {
    fail(`--select must be a JSON array: ${error.message}`);
  }
  if (!Array.isArray(requested) || requested.length === 0) {
    fail("--select must be a non-empty JSON array of plugin names");
  }

  const available = new Set(plugins.map((plugin) => plugin.name));
  const selected = [];
  for (const name of requested) {
    if (typeof name !== "string" || !available.has(name)) {
      fail(`--select names an unknown plugin: ${JSON.stringify(name)}`);
    }
    if (!selected.includes(name)) selected.push(name);
  }
  return selected;
}

/** Every published ref name for a plugin. The single source of the convention. */
export function pluginRefs(plugin, { version, channel } = {}) {
  const refs = {
    PLUGIN_NAME: plugin.name,
    PLUGIN_DIR: plugin.dir,
    PLUGIN_DIST: plugin.distDir,
    PLUGIN_ARTIFACT: `plugin-dist-${plugin.name}`,
    PLUGIN_SBOM_ARTIFACT: `plugin-sbom-${plugin.name}`,
    PLUGIN_TARBALL: `${plugin.name}-plugin.tar.gz`,
    PLUGIN_SBOM: `${plugin.name}-plugin.spdx.json`,
    PLUGIN_AWESOME_COPILOT: `${plugin.name}-awesome-copilot.zip`
  };
  if (channel !== undefined && channel !== "") {
    if (!CHANNELS.includes(channel)) {
      fail(`--channel must be one of ${CHANNELS.join(", ")}, got "${channel}"`);
    }
    refs.PLUGIN_CHANNEL_BRANCH = `releases/${plugin.name}/${channel}`;
    refs.PLUGIN_CHANNEL_TAG = `${plugin.name}@${channel}`;
  }
  if (version !== undefined && version !== "") {
    if (!SEMVER.test(version)) {
      fail(`--version requires SemVer, got ${JSON.stringify(version)}`);
    }
    refs.PLUGIN_SOURCE_TAG = `${plugin.name}@${version}`;
    refs.PLUGIN_ARTIFACT_TAG = `${plugin.name}/v${version}`;
    refs.PLUGIN_PINNED_BRANCH = `releases/${plugin.name}/v${version}`;
  }
  return refs;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes("--select")) {
    console.log(
      JSON.stringify(selectPluginNames(listPlugins(), option(args, "--select")))
    );
  } else if (args.includes("--env")) {
    const refs = pluginRefs(requirePlugin(option(args, "--env")), {
      version: option(args, "--version"),
      channel: option(args, "--channel")
    });
    for (const [key, value] of Object.entries(refs)) {
      console.log(`${key}=${value}`);
    }
  } else if (args.includes("--json")) {
    console.log(JSON.stringify(listPlugins().map((p) => p.name)));
  } else {
    for (const plugin of listPlugins()) console.log(plugin.name);
  }
}
