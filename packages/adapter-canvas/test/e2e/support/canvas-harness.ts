import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";
import {
  azureDiscoveryContract,
  type AzureDiscoveryCluster
} from "../../support/azure-discovery-contract.js";
import type { CanvasState, SharedCredentials } from "../../../src/shared.js";
import type { CanvasServerEntry } from "../../../src/server/types.js";

// Resolved from this module rather than the process directory so the suite
// behaves identically whether it is launched from the workspace root or from
// packages/adapter-canvas.
export const E2E_TMP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".tmp"
);
const WINDOWS_SHIM_ROOT = path.join(E2E_TMP_ROOT, ".windows-shim");
// packages/adapter-canvas/test/e2e/support -> repository root.
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".."
);
export const CREDENTIAL_STORE_PATH = path.join(
  E2E_TMP_ROOT,
  "credential-cache.json"
);
export const CREDENTIAL_SENTINEL = "personal-cache-must-not-leak";
const PLACEHOLDER_SECRET = "ghp_PLACEHOLDER_DO_NOT_USE_000000000000";
export const REPOSITORY = "fixture/radius-app";
export const WORKTREE_BRANCH = "feature/phase-6";
export const PROFILE_NAME = "fixture-azure";
const PROFILE_USER = "fixture-user";
const PROFILE_TENANT_ID = "11111111-1111-1111-1111-111111111111";
// The subscription every suite's fixture profile is provisioned with. Exported
// so the browser suites name the one subscription once instead of each
// declaring its own constant for the same value.
export const PROFILE_SUBSCRIPTION_ID = "22222222-2222-2222-2222-222222222222";
export const OPERATION_ID = "operation-fixture-1";
export const VERIFICATION_WORKFLOW_BLOB_SHA = "b".repeat(40);
export const VERIFICATION_WORKFLOW_CONTENT = "name: Fixture verification\n";
export const VERIFICATION_WORKFLOW_CONTENT_SHA256 = createHash("sha256")
  .update(VERIFICATION_WORKFLOW_CONTENT)
  .digest("hex");

type ServerModule = typeof import("../../../src/server.js");
type GhModule = typeof import("../../../src/gh.js");
type SharedModule = typeof import("../../../src/shared.js");
type OperationsModule = typeof import("../../../src/operations.js");

interface RetryRemovalOptions {
  attempts?: number;
  remove?: (directory: string) => Promise<void>;
  delay?: (milliseconds: number) => Promise<void>;
}

interface ConstructionCleanup {
  rootDir: string;
  originalEnv: Record<string, string | undefined>;
  resetState?: () => void;
  stopServer?: () => Promise<void>;
  removeDirectory?: (directory: string) => Promise<void>;
}

interface HarnessServerEntry {
  server: {
    close(callback?: (error?: Error) => void): unknown;
    closeAllConnections?(): void;
    readonly listening: boolean;
  };
}

interface HarnessServerStopPort {
  servers: { has(instanceId: string): boolean };
  stopServer(instanceId: string, force?: boolean): Promise<void>;
}

export interface FakeCliCommand {
  tool: string;
  args?: string[];
  argsPrefix?: string[];
  /**
   * Pins the trailing arguments when a command embeds a value the harness
   * cannot predict, such as the temporary kubeconfig path discovery generates.
   * Combined with `argsPrefix` it leaves only the unpredictable span unchecked.
   */
  argsSuffix?: string[];
  env?: Record<string, "present" | "absent" | string>;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  writeFiles?: Array<{ path: string; content: string; executable?: boolean }>;
}

/**
 * How the fake CLI decides a command models an invocation. Defined once and
 * injected into the generated script by source, so a stub asserted against this
 * predicate in a unit test is matched by exactly the same rule at runtime.
 */
export function fakeCliArgsMatch(
  command: Pick<FakeCliCommand, "args" | "argsPrefix" | "argsSuffix">,
  args: string[]
): boolean {
  if (Array.isArray(command.args)) {
    return JSON.stringify(command.args) === JSON.stringify(args);
  }
  const prefix = command.argsPrefix;
  const suffix = command.argsSuffix;
  if (!Array.isArray(prefix) && !Array.isArray(suffix)) {
    return args.length === 0;
  }
  const head = Array.isArray(prefix) ? prefix : [];
  const tail = Array.isArray(suffix) ? suffix : [];
  // Overlapping ends would let a short argument list satisfy both halves twice.
  if (head.length + tail.length > args.length) return false;
  return (
    head.every((value, index) => args[index] === value) &&
    tail.every(
      (value, index) => args[args.length - tail.length + index] === value
    )
  );
}

export interface FakeCliScenario {
  commands: FakeCliCommand[];
}

export type FakeCliCommandOverride = (
  command: FakeCliCommand
) => FakeCliCommand;

export const FAKE_CLI_TOOLS = ["gh", "rad", "az", "aws", "kubectl"] as const;

// The failure payload a partial deletion records, matching the shape the
// production delete runner writes (src/server/services/environment-deletion.ts).
// The stage is supplied by the harness because only the runner knows the real
// stage id of the operation the delete route created.
export interface EnvironmentDeletionFailure {
  code: string;
  stepSeq: number | null;
  message: string;
  classification: string;
  evidence: string | null;
}

// The terminal a driven deletion should reach: a clean success that walks every
// stage to succeeded, or a partial failure that fails the first stage.
export type EnvironmentDeletionOutcome =
  | { state: "succeeded" }
  | { state: "failed_partial"; failure: EnvironmentDeletionFailure };

// Hands the test a release it can await: it resolves only once the runner has
// entered the first stage and parked on its release promise, so a caller can
// never drop the signal by firing it before the server-owned runner installed
// the resolver.
export interface DrivenEnvironmentDeletion {
  release(): Promise<void>;
}

/**
 * Which outside world the harness runs against.
 *
 * `fake` is every existing suite: generated CLI shims on `PATH`, a placeholder
 * token, and intercepted registry traffic. `cloud` removes exactly those four
 * substitutions so the same server, routes, and browser run against real
 * `gh`, `az`, `rad`, and `kubectl`. Nothing above the seams changes.
 */
export type CanvasHarnessMode = "fake" | "cloud";

export interface HarnessProcessPlanInput {
  mode: CanvasHarnessMode;
  fakeBin: string;
  ghConfigDir: string;
  /** Present only in fake mode; the generated shim script and its side files. */
  fakeScript?: string;
  scenarioPath?: string;
  cliLogPath?: string;
  pathKey: "PATH" | "Path";
  currentPath: string;
  isWindows: boolean;
  /** The existing `RADIUS_CREDENTIALS_FILE`, preserved when already isolated. */
  credentialsFile?: string;
  /** Cloud mode only: the runner's GitHub token. */
  githubToken?: string;
}

export interface HarnessProcessPlan {
  readonly env: Record<string, string>;
  /** Variables the caller must delete; omitting them would leave a stale value. */
  readonly unsetEnv: readonly string[];
  readonly useFakeCli: boolean;
  readonly interceptFetch: boolean;
}

const FAKE_CLI_ENV_KEYS = [
  "RADIUS_FAKE_CLI_SCRIPT",
  "RADIUS_FAKE_CLI_SCENARIO",
  "RADIUS_FAKE_CLI_LOG",
  "RADIUS_RAD_BINARY",
  "RADIUS_RAD_SKIP_VERSION_CHECK"
] as const;

/**
 * Resolves every process-level difference between the two modes in one place,
 * so the mode switch is a pure function with assertable output rather than a
 * set of conditionals spread through construction.
 */
