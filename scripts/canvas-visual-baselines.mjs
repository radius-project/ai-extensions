// Pull request automation for the canonical Canvas visual baselines.
//
// Usage:
//   node scripts/canvas-visual-baselines.mjs affects
//         Reads changed repository paths from stdin, one per line, and prints
//         `true` when any of them can change what the visual suite renders.
//   node scripts/canvas-visual-baselines.mjs apply <directory>
//         Validates regenerated baselines downloaded from an untrusted job,
//         copies every changed PNG into the committed baseline directory, and
//         prints the repository-relative path of each file it changed.
//   node scripts/canvas-visual-baselines.mjs comment --pr <number>
//         --state <state> --run-url <url> [--commit <sha>] [--file <path>]...
//         Creates or updates the single status comment on a pull request.
//
// `comment` requires GITHUB_TOKEN and GITHUB_REPOSITORY; GITHUB_API_URL is
// optional and defaults to the public GitHub API.

import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BASELINE_LABEL = "pr:update-visual-baselines";
export const SNAPSHOT_DIRECTORY =
  "packages/adapter-canvas/test/visual/__screenshots__";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COMMENT_AUTHOR = "github-actions[bot]";
const COMMENT_MARKER = "<!-- canvas-visual-baselines -->";
const STATE_MARKER = /<!-- canvas-visual-baselines:state=([a-z-]+) -->/;
const BASELINE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);
const SHA = /^[0-9a-f]{40}$/;
const PAGE_SIZE = 100;

export const MAX_BASELINE_FILES = 200;
export const MAX_BASELINE_BYTES = 5 * 1024 * 1024;

// Anything the canonical container copies in can change a rendered pixel.
const VISUAL_INPUT_PREFIXES = ["packages/"];
const VISUAL_INPUT_FILES = new Set([
  ".dockerignore",
  ".github/workflows/canvas-functional.yml",
  ".node-version",
  ".npmrc",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/canvas-visual.mjs"
]);

export const COMMENT_STATES = [
  "mismatch",
  "failed",
  "passed",
  "updated",
  "unchanged",
  "update-failed"
];

export function affectsCanvasVisuals(paths) {
  return paths.some(
    (path) =>
      VISUAL_INPUT_FILES.has(path) ||
      VISUAL_INPUT_PREFIXES.some((prefix) => path.startsWith(prefix))
  );
}

function existingRegularFile(path, label) {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats && !stats.isFile()) {
    throw new Error(`${label} is not a regular file`);
  }
  return stats !== undefined;
}

/**
 * Copies regenerated baselines into the committed baseline directory. The
 * source comes from a job that ran pull request code, so every entry must be a
 * plainly named, bounded PNG; anything else rejects the whole update.
 */
export function applyBaselineUpdates(source, { root = repoRoot } = {}) {
  const target = resolve(root, SNAPSHOT_DIRECTORY);
  const targetStats = lstatSync(target, { throwIfNoEntry: false });
  if (!targetStats?.isDirectory()) {
    throw new Error(`${SNAPSHOT_DIRECTORY} is not a directory`);
  }

  const entries = readdirSync(source, { withFileTypes: true });
  if (entries.length === 0) {
    throw new Error("The regenerated baseline artifact is empty");
  }
  if (entries.length > MAX_BASELINE_FILES) {
    throw new Error(
      `The regenerated baseline artifact has ${entries.length} entries; the limit is ${MAX_BASELINE_FILES}`
    );
  }

  const updates = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!BASELINE_NAME.test(name)) {
      throw new Error(`Refusing an unexpected baseline name: ${name}`);
    }
    if (!entry.isFile()) {
      throw new Error(
        `Refusing a baseline that is not a regular file: ${name}`
      );
    }
    const stats = lstatSync(join(source, name));
    if (stats.size > MAX_BASELINE_BYTES) {
      throw new Error(
        `Refusing ${name}: ${stats.size} bytes exceeds the ${MAX_BASELINE_BYTES} byte limit`
      );
    }
    const content = readFileSync(join(source, name));
    if (!content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`Refusing ${name}: it is not a PNG image`);
    }

    const destination = join(target, name);
    if (
      existingRegularFile(destination, `${SNAPSHOT_DIRECTORY}/${name}`) &&
      readFileSync(destination).equals(content)
    ) {
      continue;
    }
    updates.push({ name, content, destination });
  }

  // Validate everything before writing anything, so a rejected artifact never
  // leaves a partial update behind.
  for (const { content, destination } of updates) {
    writeFileSync(destination, content);
  }
  return updates.map(({ name }) => `${SNAPSHOT_DIRECTORY}/${name}`).sort();
}

const labelHint = `add the \`${BASELINE_LABEL}\` label to this pull request`;

function link(runUrl) {
  return `[workflow run](${runUrl})`;
}

