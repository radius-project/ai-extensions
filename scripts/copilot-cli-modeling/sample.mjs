// Reads one case from `cases/` and plans its checkout.
//
// The dataset's trial protocol is a new checkout at the pinned commit with
// `.git` and `origin` kept, a sparse checkout when `source.path` is set, and
// each `source.exclude` path deleted before the session starts. This module
// turns a `case.yaml` into that plan.
//
// `case.yaml` uses a small fixed format. The parser accepts only that format
// and rejects every other line, so a changed dataset format fails here
// instead of silently checking out the wrong source.

import path from "node:path";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

const REPOSITORY_PATTERN =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

const SCALAR_KEYS = new Set(["repo", "commit", "path"]);

function stripComment(line) {
  if (/^\s*#/.test(line)) return "";

  return line.replace(/\s+#.*$/, "").trimEnd();
}

function unquote(value) {
  const match = /^(["'])(.*)\1$/.exec(value);

  return match ? (match[2] ?? "") : value;
}

/**
 * Validates a relative POSIX path from the dataset. Absolute paths, `..`
 * segments, backslashes, and empty segments are rejected.
 */
export function validateRelativePath(value, field) {
  const trimmed = value.replace(/\/+$/, "");
  const segments = trimmed.split("/");

  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".."
    )
  )
    throw new Error(
      `${field} must be a relative path inside the sample: "${value}".`
    );

  return trimmed;
}

/** @param text The contents of a `case.yaml`. */
export function parseCaseYaml(text) {
  const scalars = new Map();
  let exclude;
  let sawSource = false;
  let inExclude = false;

  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = stripComment(raw);

    if (!line.trim()) continue;

    const unsupported = () =>
      new Error(`case.yaml line ${index + 1} is not supported: "${raw}".`);

    if (!sawSource) {
      if (line !== "source:") throw unsupported();
      sawSource = true;
      continue;
    }

    const item = /^ {4}- (.+)$/.exec(line)?.[1];

    if (item !== undefined) {
      if (!inExclude || !exclude) throw unsupported();
      exclude.push(unquote(item.trim()));
      continue;
    }

    const [, key, value] = /^ {2}([a-z]+):(?: (.+))?$/.exec(line) ?? [];

    if (key === "exclude" && value === undefined && !exclude) {
      exclude = [];
      inExclude = true;
    } else if (
      key !== undefined &&
      SCALAR_KEYS.has(key) &&
      value !== undefined &&
      !scalars.has(key)
    ) {
      scalars.set(key, unquote(value.trim()));
      inExclude = false;
    } else throw unsupported();
  }

  if (!sawSource) throw new Error("case.yaml has no source section.");
  const repo = scalars.get("repo") ?? "";
  const repoMatch = REPOSITORY_PATTERN.exec(repo);

  if (!repoMatch)
    throw new Error(
      `source.repo must be a https://github.com/<owner>/<name> URL: "${repo}".`
    );
  const commit = scalars.get("commit") ?? "";

  if (!COMMIT_PATTERN.test(commit))
    throw new Error(`source.commit must be a full commit SHA: "${commit}".`);

  if (exclude?.length === 0)
    throw new Error("source.exclude must list at least one path.");
  const samplePath = scalars.get("path");

  return {
    repo: `https://github.com/${repoMatch[1]}/${repoMatch[2]}`,
    commit,
    path:
      samplePath === undefined ? undefined : (
        validateRelativePath(samplePath, "source.path")
      ),
    exclude: (exclude ?? []).map((entry) =>
      validateRelativePath(entry, "source.exclude")
    )
  };
}

/** The git commands, as argv arrays, that make the trial checkout. */
export function checkoutCommands(sample, checkoutDir) {
  const commands = [
    ["init", "-q", checkoutDir],
    ["-C", checkoutDir, "remote", "add", "origin", sample.repo]
  ];

  if (sample.path)
    commands.push([
      "-C",
      checkoutDir,
      "sparse-checkout",
      "set",
      "--no-cone",
      `/${sample.path}/`
    ]);
  commands.push(
    ["-C", checkoutDir, "fetch", "-q", "--depth", "1", "origin", sample.commit],
    ["-C", checkoutDir, "checkout", "-q", "FETCH_HEAD"]
  );

  return commands;
}

/**
 * The repository name, which the run uses as the checkout folder name. The
 * agent can see that name.
 */
export function repositoryName(sample) {
  const name = sample.repo.split("/").at(-1) ?? "";

  if (!name || name === "." || name === "..")
    throw new Error(`source.repo has no repository name: "${sample.repo}".`);

  return name;
}

/** The directory the agent session starts in. */
export function sessionRoot(sample, checkoutDir) {
  return sample.path ? path.join(checkoutDir, sample.path) : checkoutDir;
}

/**
 * Absolute paths to delete before the session starts. Each path must stay
 * inside the session root.
 */
export function excludeTargets(sample, root) {
  return sample.exclude.map((entry) => {
    const target = path.resolve(root, entry);
    const relative = path.relative(root, target);

    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new Error(`source.exclude leaves the sample: "${entry}".`);

    return target;
  });
}
