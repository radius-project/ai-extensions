// Creates release commits and refs through the GitHub API. GitHub signs commits
// for the App; tag refs are written only after their target commit is Verified.
//
// A runner holds no signing key, so `git commit` and `git tag` on the runner can
// only ever produce unverified objects. GitHub signs on a bot's behalf instead,
// but only when the request is authenticated as a GitHub App and carries no
// custom author, committer, tagger or signature (GitHub's "Signature
// verification for bots"). Every write below therefore goes through the API with
// those fields omitted, and refuses to move a ref unless GitHub reports the new
// object as verified.
//
// Usage:
//   node scripts/verified-git.mjs commit --message <message> --path <path>...
//         Uploads the paths as a parentless ROOT commit, so an install branch
//         built from it shares no history with main. Moves no ref, and prints
//         {"commit":"<sha>","tree":"<sha>"} so a caller can compare the tree
//         against an already published branch before deciding to publish.
//   node scripts/verified-git.mjs tag --name <tag> --target <sha> [--force]
//         Creates a lightweight tag ref after GitHub verifies its target commit.
//   node scripts/verified-git.mjs ref --name refs/heads/<branch> --sha <sha>
//                                     [--force]
//   node scripts/verified-git.mjs verify-tag --name <tag> [--target <sha>]
//         Fails unless the tag resolves to the expected GitHub-Verified commit.
//   node scripts/verified-git.mjs verify-artifact --branch <branch>
//         --plugin <name> --version <version> --source <sha>
//   node scripts/verified-git.mjs inspect-artifact --branch <branch>
//         --plugin <name>
//   node scripts/verified-git.mjs verify-completion --plugin <name>
//         --version <version> --source <sha>
//
// Writes require a GitHub App installation token with contents write; verifies
// require a token with contents read.
// GITHUB_REPOSITORY and GITHUB_API_URL come from the workflow environment.

import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pluginRefs, repoRoot, requirePlugin } from "./plugins.mjs";

const SHA = /^[0-9a-f]{40}$/;
const REF = /^refs\/(?:heads|tags)\/[^\s~^:?*[\\]+$/;
const MARKETPLACE = ".github/plugin/marketplace.json";
const EXTENSION_ROOT = ".github/extension";
const REGULAR_MODES = new Set(["100644", "100755"]);

// Unwind instead of exiting in place: calling process.exit() while a socket is
// still open aborts Node on Windows before stderr is flushed.
class Failure extends Error {}

function fail(message) {
  throw new Failure(message);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function repeated(args, name) {
  return args.flatMap((arg, index) =>
    arg === name && args[index + 1] !== undefined ? [args[index + 1]] : []
  );
}

function required(value, label) {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} is required`);
  return value;
}

function requireSha(value, label) {
  if (!SHA.test(required(value, label))) {
    fail(`${label} must be a full 40-character commit SHA`);
  }
  return value;
}

const apiUrl = (process.env.GITHUB_API_URL || "https://api.github.com").replace(
  /\/+$/,
  ""
);

function credentials() {
  return {
    repository: required(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
    token: required(process.env.GITHUB_TOKEN, "GITHUB_TOKEN")
  };
}

async function api(method, path, body, absentOn404 = false) {
  const { repository, token } = credentials();
  let response;
  try {
    response = await fetch(`${apiUrl}/repos/${repository}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    fail(`${method} ${path} could not reach GitHub: ${error.message}`);
  }

  const text = await response.text();
  if (absentOn404 && response.status === 404) return undefined;
  if (!response.ok) {
    fail(`${method} ${path} failed with ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${method} ${path} did not return JSON: ${text}`);
  }
}

// GitHub reports why it could not sign; surface that instead of publishing an
// object that would show as Unverified.
function requireVerified(object, label) {
  if (object.verification?.verified !== true) {
    fail(
      `GitHub did not sign the ${label}: ${object.verification?.reason ?? "no verification was returned"}. ` +
        "The request must be authenticated as a GitHub App and omit author, committer, tagger and signature."
    );
  }
  return object;
}

async function verifiedCommit(sha, label) {
  return requireVerified(await api("GET", `/git/commits/${sha}`), label);
}

