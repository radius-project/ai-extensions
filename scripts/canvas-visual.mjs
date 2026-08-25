import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path, { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_VISUAL_IMAGE =
  "radius-canvas-visual:playwright-1.62.1-node-24.19.0";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dockerfile = "packages/adapter-canvas/test/visual/Dockerfile";
const packageRoot = "packages/adapter-canvas";
const snapshots = `${packageRoot}/test/visual/__screenshots__`;
const testResults = `${packageRoot}/test-results`;
const htmlReport = `${packageRoot}/playwright-visual-report`;

export function parseVisualMode(argv) {
  if (argv.length !== 1 || !["check", "update"].includes(argv[0])) {
    throw new Error("Usage: node scripts/canvas-visual.mjs <check|update>");
  }
  return argv[0];
}

function bindMount(source, target, readOnly = false) {
  return `type=bind,source=${source},target=${target}${readOnly ? ",readonly" : ""}`;
}

export function createDockerRunArgs({ mode, root, uid, gid, pathApi = path }) {
  const args = [
    "run",
    "--rm",
    "--init",
    "--ipc=host",
    "--platform",
    "linux/amd64"
  ];
  if (Number.isInteger(uid) && Number.isInteger(gid)) {
    args.push("--user", `${uid}:${gid}`, "--env", "HOME=/tmp");
  }
  args.push(
    "--mount",
    bindMount(
      pathApi.resolve(root, snapshots),
      `/workspace/${snapshots}`,
      mode === "check"
    ),
    "--mount",
    bindMount(pathApi.resolve(root, testResults), `/workspace/${testResults}`),
    "--mount",
    bindMount(pathApi.resolve(root, htmlReport), `/workspace/${htmlReport}`),
    CANONICAL_VISUAL_IMAGE,
    "pnpm",
    "run",
    mode === "check" ? "test:visual:stability" : "test:visual:update"
  );
  return args;
}

export function createDockerBuildArgs({
  root = repoRoot,
  home = homedir(),
  fileExists = existsSync,
  pathApi = path
} = {}) {
  const args = [
    "build",
    "--platform",
    "linux/amd64",
    "--file",
    dockerfile,
    "--tag",
    CANONICAL_VISUAL_IMAGE
  ];
  const userNpmrc = pathApi.resolve(home, ".npmrc");
  if (fileExists(userNpmrc)) {
    args.push("--secret", `id=npmrc,src=${userNpmrc}`);
  }
  args.push(root);
  return args;
}

export function dockerPrerequisiteError(result) {
  if (result.error?.code === "ENOENT") {
    return "Docker is required for canonical Canvas visual tests. Install Docker Desktop or Docker Engine, then retry.";
  }
  if (result.error) {
    return `Docker could not be started: ${result.error.message}`;
  }
  if (result.status !== 0 || !result.stdout?.trim()) {
    const detail = result.stderr?.trim();
    return `The Docker CLI is installed, but the Docker daemon is unavailable. Start Docker Desktop or Docker Engine, then retry.${detail ? `\n${detail}` : ""}`;
  }
  const [, osType] = result.stdout.trim().split("|");
  if (osType !== "linux") {
    return osType ?
        `Docker is running with ${osType} containers. Switch Docker Desktop to Linux containers (or enable a Linux engine), then retry.`
      : "Docker did not report its container engine type. Ensure Docker is configured to run Linux containers, then retry.";
  }
  return null;
}

function runDocker(args, options = {}) {
  return spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
}

function requireDocker() {
  const result = runDocker(
    ["info", "--format", "{{.ServerVersion}}|{{.OSType}}"],
    {
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const error = dockerPrerequisiteError(result);
  if (error) throw new Error(error);
}

function prepareOutputDirectories() {
  for (const directory of [testResults, htmlReport]) {
    const absolutePath = resolve(repoRoot, directory);
    rmSync(absolutePath, { recursive: true, force: true });
    mkdirSync(absolutePath, { recursive: true });
  }
}

function requireSuccessfulCommand(result, description) {
  if (result.error) {
    throw new Error(`${description}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${description}. Review the Docker output above.`);
  }
}

export function runCanonicalVisual(argv = process.argv.slice(2)) {
  const mode = parseVisualMode(argv);
  requireDocker();
  prepareOutputDirectories();

  const build = runDocker(createDockerBuildArgs(), { stdio: "inherit" });
  requireSuccessfulCommand(build, "Failed to build the canonical visual image");

  const run = runDocker(
    createDockerRunArgs({
      mode,
      root: repoRoot,
      uid: process.getuid?.(),
      gid: process.getgid?.()
    }),
    { stdio: "inherit" }
  );
  if (run.error) {
    throw new Error(
      `Failed to run the canonical visual tests: ${run.error.message}`
    );
  }
  return run.status ?? 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    process.exitCode = runCanonicalVisual();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}