export function renderComment({ state, runUrl, files = [], commit }) {
  const lines = (() => {
    switch (state) {
      case "mismatch":
        return [
          "### Canvas visual baselines are out of date",
          "",
          `**Visual comparisons** found screenshots that no longer match their committed baselines. The actual, expected, and diff images are in the \`canvas-visual-functional\` artifact of the ${link(runUrl)}.`,
          "",
          `- **If the UI change is intended,** ${labelHint}. A workflow regenerates the baselines and commits them to this branch.`,
          "- **If it is not intended,** fix the UI and push again.",
          "",
          "Review every regenerated image in **Files changed** before approving."
        ];
      case "failed":
        return [
          "### Canvas visual comparisons failed",
          "",
          `**Visual comparisons** failed without a screenshot mismatch, so an outdated baseline is not the cause. See the ${link(runUrl)}.`
        ];
      case "passed":
        return [
          "### Canvas visual baselines match",
          "",
          `The latest **Visual comparisons** run passed. See the ${link(runUrl)}.`
        ];
      case "updated":
        return [
          "### Canvas visual baselines updated",
          "",
          `Committed ${files.length} regenerated ${files.length === 1 ? "baseline" : "baselines"} in ${commit}:`,
          "",
          ...files.map((file) => `- \`${file}\``),
          "",
          "**Visual comparisons** runs again on the new commit. Review every changed image in **Files changed** before approving.",
          "",
          `See the ${link(runUrl)}.`
        ];
      case "unchanged":
        return [
          "### Canvas visual baselines already current",
          "",
          `Regenerating the baselines produced no changes, so an outdated baseline is not what failed **Visual comparisons**. See the ${link(runUrl)}.`
        ];
      case "update-failed":
        return [
          "### Canvas visual baselines were not updated",
          "",
          `The baseline update failed. If you pushed to this branch after adding the label, ${labelHint} again. Otherwise see the ${link(runUrl)}.`
        ];
    }
  })();
  return [
    COMMENT_MARKER,
    `<!-- canvas-visual-baselines:state=${state} -->`,
    ...lines
  ].join("\n");
}

function parseCommentArgs(args) {
  const options = { files: [] };
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if (value === undefined) throw new Error(`${name} requires a value`);
    switch (name) {
      case "--pr":
        options.pr = value;
        break;
      case "--state":
        options.state = value;
        break;
      case "--run-url":
        options.runUrl = value;
        break;
      case "--commit":
        options.commit = value;
        break;
      case "--file":
        options.files.push(value);
        break;
      default:
        throw new Error(`Unknown comment option: ${name}`);
    }
  }
  return options;
}

export function validateCommentOptions({ pr, state, runUrl, files, commit }) {
  if (!/^[1-9][0-9]*$/.test(String(pr ?? ""))) {
    throw new Error("--pr must be a pull request number");
  }
  if (!COMMENT_STATES.includes(state)) {
    throw new Error(`--state must be one of: ${COMMENT_STATES.join(", ")}`);
  }
  if (!/^https:\/\/[^\s()]+$/.test(runUrl ?? "")) {
    throw new Error("--run-url must be an https URL");
  }
  for (const file of files) {
    const name =
      file.startsWith(`${SNAPSHOT_DIRECTORY}/`) ?
        file.slice(SNAPSHOT_DIRECTORY.length + 1)
      : "";
    if (!BASELINE_NAME.test(name)) {
      throw new Error(`--file is not a committed baseline path: ${file}`);
    }
  }
  if (state === "updated") {
    if (!SHA.test(commit ?? "")) {
      throw new Error("--commit must be a full commit SHA for updated");
    }
    if (files.length === 0) {
      throw new Error("--file is required for updated");
    }
  }
  return { pr: Number(pr), state, runUrl, files, commit };
}

export function createGitHubRequest({
  token,
  repository,
  apiUrl = "https://api.github.com",
  fetchImpl = fetch
}) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  const base = `${apiUrl.replace(/\/+$/, "")}/repos/${repository}`;
  return async (method, path, body) => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `${method} ${path} failed with ${response.status}: ${text}`
      );
    }
    return JSON.parse(text);
  };
}

async function findStatusComment(request, pr) {
  for (let page = 1; ; page += 1) {
    const comments = await request(
      "GET",
      `/issues/${pr}/comments?per_page=${PAGE_SIZE}&page=${page}`
    );
    const found = comments.find(
      (comment) =>
        comment.user?.login === COMMENT_AUTHOR &&
        comment.body?.startsWith(COMMENT_MARKER)
    );
    if (found || comments.length < PAGE_SIZE) return found;
  }
}

/**
 * Keeps one status comment per pull request. A passing check never creates a
 * comment, and never replaces the record of an automated baseline commit.
 */
export async function upsertStatusComment(request, options) {
  const { pr, state } = options;
  const existing = await findStatusComment(request, pr);
  if (state === "passed") {
    const previous = existing?.body.match(STATE_MARKER)?.[1];
    if (!existing || previous === "passed" || previous === "updated") {
      return "unchanged";
    }
  }
  const body = renderComment(options);
  if (existing) {
    await request("PATCH", `/issues/comments/${existing.id}`, { body });
    return "updated";
  }
  await request("POST", `/issues/${pr}/comments`, { body });
  return "created";
}

export async function runCli(
  argv,
  {
    env = process.env,
    readStdin = () => readFileSync(0, "utf8"),
    write = (text) => process.stdout.write(text),
    root = repoRoot,
    fetchImpl = fetch
  } = {}
) {
  const [command, ...args] = argv;
  switch (command) {
    case "affects": {
      const paths = readStdin()
        .split(/\r?\n/)
        .filter((path) => path.length > 0);
      write(`${affectsCanvasVisuals(paths)}\n`);
      return;
    }
    case "apply": {
      if (args.length !== 1) {
        throw new Error(
          "Usage: node scripts/canvas-visual-baselines.mjs apply <directory>"
        );
      }
      const files = applyBaselineUpdates(args[0], { root });
      if (files.length > 0) write(`${files.join("\n")}\n`);
      return;
    }
    case "comment": {
      const options = validateCommentOptions(parseCommentArgs(args));
      const request = createGitHubRequest({
        token: env.GITHUB_TOKEN,
        repository: env.GITHUB_REPOSITORY,
        apiUrl: env.GITHUB_API_URL || undefined,
        fetchImpl
      });
      const result = await upsertStatusComment(request, options);
      write(`${result}\n`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command ?? "(none)"}`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