export function planHarnessProcess(
  input: HarnessProcessPlanInput
): HarnessProcessPlan {
  const env: Record<string, string> = {
    GH_CONFIG_DIR: input.ghConfigDir,
    RADIUS_CREDENTIALS_FILE: input.credentialsFile || CREDENTIAL_STORE_PATH
  };

  if (input.mode === "cloud") {
    const token = input.githubToken?.trim();
    if (!token)
      throw new Error(
        "Cloud mode requires GH_TOKEN. Export a token for the fixture repository before running the cloud suite."
      );
    // A leaked fake-mode token would authenticate nothing while looking real,
    // so cloud mode fails closed rather than reporting an opaque gh failure.
    if (token === PLACEHOLDER_SECRET)
      throw new Error(
        "Cloud mode received the fake-mode placeholder token. Export a real token for the fixture repository."
      );
    // PATH is left alone so the real tools resolve, and the fake-CLI variables
    // are unset rather than blanked: an inherited value would silently redirect
    // a real invocation back into the shim.
    env.GH_TOKEN = token;
    env.GITHUB_TOKEN = token;
    return {
      env,
      unsetEnv: [...FAKE_CLI_ENV_KEYS],
      useFakeCli: false,
      interceptFetch: false
    };
  }

  if (!input.fakeScript || !input.scenarioPath || !input.cliLogPath)
    throw new Error(
      "Fake mode requires a generated CLI script, scenario path, and log path."
    );

  const nextPath = `${input.fakeBin}${path.delimiter}${input.currentPath}`;
  env[input.pathKey] = nextPath;
  env.PATH = nextPath;
  env.GH_TOKEN = PLACEHOLDER_SECRET;
  env.GITHUB_TOKEN = PLACEHOLDER_SECRET;
  env.RADIUS_FAKE_CLI_SCRIPT = input.fakeScript;
  env.RADIUS_FAKE_CLI_SCENARIO = input.scenarioPath;
  env.RADIUS_FAKE_CLI_LOG = input.cliLogPath;
  env.RADIUS_RAD_BINARY = path.join(
    input.fakeBin,
    input.isWindows ? "rad.exe" : "rad"
  );
  // The shim has no version to report. A real `rad` must answer the product's
  // version check, so cloud mode deliberately leaves this unset.
  env.RADIUS_RAD_SKIP_VERSION_CHECK = "1";
  return { env, unsetEnv: [], useFakeCli: true, interceptFetch: true };
}

/**
 * Applies a plan to a process environment. Deleting `unsetEnv` before the
 * assignment is the point: an inherited `RADIUS_FAKE_CLI_*` value would
 * otherwise survive into cloud mode and redirect a real invocation into the
 * shim, and an omitted key cannot clear one.
 */
export function applyHarnessProcessPlan(
  plan: HarnessProcessPlan,
  env: NodeJS.ProcessEnv = process.env
): void {
  for (const key of plan.unsetEnv) delete env[key];
  Object.assign(env, plan.env);
}

export interface HarnessWorkspacePlan {
  readonly path: string;
  /** Fake mode scaffolds an empty `.radius`; a clone already carries one. */
  readonly createRadiusDirectory: boolean;
  /** Fake mode needs a disposable Git repository; cloud mode uses its clone. */
  readonly initializeGitRepository: boolean;
}

/**
 * Fake-CLI helpers write or read files no real tool consults, so in cloud mode
 * they would quietly do nothing and let a test assert against an empty log.
 * Failing here keeps that mistake visible.
 */
export function assertFakeModeAvailable(
  mode: CanvasHarnessMode,
  operation: string
): void {
  if (mode !== "fake")
    throw new Error(
      `${operation} is only available in fake mode; this harness is in ${mode} mode.`
    );
}

function isSameOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function resolveHarnessWorkspace(input: {
  mode: CanvasHarnessMode;
  rootDir: string;
  workspacePath?: string;
  /**
   * The checkout running the suite. A cloud harness commits, pushes, and
   * deploys from its workspace, so the two must be disjoint.
   */
  repositoryRoot?: string;
}): HarnessWorkspacePlan {
  if (input.mode === "cloud") {
    if (!input.workspacePath)
      throw new Error(
        "Cloud mode requires workspacePath, a clone of the fixture repository."
      );
    if (!path.isAbsolute(input.workspacePath))
      throw new Error(
        `Cloud mode requires an absolute workspacePath; received "${input.workspacePath}".`
      );
    const workspacePath = path.resolve(input.workspacePath);
    const repositoryRoot =
      input.repositoryRoot ? path.resolve(input.repositoryRoot) : undefined;
    if (
      repositoryRoot &&
      (isSameOrInside(repositoryRoot, workspacePath) ||
        isSameOrInside(workspacePath, repositoryRoot))
    )
      throw new Error(
        `Cloud mode refuses to run against the checkout under test; workspacePath "${workspacePath}" overlaps "${repositoryRoot}". Clone the fixture repository to a disposable directory instead.`
      );
    return {
      path: workspacePath,
      createRadiusDirectory: false,
      initializeGitRepository: false
    };
  }
  if (input.workspacePath)
    throw new Error("workspacePath is only supported in cloud mode.");
  return {
    path: path.join(input.rootDir, "workspace"),
    createRadiusDirectory: true,
    initializeGitRepository: true
  };
}

/**
 * The caller owns the clone's lifecycle: the harness never deletes or resets a
 * directory it did not create. Cloud mode still refuses to start against a
 * directory that is not a git worktree, because a real `gh` or `rad` run there
 * would fail far from the cause.
 */
export async function assertCloudWorkspaceClone(
  workspacePath: string,
  access: (target: string) => Promise<void> = (target) => fs.access(target)
): Promise<void> {
  try {
    await access(path.join(workspacePath, ".git"));
  } catch {
    throw new Error(
      `Cloud mode requires workspacePath to be a git clone; "${workspacePath}" has no .git entry.`
    );
  }
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface CanvasHarnessOptions {
  page: Page;
  title: string;
  initialState?: CanvasState;
  initialPage?: string;
  /** Defaults to "fake", so every existing suite is unaffected. */
  mode?: CanvasHarnessMode;
  /**
   * Cloud mode only: an absolute path to a real clone to run against, disjoint
   * from the checkout running the suite. The caller owns its lifecycle; the
   * harness never deletes or resets a directory it did not create.
   */
  workspacePath?: string;
}

let serverModulePromise: Promise<ServerModule> | null = null;
let credentialIsolationVerified = false;

async function loadServerModule(): Promise<ServerModule> {
  serverModulePromise ??= import("../../../src/server.js");
  return await serverModulePromise;
}

function sanitizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48);
}

async function writeExecutable(
  filePath: string,
  content: string
): Promise<void> {
  await fs.writeFile(filePath, content, "utf8");
  if (process.platform !== "win32") await fs.chmod(filePath, 0o755);
}

