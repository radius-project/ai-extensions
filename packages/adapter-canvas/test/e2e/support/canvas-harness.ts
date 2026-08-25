import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect, type Page } from "@playwright/test";
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
const PROFILE_SUBSCRIPTION_ID = "22222222-2222-2222-2222-222222222222";
export const OPERATION_ID = "operation-fixture-1";

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
  env?: Record<string, "present" | "absent" | string>;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  writeFiles?: Array<{ path: string; content: string; executable?: boolean }>;
}

export interface FakeCliScenario {
  commands: FakeCliCommand[];
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
  for (const tool of ["gh", "rad"]) {
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
  if (Array.isArray(command.args)) {
    return JSON.stringify(command.args) === JSON.stringify(args);
  }
  if (Array.isArray(command.argsPrefix)) {
    return command.argsPrefix.every((value, index) => args[index] === value);
  }
  return args.length === 0;
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
    for (const tool of ["gh", "rad", "az", "aws"]) {
      await writeExecutable(
        path.join(fakeBin, `${tool}.cmd`),
        `@echo off\r\nnode "%RADIUS_FAKE_CLI_SCRIPT%" ${tool} %*\r\n`
      );
    }
  } else {
    for (const tool of ["gh", "rad", "az", "aws"]) {
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
    workspacePath,
    workspaceRepo: REPOSITORY,
    workspaceBranch: WORKTREE_BRANCH,
    graphTargetRepo: REPOSITORY,
    graphBranch: WORKTREE_BRANCH,
    plannedRepo: REPOSITORY,
    plannedBranch: WORKTREE_BRANCH,
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
    this.originalEnv = input.originalEnv;
    this.originalFetch = input.originalFetch;
    this.serverModule = input.serverModule;
    this.ghModule = input.ghModule;
  }

  static async create(options: CanvasHarnessOptions): Promise<CanvasHarness> {
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
      const workspacePath = path.join(rootParent, "workspace");
      await fs.mkdir(fakeBin, { recursive: true });
      await fs.mkdir(ghConfig, { recursive: true });
      await fs.mkdir(path.join(workspacePath, ".radius"), { recursive: true });
      const fakeScript = await writeFakeCli(fakeBin);
      const scenarioPath = path.join(rootParent, "scenario.json");
      const cliLogPath = path.join(rootParent, "cli.log");
      await fs.writeFile(
        scenarioPath,
        JSON.stringify({ commands: [] }),
        "utf8"
      );

      const pathKey = process.platform === "win32" ? "Path" : "PATH";
      process.env[pathKey] =
        `${fakeBin}${path.delimiter}${process.env[pathKey] || process.env.PATH || ""}`;
      process.env.PATH = process.env[pathKey];
      process.env.GH_CONFIG_DIR = ghConfig;
      process.env.GH_TOKEN = PLACEHOLDER_SECRET;
      process.env.GITHUB_TOKEN = PLACEHOLDER_SECRET;
      process.env.RADIUS_FAKE_CLI_SCRIPT = fakeScript;
      process.env.RADIUS_FAKE_CLI_SCENARIO = scenarioPath;
      process.env.RADIUS_FAKE_CLI_LOG = cliLogPath;
      process.env.RADIUS_RAD_BINARY =
        process.platform === "win32" ?
          path.join(fakeBin, "rad.exe")
        : path.join(fakeBin, "rad");
      process.env.RADIUS_RAD_SKIP_VERSION_CHECK = "1";
      process.env.RADIUS_CREDENTIALS_FILE ??= CREDENTIAL_STORE_PATH;
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
      replaceSharedCredentials(sharedModule.sharedCredentials, {
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
      });

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

  async seedState(state: CanvasState): Promise<void> {
    const browserMutationNonce = this.entry.state.browserMutationNonce;
    for (const key of Object.keys(this.entry.state))
      delete this.entry.state[key];
    Object.assign(this.entry.state, state);
    this.entry.state.browserMutationNonce = browserMutationNonce;
  }

  async setScenario(scenario: FakeCliScenario): Promise<void> {
    await fs.writeFile(this.scenarioPath, JSON.stringify(scenario, null, 2));
    this.ghModule.resetGhIdentityCache();
    await this.ghModule.primeGhIdentity().catch(() => undefined);
  }

  async seedRestartedVerificationFailure(): Promise<string> {
    const operationModule: OperationsModule =
      await import("../../../src/operations.js");
    const operation = operationModule.createOperation({
      operationId: "op_chromium_verification",
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
      branch: WORKTREE_BRANCH
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
    operationModule.finish(operation, "failed_partial", {
      failure: {
        code: "verify-run-failed",
        stage: operationModule.STAGE_VERIFY,
        message: "Credential verification failed.",
        classification: "user-fixable",
        evidence: "The controlled verification run failed."
      }
    });

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
    const text = typeof graph === "string" ? graph : JSON.stringify(graph);
    const raw = await fs.readFile(this.scenarioPath, "utf8");
    const scenario = JSON.parse(raw) as FakeCliScenario;
    const commands = scenario.commands.map((command) => {
      const isAppGraph =
        command.tool === "rad" &&
        command.argsPrefix?.[0] === "app" &&
        command.argsPrefix?.[1] === "graph";
      if (!isAppGraph) return command;
      return {
        ...command,
        writeFiles: [{ path: "app-graph.json", content: text }]
      };
    });
    await this.setScenario({ ...scenario, commands });
  }

  // The scenario distinguishes a token-authenticated single account from the
  // multi-account keyring listing, so tests choose which one the fake `gh` sees.
  // The identity snapshot and strategy are primed when the server starts, so the
  // cached decision is dropped here: without that reset the next resolution
  // would answer from the token state that existed before this call.
  setGitHubToken(value: string | null): void {
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
    const raw = await fs.readFile(this.scenarioPath, "utf8");
    const scenario = JSON.parse(raw) as FakeCliScenario;
    const commands = scenario.commands.map((command) => {
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
    });
    await this.setScenario({ ...scenario, commands });
  }

  async cliCalls(): Promise<Array<{ tool: string; args: string[] }>> {
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
