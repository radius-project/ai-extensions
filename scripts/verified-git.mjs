// Creates every commit, tag and ref a release publishes through the GitHub API,
// so GitHub signs each object and publishes it Verified.
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
//   node scripts/verified-git.mjs tag --name <tag> --message <message>
//                                     --target <sha> [--force]
//         Creates the annotated tag object and refs/tags/<tag>.
//   node scripts/verified-git.mjs ref --name refs/heads/<branch> --sha <sha>
//                                     [--force]
//   node scripts/verified-git.mjs verify-tag --name <tag> [--target <sha>]
//         Fails unless refs/tags/<tag> is an annotated tag object that GitHub
//         verified, so a tag written by anything else is never reused.
//
// GITHUB_TOKEN must be a GitHub App installation token with contents write.
// GITHUB_REPOSITORY and GITHUB_API_URL come from the workflow environment.

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { repoRoot } from "./plugins.mjs";

const SHA = /^[0-9a-f]{40}$/;
const REF = /^refs\/(?:heads|tags)\/[^\s~^:?*[\\]+$/;

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
  for (const declared of paths) {
    if (isAbsolute(declared)) {
      fail(`--path must be repository-relative: ${declared}`);
    }
    const target = resolve(repoRoot, declared);
    const within = relative(repoRoot, target);
    if (within === "" || within.startsWith("..") || isAbsolute(within)) {
      fail(`--path escapes the repository: ${declared}`);
    }
    collectFile(target, within.split(sep).join("/"), files);
  }
  if (files.length === 0) fail("the given paths contain no files");
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function writeRef(name, sha, force) {
  if (!REF.test(name)) {
    fail(`--name must be a refs/heads or refs/tags ref: ${name}`);
  }
  const existing = await api(
    "GET",
    `/git/ref/${name.replace(/^refs\//, "")}`,
    undefined,
    true
  );
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
  const message = required(option(args, "--message"), "--message");
  const target = requireSha(option(args, "--target"), "--target");
  const object = requireVerified(
    await api("POST", "/git/tags", {
      tag: name,
      message,
      object: target,
      type: "commit"
    }),
    `tag ${name}`
  );
  await writeRef(`refs/tags/${name}`, object.sha, args.includes("--force"));
  console.log(object.sha);
}

async function ref(args) {
  const name = required(option(args, "--name"), "--name");
  const sha = requireSha(option(args, "--sha"), "--sha");
  console.log(await writeRef(name, sha, args.includes("--force")));
}

async function verifyTag(args) {
  const name = required(option(args, "--name"), "--name");
  const expected = option(args, "--target");
  if (expected !== undefined) requireSha(expected, "--target");

  const existing = await api("GET", `/git/ref/tags/${name}`, undefined, true);
  if (!existing) fail(`refs/tags/${name} does not exist`);
  // A lightweight tag has no object of its own, so it can carry no signature.
  if (existing.object?.type !== "tag") {
    fail(
      `${name} must be an annotated tag, but its ref points straight at a ${existing.object?.type}`
    );
  }

  const object = requireVerified(
    await api("GET", `/git/tags/${existing.object.sha}`),
    `tag ${name}`
  );
  const target = object.object?.sha;
  if (expected !== undefined && target !== expected) {
    fail(`${name} points at ${target}, not ${expected}`);
  }
  console.log(target);
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
    default:
      fail(`unknown command: ${command ?? "(none)"}`);
  }
} catch (error) {
  if (!(error instanceof Failure)) throw error;
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
}