export async function prepareWindowsShim(): Promise<string> {
  await fs.mkdir(WINDOWS_SHIM_ROOT, { recursive: true });
  const source = path.join(WINDOWS_SHIM_ROOT, "fake-cli-shim.go");
  const output = path.join(WINDOWS_SHIM_ROOT, "shim.exe");
  try {
    await fs.access(output);
    return output;
  } catch {
    // Build once in global setup, outside an individual journey's 30-second
    // budget. Tests copy the resulting executable into their isolated PATH.
  }
  await fs.writeFile(
    source,
    `
package main

import (
  "fmt"
  "os"
  "os/exec"
  "path/filepath"
  "strings"
)

func main() {
  script := os.Getenv("RADIUS_FAKE_CLI_SCRIPT")
  if script == "" {
    fmt.Fprintln(os.Stderr, "RADIUS_FAKE_CLI_SCRIPT is not set")
    os.Exit(127)
  }
  tool := strings.TrimSuffix(filepath.Base(os.Args[0]), filepath.Ext(os.Args[0]))
  args := append([]string{script, tool}, os.Args[1:]...)
  cmd := exec.Command("node", args...)
  cmd.Stdout = os.Stdout
  cmd.Stderr = os.Stderr
  cmd.Stdin = os.Stdin
  cmd.Env = os.Environ()
  if err := cmd.Run(); err != nil {
    if exitErr, ok := err.(*exec.ExitError); ok {
      os.Exit(exitErr.ExitCode())
    }
    fmt.Fprintln(os.Stderr, err.Error())
    os.Exit(127)
  }
}
`,
    "utf8"
  );
  execFileSync("go", ["build", "-o", output, source], {
    cwd: WINDOWS_SHIM_ROOT,
    stdio: "pipe"
  });
  return output;
}

async function createWindowsShim(fakeBin: string): Promise<void> {
  const output = await prepareWindowsShim();
  for (const tool of ["aws", "gh", "kubectl", "rad"]) {
    await fs.copyFile(output, path.join(fakeBin, `${tool}.exe`));
  }
}

async function writeFakeCli(fakeBin: string): Promise<string> {
  // Keep the script at suite scope rather than inside an individual workspace.
  // A background server task may already have spawned a shim when teardown
  // removes that workspace; the shared script survives until global teardown
  // and can then observe the missing per-test scenario and exit quietly.
  const script = path.join(E2E_TMP_ROOT, "fake-cli.mjs");
  await fs.writeFile(
    script,
    `
import { promises as fs } from "node:fs";
import path from "node:path";

const [, , tool, ...args] = process.argv;
const scenarioPath = process.env.RADIUS_FAKE_CLI_SCENARIO;
const logPath = process.env.RADIUS_FAKE_CLI_LOG;
const stdin = await Promise.race([
new Promise((resolve) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => value += chunk);
  process.stdin.on("end", () => resolve(value));
}),
new Promise((resolve) => setTimeout(() => resolve(""), 25))
]);

async function appendLog(entry) {
  if (!logPath) return;
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, JSON.stringify(entry) + "\\n", "utf8");
}

function envMatches(expected = {}) {
  for (const [name, want] of Object.entries(expected)) {
    const actual = process.env[name] || "";
    if (want === "present" && !actual) return false;
    if (want === "absent" && actual) return false;
    if (want !== "present" && want !== "absent" && actual !== want) return false;
  }
  return true;
}

function argsMatch(command) {
  return (${fakeCliArgsMatch.toString()})(command, args);
}

if (!scenarioPath) {
  await appendLog({ tool, args, stdin, matched: false, error: "missing scenario" });
  console.error("RADIUS_FAKE_CLI_SCENARIO is not set");
  process.exit(127);
}

let scenario;
try {
  scenario = JSON.parse(await fs.readFile(scenarioPath, "utf8"));
} catch {
  // The fixture directory is removed during teardown; a straggler process must
  // exit quietly rather than printing a stack trace into the suite output.
  process.exit(127);
}
const command = (scenario.commands || []).find(
  (candidate) => candidate.tool === tool && argsMatch(candidate) && envMatches(candidate.env)
);

if (!command) {
  await appendLog({ tool, args, stdin, matched: false });
  console.error("Unmodeled fake CLI command: " + JSON.stringify({ tool, args }));
  process.exit(127);
}

for (const file of command.writeFiles || []) {
  const expanded = file.path.replace(/\\$([A-Z0-9_]+)/g, (_match, name) => process.env[name] || "");
  const target = path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, file.content, "utf8");
  if (file.executable && process.platform !== "win32") await fs.chmod(target, 0o755);
}

await appendLog({ tool, args, stdin, matched: true, exitCode: command.exitCode || 0 });
if (command.stdout) process.stdout.write(command.stdout);
if (command.stderr) process.stderr.write(command.stderr);
process.exit(command.exitCode || 0);
`,
    "utf8"
  );

  if (process.platform === "win32") {
    await createWindowsShim(fakeBin);
    for (const tool of FAKE_CLI_TOOLS) {
      await writeExecutable(
        path.join(fakeBin, `${tool}.cmd`),
        `@echo off\r\nnode "%RADIUS_FAKE_CLI_SCRIPT%" ${tool} %*\r\n`
      );
    }
  } else {
    for (const tool of FAKE_CLI_TOOLS) {
      await writeExecutable(
        path.join(fakeBin, tool),
        `#!/usr/bin/env sh\nexec node "$RADIUS_FAKE_CLI_SCRIPT" ${tool} "$@"\n`
      );
    }
  }
  return script;
}

function parseBody(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function authStatus(login: string, source: string, scopes: string[]): string {
  return [
    "github.com",
    `  ✓ Logged in to github.com account ${login} (${source})`,
    "    - Active account: true",
    `    - Token scopes: ${scopes.map((scope) => `'${scope}'`).join(", ")}`
  ].join("\n");
}

// The graph the fake `rad app graph` writes. Kept in test/fixtures so a real
// captured graph can be dropped in without touching harness code; the shape has
// to match what `rad` actually emits, including a `diffHash` per resource.
const APP_GRAPH_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/app-graph.json"
);

function appGraphJson(): string {
  return readFileSync(APP_GRAPH_FIXTURE, "utf8");
}

export function baseCanvasState(workspacePath: string): CanvasState {
  return {
    contextRepo: REPOSITORY,
    contextBranch: WORKTREE_BRANCH,
    contextBranchSource: "workspace",
    workspacePath,
    workspaceRepo: REPOSITORY,
    workspaceBranch: WORKTREE_BRANCH,
    graphTargetRepo: REPOSITORY,
    graphBranch: WORKTREE_BRANCH,
    graphFollowsWorkspaceBranch: true,
    plannedRepo: REPOSITORY,
    plannedBranch: WORKTREE_BRANCH,
    plannedFollowsWorkspaceBranch: true,
    deployingRepo: REPOSITORY,
    deployingBranch: WORKTREE_BRANCH
  };
}