function collectFile(absolute, path, files) {
  const stats = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stats) fail(`--path does not exist: ${path}`);
  if (stats.isSymbolicLink()) fail(`refusing to publish a symlink: ${path}`);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(absolute)) {
      collectFile(join(absolute, entry), `${path}/${entry}`, files);
    }
    return;
  }
  if (!stats.isFile()) fail(`refusing to publish a non-regular file: ${path}`);
  files.push({
    path,
    absolute,
    mode: stats.mode & 0o111 ? "100755" : "100644"
  });
}

/** Every file the given paths resolve to, confined to the repository. */
function collect(paths) {
  if (paths.length === 0) fail("at least one --path is required");
  const files = [];
  const canonicalRoot = realpathSync(repoRoot);
  for (const declared of paths) {
    if (isAbsolute(declared)) {
      fail(`--path must be repository-relative: ${declared}`);
    }
    const target = resolve(repoRoot, declared);
    const within = relative(repoRoot, target);
    if (within === "" || within.startsWith("..") || isAbsolute(within)) {
      fail(`--path escapes the repository: ${declared}`);
    }
    const declaredStats = lstatSync(target, { throwIfNoEntry: false });
    if (!declaredStats) fail(`--path does not exist: ${declared}`);
    if (declaredStats.isSymbolicLink()) {
      fail(`refusing to publish a symlink: ${declared}`);
    }
    const canonicalTarget = realpathSync(target);
    const canonicalWithin = relative(canonicalRoot, canonicalTarget);
    if (canonicalWithin.startsWith("..") || isAbsolute(canonicalWithin)) {
      fail(`--path resolves outside the repository: ${declared}`);
    }
    collectFile(canonicalTarget, within.split(sep).join("/"), files);
  }
  if (files.length === 0) fail("the given paths contain no files");
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function readRef(name, absentOn404 = false) {
  if (!REF.test(name)) {
    fail(`--name must be a refs/heads or refs/tags ref: ${name}`);
  }
  return api(
    "GET",
    `/git/ref/${name.replace(/^refs\//, "")}`,
    undefined,
    absentOn404
  );
}

async function writeRef(name, sha, force) {
  const existing = await readRef(name, true);
  if (existing) {
    if (!force) fail(`${name} already exists; pass --force to move it`);
    await api("PATCH", `/git/${name}`, { sha, force: true });
  } else {
    await api("POST", "/git/refs", { ref: name, sha });
  }
  return sha;
}

async function commit(args) {
  const message = required(option(args, "--message"), "--message");
  const files = collect(repeated(args, "--path"));
  const tree = [];
  for (const file of files) {
    const blob = await api("POST", "/git/blobs", {
      content: readFileSync(file.absolute).toString("base64"),
      encoding: "base64"
    });
    tree.push({
      path: file.path,
      mode: file.mode,
      type: "blob",
      sha: blob.sha
    });
  }

  // No base_tree, so the tree holds exactly these files, and no parents, so the
  // commit is a root commit.
  const created = await api("POST", "/git/trees", { tree });
  const object = requireVerified(
    await api("POST", "/git/commits", {
      message,
      tree: created.sha,
      parents: []
    }),
    "commit"
  );
  if (object.parents?.length) {
    fail(`GitHub created ${object.sha} with parents; it is not a root commit`);
  }
  console.log(JSON.stringify({ commit: object.sha, tree: created.sha }));
}

async function tag(args) {
  const name = required(option(args, "--name"), "--name");
  const target = requireSha(option(args, "--target"), "--target");
  await verifiedCommit(target, `target commit for tag ${name}`);
  await writeRef(`refs/tags/${name}`, target, args.includes("--force"));
  console.log(target);
}

async function ref(args) {
  const name = required(option(args, "--name"), "--name");
  const sha = requireSha(option(args, "--sha"), "--sha");
  console.log(await writeRef(name, sha, args.includes("--force")));
}

async function verifyTagTarget(name, expected) {
  const existing = await readRef(`refs/tags/${name}`, true);
  if (!existing) fail(`refs/tags/${name} does not exist`);
  let target;
  if (existing.object?.type === "commit") {
    target = requireSha(existing.object.sha, `${name} target`);
  } else if (existing.object?.type === "tag") {
    const object = requireVerified(
      await api("GET", `/git/tags/${existing.object.sha}`),
      `tag ${name}`
    );
    if (object.object?.type !== "commit") {
      fail(`${name} does not resolve directly to a commit`);
    }
    target = requireSha(object.object.sha, `${name} target`);
  } else {
    fail(`${name} does not point at a commit or annotated tag`);
  }
  if (expected !== undefined && target !== expected) {
    fail(`${name} points at ${target}, not ${expected}`);
  }
  await verifiedCommit(target, `target commit for tag ${name}`);
  return target;
}

async function verifyTag(args) {
  const name = required(option(args, "--name"), "--name");
  const expected = option(args, "--target");
  if (expected !== undefined) requireSha(expected, "--target");
  console.log(await verifyTagTarget(name, expected));
}

async function readJsonBlob(entry, label) {
  if (!entry || entry.type !== "blob" || !SHA.test(String(entry.sha))) {
    fail(`${label} is missing from the artifact tree`);
  }
  const blob = await api("GET", `/git/blobs/${entry.sha}`);
  if (blob.encoding !== "base64" || typeof blob.content !== "string") {
    fail(`${label} is not a base64 Git blob`);
  }
  try {
    return JSON.parse(
      Buffer.from(blob.content.replace(/\s/g, ""), "base64").toString("utf8")
    );
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

async function verifyArtifactState({
  plugin,
  version,
  source,
  branch,
  requireCurrentLayout = false
}) {
  const ref = await readRef(`refs/heads/${branch}`, true);
  if (!ref) fail(`refs/heads/${branch} does not exist`);
  if (ref.object?.type !== "commit") {
    fail(`${branch} does not point at a commit`);
  }
  const commitSha = requireSha(ref.object.sha, `${branch} target`);
  const commit = await verifiedCommit(commitSha, `commit ${commitSha}`);
  if (!Array.isArray(commit.parents) || commit.parents.length !== 0) {
    fail(`${branch} must point at a zero-parent commit`);
  }

  const treeSha = requireSha(commit.tree?.sha, `${branch} tree`);
  const tree = await api("GET", `/git/trees/${treeSha}?recursive=1`);
  if (tree.truncated === true || !Array.isArray(tree.tree)) {
    fail(`${branch} did not return a complete recursive tree`);
  }

  const files = tree.tree.filter((entry) => entry.type !== "tree");
  for (const entry of files) {
    const allowed =
      entry.path === MARKETPLACE ||
      entry.path.startsWith(`${plugin.distDir}/`) ||
      entry.path.startsWith(`${EXTENSION_ROOT}/`);
    if (!allowed) fail(`${branch} contains an unexpected path: ${entry.path}`);
    if (entry.type !== "blob" || !REGULAR_MODES.has(entry.mode)) {
      fail(`${branch} contains a non-regular file: ${entry.path}`);
    }
  }

  const rootAssets = new Map(
    files
      .filter((entry) => entry.path.startsWith(`${EXTENSION_ROOT}/`))
      .map((entry) => [entry.path.slice(EXTENSION_ROOT.length + 1), entry.sha])
  );
  const bundledRoot = `${plugin.distDir}/workflows`;
  const bundledAssets = new Map(
    files
      .filter((entry) => entry.path.startsWith(`${bundledRoot}/`))
      .map((entry) => [entry.path.slice(bundledRoot.length + 1), entry.sha])
  );
  if (requireCurrentLayout && rootAssets.size === 0) {
    fail(`${branch} does not contain ${EXTENSION_ROOT}`);
  }
  if (
    (rootAssets.size > 0 || bundledAssets.size > 0) &&
    (rootAssets.size !== bundledAssets.size ||
      [...rootAssets].some(([path, sha]) => bundledAssets.get(path) !== sha))
  ) {
    fail(
      `${branch} does not bundle an exact copy of ${EXTENSION_ROOT} in ${bundledRoot}`
    );
  }

  const packagePath = `${plugin.distDir}/package.json`;
  const packageJson = await readJsonBlob(
    files.find((entry) => entry.path === packagePath),
    packagePath
  );
  if (
    packageJson.name !== plugin.name ||
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    fail(`${packagePath} does not identify a version of ${plugin.name}`);
  }
  const actualVersion = packageJson.version;
  if (version !== undefined && actualVersion !== version) {
    fail(`${packagePath} does not identify ${plugin.name}@${version}`);
  }

  const messagePrefix = `chore(release): ${plugin.name}@${actualVersion} for `;
  const actualSource =
    commit.message?.startsWith(messagePrefix) ?
      commit.message.slice(messagePrefix.length)
    : undefined;
  requireSha(actualSource, `${branch} recorded source`);
  if (
    (requireCurrentLayout || packageJson.radiusSourceRef !== undefined) &&
    packageJson.radiusSourceRef !== actualSource
  ) {
    fail(
      `${packagePath} pins ${String(packageJson.radiusSourceRef)}, not recorded source ${actualSource}`
    );
  }
  if (source !== undefined && actualSource !== source) {
    fail(
      `${branch} does not record ${plugin.name}@${actualVersion} from ${source}`
    );
  }

  const marketplace = await readJsonBlob(
    files.find((entry) => entry.path === MARKETPLACE),
    MARKETPLACE
  );
  const catalogEntry = marketplace.plugins?.find(
    (entry) => entry.name === plugin.name
  );
  if (
    catalogEntry?.version !== actualVersion ||
    catalogEntry?.source?.ref !== branch ||
    catalogEntry?.source?.path !== plugin.distDir
  ) {
    fail(
      `${MARKETPLACE} does not publish ${plugin.name}@${actualVersion} from ${plugin.distDir} at ${branch}`
    );
  }

  return {
    commit: commitSha,
    tree: treeSha,
    version: actualVersion,
    source: actualSource
  };
}

async function verifyArtifact(args) {
  const plugin = requirePlugin(option(args, "--plugin"));
  const version = required(option(args, "--version"), "--version");
  const source = requireSha(option(args, "--source"), "--source");
  const branch = required(option(args, "--branch"), "--branch");
  console.log(
    JSON.stringify(
      await verifyArtifactState({
        plugin,
        version,
        source,
        branch,
        requireCurrentLayout: true
      })
    )
  );
}

async function inspectArtifact(args) {
  const plugin = requirePlugin(option(args, "--plugin"));
  const branch = required(option(args, "--branch"), "--branch");
  console.log(JSON.stringify(await verifyArtifactState({ plugin, branch })));
}

async function verifyCompletion(args) {
  const plugin = requirePlugin(option(args, "--plugin"));
  const version = required(option(args, "--version"), "--version");
  const source = requireSha(option(args, "--source"), "--source");
  const refs = pluginRefs(plugin, { version });
  const artifact = await verifyArtifactState({
    plugin,
    version,
    source,
    branch: refs.PLUGIN_PINNED_BRANCH,
    requireCurrentLayout: true
  });

  await verifyTagTarget(refs.PLUGIN_ARTIFACT_TAG, artifact.commit);
  await verifyTagTarget(refs.PLUGIN_SOURCE_TAG, source);

  const release = await api(
    "GET",
    `/releases/tags/${encodeURIComponent(refs.PLUGIN_SOURCE_TAG)}`,
    undefined,
    true
  );
  if (!release || release.draft !== false) {
    fail(`${refs.PLUGIN_SOURCE_TAG} does not have a published GitHub release`);
  }
  const expectedAssets = [
    refs.PLUGIN_TARBALL,
    refs.PLUGIN_SBOM,
    refs.PLUGIN_AWESOME_COPILOT
  ].sort();
  const actualAssets = (release.assets ?? []).map((asset) => asset.name).sort();
  if (JSON.stringify(actualAssets) !== JSON.stringify(expectedAssets)) {
    fail(`${refs.PLUGIN_SOURCE_TAG} does not have exactly the expected assets`);
  }

  console.log(JSON.stringify(artifact));
}

const [command, ...args] = process.argv.slice(2);
try {
  credentials();
  switch (command) {
    case "commit":
      await commit(args);
      break;
    case "tag":
      await tag(args);
      break;
    case "ref":
      await ref(args);
      break;
    case "verify-tag":
      await verifyTag(args);
      break;
    case "verify-artifact":
      await verifyArtifact(args);
      break;
    case "inspect-artifact":
      await inspectArtifact(args);
      break;
    case "verify-completion":
      await verifyCompletion(args);
      break;
    default:
      fail(`unknown command: ${command ?? "(none)"}`);
  }
} catch (error) {
  if (!(error instanceof Failure)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