export function defaultFakeCliScenario(): FakeCliScenario {
  const appBicep404 = {
    tool: "gh",
    args: [
      "api",
      `/repos/${REPOSITORY}/contents/.radius/app.bicep?ref=${WORKTREE_BRANCH}`,
      "--jq",
      ".content"
    ],
    exitCode: 1,
    stderr: "gh: Not Found (HTTP 404)"
  };
  return {
    commands: [
      {
        tool: "gh",
        args: ["--version"],
        stdout: "gh version 2.87.0 (2026-02-19)"
      },
      {
        tool: "gh",
        args: ["auth", "status", "--hostname", "github.com"],
        env: { GH_TOKEN: "present" },
        stdout: authStatus("acting-user", "GH_TOKEN", ["repo"])
      },
      {
        tool: "gh",
        args: ["auth", "status", "--hostname", "github.com"],
        env: { GH_TOKEN: "absent" },
        stdout: [
          authStatus("repo-user", "keyring", [
            "repo",
            "workflow",
            "write:packages"
          ]),
          authStatus("acting-user", "keyring", [
            "repo",
            "workflow",
            "write:packages"
          ]).replace("Active account: true", "Active account: false")
        ].join("\n")
      },
      {
        tool: "gh",
        args: [
          "auth",
          "token",
          "--hostname",
          "github.com",
          "--user",
          "repo-user"
        ],
        stdout: "fixture-repo-token"
      },
      {
        tool: "gh",
        args: [
          "auth",
          "token",
          "--hostname",
          "github.com",
          "--user",
          "acting-user"
        ],
        stdout: "fixture-acting-token"
      },
      { tool: "gh", args: ["api", "user"], stdout: '{"login":"acting-user"}' },
      {
        tool: "gh",
        args: ["api", "user", "--jq", ".login"],
        env: { GH_TOKEN: "fixture-repo-token" },
        stdout: "repo-user"
      },
      {
        tool: "gh",
        args: ["api", "user", "--jq", ".login"],
        env: { GH_TOKEN: "fixture-acting-token" },
        stdout: "acting-user"
      },
      {
        tool: "gh",
        args: ["api", "user", "--jq", ".login"],
        env: { GH_TOKEN: PLACEHOLDER_SECRET },
        stdout: "acting-user"
      },
      {
        tool: "gh",
        args: ["api", `repos/${REPOSITORY}`],
        stdout: '{"permissions":{"admin":true,"push":true,"pull":true}}'
      },
      {
        tool: "gh",
        args: [
          "auth",
          "switch",
          "--hostname",
          "github.com",
          "--user",
          "repo-user"
        ],
        stdout: ""
      },
      {
        tool: "gh",
        args: [
          "auth",
          "switch",
          "--hostname",
          "github.com",
          "--user",
          "acting-user"
        ],
        stdout: ""
      },
      {
        tool: "gh",
        args: [
          "repo",
          "list",
          "--limit",
          "30",
          "--json",
          "nameWithOwner",
          "--jq",
          ".[].nameWithOwner"
        ],
        stdout: `${REPOSITORY}\n`
      },
      { tool: "gh", args: ["org", "list"], stdout: "" },
      {
        tool: "gh",
        args: [
          "api",
          "--paginate",
          `/repos/${REPOSITORY}/branches?per_page=100`,
          "--jq",
          ".[].name"
        ],
        stdout: `${WORKTREE_BRANCH}\nrelease\n`
      },
      {
        tool: "gh",
        args: [
          "api",
          "--paginate",
          `/repos/${REPOSITORY}/branches?per_page=100`
        ],
        stdout: JSON.stringify([
          { name: WORKTREE_BRANCH, commit: { sha: "worktree" } },
          { name: "release", commit: { sha: "release-sha" } }
        ])
      },
      {
        tool: "gh",
        args: [
          "api",
          `/repos/${REPOSITORY}/actions/workflows/radius-verify-credentials.yml/runs?per_page=100`,
          "--jq",
          '.workflow_runs[] | (.id|tostring) + "\\t" + (.status // "") + "\\t" + (.conclusion // "")'
        ],
        stdout: ""
      },
      {
        tool: "gh",
        args: [
          "api",
          "--paginate",
          `/repos/${REPOSITORY}/environments?per_page=100`,
          "--jq",
          '.environments[] | (.id|tostring) + "\\t" + .name'
        ],
        stdout: "101\tfixture-environment\n"
      },
      {
        tool: "gh",
        args: [
          "api",
          `/repos/${REPOSITORY}/environments/fixture-environment/variables?per_page=100`,
          "--jq",
          '.variables[] | .name + "\\t" + (.value // "")'
        ],
        stdout: [
          "RADIUS_MANAGED\ttrue",
          "AZURE_SUBSCRIPTION_ID\tfixture-subscription",
          `RADIUS_CREDENTIAL_PROFILE\t${PROFILE_NAME}`
        ].join("\n")
      },
      {
        tool: "gh",
        args: [
          "api",
          "--paginate",
          `/repos/${REPOSITORY}/environments?per_page=100`,
          "--jq",
          ".environments[].name"
        ],
        stdout: "fixture-environment\n"
      },
      {
        tool: "gh",
        args: [
          "api",
          `/repos/${REPOSITORY}/environments/fixture-environment/variables?per_page=100`,
          "--jq",
          ".variables[].name"
        ],
        stdout: "RADIUS_MANAGED\nAZURE_SUBSCRIPTION_ID\n"
      },
      {
        tool: "gh",
        args: [
          "api",
          `/repos/${REPOSITORY}/deployments?per_page=100&environment=fixture-environment`,
          "--jq",
          ".[].id"
        ],
        stdout: "dep-1\n"
      },
      {
        // The environment-list route builds the same lookup with a different
        // argument order and page size (routes/environments.ts). The fake CLI
        // matches on exact argv, so it needs its own command or the shim exits
        // 127 and the environment fails closed to "pending".
        tool: "gh",
        args: [
          "api",
          `/repos/${REPOSITORY}/deployments?environment=fixture-environment&per_page=10`,
          "--jq",
          ".[].id"
        ],
        stdout: "dep-1\n"
      },
      {
        tool: "gh",
        args: [
          "api",
          `/repos/${REPOSITORY}/deployments/dep-1/statuses?per_page=1`,
          "--jq",
          '(.[0].state // "") + "\\t" + (.[0].log_url // .[0].target_url // "")'
        ],
        stdout: `success\thttps://github.com/${REPOSITORY}/actions/runs/1`
      },
      {
        // The deployed-page resolver reads only the latest status when it
        // already carries the run URL.
        tool: "gh",
        args: [
          "api",
          `/repos/${REPOSITORY}/deployments/dep-1/statuses?per_page=1`,
          "--jq",
          '(.[0].state // "") + "\\t" + (.[0].log_url // .[0].target_url // "") + "\\t" + (.[0].description // "")'
        ],
        stdout: `success\thttps://github.com/${REPOSITORY}/actions/runs/1\t`
      },
      {
        tool: "gh",
        args: [
          "api",
          `/repos/${REPOSITORY}/actions/runs/1`,
          "--jq",
          '(.path // "") + "\\t" + (.status // "") + "\\t" + (.conclusion // "")'
        ],
        stdout: ".github/workflows/run-rad-commands.yml\tcompleted\tsuccess"
      },
      appBicep404,
      missingGhContent(
        "/repos/radius-project/radius/contents/.github/extension/verify-azure.yml?ref=main"
      ),
      missingGhContent(
        "/repos/radius-project/radius/contents/.github/extension/run-rad-commands.yml?ref=main"
      ),
      missingGhContent(
        "/repos/radius-project/radius/contents/.github/extension/run-rad-commands-azure.yml?ref=main"
      ),
      missingGhContent(
        "/repos/radius-project/radius/contents/.github/extension/delete-application.yml?ref=main"
      ),
      missingGhContent(
        "/repos/radius-project/radius/contents/.github/extension/delete-azure.yml?ref=main"
      ),
      {
        tool: "az",
        args: ["account", "show", "-o", "json"],
        stdout: JSON.stringify({
          user: { name: "fixture-user" },
          tenantId: "11111111-1111-1111-1111-111111111111",
          id: "22222222-2222-2222-2222-222222222222",
          name: "Fixture subscription"
        })
      },
      {
        tool: "aws",
        args: ["sts", "get-caller-identity", "--output", "json"],
        stdout: JSON.stringify({
          Account: "123456789012",
          Arn: "arn:aws:iam::123456789012:user/fixture-aws-user"
        })
      },
      {
        tool: "rad",
        args: ["bicep", "download"],
        writeFiles: [
          { path: "$BICEP", content: "fake-bicep", executable: true }
        ]
      },
      {
        // buildGraphViaRad derives the bicepconfig `extensions.radius` pin from
        // the release of the binary that will run the compile, so the fake CLI
        // must report one: an unmodeled command exits 127, which would leave the
        // reference underivable and fail the compile closed.
        tool: "rad",
        args: ["version", "--cli", "--output", "json"],
        stdout: JSON.stringify({ version: "v0.60.0", bicep: "0.41.2" })
      },
      {
        tool: "rad",
        argsPrefix: ["app", "graph"],
        writeFiles: [{ path: "app-graph.json", content: appGraphJson() }]
      }
    ]
  };
}

export interface AzureDiscoveryFixture {
  subscriptionId?: string;
  clusters: AzureDiscoveryCluster[];
  resourceGroups?: string[];
  /**
   * The cluster the UI selects, which must be one of `clusters`: discovery only
   * reaches the credential and namespace commands for a cluster the listing
   * actually offered. Omit it to model the listing steps alone.
   */
  selected?: AzureDiscoveryCluster;
  namespaces?: string[];
}

// The path is generated per request by `createTemporaryKubeconfig`, so the
// harness cannot spell it out. The stubs are built from the real contract
// against this sentinel and then split around it, which pins every argument on
// both sides of the generated path instead of stopping at it.
const KUBECONFIG_SENTINEL = "<generated-kubeconfig>";

function splitAroundKubeconfig(args: string[]): {
  argsPrefix: string[];
  argsSuffix: string[];
} {
  const index = args.indexOf(KUBECONFIG_SENTINEL);
  if (index === -1) {
    throw new Error("discovery contract no longer names a kubeconfig path");
  }
  return {
    argsPrefix: args.slice(0, index),
    argsSuffix: args.slice(index + 1)
  };
}

/**
 * Fake-CLI stubs for Azure discovery, built from the shared contract in
 * `test/support/azure-discovery-contract.ts` so the browser suites model the
 * same invocations the unit and integration suites assert against.
 */
export function azureDiscoveryCommands(
  fixture: AzureDiscoveryFixture
): FakeCliCommand[] {
  if (
    fixture.selected &&
    !fixture.clusters.some((entry) => entry.id === fixture.selected?.id)
  ) {
    throw new Error(
      `selected cluster "${fixture.selected.id}" is not in the fixture listing`
    );
  }
  const contract = azureDiscoveryContract({
    subscriptionId: fixture.subscriptionId,
    cluster: fixture.selected?.id,
    resourceGroup: fixture.selected?.resourceGroup,
    kubeconfigPath: KUBECONFIG_SENTINEL
  });
  const resourceGroups =
    fixture.resourceGroups ??
    Array.from(new Set(fixture.clusters.map((entry) => entry.resourceGroup)));
  const commands: FakeCliCommand[] = [];
  if (contract.accountSet) {
    commands.push({ ...contract.accountSet, stdout: "" });
  }
  commands.push(
    { ...contract.aksList, stdout: JSON.stringify(fixture.clusters) },
    {
      ...contract.groupList,
      stdout: JSON.stringify(resourceGroups.map((name) => ({ id: name, name })))
    }
  );
  if (contract.getCredentials && contract.namespaces) {
    commands.push(
      {
        tool: contract.getCredentials.tool,
        ...splitAroundKubeconfig(contract.getCredentials.args),
        stdout: ""
      },
      {
        tool: contract.namespaces.tool,
        ...splitAroundKubeconfig(contract.namespaces.args),
        stdout: (fixture.namespaces ?? []).join(" ")
      }
    );
  }
  return commands;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createHarnessFetch(delegate: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : input.url;
    if (url.startsWith("https://ghcr.io/token?")) {
      return new Response(JSON.stringify({ token: "fixture-registry-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.startsWith("https://ghcr.io/v2/") && init?.method === "POST") {
      return new Response(null, {
        status: 202,
        headers: {
          Location: "/v2/fixture/radius-app/blobs/uploads/fixture-session"
        }
      });
    }
    if (
      url ===
        "https://ghcr.io/v2/fixture/radius-app/blobs/uploads/fixture-session" &&
      init?.method === "DELETE"
    ) {
      return new Response(null, { status: 204 });
    }
    return await delegate(input, init);
  };
}

export function replaceSharedCredentials(
  target: SharedCredentials,
  replacement: SharedCredentials = {}
): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

export async function prepareCredentialStoreIsolation(): Promise<void> {
  await fs.mkdir(E2E_TMP_ROOT, { recursive: true });
  process.env.RADIUS_CREDENTIALS_FILE = CREDENTIAL_STORE_PATH;
  await fs.writeFile(
    CREDENTIAL_STORE_PATH,
    JSON.stringify({
      azure: { clientSecret: CREDENTIAL_SENTINEL },
      aws: { secretAccessKey: CREDENTIAL_SENTINEL },
      preferredGitHubLogin: CREDENTIAL_SENTINEL,
      profiles: {
        [REPOSITORY]: [
          {
            name: CREDENTIAL_SENTINEL,
            provider: "azure",
            user: CREDENTIAL_SENTINEL
          }
        ]
      },
      unknownPersistedField: CREDENTIAL_SENTINEL
    }),
    "utf8"
  );
}

export async function stopHarnessServer(
  entry: HarnessServerEntry,
  instanceId: string,
  serverModule: HarnessServerStopPort,
  timeoutMs = 500,
  wait: (milliseconds: number) => Promise<void> = delay
): Promise<void> {
  let closeError: unknown;
  const gracefulClose = new Promise<"closed">((resolve, reject) => {
    entry.server.close((error) => (error ? reject(error) : resolve("closed")));
  }).catch((error: unknown) => {
    closeError = error;
    return "failed" as const;
  });
  const outcome = await Promise.race([
    gracefulClose,
    wait(timeoutMs).then(() => "timeout" as const)
  ]);

  await serverModule.stopServer(
    instanceId,
    outcome === "timeout" || outcome === "failed"
  );

  if (serverModule.servers.has(instanceId))
    throw new Error(`Canvas server ${instanceId} remained registered.`);
  if (entry.server.listening)
    throw new Error(`Canvas server ${instanceId} remained listening.`);
  if (closeError) throw closeError;
}

// Windows keeps a brief lock on the fake CLI executables after the last child
// process exits, so removal is retried with a growing delay. A directory that
// is still locked after the last attempt is left for the global teardown to
// sweep: a transient file lock must never be reported as a journey failure.
export async function removeDirectoryWithRetries(
  directory: string,
  options: RetryRemovalOptions = {}
): Promise<void> {
  const attempts = options.attempts ?? 12;
  const remove =
    options.remove ??
    ((target: string) => fs.rm(target, { recursive: true, force: true }));
  const wait = options.delay ?? delay;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await remove(directory);
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts)
        await wait(Math.min(100 * (attempt + 1), 500));
    }
  }
  throw lastError;
}

function missingGhContent(pathname: string): FakeCliCommand {
  return {
    tool: "gh",
    args: ["api", pathname, "--jq", ".content"],
    exitCode: 1,
    stderr: "gh: Not Found (HTTP 404)"
  };
}

async function closePage(page: Page): Promise<void> {
  if (!page.isClosed()) await page.close();
}

function restoreEnvironment(
  originalEnv: Record<string, string | undefined>
): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function captureCleanupError(
  errors: unknown[],
  action: () => void | Promise<void>
): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
}

export async function unwindHarnessConstruction(
  cleanup: ConstructionCleanup
): Promise<void> {
  const errors: unknown[] = [];
  await captureCleanupError(errors, () => cleanup.stopServer?.());
  await captureCleanupError(errors, () => cleanup.resetState?.());
  restoreEnvironment(cleanup.originalEnv);
  await captureCleanupError(errors, () =>
    (cleanup.removeDirectory ?? removeDirectoryWithRetries)(cleanup.rootDir)
  );
  if (errors.length > 0)
    throw new AggregateError(errors, "Failed to unwind Canvas harness.");
}

export class CanvasHarness {
  readonly entry: CanvasServerEntry;
  readonly instanceId: string;
  readonly rootDir: string;
  readonly fakeBin: string;
  readonly scenarioPath: string;
  readonly cliLogPath: string;
  readonly workspacePath: string;
  readonly mode: CanvasHarnessMode;
  readonly requests: RecordedRequest[] = [];
  readonly externalRequests: string[] = [];

  private readonly page: Page;
  private readonly originalEnv: Record<string, string | undefined>;
  private readonly serverModule: ServerModule;
  private readonly ghModule: GhModule;
  private readonly originalFetch: typeof fetch;
  private readonly seededOperationIds = new Set<string>();

  private constructor(input: {
    page: Page;
    entry: CanvasServerEntry;
    instanceId: string;
    rootDir: string;
    fakeBin: string;
    scenarioPath: string;
    cliLogPath: string;
    workspacePath: string;
    mode: CanvasHarnessMode;
    originalEnv: Record<string, string | undefined>;
    originalFetch: typeof fetch;
    serverModule: ServerModule;
    ghModule: GhModule;
  }) {
    this.page = input.page;
    this.entry = input.entry;
    this.instanceId = input.instanceId;
    this.rootDir = input.rootDir;
    this.fakeBin = input.fakeBin;
    this.scenarioPath = input.scenarioPath;
    this.cliLogPath = input.cliLogPath;
    this.workspacePath = input.workspacePath;
    this.mode = input.mode;
    this.originalEnv = input.originalEnv;
    this.originalFetch = input.originalFetch;
    this.serverModule = input.serverModule;
    this.ghModule = input.ghModule;
  }

  static async create(options: CanvasHarnessOptions): Promise<CanvasHarness> {
    const mode: CanvasHarnessMode = options.mode ?? "fake";
    await fs.mkdir(E2E_TMP_ROOT, { recursive: true });
    const rootParent = await fs.mkdtemp(
      path.join(E2E_TMP_ROOT, `${sanitizeTitle(options.title)}-`)
    );
    const envKeys = [
      "PATH",
      "Path",
      "GH_CONFIG_DIR",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "RADIUS_FAKE_CLI_SCRIPT",
      "RADIUS_FAKE_CLI_SCENARIO",
      "RADIUS_FAKE_CLI_LOG",
      "RADIUS_RAD_BINARY",
      "RADIUS_RAD_SKIP_VERSION_CHECK",
      "RADIUS_CREDENTIALS_FILE"
    ];
    const originalEnv = Object.fromEntries(
      envKeys.map((key) => [key, process.env[key]])
    );
    const originalFetch = globalThis.fetch;
    let serverModule: ServerModule | undefined;
    let ghModule: GhModule | undefined;
    let sharedModule: SharedModule | undefined;
    let entry: CanvasServerEntry | undefined;
    let instanceId: string | undefined;

    try {
      const fakeBin = path.join(rootParent, "bin");
      const ghConfig = path.join(rootParent, "gh-config");
      const workspace = resolveHarnessWorkspace({
        mode,
        rootDir: rootParent,
        workspacePath: options.workspacePath,
        repositoryRoot: REPOSITORY_ROOT
      });
      const workspacePath = workspace.path;
      if (mode === "cloud") await assertCloudWorkspaceClone(workspacePath);
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.mkdir(ghConfig, { recursive: true });
      if (workspace.createRadiusDirectory)
        await fs.mkdir(path.join(workspacePath, ".radius"), {
          recursive: true
        });
      if (workspace.initializeGitRepository) {
        await fs.writeFile(path.join(workspacePath, ".gitkeep"), "", "utf8");
        execFileSync("git", ["init", "--initial-branch", WORKTREE_BRANCH], {
          cwd: workspacePath,
          stdio: "pipe"
        });
        execFileSync("git", ["add", ".gitkeep"], {
          cwd: workspacePath,
          stdio: "pipe"
        });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Radius Tests",
            "-c",
            "user.email=radius-tests@example.invalid",
            "commit",
            "-m",
            "Initialize fixture"
          ],
          { cwd: workspacePath, stdio: "pipe" }
        );
      }
      const useFakeCli = mode === "fake";
      const fakeScript = useFakeCli ? await writeFakeCli(fakeBin) : undefined;
      const scenarioPath = path.join(rootParent, "scenario.json");
      const cliLogPath = path.join(rootParent, "cli.log");
      if (useFakeCli)
        await fs.writeFile(
          scenarioPath,
          JSON.stringify({ commands: [] }),
          "utf8"
        );

      const pathKey = process.platform === "win32" ? "Path" : "PATH";
      const plan = planHarnessProcess({
        mode,
        fakeBin,
        ghConfigDir: ghConfig,
        fakeScript,
        scenarioPath: useFakeCli ? scenarioPath : undefined,
        cliLogPath: useFakeCli ? cliLogPath : undefined,
        pathKey,
        currentPath: process.env[pathKey] || process.env.PATH || "",
        isWindows: process.platform === "win32",
        credentialsFile: process.env.RADIUS_CREDENTIALS_FILE,
        githubToken: process.env.GH_TOKEN
      });
      applyHarnessProcessPlan(plan);
      if (plan.interceptFetch)
        globalThis.fetch = createHarnessFetch(originalFetch);

      // All process and credential-store isolation is in place before the first
      // production import. shared.ts reads its store at module initialization.
      serverModule = await loadServerModule();
      ghModule = await import("../../../src/gh.js");
      sharedModule = await import("../../../src/shared.js");
      if (
        !credentialIsolationVerified &&
        sharedModule.sharedCredentials.unknownPersistedField !==
          CREDENTIAL_SENTINEL
      ) {
        throw new Error(
          "The isolated credential sentinel was not loaded before production imports."
        );
      }
      credentialIsolationVerified = true;
      ghModule.resetGhIdentityCache();
      await ghModule.primeGhIdentity().catch(() => undefined);
      // The fixture profile names a tenant and subscription that do not exist.
      // Cloud mode is left with an empty store so the caller can seed the real
      // ones; seeding fictional identifiers there would make the first real
      // Azure call fail for a reason that has nothing to do with the product.
      replaceSharedCredentials(
        sharedModule.sharedCredentials,
        useFakeCli ?
          {
            profiles: {
              [REPOSITORY]: [
                {
                  name: PROFILE_NAME,
                  provider: "azure",
                  status: "verified",
                  user: PROFILE_USER,
                  tenantId: PROFILE_TENANT_ID,
                  tenantName: "Fixture tenant",
                  subscriptionId: PROFILE_SUBSCRIPTION_ID,
                  subscriptionName: "Fixture subscription"
                }
              ]
            }
          }
        : {}
      );

      // The production SDK entry registers this hook to open a worktree file in
      // the editor canvas. The Chromium harness has no host SDK, so provide the
      // successful local boundary explicitly; otherwise the browser correctly
      // falls back to the public GitHub URL and violates offline isolation.
      serverModule.setOpenSourceHandler(async () => undefined);

      // The listing caches are module-scoped, so a listing captured under a
      // previous test's fake CLI scenario would otherwise still be served here.
      serverModule.resetListingCaches();

      instanceId = `chromium-${sanitizeTitle(options.title)}-${randomUUID()}`;
      entry = await serverModule.getOrCreateServer(
        instanceId,
        options.initialPage || "environment"
      );
      const nonceDeadline = Date.now() + 1000;
      while (
        (typeof entry.state.browserMutationNonce !== "string" ||
          entry.state.browserMutationNonce === "") &&
        Date.now() < nonceDeadline
      ) {
        await delay(10);
      }
      if (
        typeof entry.state.browserMutationNonce !== "string" ||
        entry.state.browserMutationNonce === ""
      ) {
        throw new Error("The Canvas server did not publish a mutation nonce.");
      }
      Object.assign(entry.state, options.initialState || {});

      const harness = new CanvasHarness({
        page: options.page,
        entry,
        instanceId,
        rootDir: rootParent,
        fakeBin,
        scenarioPath,
        cliLogPath,
        workspacePath,
        mode,
        originalEnv,
        originalFetch,
        serverModule,
        ghModule
      });
      await harness.installNetworkGuard();
      return harness;
    } catch (error) {
      const cleanupEntry = entry;
      const cleanupInstanceId = instanceId;
      const cleanupServerModule = serverModule;
      try {
        await unwindHarnessConstruction({
          rootDir: rootParent,
          originalEnv,
          stopServer:
            cleanupServerModule && cleanupEntry && cleanupInstanceId ?
              () =>
                stopHarnessServer(
                  cleanupEntry,
                  cleanupInstanceId,
                  cleanupServerModule
                )
            : undefined,
          resetState: () => {
            cleanupServerModule?.resetListingCaches();
            ghModule?.resetGhIdentityCache();
            if (sharedModule)
              replaceSharedCredentials(sharedModule.sharedCredentials);
          }
        });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Canvas harness construction and cleanup failed.",
          { cause: cleanupError }
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
      throw error;
    }
  }

  get baseUrl(): string {
    return this.entry.baseUrl;
  }

  renameWorkspaceBranch(branch: string): void {
    execFileSync("git", ["branch", "-m", branch], {
      cwd: this.workspacePath,
      stdio: "pipe"
    });
  }

  currentWorkspaceBranch(): string {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: this.workspacePath,
      encoding: "utf8",
      stdio: "pipe"
    }).trim();
  }

  async seedState(state: CanvasState): Promise<void> {
    const browserMutationNonce = this.entry.state.browserMutationNonce;
    for (const key of Object.keys(this.entry.state))
      delete this.entry.state[key];
    Object.assign(this.entry.state, state);
    this.entry.state.browserMutationNonce = browserMutationNonce;
  }

  async setScenario(scenario: FakeCliScenario): Promise<void> {
    this.assertFakeMode("setScenario");
    await fs.writeFile(this.scenarioPath, JSON.stringify(scenario, null, 2));
    this.ghModule.resetGhIdentityCache();
    await this.ghModule.primeGhIdentity().catch(() => undefined);
  }

  /**
   * Fake-CLI helpers write or read files no real tool consults, so in cloud
   * mode they would quietly do nothing and let a test assert against an empty
   * log. Failing here keeps that mistake visible.
   */
  private assertFakeMode(operation: string): void {
    assertFakeModeAvailable(this.mode, operation);
  }

  async setScenarioOverrides(
    scenario: FakeCliScenario,
    overrides: readonly FakeCliCommandOverride[],
    appendedCommands: readonly FakeCliCommand[] = []
  ): Promise<void> {
    const commands = scenario.commands.map((command) =>
      overrides.reduce((overridden, override) => override(overridden), command)
    );
    await this.setScenario({
      ...scenario,
      commands: [...commands, ...appendedCommands]
    });
  }

  async seedRestartedVerificationFailure(): Promise<string> {
    return this.seedRestartedVerification("failed");
  }

  async seedInterruptedVerification(): Promise<string> {
    return this.seedRestartedVerification("interrupted");
  }

  private async seedRestartedVerification(
    outcome: "failed" | "interrupted"
  ): Promise<string> {
    const operationModule: OperationsModule =
      await import("../../../src/operations.js");
    const operation = operationModule.createOperation({
      operationId:
        outcome === "failed" ?
          "op_chromium_verification"
        : "op_chromium_interrupted_verification",
      provider: "azure",
      repo: REPOSITORY,
      environment: "fixture-environment",
      stages: operationModule.buildStages({ includeIdentity: true }),
      journey: { origin: "environments" }
    });
    operation.context = { githubLogin: "repo-user" };
    operationModule.recordAzureApp(operation, {
      state: "created",
      appId: "fixture-app-id",
      displayName: "radius-fixture"
    });
    operationModule.recordCommittedWorkflowFile(operation, {
      path: ".github/workflows/radius-verify-credentials.yml",
      mode: "default_branch",
      branch: WORKTREE_BRANCH,
      commitSha: "c".repeat(40),
      blobSha: VERIFICATION_WORKFLOW_BLOB_SHA,
      contentSha256: VERIFICATION_WORKFLOW_CONTENT_SHA256,
      previousBlobSha: null,
      previousBlobKnown: true
    });
    operationModule.recordCommitState(operation, {
      mode: "default_branch",
      branch: WORKTREE_BRANCH,
      baseBranch: WORKTREE_BRANCH
    });
    operationModule.enterStage(operation, operationModule.STAGE_VERIFY);
    operation.verification = {
      dispatchedAt: Date.now() - 1000,
      workflow: "radius-verify-credentials.yml",
      ref: WORKTREE_BRANCH,
      environment: "fixture-environment",
      event: "workflow_dispatch",
      operationMarker: operation.operationId,
      runId: "39",
      runUrl: `https://github.com/${REPOSITORY}/actions/runs/39`
    };
    if (outcome === "failed") {
      operationModule.finish(operation, "failed_partial", {
        failure: {
          code: "verify-run-failed",
          stage: operationModule.STAGE_VERIFY,
          message: "Credential verification failed.",
          classification: "user-fixable",
          evidence: "The controlled verification run failed."
        }
      });
    }

    const restored = operationModule.fromPersistedOperation(
      JSON.parse(JSON.stringify(operation))
    );
    operationModule.reconcileRestoredOperation(restored);
    operationModule.operations.put(restored);
    await operationModule.operations.persist();
    this.seededOperationIds.add(restored.operationId);
    return restored.operationId;
  }

  async operationRecord(operationId: string): Promise<Record<string, unknown>> {
    const operationModule: OperationsModule =
      await import("../../../src/operations.js");
    return structuredClone(
      operationModule.operations.get(operationId) as Record<string, unknown>
    );
  }

  // Replaces the graph the fake `rad app graph` writes, for a test that needs a
  // different topology than the shared fixture. Accepts either raw `rad` JSON
  // text or the parsed object.
  async setAppGraph(graph: string | object): Promise<void> {
    this.assertFakeMode("setAppGraph");
    const text = typeof graph === "string" ? graph : JSON.stringify(graph);
    const raw = await fs.readFile(this.scenarioPath, "utf8");
    const scenario = JSON.parse(raw) as FakeCliScenario;
    await this.setScenarioOverrides(scenario, [
      (command) => {
        const isAppGraph =
          command.tool === "rad" &&
          command.argsPrefix?.[0] === "app" &&
          command.argsPrefix?.[1] === "graph";
        if (!isAppGraph) return command;
        return {
          ...command,
          writeFiles: [{ path: "app-graph.json", content: text }]
        };
      }
    ]);
  }

  // The scenario distinguishes a token-authenticated single account from the
  // multi-account keyring listing, so tests choose which one the fake `gh` sees.
  // The identity snapshot and strategy are primed when the server starts, so the
  // cached decision is dropped here: without that reset the next resolution
  // would answer from the token state that existed before this call.
  setGitHubToken(value: string | null): void {
    // Cloud mode's token authenticates real GitHub calls; replacing or clearing
    // it here would silently change the identity a real deploy runs under.
    this.assertFakeMode("setGitHubToken");
    if (value === null) {
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GH_TOKEN = value;
      process.env.GITHUB_TOKEN = value;
    }
    this.ghModule.resetGhIdentityCache();
  }

  // Rewrites the scopes the keyring accounts report. The production strategy
  // falls back to a keyring account whenever that account carries `workflow`
  // and the injected token does not, so a test that needs the injected token to
  // stay in effect has to withhold the scope from the keyring too. Doing that
  // through the scenario keeps the decision deterministic instead of depending
  // on which probe resolved first.
  async setGitHubKeyringScopes(scopes: readonly string[]): Promise<void> {
    this.assertFakeMode("setGitHubKeyringScopes");
    const raw = await fs.readFile(this.scenarioPath, "utf8");
    const scenario = JSON.parse(raw) as FakeCliScenario;
    await this.setScenarioOverrides(scenario, [
      (command) => {
        const isKeyringStatus =
          command.tool === "gh" &&
          JSON.stringify(command.args) ===
            JSON.stringify(["auth", "status", "--hostname", "github.com"]) &&
          command.env?.GH_TOKEN === "absent";
        if (!isKeyringStatus) return command;
        return {
          ...command,
          stdout: [
            authStatus("repo-user", "keyring", [...scopes]),
            authStatus("acting-user", "keyring", [...scopes]).replace(
              "Active account: true",
              "Active account: false"
            )
          ].join("\n")
        };
      }
    ]);
  }

  async cliCalls(): Promise<Array<{ tool: string; args: string[] }>> {
    this.assertFakeMode("cliCalls");
    try {
      const text = await fs.readFile(this.cliLogPath, "utf8");
      return text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { tool: string; args: string[] });
    } catch {
      return [];
    }
  }

  async expectCliInvoked(tool: string): Promise<void> {
    // Guard before polling: a throw raised inside the poll callback would be
    // reported as a timeout instead of the mode mismatch that caused it.
    this.assertFakeMode("expectCliInvoked");
    await expect
      .poll(async () =>
        (await this.cliCalls()).some((call) => call.tool === tool)
      )
      .toBe(true);
  }

  setEnvironmentOperationRunner(
    runner: ((operationId: string) => Promise<void>) | null
  ): void {
    this.serverModule.setEnvironmentOperationTestRunner(runner);
  }

  // Drives the real delete OperationRecord the route creates to a terminal,
  // exactly as the production runner does (environment-deletion.ts): enter every
  // stage and finish. The completion is gated on the returned `release` so the
  // progress poller first observes the operation running -- it ignores an
  // operation already terminal on its first observation, treating it as a stale
  // prior record. The created id is tracked for cleanup so a settled panel that
  // was never dismissed cannot bleed into the next test.
  driveEnvironmentDeletion(
    outcome: EnvironmentDeletionOutcome
  ): DrivenEnvironmentDeletion {
    let releaseRunner: (() => void) | null = null;
    let signalArrived: (() => void) | null = null;
    const arrived = new Promise<void>((resolve) => {
      signalArrived = resolve;
    });
    this.setEnvironmentOperationRunner(async (operationId: string) => {
      const ops: OperationsModule = await import("../../../src/operations.js");
      const op = ops.operations.get(operationId);
      if (!op) throw new Error(`operation ${operationId} was never created`);
      const [firstStage] = op.stages;
      if (!firstStage)
        throw new Error(`operation ${operationId} has no stages`);
      this.seededOperationIds.add(operationId);
      ops.enterStage(op, firstStage.id);
      await new Promise<void>((resolve) => {
        releaseRunner = resolve;
        signalArrived?.();
      });
      if (outcome.state === "succeeded") {
        for (const stage of op.stages) {
          ops.enterStage(op, stage.id);
          ops.setStageState(op, stage.id, "succeeded");
        }
        ops.finishSucceeded(op, "succeeded");
      } else {
        ops.setStageState(op, firstStage.id, "failed");
        ops.finish(op, "failed_partial", {
          failure: { ...outcome.failure, stage: firstStage.id }
        });
      }
      await ops.operations.persist();
    });
    return {
      release: async () => {
        await arrived;
        releaseRunner?.();
      }
    };
  }

  async cleanup(): Promise<void> {
    const errors: unknown[] = [];
    this.serverModule.setEnvironmentOperationTestRunner(null);
    this.serverModule.markEnvironmentInstanceShuttingDown(this.instanceId);
    if (this.serverModule.hasActiveEnvironmentTasks(this.instanceId)) {
      await new Promise<void>((resolve) => {
        const stop = this.serverModule.onEnvironmentTasksSettled(
          this.instanceId,
          () => {
            stop();
            resolve();
          }
        );
        setTimeout(() => {
          stop();
          resolve();
        }, 1000).unref?.();
      });
    }
    await captureCleanupError(errors, async () => {
      const operationModule: OperationsModule =
        await import("../../../src/operations.js");
      for (const operationId of this.seededOperationIds) {
        operationModule.operations.delete(operationId);
      }
      this.seededOperationIds.clear();
      await operationModule.operations.persist();
    });
    await captureCleanupError(errors, () => closePage(this.page));
    await captureCleanupError(errors, () =>
      stopHarnessServer(this.entry, this.instanceId, this.serverModule)
    );
    // Drain any identity probe this test started before restoring the
    // environment: a probe that settled after the next test reset the cache
    // would publish this test's identity into that test's page.
    await captureCleanupError(errors, async () => {
      await this.ghModule.primeGhIdentity();
    });
    this.ghModule.resetGhIdentityCache();
    this.serverModule.resetListingCaches();
    const sharedModule = await import("../../../src/shared.js");
    replaceSharedCredentials(sharedModule.sharedCredentials);
    globalThis.fetch = this.originalFetch;
    restoreEnvironment(this.originalEnv);
    await captureCleanupError(errors, () =>
      removeDirectoryWithRetries(this.rootDir)
    );
    if (this.externalRequests.length > 0)
      errors.push(
        new Error(
          `Unexpected external requests: ${this.externalRequests.join(", ")}`
        )
      );
    if (errors.length > 0)
      throw new AggregateError(errors, "Canvas harness cleanup failed.");
  }

  private async installNetworkGuard(): Promise<void> {
    const allowedOrigin = new URL(this.entry.baseUrl).origin;
    // Context routing also intercepts a popup's initial navigation. Page-level
    // routing starts too late for target="_blank" links and could allow a live
    // GitHub or cloud URL to escape the offline harness.
    await this.page.context().route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== allowedOrigin) {
        this.externalRequests.push(request.url());
        await route.abort();
        return;
      }
      this.requests.push({
        method: request.method(),
        path: `${url.pathname}${url.search}`,
        body: parseBody(request.postData())
      });
      await route.continue();
    });
  }
}

export const test = base.extend<{ canvas: CanvasHarness }>({
  canvas: async ({ page }, use, testInfo) => {
    const canvas = await CanvasHarness.create({
      page,
      title: testInfo.title
    });
    try {
      await use(canvas);
    } finally {
      await canvas.cleanup();
    }
  }
});

export { expect, PLACEHOLDER_SECRET };
