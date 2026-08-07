// Canvas adapter — HTTP server host for the webview.
//
// Owns the local loopback server that backs each canvas instance: the ~21-route
// request handler (parse request -> call an @radius-project/core use-case or adapter
// helper -> serialize), the page router, and the idempotent server lifecycle
// (stable per-instance port, reuse on re-open). The only product logic here is
// glue; everything substantive is delegated to @radius-project/core or the sibling
// adapter modules (pages/deploy/infra/gh). No SDK surface — that stays in
// extension.ts.

import { createServer } from "node:http";
import type {
  IncomingMessage,
  Server as HttpServer,
  ServerResponse
} from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import {
  computeGraphDiff,
  fetchBicepFromRepo,
  fetchRecipePack,
  resolveRecipeOutputs,
  filterGraphVisualizationResources,
  DEFAULT_STATE_ARCHIVE,
  OCI_STATE_BACKEND,
  stateRegistryForEnvironment,
  buildEnvironmentSuffix
} from "@radius-project/core";
import { buildGraphViaRad } from "@radius-project/adapter-shared";
import { ensureVendorScripts } from "./vendor.js";
import {
  sharedCredentials,
  cloudCredential,
  saveCredentials,
  listCredentialProfiles,
  saveCredentialProfile,
  deleteCredentialProfile,
  getPreferredGitHubLogin,
  setPreferredGitHubLogin
} from "./shared.js";
import type { CanvasGraphResource, CanvasState, GraphView } from "./shared.js";
import {
  fetchFileFromRepo,
  github,
  cliExec,
  runCommand,
  commitFileToRepo,
  getDefaultBranch,
  getBranchHeadSha,
  createBranchRef,
  createPullRequestApi,
  ghApiJson,
  getGitHubIdentity,
  switchGhAccount,
  getGhPackageCredentials,
  resetGhIdentityCache,
  primeGhIdentity,
  setPreferredGhLogin
} from "./gh.js";
import type { CliOptions } from "./gh.js";
import {
  resolveOidcSubject,
  buildAppCreateArgs,
  isServiceManagementReferenceError,
  selectMissingFederatedCredentials,
  decideExistingClientId,
  isAzResourceNotFound,
  decideAppSelection,
  parseServedReposFromSubjects,
  validateAppRegistrationName,
  isUuid,
  isValidRepoSlug,
  isAksClusterName,
  isResourceGroupName,
  GITHUB_API_VERSION
} from "./azure-oidc.js";
import type { GitHubJsonResponse, GitHubJsonRunner } from "./azure-oidc.js";
import { bootstrapGHCRStatePackage } from "./ghcr.js";
import {
  appParams,
  resolveDeployParams,
  partitionParams,
  buildDeployRadCommand,
  buildAppGraphRadCommand,
  extractAppName
} from "./bicep.js";
import {
  createWorkspaceGitHub,
  defaultBranchForState,
  resolveWorkspaceBicep,
  fetchWorkspaceFile,
  isWorkspaceSelection,
  resolveSessionId,
  toSafeRepoRelPath,
  workspaceGraphJsonPath
} from "./workspace.js";
import { DEFAULT_CANVAS_PAGE } from "./runtime/hooks.js";
import {
  radArtifactsDirForSelection,
  radArtifactsFingerprint
} from "./remote-rad-artifacts.js";
import {
  prepareSourceRefResources,
  setSourceRefResources
} from "./source-refs.js";
import {
  generateAzureOIDC,
  validateAzureCredentials,
  generateAWSOIDC,
  generateVerifyWorkflow,
  generateDeployWorkflow,
  generateDeleteWorkflow,
  generatePortalUrl,
  syncRepoWorkflows,
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  DELETE_APP_DISPATCHER_FILE,
  DELETE_AZURE_FILE
} from "./infra.js";
import {
  findWorkflowRun,
  getRunDetail,
  fetchRunLog,
  fetchLiveDeployLog,
  fetchLiveActivityLog,
  fetchLiveControlPlaneLog,
  fetchDeployState,
  createDeployStatusReader,
  appNameForGraphTag,
  normalizeDeployedGraph,
  rewireDeployedGraphChain,
  reduceActivityLog,
  applyActivityToResources,
  extractErrorLines,
  extractRadDeployError,
  explainOidcEnterpriseClaim,
  explainRepoAccessForEnvSetup,
  parseResourceProgress,
  parseRadDeployLog
} from "./deploy.js";
import {
  graphPage,
  plannedGraphPage,
  graphDiffPage,
  deployedGraphPage,
  environmentPage,
  deployingPage
} from "./pages.js";

export interface CanvasServerEntry {
  server: HttpServer;
  baseUrl: string;
  url: string;
  page: string;
  state: CanvasState;
}

interface CommandResult {
  code: string | number;
  stdout: string;
  stderr: string;
}

interface PullRequestState {
  branch: string;
  base: string;
}

interface EnvironmentListResult {
  error?: string;
  stdout?: string;
}

interface VerifyRun {
  status: string;
  conclusion: string;
}

interface DiscoveryItem {
  id: string;
  name: string;
  resourceGroup?: string;
}

interface DiscoveryResult {
  clusters: DiscoveryItem[];
  resourceGroups: DiscoveryItem[];
  namespaces: string[];
  vpcs: DiscoveryItem[];
  subnets: DiscoveryItem[];
  errors?: Record<string, string>;
}

interface BranchInfo {
  name: string;
  sha: string;
}

interface BranchResult {
  branches?: BranchInfo[];
  workspaceBranch?: string;
  error?: string;
}

interface ChildProcessInput {
  stdin: { end(): unknown } | null;
}

function discoveryItems(value: unknown): DiscoveryItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const fields = record(item);
    return {
      id: optionalString(fields.id),
      name: optionalString(fields.name),
      resourceGroup: optionalString(fields.resourceGroup)
    };
  });
}

export function endChildInput(child: ChildProcessInput): void {
  try {
    child.stdin?.end();
  } catch (_error: unknown) {
    // Closing stdin is best-effort; the command callback remains authoritative.
  }
}

function runCliCommand(
  cmd: string,
  args: string[],
  timeout = 60000
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = cliExec(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({
        code: err ? err.code || 1 : 0,
        stdout: stdout || "",
        stderr: stderr || ""
      });
    });
    endChildInput(child);
  });
}

interface ManagedEnvironment {
  name: string;
  provider?: string;
}

interface CachedPayload {
  at: number;
  payload: unknown;
}

interface AppBicepHandoffInput {
  repo: string;
  branches: string[];
  page: string;
}

export interface DeployRepairHandoffInput {
  repo: string;
  branch: string;
  error: string;
  deployRunUrl: string;
  attemptId: string;
  instanceId: string;
}

interface OpenSourceInput {
  path: string;
  line: number;
  instanceId: string;
  state?: CanvasState;
}

type AppBicepHandoff = (input: AppBicepHandoffInput) => Promise<unknown>;
type DeployRepairHandoff = (input: DeployRepairHandoffInput) => unknown;
type OpenSourceHandler = (input: OpenSourceInput) => Promise<unknown>;
type SessionPromptHandler = (prompt: string) => Promise<unknown>;

interface IdValidationInput {
  tenantId?: string;
  subscriptionId?: string;
}

interface AzureLoginInput {
  tenantId?: string;
  activeTenantId?: string;
}

interface AzureCliAssistInput {
  action?: string;
  tenantId?: string;
}

interface DeployHandoffSummary {
  state: string;
  attempts: number;
  maxAttempts: number;
  pending: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown, fallback: string): string {
  const value = record(error).code;
  return typeof value === "string" && value ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value));
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function canvasGraphResources(values: unknown[]): CanvasGraphResource[] {
  return values.map((value) => {
    const item = record(value);
    const connections =
      Array.isArray(item.connections) ?
        item.connections.map((connection) => {
          const fields = record(connection);
          return {
            ...fields,
            id: optionalString(fields.id),
            name: optionalString(fields.name),
            direction: optionalString(fields.direction)
          };
        })
      : undefined;
    return {
      ...item,
      id: optionalString(item.id),
      name: optionalString(item.name),
      type: optionalString(item.type),
      ...(connections ? { connections } : {})
    };
  });
}

interface DeploymentRecord {
  id: string;
  state: string;
  runUrl: string;
  isDeploy: boolean;
  isDelete: boolean;
  runStatus: string;
  runConclusion: string;
}

interface DeploymentRow {
  app: string;
  environment: string;
  provider: string;
  status: string;
  deploymentId: string;
  runUrl: string;
}

interface DeployStatusRecord {
  runConclusion?: string;
  runStatus?: string;
  state?: string;
}

interface RoleAssignmentInput {
  objectId: string;
  role: string;
  scope: string;
  subscriptionId: string;
}

interface FederatedCredential {
  name: string;
  subject: string;
}

// Per-instance canvas servers: instanceId -> { server, url, page, state }.
// Shared with the SDK entry (extension.ts) for open/close + shutdown.
export const servers = new Map<string, CanvasServerEntry>();

export function graphDefinitionHash(
  content: string,
  artifactsFingerprint = ""
): string {
  return createHash("sha256")
    .update(content)
    .update("\0")
    .update(artifactsFingerprint)
    .digest("hex");
}

export function canReuseModeledGraph(
  state: CanvasState,
  repo: string,
  branch: string,
  definitionHash: string
): boolean {
  return (
    state?.graphLoaded === true &&
    state.graphTargetRepo === repo &&
    state.graphBranch === branch &&
    state.graphDefinitionHash === definitionHash &&
    Array.isArray(state.graphResources)
  );
}

export function isCurrentSourceRefToken(
  state: {
    sourceRefContexts?: Partial<Record<GraphView, { token?: string }>>;
  },
  view: GraphView,
  token: unknown
): boolean {
  return !!token && state?.sourceRefContexts?.[view]?.token === token;
}

export function addGraphProgress(
  state: CanvasState,
  generation: number,
  message: string
): boolean {
  if (!state || state.graphBuildGeneration !== generation) return false;
  if (!state.progressMessages) state.progressMessages = [];
  state.progressMessages.push(message);
  return true;
}

// deployStatusReaderFromState - build a GHCR-first deployed-graph/status reader
// from a canvas instance's state. The graph registry/tag are derived the same
// way the deploy workflow producer derives them (from the environment's GHCR
// state registry + the environment/app names), so the reader pulls the exact
// artifact the deploy published. Falls back to the radius-deploy-status branch
// when the environment/app/registry can't be resolved or the artifact is
// absent.
//
// The app name is required to build the producer's "<environment>-<app>-latest"
// tag. It's populated during the deploy flow, but on a fresh session (or when
// the Deployed tab is opened without first deploying) it's derived here from the
// repo's app.bicep — the SAME first-`name:`-literal extraction the producer uses
// — and cached back into state so GHCR retrieval works across reloads.
async function deployStatusReaderFromState(
  state: CanvasState,
  repo: string,
  branch: string
) {
  const environment = state?.deployEnvName || state?.envName || "";
  let app = state?.deployAppName || "";
  if (!app && repo && environment) {
    app = await resolveGraphAppName(
      repo,
      branch || state?.deployingBranch || state?.graphBranch || ""
    );
    if (app && state) state.deployAppName = app;
  }
  let stateRegistry = "";
  if (repo && environment) {
    try {
      stateRegistry = stateRegistryForEnvironment(repo, environment);
    } catch {
      stateRegistry = "";
    }
  }
  return createDeployStatusReader({ repo, environment, app, stateRegistry });
}

// resolveGraphAppName - extract the Radius app name for the GHCR graph tag using
// the producer's exact rule (the first `name: '...'` literal in app.bicep). This
// differs from resolveRepoAppName, which prefers the applications resource name
// and falls back to the repo basename; the tag must match the producer's grep
// byte-for-byte, so an unresolved name yields "" (reader stays on the branch).
async function resolveGraphAppName(
  repo: string,
  branch: string
): Promise<string> {
  const ref = branch || "main";
  for (const p of [".radius/app.bicep", "app.bicep"]) {
    let raw: string;
    try {
      raw = await ghOrThrow([
        "api",
        `/repos/${repo}/contents/${p}?ref=${ref}`,
        "--jq",
        ".content"
      ]);
    } catch {
      raw = "";
    }
    if (!raw) continue;
    let decoded: string;
    try {
      decoded = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      decoded = "";
    }
    const name = appNameForGraphTag(decoded);
    if (name) return name;
  }
  return "";
}

// Short-lived cache for the /api/list-environments listing to keep the planned
// and deploy pages snappy. Invalidated on environment creation.
const ENV_LIST_TTL_MS = 15000;
const envListCache = new Map<string, CachedPayload>();

// Short-lived cache for the /api/list-deployments listing. The listing fans out
// into many per-record `gh api` calls, so caching keeps the deploy page snappy
// across re-opens and the workflow poll. Invalidated when a deploy or delete is
// dispatched (see /api/deploy and /api/delete-deployment).
const DEPLOY_LIST_TTL_MS = 15000;
const deployListCache = new Map<string, CachedPayload>();

// Throttle for the background workflow drift-sync kicked off from the
// environments listing: repo -> last-attempt epoch ms. Keeps the sync from
// re-running on every page load / poll while still self-healing stale workflows.
const WORKFLOW_SYNC_TTL_MS = 5 * 60 * 1000;
const workflowSyncState = new Map<string, number>();

// Fire-and-forget: re-sync the repo's committed Radius workflow files with the
// upstream templates when they've drifted. Runs in the background so it never
// delays the environments listing, and is throttled per repo. Managed
// environments (name + provider) are required to regenerate the expected
// content, so this is only called on the fresh-compute path. `workingBranch` is
// the session worktree branch (when it matches the repo) so the sync updates
// both the default branch and the branch a worktree-consistent deploy runs.
function kickoffWorkflowSync(
  repo: string,
  managedEnvironments: ManagedEnvironment[],
  workingBranch: string
): void {
  if (!repo || !managedEnvironments || managedEnvironments.length === 0) return;
  // Throttle per repo+branch so switching the working branch triggers a fresh
  // sync instead of waiting out a repo-wide cooldown.
  const key = `${repo}\u0000${workingBranch || ""}`;
  const last = workflowSyncState.get(key) || 0;
  if (Date.now() - last < WORKFLOW_SYNC_TTL_MS) return;
  workflowSyncState.set(key, Date.now());
  syncRepoWorkflows(repo, managedEnvironments, {
    workingBranch: workingBranch || "",
    log: (m) => console.error(`[radius workflow-sync] ${repo}: ${m}`)
  })
    .then((r) => {
      if (r && r.updated && r.updated.length) {
        console.error(
          `[radius workflow-sync] ${repo}: updated ${r.updated.length} workflow file(s) across ${(r.branches || []).join(", ")}: ${r.updated.join(", ")}`
        );
      }
    })
    .catch((e: unknown) =>
      console.error(`[radius workflow-sync] ${repo}: ${errorMessage(e)}`)
    );
}

// Bare filename of the shared verify-credentials workflow (matches
// infra.ts's VERIFY_WORKFLOW_PATH). Used to target a pre-dispatch sync.
// Awaited, best-effort pre-dispatch workflow sync. Before the extension runs a
// committed workflow (deploy / delete / verify), ensure that workflow's files
// are in sync with the upstream Radius templates so the run never executes a
// drifted copy. Unlike the throttled background pass (kickoffWorkflowSync), this
// is scoped to just the workflow about to run (`only`) and is awaited so any
// in-place update lands before the dispatch — but a sync failure never blocks
// the dispatch (we log and proceed). `provider` may be "" when unknown; deploy
// and delete workflow content is provider-agnostic, so it only matters for
// verify. `workingBranch` (when it matches the repo) is synced alongside the
// default branch so a worktree-consistent run uses current files on both.
async function ensureWorkflowsCurrent(
  repo: string,
  environment: string,
  provider: string,
  only: string[],
  workingBranch = ""
): Promise<void> {
  if (!repo || !environment || !only || only.length === 0) return;
  try {
    const r = await syncRepoWorkflows(
      repo,
      [{ name: environment, provider: provider || "" }],
      {
        workingBranch: workingBranch || "",
        only,
        log: (m) => console.error(`[radius workflow-presync] ${repo}: ${m}`)
      }
    );
    if (r && r.updated && r.updated.length) {
      console.error(
        `[radius workflow-presync] ${repo}: updated ${r.updated.join(", ")} before dispatch`
      );
    }
  } catch (e) {
    console.error(`[radius workflow-presync] ${repo}: ${errorMessage(e)}`);
  }
}

// no access to the SDK `session`, so when a graph/generate route finds no
// app.bicep it delegates through this hook, which injects a user turn asking the
// agent to run the radius-app-bicep skill. This is what makes branch/repo
// selection (not just canvas open) trigger generation automatically.
let appBicepHandoff: AppBicepHandoff | null = null;
export function setAppBicepHandoff(fn: AppBicepHandoff): void {
  appBicepHandoff = fn;
}

// Registered by the SDK entry (extension.ts) to hand a failed canvas deploy
// back to the agent for repair. The canvas Deploy button dispatches the workflow
// itself, so without this a failure dead-ends in the UI.
let deployRepairHandoff: DeployRepairHandoff | null = null;
export function setDeployRepairHandoff(fn: DeployRepairHandoff | null): void {
  deployRepairHandoff = fn;
}

// Handler registered by the SDK entry (extension.ts) that opens a repo file in
// the Copilot app's built-in "editor" canvas (side pane). The server has no SDK
// access, so the webview's "View source code" click (for local-workspace graphs)
// reaches the SDK through this hook. Mirrors setAppBicepHandoff.
let openSourceHandler: OpenSourceHandler | null = null;
export function setOpenSourceHandler(fn: OpenSourceHandler): void {
  openSourceHandler = fn;
}

// The server also cannot inject an arbitrary user turn by itself, so routes that
// need the Copilot session to take an out-of-band action (for example, kicking
// off Azure CLI login or install guidance) delegate through this hook.
let sessionPromptHandler: SessionPromptHandler | null = null;
export function setSessionPromptHandler(fn: SessionPromptHandler): void {
  sessionPromptHandler = fn;
}

export function isCliCommandMissing(detail: unknown): boolean {
  const text = String(detail || "").trim();
  if (!text) return false;
  return (
    /\bspawn(?:Sync)?\s+az(?:\.exe)?\s+ENOENT\b/i.test(text) ||
    /\baz(?:\.exe)?:\s*command not found\b/i.test(text) ||
    /['"]?az(?:\.exe)?['"]?\s+is not recognized as an internal or external command\b/i.test(
      text
    )
  );
}

export function azureCredentialIdValidationError({
  tenantId = "",
  subscriptionId = ""
}: IdValidationInput = {}): string {
  if (tenantId && !isUuid(tenantId)) {
    return `Invalid tenantId "${tenantId}" (expected a GUID).`;
  }
  if (subscriptionId && !isUuid(subscriptionId)) {
    return `Invalid subscriptionId "${subscriptionId}" (expected a GUID).`;
  }
  return "";
}

export function azureLoginRequiredResponse({
  tenantId = "",
  activeTenantId = ""
}: AzureLoginInput = {}): {
  error: string;
  code: string;
  tenantId: string;
} {
  const error =
    activeTenantId ?
      `Active Azure session is tenant ${activeTenantId}, not ${tenantId}. Run "az login --use-device-code --tenant ${tenantId}" in your terminal, then click Verify Credentials again.`
    : 'No active Azure session. Run "az login --use-device-code" in your terminal, then click Verify Credentials again.';
  return { error, code: "az-login-required", tenantId };
}

export async function invokeSessionPrompt(
  handler: SessionPromptHandler | null,
  prompt: string
): Promise<{ status: number; error?: string }> {
  if (typeof handler !== "function") {
    return {
      status: 503,
      error: "Could not reach the Copilot session to start Azure CLI help."
    };
  }
  try {
    await handler(prompt);
    return { status: 200 };
  } catch {
    return {
      status: 502,
      error: "The Copilot session could not start Azure CLI help."
    };
  }
}

export function buildAzureCliAssistPrompt({
  action = "login",
  tenantId = ""
}: AzureCliAssistInput = {}): string {
  const safeTenantId =
    typeof tenantId === "string" && isUuid(tenantId.trim()) ?
      tenantId.trim()
    : "";
  const loginCommand = `az login --use-device-code${safeTenantId ? ` --tenant ${safeTenantId}` : ""}`;
  const loginInstructions = [
    `Run \`${loginCommand}\` in this Copilot session.`,
    "For that command, remove COPILOT_AGENT_SESSION_ID from the az process environment so Azure CLI does not inject it into the authentication request.",
    "Use the shell-appropriate way to unset the variable only for the login invocation, and show me the device code and sign-in URL."
  ].join(" ");
  if (action === "install") {
    return [
      "Azure CLI is not installed in this environment, so the Radius canvas can't verify Azure credentials yet.",
      `Please install Azure CLI, then ${loginInstructions}`,
      "After the install and login finish, return to the Radius canvas and click Verify Credentials again."
    ].join("\n\n");
  }
  return [
    "The Radius canvas needs an active Azure CLI session before it can verify these credentials.",
    loginInstructions,
    "After the login finishes, return to the Radius canvas and click Verify Credentials again."
  ].join("\n\n");
}

// Fire the app.bicep handoff at most once per repo+branch(es) for a given
// instance. Fire-and-forget so it never blocks the HTTP response.
function triggerAppBicepHandoff(
  entry: CanvasServerEntry | undefined,
  repo: string,
  branches: string | string[],
  page: string
): void {
  try {
    if (typeof appBicepHandoff !== "function") return;
    if (!repo) return;
    const list = (Array.isArray(branches) ? branches : [branches]).filter(
      (branch): branch is string => Boolean(branch)
    );
    const state = entry?.state;
    const key = `${repo}::${list.join(",")}`;
    if (state) {
      if (state.appBicepHandoffKey === key) return; // already handed off
      state.appBicepHandoffKey = key;
    }
    Promise.resolve(appBicepHandoff({ repo, branches: list, page })).catch(
      () => {}
    );
  } catch {
    /* never let a handoff failure break the response */
  }
}

// Hand a failed deploy to the agent to repair and redeploy. Fires at most once
// per repair loop: once the agent owns the loop it redeploys and re-reads status
// itself, so re-handing off every failed attempt would double-drive it.
// `branch-not-pushed` is excluded: the user fixes that with a push, not by
// editing the model.
//
// Delivery is tracked explicitly (pending -> delivered | failed) because the
// browser stops polling once a deploy is terminal: a rejected send has no later
// poll to piggyback on, so the status route keeps the poll alive while delivery
// is pending or retryable and gives up after DEPLOY_HANDOFF_MAX_ATTEMPTS.
export const DEPLOY_HANDOFF_MAX_ATTEMPTS = 3;

export function triggerDeployRepairHandoff(
  entry: { state: CanvasState } | undefined,
  instanceId = ""
): boolean {
  try {
    if (typeof deployRepairHandoff !== "function") return false;
    const state = entry?.state;
    if (!state || state.deployStatus !== "failed") return false;
    if (state.deployErrorKind === "branch-not-pushed") return false;
    if (state.deployRepairing) return false;
    if (
      state.deployHandoffState === "pending" ||
      state.deployHandoffState === "failed"
    )
      return false;
    const repo =
      state.deployingRepo || state.plannedRepo || state.contextRepo || "";
    const branch = state.deployingBranch || "";
    const error = state.deployError || "";
    const deployRunUrl = state.deployRunUrl || "";
    const attemptId = state.deployAttempt?.id || "";
    state.deployHandoffState = "pending";
    state.deployHandoffAttempts = (state.deployHandoffAttempts || 0) + 1;
    const delivered = () => {
      state.deployHandoffState = "delivered";
      state.deployRepairing = true;
    };
    // A handoff that never reached the agent must not leave the loop marked as
    // owned; it becomes retryable until the attempt budget runs out.
    const failed = () => {
      state.deployRepairing = false;
      state.deployHandoffState =
        (state.deployHandoffAttempts || 0) >= DEPLOY_HANDOFF_MAX_ATTEMPTS ?
          "failed"
        : "retryable";
    };
    try {
      Promise.resolve(
        deployRepairHandoff({
          repo,
          branch,
          error,
          deployRunUrl,
          attemptId,
          instanceId
        })
      ).then(delivered, failed);
    } catch {
      failed();
      return false;
    }
    return true;
  } catch {
    /* never let a handoff failure break the response */
  }
  return false;
}

// What the webview needs to decide whether to keep polling after a failed deploy.
export function deployHandoffStatus(state: CanvasState): DeployHandoffSummary {
  const handoffState = state?.deployHandoffState || "idle";
  return {
    state: handoffState,
    attempts: state?.deployHandoffAttempts || 0,
    maxAttempts: DEPLOY_HANDOFF_MAX_ATTEMPTS,
    pending: handoffState === "pending" || handoffState === "retryable"
  };
}

// Bare filename of the legacy monolithic deploy workflow that the composite-
// action model (run-rad-commands*.yml) replaces. Removed from target repos on
// commit so it does not double-trigger alongside the new dispatcher.
const LEGACY_DEPLOY_WORKFLOW_FILE = "radius-deploy.yml";

// The workflow that actually runs `rad` deploy commands. The deployments list
// only surfaces deployment records produced by this workflow — records created
// by other environment-bound workflows (verify-credentials, delete-application)
// are not real application deployments and are filtered out.
const DEPLOY_WORKFLOW_FILE = "run-rad-commands.yml";
const DELETE_WORKFLOW_FILE = "delete-application.yml";

// gh runner that REJECTS on failure, so callers can fail closed instead of
// silently treating a GitHub outage or timeout as "no data". Used by the
// deployment-resolution paths where an empty result must not be mistaken for a
// definitive answer (e.g. "no app is deployed" → allow environment deletion).
function ghOrThrow(args: string[], timeout = 12000): Promise<string> {
  return new Promise((resolve, reject) => {
    cliExec("gh", args, { timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve((stdout || "").trim());
    });
  });
}

// Preflight the acting gh account's access to `repo` BEFORE any Azure/GitHub
// mutation (App Registration create, environment PUT). Uses ghApiJson, which
// routes through cliExec→ghChildEnv and therefore acts as the same active
// keyring account the later mutations use. Returns a clear, actionable error
// string when the account can't read the repo or lacks admin, else ''.
//
// Keying on ghApiJson's parsed HTTP status (not string-matched error text) makes
// the two failure modes unambiguous: a 404 means the account genuinely can't see
// the repo (readFailed), while any other non-ok result — a transient error, a
// non-JSON body, or an unparseable status — is treated as ambiguous and returns
// '' so the preflight never silently misdirects; the real op then surfaces the
// true error. GitHub still enforces permissions server-side regardless.
async function preflightRepoAdmin(repo: string): Promise<string> {
  let login = "";
  const who = await ghApiJson("user");
  if (who.ok) login = optionalString(record(who.json).login);
  let readFailed = false,
    permissions = null;
  const res = await ghApiJson(`repos/${repo}`);
  if (res.ok) {
    const value = record(res.json).permissions;
    permissions = value && typeof value === "object" ? record(value) : null;
  } else if (res.status === 404) {
    readFailed = true;
  } else {
    return ""; // ambiguous/transient — don't block or mislead; let the real op surface the true error
  }
  return explainRepoAccessForEnvSetup({
    repo,
    login,
    readFailed,
    permissions
  });
}

// How many of an environment's newest deployment records to resolve
// concurrently before falling back to a serial walk. The relevant deploy/delete
// record is almost always in the newest handful.
const DEPLOY_MAX_PARALLEL_RECORDS = 10;

// Resolve the Radius application name for a repo the same way /api/list-applications
// does: read the name declared in `.radius/app.bicep` (or `app.bicep`) on `branch`,
// falling back to the repo's short name when it can't be read. A repo hosts a single
// Radius application in this model. Best-effort — a read failure falls back to the
// basename rather than throwing, since callers use the name only for display and for
// targeting the app's deploy/delete, not for the fail-closed deployment check itself.
async function resolveRepoAppName(
  repo: string,
  branch: string
): Promise<string> {
  let appName = repo.split("/").pop() || repo;
  const ref = branch || "main";
  for (const p of [".radius/app.bicep", "app.bicep"]) {
    let raw: string;
    try {
      raw = await ghOrThrow([
        "api",
        `/repos/${repo}/contents/${p}?ref=${ref}`,
        "--jq",
        ".content"
      ]);
    } catch {
      raw = "";
    }
    if (!raw) continue;
    let decoded: string;
    try {
      decoded = Buffer.from(raw, "base64").toString("utf8");
    } catch {
      decoded = "";
    }
    const name = extractAppName(decoded);
    if (name) {
      appName = name;
      break;
    }
  }
  return appName;
}

// Derive the deployment status for a single deploy record from the linked
// workflow run's completion state, falling back to the deployment-status record
// when no run information is available.  Exported for unit tests.
//
// `rec` must carry: { runConclusion, runStatus, state }
// Returns one of: "success" | "failed" | "pending"
export function resolveDeployStatus(rec: DeployStatusRecord): string {
  if (rec.runConclusion === "success") return "success";
  if (rec.runConclusion) return "failed"; // completed, non-success (failure/cancelled/timed_out/…)
  if (rec.runStatus && rec.runStatus !== "completed") return "pending"; // genuinely still running
  // No linked run (or unknown run state): fall back to the deployment
  // record's own state so we still reflect a terminal outcome.
  if (rec.state === "success") return "success";
  if (rec.state === "failure" || rec.state === "error") return "failed";
  return "pending";
}

// True when an `az role assignment create` error means the assignee principal
// has not replicated through Microsoft Graph yet, so the SAME command is worth
// retrying after a short delay. Genuine failures — above all AuthorizationFailed
// (the signed-in user lacks permission to assign roles) — return false so they
// surface immediately instead of being masked by pointless retries. See the
// Step-6 role-assignment block for why this race exists and why it is platform
// independent (not a macOS/Windows difference).
export function isReplicationLagError(stderr?: string): boolean {
  if (!stderr) return false;
  return /does not exist in the directory|PrincipalNotFound|Cannot find (?:principal|user or service principal)|No matching principal|not found in the directory/i.test(
    stderr
  );
}

// Build the argument vector for `az role assignment create`. Assign by the
// Service Principal's OBJECT ID (not its appId): `--assignee <appId>` forces az
// to resolve the appId to its SP object first, which races Graph replication
// right after `az ad sp create` and, on some CLI versions, silently no-ops so
// the role is never written (the identity then signs in but sees "No
// subscriptions found"). `--assignee-object-id` with an explicit
// `--assignee-principal-type ServicePrincipal` skips that lookup entirely.
export function buildRoleAssignmentArgs({
  objectId,
  role,
  scope,
  subscriptionId
}: RoleAssignmentInput): string[] {
  return [
    "role",
    "assignment",
    "create",
    "--assignee-object-id",
    objectId,
    "--assignee-principal-type",
    "ServicePrincipal",
    "--role",
    role,
    "--scope",
    scope,
    "--subscription",
    subscriptionId,
    "--output",
    "none"
  ];
}

// Detect the federated-credential NAME collision that reintroduces AADSTS700213.
// FIC creation dedups on SUBJECT, but Azure keys FIC uniqueness on NAME, and
// `buildFederatedCredentialName` runs the env name through clean() (collapsing
// non-alphanumerics to "-") while the subject keeps its "%3A"-encoded colon. So
// two environments whose names normalize to the same string (e.g. "prod:west"
// and "prod-west") produce ONE name with TWO subjects. Given the post-dedup list
// to create and a name→subject map of the FICs already on the app, return the
// first credential whose name already exists with a DIFFERENT subject (a real
// collision that must fail loud), or null when there is none. `desired` items
// with a subject already present would have been deduped upstream, so any name
// hit here is genuinely a different environment.
export function findFederatedCredentialNameCollision(
  desired: Array<Partial<FederatedCredential>> | null,
  existingNameToSubject: Map<string, string> | Record<string, string> | null
): {
  name: string;
  existingSubject: string | undefined;
  desiredSubject: string;
} | null {
  if (!desired || !existingNameToSubject) return null;
  const lookup =
    existingNameToSubject instanceof Map ?
      existingNameToSubject
    : new Map(Object.entries(existingNameToSubject));
  for (const fic of desired) {
    if (!fic || !fic.name || !fic.subject) continue;
    if (lookup.has(fic.name) && lookup.get(fic.name) !== fic.subject) {
      return {
        name: fic.name,
        existingSubject: lookup.get(fic.name),
        desiredSubject: fic.subject
      };
    }
  }
  return null;
}

// Choose the resource group that actually holds the AKS cluster, for building
// the Cluster Admin role scope. The deployment resource group (the editable RG
// combo in the dialog) and the cluster's own resource group can legitimately
// differ: a cluster in "rg-shared" can be targeted by an environment that
// deploys into "rg-app". The dialog auto-syncs the RG combo to the cluster's RG
// when a cluster is picked, but the combo stays editable — so a user who then
// changes the RG would otherwise scope the AKS grant to a resource group that
// does NOT contain the cluster, landing the Cluster Admin assignment on a path
// where the cluster doesn't exist and failing the deploy at "Verify AKS Access".
// `clusterResourceGroup` is sourced from /api/discover (which returns each
// cluster's own resourceGroup) and is therefore authoritative when present;
// fall back to the deployment resource group only when it is absent (e.g. a
// custom-typed cluster name that never came from discovery).
export function pickAksResourceGroup(
  clusterResourceGroup: unknown,
  resourceGroup: string
): string {
  const own =
    typeof clusterResourceGroup === "string" ? clusterResourceGroup.trim() : "";
  return own || resourceGroup;
}

// Resolve the CURRENT application deployment for a single environment, or null
// when no application is deployed (no deploy/delete record, or the latest delete
// succeeded). Scoped to the environment's OWN deployment history (the GitHub
// `environment=` filter) so a busy environment can never crowd another's latest
// record out of a shared, repo-wide page. Rejects on any GitHub error so callers
// fail closed rather than mistaking an outage for "nothing deployed".
//
// `appName` is the resolved Radius application name (see resolveRepoAppName); it
// must be passed in so the returned row targets the real app declared in
// app.bicep, not the repo basename — the environment-deletion guard dispatches a
// delete for this name and redirects to it, and the deployments list links to it.
// Returns `{ app, environment, provider, status, deploymentId, runUrl }`.
async function resolveEnvDeployment(
  repo: string,
  environment: string,
  appName: string
): Promise<DeploymentRow | null> {
  appName = appName || repo.split("/").pop() || repo;
  // Provider is cosmetic (drives portal links only), so a lookup failure here
  // must not block the whole resolution — soft-fail to an empty provider.
  let provider = "";
  try {
    const varsRaw = await ghOrThrow([
      "api",
      `/repos/${repo}/environments/${encodeURIComponent(environment)}/variables?per_page=100`,
      "--jq",
      ".variables[].name"
    ]);
    if (/AZURE_/.test(varsRaw)) provider = "azure";
    else if (/AWS_/.test(varsRaw)) provider = "aws";
  } catch {
    /* provider stays "" */
  }

  // Newest-first deployment records for THIS environment only.
  const idsRaw = await ghOrThrow([
    "api",
    `/repos/${repo}/deployments?per_page=100&environment=${encodeURIComponent(environment)}`,
    "--jq",
    ".[].id"
  ]);
  const ids = idsRaw ? idsRaw.split("\n").filter(Boolean) : [];

  const resolveRecord = async (id: string): Promise<DeploymentRecord> => {
    const stateRaw = await ghOrThrow([
      "api",
      `/repos/${repo}/deployments/${id}/statuses?per_page=1`,
      "--jq",
      '(.[0].state // "") + "\\t" + (.[0].log_url // .[0].target_url // "")'
    ]);
    const tab = stateRaw.indexOf("\t");
    const state = tab === -1 ? stateRaw : stateRaw.slice(0, tab);
    const logUrl = tab === -1 ? "" : stateRaw.slice(tab + 1);
    let runUrl = "";
    const m = /actions\/runs\/(\d+)/.exec(logUrl || "");
    if (m) runUrl = `https://github.com/${repo}/actions/runs/${m[1]}`;
    else if (/^https?:\/\//.test(logUrl || "")) runUrl = logUrl;
    let runPath = "";
    let runStatus = "";
    let runConclusion = "";
    if (m) {
      const runInfo = await ghOrThrow([
        "api",
        `/repos/${repo}/actions/runs/${m[1]}`,
        "--jq",
        '(.path // "") + "\\t" + (.status // "") + "\\t" + (.conclusion // "")'
      ]);
      const parts = runInfo.split("\t");
      runPath = parts[0] || "";
      runStatus = parts[1] || "";
      runConclusion = parts[2] || "";
    }
    const isDeploy = new RegExp(
      `(^|/)${DEPLOY_WORKFLOW_FILE.replace(/[.]/g, "\\$&")}$`
    ).test(runPath);
    const isDelete = new RegExp(
      `(^|/)${DELETE_WORKFLOW_FILE.replace(/[.]/g, "\\$&")}$`
    ).test(runPath);
    return { id, state, runUrl, isDeploy, isDelete, runStatus, runConclusion };
  };

  // Apply the selection rules to a resolved record:
  //   'skip'  → not relevant (verify-credentials, or a failed delete); keep walking
  //   null    → app deleted; environment has no active deployment
  //   object  → the deployment row for this environment
  const decide = (rec: DeploymentRecord): DeploymentRow | "skip" | null => {
    if (!rec.isDeploy && !rec.isDelete) return "skip";
    if (rec.isDelete && rec.runConclusion === "success") return null;
    if (rec.isDelete && rec.runConclusion && rec.runConclusion !== "success")
      return "skip";
    let status: string;
    if (rec.isDelete) {
      status = "deleting"; // delete still in progress
    } else {
      // Deploy status is derived from the WORKFLOW RUN's completion, not the
      // GitHub deployment-status record. A failed deploy often leaves that
      // record stuck at "pending"/"in_progress" (the workflow never posts a
      // terminal "failure" status), which previously mis-reported a failed
      // deploy as "pending" and wrongly kept the Deploy button greyed out.
      // Treat the run as authoritative: only a run that has NOT completed is
      // "pending"; a completed run is "success" or "failed" by its
      // conclusion, and a failed deploy does not block a redeploy.
      status = resolveDeployStatus(rec);
    }
    return {
      app: appName,
      environment,
      provider,
      status,
      deploymentId: rec.id,
      runUrl: rec.runUrl
    };
  };

  // Resolve the newest batch concurrently, then apply the rules newest-first.
  const batch = ids.slice(0, DEPLOY_MAX_PARALLEL_RECORDS);
  const resolved = await Promise.all(batch.map(resolveRecord));
  for (const rec of resolved) {
    const r = decide(rec);
    if (r === "skip") continue;
    return r;
  }
  // Rare fallback: nothing decisive in the newest batch — walk the rest serially.
  for (const id of ids.slice(DEPLOY_MAX_PARALLEL_RECORDS)) {
    const r = decide(await resolveRecord(id));
    if (r === "skip") continue;
    return r;
  }
  return null;
}

/**
 * Best-effort delete of the legacy `.github/workflows/radius-deploy.yml` from a
 * target repo. No-op when the file is absent. Self-contained (uses cliExec) so
 * it can be called from any request handler regardless of its local gh runner.
 */
function deleteLegacyDeployWorkflow(targetRepo: string): Promise<boolean> {
  const path = ".github/workflows/" + LEGACY_DEPLOY_WORKFLOW_FILE;
  return new Promise((resolve) => {
    cliExec(
      "gh",
      ["api", "/repos/" + targetRepo + "/contents/" + path, "--jq", ".sha"],
      { timeout: 30000 },
      (err, stdout) => {
        const sha = err ? "" : (stdout || "").trim();
        if (!sha) {
          resolve(false);
          return;
        }
        cliExec(
          "gh",
          [
            "api",
            "--method",
            "DELETE",
            "/repos/" + targetRepo + "/contents/" + path,
            "-f",
            "message=Remove legacy Radius deploy workflow (replaced by run-rad-commands.yml)",
            "-f",
            "sha=" + sha
          ],
          { timeout: 30000 },
          () => resolve(true)
        );
      }
    );
  });
}

// Ensure the deploy workflow files exist on `branch` so that dispatching
// `run-rad-commands.yml` with `--ref branch` resolves — both the dispatcher
// itself and the provider workflow it pulls in via a local-path `uses:`. The
// env-creation flow commits these to the repo's DEFAULT branch only (the GitHub
// contents API commit is branch-less), so a feature/worktree branch usually
// lacks them. Missing files are generated from the pinned upstream templates and
// committed onto `branch`; existing ones are left untouched. Best-effort per
// file — a commit failure is surfaced by the caller, not thrown here.
async function ensureDeployWorkflowsOnBranch(
  repo: string,
  branch: string,
  envName: string,
  log: (message: string) => void = () => {}
): Promise<void> {
  if (!repo || !branch) return;
  // Only the dispatcher + the Azure provider workflow are published to target
  // repos today (the AWS provider file is intentionally withheld, matching the
  // env-creation commit step), so those are the two a `--ref` dispatch needs.
  const wanted = [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE];
  const existsOnBranch = (file: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      cliExec(
        "gh",
        [
          "api",
          `/repos/${repo}/contents/.github/workflows/${file}?ref=${encodeURIComponent(branch)}`,
          "--jq",
          ".sha"
        ],
        { timeout: 15000 },
        (err, stdout) => resolve(!err && !!(stdout || "").trim())
      );
    });
  const presence = await Promise.all(wanted.map(existsOnBranch));
  const missing = wanted.filter((_, i) => !presence[i]);
  if (missing.length === 0) return;
  log(
    'Publishing deploy workflow(s) to branch "' +
      branch +
      '": ' +
      missing.join(", ")
  );
  const generated = await generateDeployWorkflow(envName, ".radius/app.bicep");
  for (const file of missing) {
    const content = generated && generated[file];
    if (!content) continue;
    await commitFileToRepo(
      repo,
      ".github/workflows/" + file,
      content,
      branch,
      "Add Radius deploy workflow (" +
        file +
        ") to " +
        branch +
        " for worktree-consistent deploy"
    );
  }
}

// request handler and read by the host-channel keepalive via the getter below
// to tell whether a panel is actively open (so the process isn't idle-reaped).
let lastWebviewActivityAt = 0;
export function getLastWebviewActivityAt(): number {
  return lastWebviewActivityAt;
}

function accessForSelection(
  entry: CanvasServerEntry,
  repo: string,
  branch: string
) {
  const state = entry?.state || {};
  const selectedBranch = branch || defaultBranchForState(state);
  const useWorkspace = isWorkspaceSelection(state, repo, selectedBranch);
  return {
    branch: selectedBranch,
    github:
      useWorkspace ?
        createWorkspaceGitHub(state, repo, selectedBranch)
      : github,
    useWorkspace
  };
}

// Unlike repoMatches() in workspace.ts, this helper always receives a
// non-empty repo string and performs strict equality only (no falsy-arg
// shortcut), so the workspace.ts version is not reused here.
function repoMatchesWorkspace(state: CanvasState, repo: string): boolean {
  const workspaceRepo = state?.workspaceRepo || "";
  return !!workspaceRepo && repo === workspaceRepo;
}

// Resolves the app.bicep for a selection and reports where it came from.
// `fromWorkspace` is true only when the local session workspace actually
// supplied the content (not when we fell back to the remote repo), and
// `bicepPath` is the repo-relative path of the local file so callers can save
// sibling artifacts next to the exact app.bicep that was graphed.
async function fetchBicepSelection(
  entry: CanvasServerEntry,
  repo: string,
  branch: string
): Promise<{
  content: string | null;
  fromWorkspace: boolean;
  branch: string;
  bicepPath: string;
}> {
  const access = accessForSelection(entry, repo, branch);
  if (access.useWorkspace) {
    const local = await resolveWorkspaceBicep(entry.state, repo, access.branch);
    if (local)
      return {
        content: local.content,
        fromWorkspace: true,
        branch: access.branch,
        bicepPath: local.repoPath
      };
  }
  const remote = await fetchBicepFromRepo(github, repo, access.branch);
  return {
    content: remote,
    fromWorkspace: false,
    branch: access.branch,
    bicepPath: ""
  };
}

async function fetchFileForSelection(
  entry: CanvasServerEntry,
  repo: string,
  branch: string,
  repoPath: string
): Promise<string | null> {
  const access = accessForSelection(entry, repo, branch);
  if (access.useWorkspace) {
    const local = await fetchWorkspaceFile(
      entry.state,
      repo,
      access.branch,
      repoPath
    );
    if (local !== null) return local;
  }
  return await fetchFileFromRepo(repo, repoPath, access.branch);
}

// Reject browser-labeled cross-site mutations while allowing non-browser clients.
export function isCrossSiteMutation(
  method: string | undefined,
  secFetchSite: string | string[] | undefined | null
): boolean {
  const m = String(method || "").toUpperCase();
  if (m === "GET" || m === "HEAD") return false;
  const site = String(
    Array.isArray(secFetchSite) ? secFetchSite[0] : secFetchSite || ""
  )
    .trim()
    .toLowerCase();
  if (!site) return false; // non-browser client (no header) — allow.
  return site !== "same-origin" && site !== "none";
}

function createRequestHandler(instanceId: string) {
  return async (
    req: IncomingMessage,
    res: ServerResponse<IncomingMessage>
  ): Promise<void> => {
    lastWebviewActivityAt = Date.now();
    const url = new URL(req.url || "/", `http://localhost`);
    const pathname = url.pathname;
    // CSRF defense-in-depth: reject cross-site state-changing requests before
    // any routing or body parse. See isCrossSiteMutation for the rules.
    if (isCrossSiteMutation(req.method, req.headers["sec-fetch-site"])) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(403);
      res.end(
        JSON.stringify({
          error: "Cross-site request rejected.",
          code: "cross-site-forbidden"
        })
      );
      return;
    }
    const requestedPage = url.searchParams.get("page");
    const canvasEntry = servers.get(instanceId);
    if (canvasEntry && requestedPage) {
      canvasEntry.page = requestedPage;
      if (requestedPage === "graph")
        canvasEntry.state.activeGraphView = "graph";
      else if (requestedPage === "planned")
        canvasEntry.state.activeGraphView = "planned";
      else if (
        requestedPage === "graph-diff" ||
        requestedPage === "graphDiff"
      ) {
        canvasEntry.state.activeGraphView = "diff";
      }
    }

    // Lightweight liveness probe used by the client-side heartbeat so pages
    // can detect when the server has come back after an idle respawn.
    if (pathname === "/api/ping") {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, instanceId }));
      return;
    }

    // Open a source file from the local workspace in the Copilot editor
    // canvas (side pane). Only the webview for a local-workspace graph calls
    // this (client passes localSource); the actual open is delegated to the
    // SDK session via the handler registered in extension.ts. Status codes
    // are meaningful so the webview can flag a failed open to the user:
    // 400 invalid path, 503 handler unavailable, 500 open failed, 200 ok.
    if (pathname === "/api/open-source" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      let relPath: string;
      // `line` is reserved: the editor canvas has no line-selection input
      // yet, so it is validated and threaded through but not acted on. When
      // the canvas gains line support, the handler can start honoring it.
      let line: number;
      try {
        const data = JSON.parse(body || "{}");
        relPath = toSafeRepoRelPath(data.path);
        const lineRaw = Number.parseInt(data.line, 10);
        line = Number.isFinite(lineRaw) && lineRaw > 0 ? lineRaw : 0;
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: "invalid path" }));
        return;
      }
      if (typeof openSourceHandler !== "function") {
        res.writeHead(503);
        res.end(JSON.stringify({ ok: false, error: "unavailable" }));
        return;
      }
      try {
        const entry = servers.get(instanceId);
        await Promise.resolve(
          openSourceHandler({
            path: relPath,
            line,
            instanceId,
            state: entry?.state
          })
        );
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(
          JSON.stringify({
            ok: false,
            error: e instanceof Error ? e.message : "failed"
          })
        );
      }
      return;
    }

    // JSON API: OIDC validation
    if (pathname === "/api/oidc" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        if (data.provider === "azure") {
          // Real Azure validation via az CLI
          const validation = await validateAzureCredentials(data);
          const entry = servers.get(instanceId);
          if (validation.success) {
            const result = {
              message: `✅ Azure authentication confirmed — logged in as ${validation.userName || "user"}`,
              validated: true,
              tenantId: validation.tenantId,
              subscriptionId: validation.subscriptionId,
              subscriptionName: validation.subscriptionName,
              userName: validation.userName,
              output: generateAzureOIDC(data).output
            };
            if (entry) {
              entry.state.oidcAzure = {
                ...result,
                clientId: data.clientId || "",
                tenantName: "",
                clientName: ""
              };
            }
            // Persist credentials
            sharedCredentials.azure = {
              tenantId: validation.tenantId,
              subscriptionId: validation.subscriptionId,
              subscriptionName: validation.subscriptionName,
              userName: validation.userName,
              clientId: data.clientId || ""
            };
            saveCredentials();
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } else {
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(
              JSON.stringify({
                message: `❌ ${validation.error}`,
                validated: false,
                output: ""
              })
            );
          }
        } else {
          const result = generateAWSOIDC(data);
          const entry = servers.get(instanceId);
          if (entry) {
            entry.state.oidcAws = {
              ...result,
              accountId: data.accountId || "",
              accountName: data.accountName || "",
              region: data.region || ""
            };
          }
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(JSON.stringify(result));
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e || "");
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: detail || "Bad request." }));
      }
      return;
    }

    // Verify Azure CLI login with specified tenant/subscription
    if (pathname === "/api/verify-azure-login" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const tenantId = (data.tenantId || "").trim();
        const subscriptionId = (data.subscriptionId || "").trim();

        // Reject non-GUID credential identifiers before using them in
        // command guidance or passing the subscription to the az argv.
        // On Windows cliExec routes az through `cmd.exe /c`, and libuv only
        // quotes args containing whitespace, so a value like "x&calc" would
        // be parsed by cmd.exe as a command separator. An empty value is
        // allowed (fall back to the ambient CLI context). Mirrors the guard
        // already enforced in /api/azure-auto-setup.
        const validationError = azureCredentialIdValidationError({
          tenantId,
          subscriptionId
        });
        if (validationError) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(JSON.stringify({ error: validationError }));
          return;
        }

        // NOTE: we intentionally do NOT run `az login` here. Interactive
        // login opens a browser/device-code flow that blocks indefinitely
        // and would hang this server. Instead we verify the user's existing
        // Azure CLI session (and optionally switch subscription). If there
        // is no session, the canvas can ask Copilot to start device-code login.
        if (subscriptionId) {
          try {
            await runCommand(
              "az",
              ["account", "set", "--subscription", subscriptionId],
              { timeout: 10000 }
            );
          } catch (e) {}
        }

        let acct;
        try {
          const acctJson = await runCommand(
            "az",
            ["account", "show", "-o", "json"],
            { timeout: 10000 }
          );
          acct = JSON.parse(acctJson);
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e || "");
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          if (isCliCommandMissing(detail)) {
            res.end(
              JSON.stringify({
                error: "Azure CLI is not installed.",
                code: "az-cli-missing",
                tenantId
              })
            );
          } else {
            res.end(JSON.stringify(azureLoginRequiredResponse({ tenantId })));
          }
          return;
        }

        // If a tenant was specified and the active session is for a
        // different tenant, surface a clear, actionable message.
        if (
          tenantId &&
          acct.tenantId &&
          acct.tenantId.toLowerCase() !== tenantId.toLowerCase()
        ) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(
            JSON.stringify(
              azureLoginRequiredResponse({
                tenantId,
                activeTenantId: acct.tenantId
              })
            )
          );
          return;
        }

        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            success: true,
            user: acct.user?.name || "",
            tenantId: acct.tenantId,
            subscriptionId: acct.id,
            subscriptionName: acct.name
          })
        );
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            error: "Azure CLI verification failed: " + errorMessage(e)
          })
        );
      }
      return;
    }

    if (pathname === "/api/azure-cli-assist" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body || "{}");
        const action = data.action === "install" ? "install" : "login";
        const requestedTenantId =
          typeof data.tenantId === "string" ? data.tenantId.trim() : "";
        const tenantId = isUuid(requestedTenantId) ? requestedTenantId : "";
        const prompt = buildAzureCliAssistPrompt({ action, tenantId });
        const promptResult = await invokeSessionPrompt(
          sessionPromptHandler,
          prompt
        );
        if (promptResult.error) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(promptResult.status);
          res.end(JSON.stringify({ error: promptResult.error }));
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            success: true,
            message:
              action === "install" ?
                "Asked Copilot to help install Azure CLI and start Azure login. Complete the steps it opens, then click Verify Credentials again."
              : "Asked Copilot to start Azure login. Complete the sign-in flow it opens, then click Verify Credentials again."
          })
        );
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e || "");
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: detail || "Bad request." }));
      }
      return;
    }

    // Verify an AWS CLI session for a credential profile. Like the Azure
    // verify, we do NOT log in interactively — we check the caller's existing
    // `aws sts get-caller-identity` and (optionally) note the requested region.
    if (pathname === "/api/verify-aws-login" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body || "{}");
        let ident;
        try {
          const out = await runCommand(
            "aws",
            ["sts", "get-caller-identity", "--output", "json"],
            { timeout: 15000 }
          );
          ident = JSON.parse(out);
        } catch (e) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(
            JSON.stringify({
              error:
                'No active AWS CLI session. Run "aws configure" (or "aws sso login") in your terminal, then click Verify again.'
            })
          );
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            success: true,
            accountId: ident.Account || data.accountId || "",
            arn: ident.Arn || "",
            user:
              ident.Arn ?
                String(ident.Arn).split("/").pop()
              : ident.Account || "",
            region: data.region || ""
          })
        );
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            error: "AWS CLI verification failed: " + errorMessage(e)
          })
        );
      }
      return;
    }

    // List the saved credential profiles for a repo.
    if (pathname === "/api/credential-profiles" && req.method === "GET") {
      const repo = url.searchParams.get("repo") || "";
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(
        JSON.stringify({ profiles: repo ? listCredentialProfiles(repo) : [] })
      );
      return;
    }

    // Report the GitHub identity setup will act as, plus switchable accounts.
    // Used by the Create Environment dialog to warn when the acting account
    // differs from the one the host UI shows, or lacks the workflow scope.
    if (pathname === "/api/github-identity" && req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      try {
        // A re-check (?fresh=1) means the user just changed their gh auth
        // out-of-band (e.g. ran `gh auth refresh` to add write:packages).
        // The snapshot is memoized for the process, so drop it first and
        // force `gh auth status` to be re-read; otherwise we'd return the
        // stale pre-refresh scopes and the warning would never clear.
        if (url.searchParams.get("fresh") === "1") resetGhIdentityCache();
        // Resolve identity first — this primes the token strategy, so the
        // repo preflight below (via ghApiJson→ghChildEnv) acts as the same
        // account setup will. When the dialog passes its repo, fold in the
        // admin/read preflight so a non-admin (write/maintain) account is
        // surfaced HERE, at dialog open next to the account it concerns,
        // instead of only after the user fills the form and submits. This
        // mirrors the submit-time gates (which stay authoritative); a
        // missing/invalid repo just skips the preflight — the identity
        // response must still render.
        const identity = await getGitHubIdentity();
        const repoParam = (url.searchParams.get("repo") || "").trim();
        if (repoParam && isValidRepoSlug(repoParam)) {
          try {
            const accessMsg = await preflightRepoAdmin(repoParam);
            if (accessMsg) identity.repoAccess = accessMsg;
          } catch {
            /* preflight is advisory here; never fail identity on it */
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify(identity));
      } catch (e) {
        res.writeHead(200);
        res.end(JSON.stringify({ error: errorMessage(e), accounts: [] }));
      }
      return;
    }

    // Switch the active GitHub account setup acts as.
    if (pathname === "/api/github-account" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.setHeader("Content-Type", "application/json");
      try {
        const data = JSON.parse(body || "{}");
        const login = (data.login || "").trim();
        const result = await switchGhAccount(login);
        if (!result.ok) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: result.error || "Failed to switch account."
            })
          );
          return;
        }
        // Persist the explicit choice machine-wide so it survives a
        // restart. Without this the in-memory preference dies with the
        // process and the token strategy reverts to the injected token's
        // account — the same wrong-identity failure this flow exists to
        // prevent, deferred by one process lifetime.
        setPreferredGitHubLogin(login);
        res.writeHead(200);
        res.end(
          JSON.stringify({ success: true, identity: await getGitHubIdentity() })
        );
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      }
      return;
    }

    // Create / update a credential profile (already verified client-side).
    if (pathname === "/api/save-credential-profile" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body || "{}");
        const repo = (data.repo || "").trim();
        const name = (data.name || "").trim();
        if (!repo || !name) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(JSON.stringify({ error: "repo and name are required." }));
          return;
        }
        const saved = saveCredentialProfile(repo, data);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, profile: saved }));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      }
      return;
    }

    // Delete a credential profile.
    if (
      pathname === "/api/delete-credential-profile" &&
      req.method === "POST"
    ) {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body || "{}");
        const repo = (data.repo || "").trim();
        const name = (data.name || "").trim();
        const removed = deleteCredentialProfile(repo, name);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, removed }));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      }
      return;
    }

    // Delete a GitHub environment (from the Environments table "Delete Env").
    if (pathname === "/api/delete-environment" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body || "{}");
        const repo = (data.repo || "").trim();
        const envName = (data.environment || "").trim();
        if (!repo || !envName) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(
            JSON.stringify({ error: "repo and environment are required." })
          );
          return;
        }
        // Guard: an environment must not be deleted while an application is
        // still deployed to it (its cloud resources would be orphaned).
        // Require the app deployment to be torn down first and point the
        // client at the app-deletion flow.
        let active = null;
        try {
          // Resolve the real app name (from app.bicep) so the guard's
          // message, redirect, and delete target the app declared in the
          // bicep rather than the repo basename.
          const delEntry = servers.get(instanceId);
          const delBranch =
            delEntry?.state?.contextBranch ||
            delEntry?.state?.plannedBranch ||
            delEntry?.state?.graphBranch ||
            "main";
          const delAppName = await resolveRepoAppName(repo, delBranch);
          active = await resolveEnvDeployment(repo, envName, delAppName);
        } catch (e) {
          // Fail closed: if we can't confirm whether an app is still
          // deployed (e.g. GitHub is unavailable), do NOT delete — that
          // could orphan the application's cloud resources.
          console.error(
            `[radius delete-environment] active-app check failed for ${repo}/${envName}: ${errorMessage(e)}`
          );
          res.setHeader("Content-Type", "application/json");
          res.writeHead(503);
          res.end(
            JSON.stringify({
              error: `Could not verify whether an application is still deployed to "${envName}" (GitHub API error: ${errorMessage(e)}). The environment was not deleted — please try again.`
            })
          );
          return;
        }
        if (active) {
          const deleting = active.status === "deleting";
          res.setHeader("Content-Type", "application/json");
          res.writeHead(409);
          res.end(
            JSON.stringify({
              error:
                deleting ?
                  `Application "${active.app}" is still being deleted from environment "${envName}". Wait for that to finish before deleting the environment.`
                : `Application "${active.app}" is still deployed to environment "${envName}". Delete the application deployment first, then delete the environment.`,
              code: "app-deployed",
              app: active.app,
              environment: envName,
              redirect: `/?page=deploying&app=${encodeURIComponent(active.app)}&env=${encodeURIComponent(envName)}`
            })
          );
          return;
        }
        try {
          await runCommand(
            "gh",
            [
              "api",
              "--method",
              "DELETE",
              "/repos/" + repo + "/environments/" + encodeURIComponent(envName)
            ],
            { timeout: 20000 }
          );
        } catch (e) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(500);
          res.end(
            JSON.stringify({
              error: "Could not delete environment: " + errorMessage(e)
            })
          );
          return;
        }
        envListCache.delete(repo);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      }
      return;
    }

    // Auto-setup Azure credentials: create App Registration, federated cred (OIDC), role assignment
    if (pathname === "/api/azure-auto-setup" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      // Cleaned up in finally; declared here so it's reachable from finally.
      let fedTmpFile = null;
      try {
        const data = JSON.parse(body);
        const targetRepo = data.repo || "";
        const envName = data.environment || "dev";
        const resourceGroup = data.resourceGroup || "";
        const clusterName = data.cluster || "";
        // The resource group that actually holds the AKS cluster, sourced
        // from /api/discover (per-cluster resourceGroup) independently of
        // the editable RG combo. Used to scope the AKS Cluster Admin grant
        // so it lands on the cluster's real path even when the deployment
        // resource group differs. Absent for a custom-typed cluster.
        const clusterResourceGroup = (data.clusterResourceGroup || "").trim();
        const serviceManagementReference =
          data.serviceManagementReference || "";
        // ROUND 9 app-registration selection inputs:
        //   data.appId     — an explicit App Registration the user picked
        //                    (duplicate picker or the opt-in "use an
        //                    existing application" cross-repo flow).
        //   data.createNew — user explicitly chose "create a new
        //                    application instead" from the picker.
        //   data.appName   — an editable display name for a NEW app.
        const explicitAppId = (data.appId || "").trim();
        const createNewApp = data.createNew === true;
        // Distinguish "field omitted" from "explicitly sent blank": a
        // present-but-blank name is a user error (invalid-app-name), not
        // a silent fall-back to the derived default.
        const appNameProvided = typeof data.appName === "string";
        const requestedAppName = appNameProvided ? data.appName : "";
        // Subscription the user selected (profile). Required so we can pin
        // the az CLI context to it before the Graph calls (issue #125).
        const requestedSubscriptionId = (data.subscriptionId || "").trim();

        const fail = (
          status: number,
          error: string,
          code: string,
          extra: Record<string, unknown> = {}
        ): void => {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(status);
          res.end(
            JSON.stringify({
              error,
              ...(code ? { code } : {}),
              ...(extra || {})
            })
          );
        };

        if (!targetRepo || !resourceGroup || !clusterName) {
          fail(
            400,
            "repo, resourceGroup, and cluster are required.",
            "missing-params"
          );
          return;
        }
        // Validate every value that reaches an `az`/`gh` argv. execFile
        // does not use a shell, but a leading '-' could still be parsed
        // as a flag, and a bad repo slug would corrupt the OIDC subject.
        if (!isValidRepoSlug(targetRepo)) {
          fail(
            400,
            `Invalid repository "${targetRepo}". Expected "owner/repo".`,
            "invalid-repo"
          );
          return;
        }
        if (!isResourceGroupName(resourceGroup)) {
          fail(
            400,
            `Invalid resource group name "${resourceGroup}".`,
            "invalid-resource-group"
          );
          return;
        }
        if (!isAksClusterName(clusterName)) {
          fail(
            400,
            `Invalid cluster name "${clusterName}".`,
            "invalid-cluster"
          );
          return;
        }
        if (
          clusterResourceGroup &&
          !isResourceGroupName(clusterResourceGroup)
        ) {
          fail(
            400,
            `Invalid cluster resource group name "${clusterResourceGroup}".`,
            "invalid-cluster-resource-group"
          );
          return;
        }
        if (data.tenantId && !isUuid(data.tenantId)) {
          fail(
            400,
            `Invalid tenantId "${data.tenantId}" (expected a GUID).`,
            "invalid-tenant"
          );
          return;
        }
        if (data.subscriptionId && !isUuid(data.subscriptionId)) {
          fail(
            400,
            `Invalid subscriptionId "${data.subscriptionId}" (expected a GUID).`,
            "invalid-subscription"
          );
          return;
        }
        // The Service Management Reference is only surfaced by the UI
        // AFTER a first attempt fails with the Entra policy error
        // (progressive disclosure), so it is optional here. When present
        // it must be a GUID (for Microsoft-internal tenants this is the
        // Service Tree ID).
        if (serviceManagementReference && !isUuid(serviceManagementReference)) {
          fail(
            400,
            `Invalid Service Management Reference "${serviceManagementReference}". It must be a GUID (for Microsoft-internal tenants, your Service Tree ID).`,
            "invalid-smr"
          );
          return;
        }

        // A subscription is required so we can pin the az CLI context to
        // the selected profile. Without it, the `az ad` (Graph) calls
        // below fall back to the ambient default context and create the
        // App Registration / SP in the wrong tenant (issue #125).
        if (!requestedSubscriptionId) {
          fail(
            400,
            "subscriptionId is required so setup targets the selected profile, not the ambient Azure CLI default.",
            "subscription-required"
          );
          return;
        }

        // Preflight repo access + admin BEFORE creating any App
        // Registration. Catches both a wrong-active-gh-account 404 and an
        // insufficient-permission (non-admin) 404, which GitHub otherwise
        // returns as bare, unhelpful 404s later in the flow.
        const accessMsg = await preflightRepoAdmin(targetRepo);
        if (accessMsg) {
          fail(403, accessMsg, "repo-admin-required");
          return;
        }

        // Run `az` non-interactively: close stdin so it can never block on
        // an interactive prompt inside this GUI host process.
        const runCmd = runCliCommand;
        const ghJsonRunner: GitHubJsonRunner = async (
          apiPath: string
        ): Promise<GitHubJsonResponse> => {
          const result = await ghApiJson(apiPath, {
            headers: { "X-GitHub-Api-Version": GITHUB_API_VERSION }
          });
          return {
            ok: result.ok,
            status: result.status,
            json:
              (
                result.json !== null &&
                typeof result.json === "object" &&
                !Array.isArray(result.json)
              ) ?
                record(result.json)
              : null,
            stderr: result.stderr
          };
        };

        const steps: string[] = [];

        // Record the GitHub identity setup is acting as, so the setup
        // log makes it obvious when mutations run as a different account
        // than the one the host UI shows (e.g. an enterprise/EMU login
        // that may lack access to the target repo or Azure tenant).
        try {
          const ghId = await getGitHubIdentity();
          if (ghId && ghId.actingLogin) {
            steps.push(`Acting on GitHub as @${ghId.actingLogin}.`);
            if (ghId.mismatch && ghId.displayLogin) {
              steps.push(
                `Note: the app shows @${ghId.displayLogin} but setup is acting as @${ghId.actingLogin}. If setup fails with a permission error, switch accounts in the Create Environment dialog.`
              );
            }
          }
        } catch {
          /* identity is advisory — never block setup on it */
        }

        // Step 1: Pin the az CLI context to the SELECTED profile, then
        // confirm login and align the tenant. Microsoft Graph / AAD
        // commands (`az ad app create`, `az ad sp create`, `az ad app
        // federated-credential create`) do NOT accept a `--subscription`
        // flag — they target the tenant of the active `az` login context.
        // If we rely on the ambient default the App Registration / SP can
        // be created in the wrong tenant (issue #125), so we switch the
        // active subscription first and then verify the resulting tenant.
        let tenantId = (data.tenantId || "").trim();
        let subscriptionId = requestedSubscriptionId;

        steps.push(`Selecting subscription ${subscriptionId}...`);
        const setResult = await runCmd("az", [
          "account",
          "set",
          "--subscription",
          subscriptionId
        ]);
        if (setResult.code !== 0) {
          // Surface the CLI stderr — the failure may be a logged-out
          // session, expired credentials, or a tenant restriction, not
          // just an unknown subscription.
          const detail = (setResult.stderr || "").trim();
          fail(
            400,
            `Could not select subscription ${subscriptionId}. Ensure you are logged in ("az login") to an account with access, then try again.${detail ? " Azure CLI: " + detail : ""}`,
            "az-subscription-set-failed",
            { steps }
          );
          return;
        }

        // Read the now-active account — the source of truth for what the
        // subsequent `az ad` (Graph) calls will actually target.
        steps.push("Checking Azure CLI login...");
        const acctResult = await runCmd("az", [
          "account",
          "show",
          "--output",
          "json"
        ]);
        if (acctResult.code !== 0) {
          fail(
            400,
            'Azure CLI not logged in. Run "az login" first.',
            "az-not-logged-in",
            { steps }
          );
          return;
        }
        let account: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(acctResult.stdout);
          account = record(parsed);
        } catch (e) {
          fail(
            400,
            'Could not parse "az account show" output.',
            "az-account-parse",
            { steps }
          );
          return;
        }
        const activeTenantId = optionalString(account.tenantId);
        // Prefer the active account's id as the canonical subscription
        // after switching context.
        subscriptionId = optionalString(account.id) || subscriptionId;

        // Fail with guidance when the selected tenant is not the active
        // one — otherwise the app would land in the wrong directory.
        if (
          tenantId &&
          activeTenantId &&
          tenantId.toLowerCase() !== activeTenantId.toLowerCase()
        ) {
          fail(
            400,
            `Azure CLI is signed in to tenant ${activeTenantId}, but tenant ${tenantId} was requested. ` +
              `Run "az login --tenant ${tenantId}" and retry.`,
            "az-tenant-mismatch",
            { steps }
          );
          return;
        }
        tenantId = tenantId || activeTenantId;

        // Validate the resolved subscription id before it reaches an
        // `az` scope argument, and ensure the tenant is known.
        if (!isUuid(subscriptionId)) {
          fail(
            400,
            `Resolved subscription id "${subscriptionId}" is not a valid GUID.`,
            "invalid-subscription",
            { steps }
          );
          return;
        }
        if (!activeTenantId) {
          fail(
            400,
            'Could not determine the active Azure tenant. Run "az login" and "az account set --subscription <id>", then try again.',
            "az-account-incomplete",
            { steps }
          );
          return;
        }
        steps.push(
          `✅ Using subscription=${subscriptionId}, tenant=${tenantId}`
        );

        // Step 2: Resolve the federated credential(s) BEFORE creating
        // anything. This reads the canonical repo + subject customization
        // from GitHub. For the default (not customized) subject we create
        // BOTH the mutable and immutable forms so whichever GitHub mints
        // at token time matches; for a customized subject we build the
        // single exact subject (failing loud only if a repo/repository
        // claim needs an immutability decision it cannot make).
        steps.push("Resolving GitHub OIDC subject...");
        // Note: enterprise-claim rejection (AADSTS7002381) is handled at
        // Actions-run failure time via explainOidcEnterpriseClaim (deploy.ts),
        // which surfaces a tenant-agnostic explanation. Package-scope /
        // workflow-permission changes remain out of scope for this fix.
        let oidc;
        try {
          oidc = await resolveOidcSubject(
            {
              targetRepo,
              envName,
              suffix: buildEnvironmentSuffix(envName)
            },
            ghJsonRunner
          );
        } catch (e) {
          fail(400, errorMessage(e), errorCode(e, "oidc-subject-failed"), {
            steps
          });
          return;
        }
        steps.push(
          `✅ OIDC subject(s): ${oidc.federatedCredentials.map((f) => f.subject).join(", ")}`
        );

        // Step 3: Resolve the target App Registration idempotently
        // (lookup-then-create). Creating unconditionally would spawn a
        // new app on every run (Azure AD allows duplicate display
        // names) — tenant sprawl, a new clientId that orphans the
        // AZURE_CLIENT_ID already wired into the GitHub environment, and
        // a fresh app with no Service Management Reference (forcing the
        // user to redo the approval-gated SMR). Instead we reuse an
        // existing app the caller OWNS when one exists.
        // The default per-repo deploy identity name. Editable: when the
        // user supplies data.appName (create path), we validate and use
        // it instead — but only for the name lookup / create below, never
        // to repoint an already-wired AZURE_CLIENT_ID. When an explicit
        // appId is chosen the name is irrelevant (we reuse that app), so
        // validation is skipped there.
        let appName = `radius-deploy-${oidc.fullName.replace("/", "-")}`;
        if (!explicitAppId) {
          // Always validate the FINAL effective name — including the
          // derived default, which for a very long owner/repo could
          // exceed Entra's 120-char limit. A present-but-blank name is
          // an explicit error rather than a silent derive.
          if (appNameProvided) {
            const nameCheck = validateAppRegistrationName(requestedAppName);
            if (!nameCheck.ok) {
              fail(400, nameCheck.reason, "invalid-app-name", { steps });
              return;
            }
            appName = nameCheck.name;
          } else {
            const nameCheck = validateAppRegistrationName(appName);
            if (!nameCheck.ok) {
              fail(
                400,
                "The derived App Registration name is invalid: " +
                  nameCheck.reason +
                  " Supply a shorter appName.",
                "invalid-app-name",
                { steps }
              );
              return;
            }
            appName = nameCheck.name;
          }
        }

        // The repo's existing AZURE_CLIENT_ID (if any). Read from the
        // request body first, else the GitHub environment variable. We
        // prefer the identity already wired into the environment so a
        // repo rename or a hand-made app is never silently repointed.
        let existingClientId = (data.clientId || "").trim();
        if (!existingClientId) {
          const varRes = await ghJsonRunner(
            `/repos/${oidc.fullName}/environments/${encodeURIComponent(envName)}/variables/AZURE_CLIENT_ID`
          );
          if (
            varRes?.ok &&
            varRes.json &&
            typeof varRes.json.value === "string"
          ) {
            existingClientId = varRes.json.value.trim();
          }
          // A 404 (no environment/variable yet) is expected on a first
          // run; a hard transport/permission failure is non-fatal here
          // (the name lookup below still resolves the app).
        }

        // Signed-in user id + ownership check, fetched once and cached —
        // reused for both the existingClientId path and name scoping.
        let signedInUserId: string | null = null;
        const getSignedInUserId = async (): Promise<
          { ok: true; id: string } | { ok: false; stderr: string }
        > => {
          if (signedInUserId !== null) return { ok: true, id: signedInUserId };
          const meRes = await runCmd("az", [
            "ad",
            "signed-in-user",
            "show",
            "--query",
            "id",
            "-o",
            "tsv"
          ]);
          if (meRes.code !== 0) return { ok: false, stderr: meRes.stderr };
          signedInUserId = meRes.stdout.trim().toLowerCase();
          return { ok: true, id: signedInUserId };
        };
        const isOwnedBySignedInUser = async (appId: string) => {
          const me = await getSignedInUserId();
          if (!me.ok) return { ok: false, stderr: me.stderr };
          const ownRes = await runCmd("az", [
            "ad",
            "app",
            "owner",
            "list",
            "--id",
            appId,
            "--query",
            "[].id",
            "-o",
            "tsv"
          ]);
          if (ownRes.code !== 0) return { ok: false, stderr: ownRes.stderr };
          const owners = ownRes.stdout
            .split(/\s+/)
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean);
          return { ok: true, owned: owners.includes(me.id) };
        };

        // TODO(defer): TOCTOU race — two concurrent requests could both
        // observe "no app" and each create one. Left unhandled by design:
        // this is a single-user local canvas server, so concurrent
        // same-repo setup is implausible; a mutex+re-list+delete-loser is
        // disproportionate.
        let clientId = "";

        // Step 3a: existingClientId-first. If AZURE_CLIENT_ID already
        // points at an app we own, reuse it directly — the wired identity
        // wins over any name match, so we never overwrite a working
        // deployment's identity or churn its FICs/role.
        if (existingClientId) {
          steps.push(
            `Verifying the repository's existing AZURE_CLIENT_ID: ${existingClientId}...`
          );
          const showRes = await runCmd("az", [
            "ad",
            "app",
            "show",
            "--id",
            existingClientId,
            "--query",
            "id",
            "-o",
            "tsv"
          ]);
          let showStatus;
          if (showRes.code === 0 && showRes.stdout.trim()) {
            showStatus = "found";
          } else if (isAzResourceNotFound(showRes.stderr)) {
            showStatus = "not-found";
          } else {
            showStatus = "lookup-failed";
          }
          let owned = false;
          if (showStatus === "found") {
            const own = await isOwnedBySignedInUser(existingClientId);
            if (!own.ok) {
              fail(
                400,
                `Could not read owners of the existing AZURE_CLIENT_ID app ${existingClientId}: ` +
                  own.stderr,
                "app-owner-lookup-failed",
                { steps, azError: own.stderr }
              );
              return;
            }
            owned = own.owned === true;
          }
          const decision = decideExistingClientId({
            clientId: existingClientId,
            showStatus,
            owned
          });
          if (decision.action === "fatal") {
            fail(
              400,
              `Could not verify the repository's AZURE_CLIENT_ID (${existingClientId}): ` +
                showRes.stderr,
              decision.code || "existing-client-id-failed",
              { steps, azError: showRes.stderr }
            );
            return;
          }
          if (decision.action === "error") {
            fail(
              400,
              `The repository's AZURE_CLIENT_ID (${existingClientId}) references an App Registration owned by another user. Verify or clear the variable and retry.`,
              decision.code || "existing-client-id-not-owned",
              { steps }
            );
            return;
          }
          if (decision.action === "reuse") {
            clientId = existingClientId;
            // Reuse path: never touch the existing Service Management
            // Reference — it may be approval-gated.
            steps.push(
              `✅ Reusing the App Registration already wired into AZURE_CLIENT_ID: ${clientId}`
            );
          }
          // 'fallthrough' (empty / stale not-found) → name lookup below.
        }

        // Step 3b: explicit selection, or name lookup + ownership scoping
        // (only when the wired identity did not already resolve the app).
        if (!clientId) {
          // Per-candidate FIC → served-repos enrichment. Best-effort: a
          // FIC-list failure just omits servesRepos for that candidate.
          const listServesRepos = async (appId: string) => {
            const ficRes = await runCmd("az", [
              "ad",
              "app",
              "federated-credential",
              "list",
              "--id",
              appId,
              "--query",
              "[].subject",
              "-o",
              "json"
            ]);
            if (ficRes.code !== 0) return undefined;
            try {
              return parseServedReposFromSubjects(JSON.parse(ficRes.stdout));
            } catch {
              return undefined;
            }
          };

          // Explicit choice: the duplicate picker or the opt-in "use an
          // existing application" (cross-repo) flow resubmits with an
          // appId. Verify ownership of THAT exact app and reuse it — this
          // deliberately bypasses the name lookup so a shared,
          // non-name-matched identity is honored. Ownership is still
          // enforced (an app we don't own would fail FIC/role writes and
          // could hijack another user's identity).
          if (explicitAppId) {
            if (!isUuid(explicitAppId)) {
              fail(
                400,
                "The selected App Registration id is not a valid GUID.",
                "invalid-app-id",
                { steps }
              );
              return;
            }
            const own = await isOwnedBySignedInUser(explicitAppId);
            if (!own.ok) {
              fail(
                400,
                `Could not read owners of App Registration ${explicitAppId}: ` +
                  own.stderr,
                "app-owner-lookup-failed",
                { steps, azError: own.stderr }
              );
              return;
            }
            if (!own.owned) {
              fail(
                400,
                "The selected App Registration is owned by another user. Choose one you own or create a new application.",
                "app-registration-not-owned",
                { steps, appName }
              );
              return;
            }
            clientId = explicitAppId;
            // Reuse path: never touch SMR (may be approval-gated).
            steps.push(`✅ Using the selected App Registration: ${clientId}`);
          }

          if (!clientId) {
            steps.push(`Looking up existing App Registration: ${appName}...`);
            const listRes = await runCmd("az", [
              "ad",
              "app",
              "list",
              // single-quote-safe: appName was replaced with the
              // validateAppRegistrationName() result above, whose
              // allow-list forbids quotes, so it cannot break out of
              // this OData single-quoted string literal.
              "--filter",
              `displayName eq '${appName}'`,
              "--query",
              "[].{appId:appId,id:id,displayName:displayName,createdDateTime:createdDateTime}",
              "-o",
              "json"
            ]);
            if (listRes.code !== 0) {
              // FATAL: a silent fall-through to create would resurrect
              // the sprawl bug this fix exists to prevent.
              fail(
                400,
                "Failed to look up existing App Registrations: " +
                  listRes.stderr,
                "app-lookup-failed",
                { steps, azError: listRes.stderr }
              );
              return;
            }
            // `az ... -o json` returns a literal `[]` for no matches, so
            // an empty string is anomalous. Only a genuine array
            // proceeds; a non-array or unparseable result is FATAL. A
            // legitimately EMPTY array still proceeds to create.
            let matches;
            try {
              const parsed = JSON.parse(listRes.stdout);
              if (!Array.isArray(parsed)) {
                fail(
                  400,
                  "The App Registration lookup returned an unexpected (non-array) result.",
                  "app-lookup-parse",
                  { steps }
                );
                return;
              }
              matches = parsed;
            } catch (e) {
              fail(
                400,
                "Could not parse the App Registration lookup result.",
                "app-lookup-parse",
                { steps }
              );
              return;
            }

            // Scope matches to apps the signed-in user owns; reusing an
            // app we don't own would fail on FIC/role writes and risks
            // hijacking another user's app in a shared tenant.
            let ownedMatches = [];
            for (const m of matches) {
              if (!m || !m.appId) continue;
              const own = await isOwnedBySignedInUser(m.appId);
              if (!own.ok) {
                fail(
                  400,
                  `Could not read owners of App Registration ${m.appId}: ` +
                    own.stderr,
                  "app-owner-lookup-failed",
                  { steps, azError: own.stderr }
                );
                return;
              }
              if (own.owned) ownedMatches.push(m);
            }

            const selection = decideAppSelection({
              ownedMatches,
              hasUnownedMatch: matches.length > ownedMatches.length,
              existingClientId,
              createNew: createNewApp
            });

            if (selection.action === "error") {
              fail(
                400,
                selection.reason || "Could not select an App Registration.",
                selection.code || "app-selection-failed",
                { steps, appName }
              );
              return;
            }

            if (selection.action === "needs-selection") {
              // >1 owned name-matches and no explicit choice yet.
              // Enrich each candidate with the repos it already serves
              // (from its FIC subjects) so the user can choose
              // knowingly, then ask the frontend to prompt.
              const candidates = [];
              for (const c of selection.candidates || []) {
                const servesRepos = await listServesRepos(c.appId);
                candidates.push({
                  appId: c.appId,
                  displayName: c.displayName,
                  createdDateTime: c.createdDateTime,
                  ...(servesRepos ? { servesRepos } : {})
                });
              }
              fail(
                400,
                "Multiple owned App Registrations found — choose which identity to use.",
                "app-selection-required",
                {
                  steps,
                  appName,
                  candidates,
                  defaultAppId: selection.defaultAppId
                }
              );
              return;
            }

            if (selection.action === "reuse") {
              clientId = selection.appId || "";
              // Reuse path: never touch the existing Service Management
              // Reference — it may be approval-gated. SMR only applies
              // when creating a new app below.
              steps.push(`✅ Reusing existing App Registration: ${clientId}`);
            } else {
              // Create a fresh App Registration. Attempt WITHOUT a
              // Service Management Reference first; only if Entra policy
              // rejects it do we ask the user for one (progressive
              // disclosure) — `az ad app create` fails atomically, so
              // the retry is clean with no orphaned app. The creator is
              // automatically an owner.
              steps.push(`Creating App Registration: ${appName}...`);
              const appResult = await runCmd(
                "az",
                buildAppCreateArgs({
                  appName,
                  serviceManagementReference
                }).filter((arg): arg is string => typeof arg === "string")
              );
              if (appResult.code !== 0) {
                if (
                  !serviceManagementReference &&
                  isServiceManagementReferenceError(appResult.stderr)
                ) {
                  fail(
                    400,
                    "This Entra tenant requires a Service Management Reference on new App Registrations. " +
                      "Enter your Service Management Reference (for Microsoft-internal tenants, your Service Tree ID GUID) and retry.",
                    "service-management-reference-required",
                    { steps, azError: appResult.stderr }
                  );
                  return;
                }
                fail(
                  400,
                  "Failed to create App Registration: " + appResult.stderr,
                  "app-create-failed",
                  { steps, azError: appResult.stderr }
                );
                return;
              }
              clientId = appResult.stdout.trim();
              steps.push(`✅ App Registration created: ${clientId}`);
            }
          }
        }

        // Step 4: Create Service Principal (FATAL on failure). Once the
        // app exists, any later failure returns clientId/appName so the
        // user can find and clean it up manually (full rollback deferred).
        steps.push("Creating Service Principal...");
        const spResult = await runCmd("az", [
          "ad",
          "sp",
          "create",
          "--id",
          clientId
        ]);
        if (
          spResult.code !== 0 &&
          !spResult.stderr.includes("already exists")
        ) {
          // The SP may already exist under a different identity; confirm.
          const spShow = await runCmd("az", [
            "ad",
            "sp",
            "show",
            "--id",
            clientId,
            "--query",
            "id",
            "-o",
            "tsv"
          ]);
          if (spShow.code !== 0) {
            fail(
              400,
              "Could not create or find the Service Principal: " +
                spResult.stderr,
              "sp-failed",
              { steps, clientId, appName, azError: spResult.stderr }
            );
            return;
          }
        }
        steps.push("✅ Service Principal ready");

        // Step 5: Create the Federated Credential(s) (FATAL on failure).
        // Idempotent by SUBJECT: on a reused app (or a rerun) skip any
        // FIC whose subject already exists, so we stay under Azure's
        // ~20-FIC/app cap and don't churn credentials. "already exists" is
        // never trusted blindly — a name collision is caught up front and
        // a stale-list race is verified by reading the FIC back (below).
        const { writeFileSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        let existingSubjects = [];
        let existingNameToSubject = new Map();
        // Fetch existing FICs as {name, subject} pairs. Dedup stays keyed
        // on SUBJECT (below), but we also need the NAME→subject map to
        // detect a name collision: clean() collapses ':' and '-' to the
        // same FIC name while the subject keeps '%3A', so two distinct
        // environments can map to one name with different subjects.
        const ficListRes = await runCmd("az", [
          "ad",
          "app",
          "federated-credential",
          "list",
          "--id",
          clientId,
          "--query",
          "[].{name:name,subject:subject}",
          "-o",
          "json"
        ]);
        if (ficListRes.code === 0) {
          try {
            const parsed = JSON.parse(ficListRes.stdout || "[]");
            if (Array.isArray(parsed)) {
              existingSubjects = parsed
                .map((f) => f && f.subject)
                .filter(Boolean);
              existingNameToSubject = new Map(
                parsed
                  .filter((f) => f && f.name)
                  .map((f) => [f.name, f.subject])
              );
            }
          } catch {
            /* fall back to attempting all, guarded by the read-back below */
          }
        }
        const ficsToCreate = selectMissingFederatedCredentials(
          oidc.federatedCredentials,
          existingSubjects
        );
        const skippedCount =
          oidc.federatedCredentials.length - ficsToCreate.length;
        if (skippedCount > 0) {
          steps.push(
            `✅ ${skippedCount} federated credential(s) already present — skipping`
          );
        }
        // Fail loud on a NAME collision (two environments normalizing to
        // one FIC name with different subjects). Creating the second would
        // silently no-op ("already exists") and leave this environment
        // with no matching credential → AADSTS700213 at deploy.
        const ficCollision = findFederatedCredentialNameCollision(
          ficsToCreate,
          existingNameToSubject
        );
        if (ficCollision) {
          fail(
            400,
            `Federated credential name "${ficCollision.name}" already exists with a different subject ` +
              `("${ficCollision.existingSubject}" vs required "${ficCollision.desiredSubject}"). Two environment ` +
              `names normalize to the same credential name — rename this environment to avoid characters ` +
              `that collapse together (for example ":" and "-").`,
            "federated-credential-name-collision",
            { steps, clientId, appName }
          );
          return;
        }
        for (const fic of ficsToCreate) {
          steps.push(`Creating federated credential "${fic.name}"...`);
          const fedParams = JSON.stringify({
            name: fic.name,
            issuer: "https://token.actions.githubusercontent.com",
            subject: fic.subject,
            audiences: ["api://AzureADTokenExchange"]
          });
          // Unpredictable filename so a shared tmpdir can't be
          // pre-created or read by another local user.
          fedTmpFile = join(
            tmpdir(),
            `radius-fed-cred-${randomBytes(12).toString("hex")}.json`
          );
          writeFileSync(fedTmpFile, fedParams, { mode: 0o600 });
          const fedResult = await runCmd("az", [
            "ad",
            "app",
            "federated-credential",
            "create",
            "--id",
            clientId,
            "--parameters",
            "@" + fedTmpFile
          ]);
          try {
            (await import("node:fs")).unlinkSync(fedTmpFile);
          } catch {
            /* best-effort */
          }
          fedTmpFile = null;
          if (fedResult.code !== 0) {
            if (!fedResult.stderr.includes("already exists")) {
              fail(
                400,
                `Failed to create federated credential "${fic.name}": ` +
                  fedResult.stderr,
                "federated-credential-failed",
                { steps, clientId, appName, azError: fedResult.stderr }
              );
              return;
            }
            // Backstop: the pre-create list was stale or a concurrent
            // create won the race. Never trust "already exists" as
            // success — read the FIC back and confirm its subject
            // matches before reporting the credential as created.
            const showRes = await runCmd("az", [
              "ad",
              "app",
              "federated-credential",
              "show",
              "--id",
              clientId,
              "--federated-credential-id",
              fic.name,
              "--query",
              "subject",
              "-o",
              "tsv"
            ]);
            const actualSubject = (showRes.stdout || "").trim();
            if (showRes.code !== 0 || actualSubject !== fic.subject) {
              fail(
                400,
                `Federated credential "${fic.name}" already exists but its subject ` +
                  `("${actualSubject}") does not match the required subject ("${fic.subject}"). Rename this ` +
                  `environment to avoid a credential-name collision.`,
                "federated-credential-subject-mismatch",
                { steps, clientId, appName }
              );
              return;
            }
          }
          steps.push(`✅ Federated credential "${fic.name}" created`);
        }

        // Step 6: Assign Contributor role on the resource group (FATAL).
        //
        // Assign by the Service Principal's OBJECT ID, not its appId. A
        // role assignment created with `--assignee <appId>` right after
        // `az ad sp create` races Microsoft Graph replication: az must
        // first resolve the appId to its SP object, and until that object
        // has replicated the lookup can fail — or, on some az-CLI
        // versions, silently no-op so the role is never written. The
        // identity then signs in successfully but sees "No subscriptions
        // found" because it has no effective RBAC. This is a real,
        // platform-independent race, NOT a macOS/Windows difference; it
        // just surfaces more often on some CLI-version/timing
        // combinations (e.g. a reviewer's freshly reset machine) than on
        // the author's.
        //
        // `--assignee-object-id` with an explicit
        // `--assignee-principal-type ServicePrincipal` skips the appId
        // lookup entirely, and a short retry absorbs the residual lag in
        // the object itself becoming visible. Genuine authorization
        // failures (the signed-in user cannot assign roles) are NOT
        // retried, so they surface immediately with actionable detail.

        // Errors meaning "the principal hasn't replicated yet" are
        // retried; genuine failures (notably AuthorizationFailed) surface
        // immediately. See isReplicationLagError / buildRoleAssignmentArgs.
        const resolveSpObjectId = async () => {
          let lastErr = "";
          for (let attempt = 0; attempt < 6; attempt++) {
            const show = await runCmd("az", [
              "ad",
              "sp",
              "show",
              "--id",
              clientId,
              "--query",
              "id",
              "-o",
              "tsv"
            ]);
            const objId = (show.stdout || "").trim();
            if (show.code === 0 && objId) return { objectId: objId, error: "" };
            lastErr = show.stderr || show.stdout || "";
            if (attempt < 5)
              await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          }
          return { objectId: "", error: lastErr };
        };

        const assignRoleByObjectId = async (
          objectId: string,
          role: string,
          scope: string
        ) => {
          let last: CommandResult = { code: 1, stdout: "", stderr: "" };
          for (let attempt = 0; attempt < 6; attempt++) {
            last = await runCmd(
              "az",
              buildRoleAssignmentArgs({ objectId, role, scope, subscriptionId })
            );
            if (last.code === 0 || last.stderr.includes("already exists"))
              return { ok: true, stderr: "" };
            if (!isReplicationLagError(last.stderr)) break;
            if (attempt < 5)
              await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          }
          return { ok: false, stderr: last.stderr };
        };

        steps.push("Resolving Service Principal object id...");
        const spObjLookup = await resolveSpObjectId();
        if (!spObjLookup.objectId) {
          fail(
            400,
            "Could not resolve the Service Principal object id needed to assign Azure roles: " +
              spObjLookup.error,
            "sp-objectid-failed",
            { steps, clientId, appName, azError: spObjLookup.error }
          );
          return;
        }
        const spObjectId = spObjLookup.objectId;

        steps.push(`Assigning Contributor role on ${resourceGroup}...`);
        const roleResult = await assignRoleByObjectId(
          spObjectId,
          "Contributor",
          `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`
        );
        if (!roleResult.ok) {
          fail(
            400,
            "Failed to assign Contributor role: " + roleResult.stderr,
            "role-assignment-failed",
            { steps, clientId, appName, azError: roleResult.stderr }
          );
          return;
        }
        steps.push("✅ Contributor role assigned");

        // Step 6b: Assign an AKS Kubernetes RBAC role scoped to the
        // cluster (best-effort). Contributor on the resource group is a
        // MANAGEMENT-plane role — it lets the identity read/manage the
        // cluster *resource*, but on clusters with Azure RBAC for
        // Kubernetes enabled (the default for AKS Automatic) every
        // kubectl/data-plane call (e.g. `kubectl get services`) is
        // authorized by Azure roles scoped to the cluster, NOT by
        // Contributor. Without this the deploy identity signs in but
        // gets "cannot list resource ... : User does not have access to
        // the resource in Azure" and the run fails at Verify AKS Access.
        // Cluster Admin is required because the Radius control plane
        // installs cluster-scoped resources (CRDs, namespaces). This is
        // a no-op on clusters that use only Kubernetes RBAC, so we
        // attempt it whenever an AKS cluster is targeted and treat a
        // failure as a warning rather than aborting the whole setup.
        //
        // Scope the grant to the cluster's OWN resource group — not the
        // deployment resource group above. The two can differ, and the
        // editable RG combo in the dialog can be changed after a cluster
        // is picked; scoping to the wrong RG puts the assignment on a path
        // where the cluster doesn't exist, so the deploy still fails at
        // "Verify AKS Access". pickAksResourceGroup prefers the cluster's
        // discovered resource group and falls back only when it's absent.
        const aksResourceGroup = pickAksResourceGroup(
          clusterResourceGroup,
          resourceGroup
        );
        const clusterScope = `/subscriptions/${subscriptionId}/resourceGroups/${aksResourceGroup}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
        steps.push(
          `Assigning Azure Kubernetes Service RBAC Cluster Admin on ${clusterName}...`
        );
        const aksRoleResult = await assignRoleByObjectId(
          spObjectId,
          "Azure Kubernetes Service RBAC Cluster Admin",
          clusterScope
        );
        if (aksRoleResult.ok) {
          steps.push("✅ AKS RBAC Cluster Admin role assigned");
        } else {
          // Non-fatal: control-plane access is already in place, and
          // clusters without Azure RBAC for Kubernetes don't need this.
          // Surface actionable guidance so an Automatic-cluster user can
          // grant it manually if the deploy later fails on AKS access.
          steps.push(
            "⚠️ Could not assign the AKS RBAC Cluster Admin role automatically. " +
              'If your cluster uses Azure RBAC for Kubernetes (the default for AKS Automatic) the deploy will fail at "Verify AKS Access". ' +
              `Grant it manually: az role assignment create --assignee-object-id ${spObjectId} --assignee-principal-type ServicePrincipal --role "Azure Kubernetes Service RBAC Cluster Admin" --scope ${clusterScope}. ` +
              "Details: " +
              aksRoleResult.stderr
          );
        }

        // Return all credentials for the environment setup
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            success: true,
            clientId,
            tenantId,
            subscriptionId,
            resourceGroup,
            cluster: clusterName,
            appName,
            subjects: oidc.federatedCredentials.map((f) => f.subject),
            steps
          })
        );
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      } finally {
        if (fedTmpFile) {
          try {
            (await import("node:fs")).unlinkSync(fedTmpFile);
          } catch {
            /* best-effort */
          }
        }
      }
      return;
    }

    // List all App Registrations owned by the signed-in user, enriched with
    // the repos each already serves (from its FIC subjects). Backs the
    // opt-in "use an existing application" cross-repo picker on the
    // Environment page. Runs under the same agent-session-stripped cliExec
    // env as the rest of the Azure setup.
    if (
      pathname === "/api/list-azure-app-registrations" &&
      req.method === "GET"
    ) {
      const runCmd = runCliCommand;
      try {
        // `--show-mine` scopes to apps the signed-in user owns, so we
        // avoid an O(N) owner lookup across the whole tenant.
        const listRes = await runCmd("az", [
          "ad",
          "app",
          "list",
          "--show-mine",
          "--query",
          "[].{appId:appId,displayName:displayName,createdDateTime:createdDateTime}",
          "-o",
          "json"
        ]);
        if (listRes.code !== 0) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: "Failed to list App Registrations: " + listRes.stderr,
              code: "app-list-failed",
              azError: listRes.stderr
            })
          );
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(listRes.stdout);
        } catch {
          parsed = null;
        }
        if (!Array.isArray(parsed)) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: "The App Registration list returned an unexpected result.",
              code: "app-list-parse"
            })
          );
          return;
        }
        // Return the owned apps immediately. The `servesRepos` label
        // (which repos each app already deploys) needs one
        // `az ad app federated-credential list` per app, so computing it
        // up front made the picker block on N process spawns before any
        // row rendered (a user owning 100 apps paid ~100 spawns). The
        // client now lazy-loads that label per row via
        // /api/azure-app-serves-repos, so the list appears at once and
        // the labels fill in progressively.
        const apps = parsed
          .filter((a) => a && a.appId)
          .map((a) => ({
            appId: a.appId,
            displayName: a.displayName,
            createdDateTime: a.createdDateTime
          }));
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ apps }));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(
          JSON.stringify({ error: errorMessage(e), code: "app-list-failed" })
        );
      }
      return;
    }

    // Lazy per-app companion to /api/list-azure-app-registrations: computes
    // the "already serves" repo label for ONE App Registration from its
    // federated-credential subjects. The picker calls this per row after the
    // list renders, so owning many apps no longer blocks the picker on an
    // up-front N+1 chain of `az` spawns. Best-effort: any failure yields a
    // null label rather than an error the row would have to surface.
    if (pathname === "/api/azure-app-serves-repos" && req.method === "GET") {
      const appId = url.searchParams.get("appId") || "";
      if (!isUuid(appId)) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error: "A valid appId is required.",
            code: "app-serves-bad-id"
          })
        );
        return;
      }
      const runCmd = runCliCommand;
      let servesRepos = null;
      const ficRes = await runCmd("az", [
        "ad",
        "app",
        "federated-credential",
        "list",
        "--id",
        appId,
        "--query",
        "[].subject",
        "-o",
        "json"
      ]);
      if (ficRes.code === 0) {
        try {
          servesRepos =
            parseServedReposFromSubjects(JSON.parse(ficRes.stdout)) || null;
        } catch {
          servesRepos = null;
        }
      }
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ servesRepos }));
      return;
    }

    // Create GitHub Environment with secrets/variables and commit verify workflow
    if (pathname === "/api/app-params" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const repo = data.repo || "";
        if (!repo) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(
            JSON.stringify({ error: "No repository specified.", params: [] })
          );
          return;
        }
        // Resolve the branch the deploy will run against (the caller's
        // selection, else the repo default) and locate the app.bicep the
        // same way the deploy route does (.radius/app.bicep, then app.bicep).
        let branch = data.branch || "";
        if (!branch) {
          const def = await runCommand("gh", [
            "repo",
            "view",
            repo,
            "--json",
            "defaultBranchRef",
            "--jq",
            ".defaultBranchRef.name"
          ]).catch(() => "");
          branch = (def || "").trim() || "main";
        }
        let source = await fetchFileFromRepo(repo, ".radius/app.bicep", branch);
        if (!source)
          source = await fetchFileFromRepo(repo, "app.bicep", branch);
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            branch,
            found: !!source,
            params: source ? appParams(source) : []
          })
        );
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ error: errorMessage(e), params: [] }));
      }
      return;
    }

    if (pathname === "/api/create-environment" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const targetRepo = data.repo || "";
        const envName = data.environment || "dev";
        const provider = data.provider || "azure";

        if (!targetRepo) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(JSON.stringify({ error: "No target repository specified." }));
          return;
        }

        if (!isValidRepoSlug(targetRepo)) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error: `Invalid repository "${targetRepo}". Expected "owner/repo".`,
              code: "invalid-repo"
            })
          );
          return;
        }

        // Preflight repo access + admin BEFORE any GitHub mutation.
        // Reachable directly when credentials already exist and
        // azure-auto-setup is skipped, so guarding here too is required.
        const accessMsg = await preflightRepoAdmin(targetRepo);
        if (accessMsg) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(403);
          res.end(
            JSON.stringify({ error: accessMsg, code: "repo-admin-required" })
          );
          return;
        }

        const runGh = (
          args: string[],
          stdin?: string,
          extraOpts: CliOptions = {}
        ): Promise<CommandResult> => {
          return new Promise((resolve) => {
            const child = cliExec(
              "gh",
              args,
              { timeout: 30000, ...(extraOpts || {}) },
              (err, stdout, stderr) => {
                resolve({
                  code: err ? err.code || 1 : 0,
                  stdout: stdout || "",
                  stderr: stderr || ""
                });
              }
            );
            if (stdin !== undefined) child.stdin?.end(stdin);
          });
        };

        const runGhOrThrow = async (
          args: string[],
          message: string,
          stdin?: string
        ): Promise<CommandResult> => {
          const result = await runGh(args, stdin);
          if (result.code !== 0) {
            const detail = (result.stderr || result.stdout || "").trim();
            throw new Error(detail ? `${message}: ${detail}` : message);
          }
          return result;
        };

        const setEnvironmentVariable = async (
          name: string,
          value: string
        ): Promise<boolean> => {
          if (!value) return false;
          await runGhOrThrow(
            [
              "variable",
              "set",
              name,
              "--body",
              value,
              "--env",
              envName,
              "--repo",
              targetRepo
            ],
            `Failed to set ${name} on GitHub environment "${envName}"`
          );
          return true;
        };

        // The host often injects GH_TOKEN (an OAuth app token) that lacks the
        // `workflow` scope, which is required to create/update files under
        // .github/workflows/ or to dispatch workflows. The user's stored gh
        // credential (keyring) usually has that scope. For workflow-scoped
        // commands, run normally first; if it fails while an injected token is
        // present, retry with GH_TOKEN/GITHUB_TOKEN stripped so gh falls back
        // to the keyring credential. (A missing `workflow` scope surfaces as
        // either a 403 "without workflow scope" on updates or a bare 404 on
        // creates, so we retry on any failure rather than pattern-matching.)
        const needsWorkflowScope = (stderr?: string): boolean => {
          return (
            /workflow.{0,20}scope/i.test(stderr || "") ||
            /without .?workflow.? scope/i.test(stderr || "")
          );
        };
        const runGhWorkflow = async (
          args: string[],
          stdin?: string
        ): Promise<CommandResult> => {
          const first = await runGh(args, stdin);
          if (first.code === 0) return first;
          const hasInjectedToken = !!(
            process.env.GH_TOKEN || process.env.GITHUB_TOKEN
          );
          if (!hasInjectedToken) return first;
          const fallbackEnv = { ...process.env };
          delete fallbackEnv.GH_TOKEN;
          delete fallbackEnv.GITHUB_TOKEN;
          const retry = await runGh(args, stdin, { env: fallbackEnv });
          // Prefer the retry only if it actually succeeded; otherwise keep the
          // original error, which is usually the more meaningful one.
          return retry.code === 0 ? retry : first;
        };

        const steps: string[] = [];
        const stateRegistry = stateRegistryForEnvironment(targetRepo, envName);

        steps.push(
          'Creating private GHCR state package "' + stateRegistry + '"...'
        );
        // Authenticate GHCR as the identity setup acts as (the account
        // shown/selected in the dialog), not whatever keyring account is
        // active. On multi-account machines the active keyring login can
        // be an enterprise/EMU account GHCR rejects, even though the rest
        // of setup runs as the intended account.
        let packageCredentials;
        try {
          packageCredentials = await getGhPackageCredentials();
        } catch (e) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(403);
          res.end(
            JSON.stringify({
              error: `Could not authenticate to GitHub Packages for this repository. ${errorMessage(e)}`,
              code: "ghcr-auth-failed",
              steps
            })
          );
          return;
        }
        // Fail fast when the acting account lacks write:packages, BEFORE
        // the bootstrap push. GHCR's token endpoint silently issues a
        // pull-only token for a read-only credential, so without this gate
        // the missing scope only surfaces as a cryptic 403 deep in the blob
        // upload — after the rest of setup has already run. actingHasPackages
        // is read keyring-first, matching the credential getGhPackageCredentials
        // pins, so it reflects the token this push actually uses.
        const ghPkgIdentity = await getGitHubIdentity();
        if (
          ghPkgIdentity &&
          ghPkgIdentity.actingLogin &&
          !ghPkgIdentity.actingHasPackages
        ) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(403);
          res.end(
            JSON.stringify({
              error: `The GitHub account @${ghPkgIdentity.actingLogin} is missing the "write:packages" scope required to create this repository's private Radius state package in GHCR. Run "gh auth switch -h github.com -u ${ghPkgIdentity.actingLogin} && gh auth refresh -h github.com -s read:packages -s write:packages" (or switch to an account that has it in the Create Environment dialog), then retry. Note: gh auth switch changes your machine's active GitHub account for every tool in this terminal until you switch back.`,
              code: "ghcr-scope-required",
              steps
            })
          );
          return;
        }
        const statePackage = await bootstrapGHCRStatePackage({
          targetRepository: targetRepo,
          registry: stateRegistry,
          credentials: packageCredentials
        });
        steps.push(
          `✅ GHCR state package is ${statePackage.visibility} and linked to ${targetRepo}.`
        );

        // --- Workflow commit + PR-fallback plumbing ---------------------
        // Workflow files are normally committed straight to the repo's
        // default branch via the contents API. When that branch is
        // protected (or the user otherwise lacks direct-push permission),
        // the PUT fails; instead of aborting, we lazily create a feature
        // branch, commit every workflow file there, and open a PR the user
        // can merge. The PR link is surfaced in `steps`.
        const { writeFileSync, unlinkSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");

        // A protected-branch / missing-write-access failure (as opposed to
        // a missing `workflow` token scope, which a PR can't fix). Kept
        // deliberately broad; branch creation gates the fallback, so a
        // genuine no-access repo still surfaces the original error.
        const isProtectedBranchFailure = (stderr: string): boolean => {
          const s = stderr || "";
          if (needsWorkflowScope(s)) return false;
          return /HTTP 40[39]|protected branch|through a pull request|required status check|approving review|not have permission|Resource not accessible|refusing to allow|review is required|push declined|branch protection/i.test(
            s
          );
        };

        // PR-fallback state; populated lazily on the first protected-branch
        // failure. Once set, every subsequent workflow commit targets the
        // PR branch instead of the default branch.
        let prState: PullRequestState | undefined;
        const beginPrFallback = async (): Promise<PullRequestState> => {
          if (prState) return prState;
          const base = (await getDefaultBranch(targetRepo)) || "main";
          const baseSha = await getBranchHeadSha(targetRepo, base);
          if (!baseSha)
            throw new Error(`could not resolve head of base branch "${base}"`);
          const branch = `radius/setup-${envName}-workflows-${Date.now()}`;
          const created = await createBranchRef(targetRepo, branch, baseSha);
          if (!created.ok)
            throw new Error(
              `could not create branch "${branch}": ${created.stderr}`
            );
          prState = { branch, base };
          steps.push(
            `ℹ️ No permission to push to "${base}" directly — committing workflows to branch "${branch}" and opening a pull request.`
          );
          return prState;
        };

        // Commit one workflow file via the contents API. `branch === ''`
        // targets the default branch. Looks up the existing blob SHA on the
        // same ref so a re-commit is an update rather than a rejected
        // create. Returns the raw runGhWorkflow result ({ code, stderr }).
        const putWorkflowContent = async (
          path: string,
          contentB64: string,
          message: string,
          branch = ""
        ): Promise<CommandResult> => {
          const refQ = branch ? "?ref=" + encodeURIComponent(branch) : "";
          const shaRes = await runGh([
            "api",
            "/repos/" + targetRepo + "/contents/" + path + refQ,
            "--jq",
            ".sha"
          ]);
          const sha = shaRes.code === 0 ? shaRes.stdout.trim() : "";
          const bodyObj = {
            message,
            content: contentB64,
            ...(branch ? { branch } : {}),
            ...(sha ? { sha } : {})
          };
          const tmp = join(
            tmpdir(),
            "radius-wf-commit-" +
              Date.now() +
              "-" +
              Math.random().toString(36).slice(2) +
              ".json"
          );
          writeFileSync(tmp, JSON.stringify(bodyObj));
          const r = await runGhWorkflow([
            "api",
            "--method",
            "PUT",
            "/repos/" + targetRepo + "/contents/" + path,
            "--input",
            tmp
          ]);
          try {
            unlinkSync(tmp);
          } catch {}
          return r;
        };

        // Commit a workflow file, transparently switching to the PR branch
        // (creating it on first use) when the default branch rejects the
        // push for permission reasons. Returns { ok, stderr, viaPr }.
        const commitWorkflowFileSmart = async (
          path: string,
          contentB64: string,
          message: string
        ): Promise<{ ok: boolean; stderr?: string; viaPr: boolean }> => {
          if (prState) {
            const r = await putWorkflowContent(
              path,
              contentB64,
              message,
              prState.branch
            );
            return { ok: r.code === 0, stderr: r.stderr, viaPr: true };
          }
          const direct = await putWorkflowContent(
            path,
            contentB64,
            message,
            ""
          );
          if (direct.code === 0) return { ok: true, viaPr: false };
          if (isProtectedBranchFailure(direct.stderr)) {
            let fallback: PullRequestState;
            try {
              fallback = await beginPrFallback();
              prState = fallback;
            } catch (e) {
              return {
                ok: false,
                stderr: `${direct.stderr} (PR fallback failed: ${errorMessage(e)})`,
                viaPr: false
              };
            }
            const r = await putWorkflowContent(
              path,
              contentB64,
              message,
              fallback.branch
            );
            return { ok: r.code === 0, stderr: r.stderr, viaPr: true };
          }
          return { ok: false, stderr: direct.stderr, viaPr: false };
        };

        // Step 1: Create the GitHub environment
        steps.push('Creating GitHub environment "' + envName + '"...');
        await runGhOrThrow(
          [
            "api",
            "--method",
            "PUT",
            "/repos/" + targetRepo + "/environments/" + envName
          ],
          'Failed to create GitHub environment "' + envName + '"'
        );
        // Tag the environment as Radius-managed so the listing can filter
        // out environments created outside this extension.
        await setEnvironmentVariable("RADIUS_MANAGED", "true");
        // A new environment invalidates the cached listing for this repo.
        envListCache.delete(targetRepo);

        steps.push(
          'Configuring Radius state package "' + stateRegistry + '"...'
        );
        await setEnvironmentVariable("RADIUS_STATE_BACKEND", OCI_STATE_BACKEND);
        await setEnvironmentVariable("RADIUS_STATE_REGISTRY", stateRegistry);
        await setEnvironmentVariable(
          "RADIUS_STATE_ARCHIVE",
          DEFAULT_STATE_ARCHIVE
        );
        steps.push(
          `✅ Radius state package configured with archive tag "${DEFAULT_STATE_ARCHIVE}".`
        );

        // Record the credential profile this environment was created from
        // so the Environments listing can show it in the Credentials column.
        if (data.profileName) {
          await setEnvironmentVariable(
            "RADIUS_CREDENTIAL_PROFILE",
            data.profileName
          );
        }

        // Step 2: Set environment variables and secrets based on provider
        steps.push("Setting environment variables and secrets...");
        // Fall back to shared credentials for values not provided in the request
        const azureCreds = cloudCredential(sharedCredentials.azure);
        const awsCreds = cloudCredential(sharedCredentials.aws);

        if (provider === "azure") {
          const clientId = data.clientId || optionalString(azureCreds.clientId);
          const tenantId = data.tenantId || optionalString(azureCreds.tenantId);
          const subscriptionId =
            data.subscriptionId || optionalString(azureCreds.subscriptionId);
          const rg = data.resourceGroup || "";
          const k8s = data.cluster || "";

          await setEnvironmentVariable("AZURE_CLIENT_ID", clientId);
          await setEnvironmentVariable("AZURE_TENANT_ID", tenantId);
          await setEnvironmentVariable("AZURE_SUBSCRIPTION_ID", subscriptionId);
          await setEnvironmentVariable("AZURE_RESOURCE_GROUP", rg);
          await setEnvironmentVariable("AZURE_AKS_CLUSTER_NAME", k8s);
          await setEnvironmentVariable("AZURE_LOCATION", data.location);
          await setEnvironmentVariable("RADIUS_NAMESPACE", data.namespace);

          const setCount = [
            clientId,
            tenantId,
            subscriptionId,
            rg,
            k8s,
            data.location,
            data.namespace
          ].filter(Boolean).length;
          steps.push(`Set ${setCount} environment value(s) for Azure.`);
          if (!clientId || !tenantId || !subscriptionId) {
            steps.push(
              "⚠️ Missing OIDC credentials (clientId/tenantId/subscriptionId). Use auto-setup or enter them manually."
            );
          }
        } else {
          const roleArn = data.roleArn || "";
          const region =
            data.region || optionalString(awsCreds.region) || "us-east-1";
          const accountId =
            data.accountId || optionalString(awsCreds.accountId);
          const k8s = data.cluster || "";

          await setEnvironmentVariable("AWS_ROLE_ARN", roleArn);
          await setEnvironmentVariable("AWS_REGION", region);
          await setEnvironmentVariable("AWS_ACCOUNT_ID", accountId);
          await setEnvironmentVariable("AWS_EKS_CLUSTER_NAME", k8s);
          await setEnvironmentVariable("RADIUS_VPC_ID", data.vpcId);
          await setEnvironmentVariable("RADIUS_SUBNET_IDS", data.subnetIds);
          await setEnvironmentVariable("RADIUS_NAMESPACE", data.namespace);
        }

        // Step 2b: Provision application parameters. Parse the app.bicep the
        // deploy will run against and auto-generate a value for every required
        // parameter that has no Bicep default (e.g. an @secure() password),
        // skipping params that do have a default (Bicep applies it). Values are
        // no longer collected from the UI. The result is stored as a single
        // JSON secret the deploy workflow reads and expands into
        // `--parameters name=value` pairs.
        try {
          // Detect the repo's real default branch once so both the
          // requested-branch resolution and the fallback below use it
          // (a repo may default to master/develop, not main).
          const detectedDefault = (
            (await runCommand("gh", [
              "repo",
              "view",
              targetRepo,
              "--json",
              "defaultBranchRef",
              "--jq",
              ".defaultBranchRef.name"
            ]).catch(() => "")) || ""
          ).trim();
          const defaultBranch = detectedDefault || "main";
          let paramBranch = data.branch || defaultBranch;
          let bicepSource = await fetchFileFromRepo(
            targetRepo,
            ".radius/app.bicep",
            paramBranch
          );
          let bicepPath = ".radius/app.bicep";
          if (!bicepSource) {
            bicepSource = await fetchFileFromRepo(
              targetRepo,
              "app.bicep",
              paramBranch
            );
            bicepPath = "app.bicep";
          }
          // Fall back to the repo default branch if the requested branch
          // has no app.bicep (e.g. an unpushed worktree branch). Without
          // this, step 2b would silently write neither RADIUS_DEPLOY_PARAMS
          // nor RADIUS_RAD_COMMANDS, leaving the deploy with no password
          // and a missing rad command.
          if (!bicepSource && paramBranch !== defaultBranch) {
            const fallbackBranch = defaultBranch;
            bicepPath = ".radius/app.bicep";
            bicepSource = await fetchFileFromRepo(
              targetRepo,
              ".radius/app.bicep",
              fallbackBranch
            );
            if (!bicepSource) {
              bicepSource = await fetchFileFromRepo(
                targetRepo,
                "app.bicep",
                fallbackBranch
              );
              bicepPath = "app.bicep";
            }
            if (bicepSource) {
              steps.push(
                `ℹ️ No app.bicep on "${paramBranch}"; resolved deploy parameters from "${fallbackBranch}".`
              );
            }
          }
          if (bicepSource) {
            const parsed = appParams(bicepSource);
            const resolved = resolveDeployParams(parsed);
            // Split into secret (provisioned as a secret, appended by the
            // workflow) and non-secret (inlined into the rad deploy command).
            const { secret: secretParams, public: publicParams } =
              partitionParams(parsed, resolved);
            await runGhOrThrow(
              [
                "secret",
                "set",
                "RADIUS_DEPLOY_PARAMS",
                "--env",
                envName,
                "--repo",
                targetRepo
              ],
              `Failed to set RADIUS_DEPLOY_PARAMS on GitHub environment "${envName}"`,
              Object.keys(secretParams).length ?
                JSON.stringify(secretParams)
              : "{}"
            );

            // Build the rad deploy command with non-secret params inline and
            // store it as an environment variable. The deploy workflow reads
            // it via `inputs.rad_commands || vars.RADIUS_RAD_COMMANDS`, so it
            // applies on both explicit dispatch and the verify→deploy auto
            // trigger (where inputs are empty). Secret params are appended by
            // the workflow from RADIUS_DEPLOY_PARAMS.
            //
            // Store a JSON array so the deploy also runs `rad app graph`
            // after `rad deploy`, matching the dispatch-time path — otherwise
            // the verify→deploy auto trigger (which relies on this variable)
            // would deploy without rendering the application graph.
            const radDeployCommand = buildDeployRadCommand(
              bicepPath,
              envName,
              publicParams
            );
            const radCommands = [radDeployCommand];
            const appName = extractAppName(bicepSource);
            if (appName) radCommands.push(buildAppGraphRadCommand(appName));
            await setEnvironmentVariable(
              "RADIUS_RAD_COMMANDS",
              JSON.stringify(radCommands)
            );

            const names = Object.keys(resolved);
            if (names.length > 0) {
              steps.push(
                `Provisioned ${names.length} application parameter(s) (auto-generated: ${names.join(", ")}).`
              );
            }
          } else {
            steps.push(
              `⚠️ Could not read app.bicep on "${paramBranch}" (or the default branch), so RADIUS_DEPLOY_PARAMS / RADIUS_RAD_COMMANDS were not set for "${envName}". Deploys will fail until the branch has a committed .radius/app.bicep.`
            );
          }
        } catch (paramErr) {
          steps.push(
            "⚠️ Could not resolve application parameters: " +
              errorMessage(paramErr)
          );
        }

        // Step 3: Commit the verify-credentials workflow
        steps.push("Committing verify-credentials workflow...");
        const verifyWorkflow = await generateVerifyWorkflow(envName, provider);
        const verifyContent = Buffer.from(verifyWorkflow).toString("base64");
        const verifyPath = ".github/workflows/radius-verify-credentials.yml";

        const verifyCommit = await commitWorkflowFileSmart(
          verifyPath,
          verifyContent,
          "Add Radius verify-credentials workflow for environment " + envName
        );

        if (!verifyCommit.ok) {
          steps.push("❌ Failed to commit verify-credentials workflow.");
          const scopeHint =
            needsWorkflowScope(verifyCommit.stderr) ?
              ' Your GitHub token is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.'
            : " Check that you have write access to the repository and that GitHub Actions is enabled.";
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(
            JSON.stringify({
              error:
                "Failed to commit the verify-credentials workflow (" +
                verifyPath +
                ") to " +
                targetRepo +
                ". " +
                ((verifyCommit.stderr || "").trim() ||
                  "The GitHub API request failed.") +
                scopeHint,
              steps
            })
          );
          return;
        }
        steps.push("✅ Verify workflow committed.");

        // Step 4: Also commit the deploy workflows (dispatcher + both
        // provider workflows). The dispatcher references both provider
        // files by path, so all three must exist in the target repo.
        steps.push("Committing deploy workflows...");
        const deployWorkflows = await generateDeployWorkflow(
          envName,
          ".radius/app.bicep"
        );

        for (const [fileName, content] of Object.entries(deployWorkflows)) {
          const deployContent = Buffer.from(content).toString("base64");
          const deployPath = ".github/workflows/" + fileName;

          const deployCommit = await commitWorkflowFileSmart(
            deployPath,
            deployContent,
            "Add Radius deploy workflow (" +
              fileName +
              ") for environment " +
              envName
          );

          if (!deployCommit.ok) {
            steps.push("❌ Failed to commit deploy workflow " + fileName + ".");
            const scopeHint2 =
              needsWorkflowScope(deployCommit.stderr) ?
                ' Your GitHub token is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.'
              : " Check that you have write access to the repository and that GitHub Actions is enabled.";
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(
              JSON.stringify({
                error:
                  "Failed to commit the deploy workflow (" +
                  deployPath +
                  ") to " +
                  targetRepo +
                  ". " +
                  ((deployCommit.stderr || "").trim() ||
                    "The GitHub API request failed.") +
                  scopeHint2,
                steps
              })
            );
            return;
          }
        }
        // Best-effort: remove the legacy monolithic deploy workflow so it
        // does not double-trigger alongside the new dispatcher. Skipped in
        // PR-fallback mode since we can't push to the default branch.
        if (!prState) await deleteLegacyDeployWorkflow(targetRepo);
        steps.push("✅ Deploy workflows committed.");

        // Step 4b: Commit the application-delete workflows (dispatcher +
        // Azure provider workflow) so the Delete Deployment button can
        // dispatch `rad app delete`. Only Azure workflows are generated and
        // committed; the AWS provider file is never produced.
        steps.push("Committing delete workflows...");
        try {
          const deleteWorkflows = await generateDeleteWorkflow(envName);
          for (const [fileName, content] of Object.entries(deleteWorkflows)) {
            const delContent = Buffer.from(content).toString("base64");
            const delPath = ".github/workflows/" + fileName;

            const delCommit = await commitWorkflowFileSmart(
              delPath,
              delContent,
              "Add Radius delete workflow (" +
                fileName +
                ") for environment " +
                envName
            );

            if (!delCommit.ok) {
              steps.push(
                "⚠️ Could not commit delete workflow " +
                  fileName +
                  ": " +
                  ((delCommit.stderr || "").trim() ||
                    "GitHub API request failed.")
              );
            }
          }
          steps.push("✅ Delete workflows committed.");
        } catch (delErr) {
          // Delete workflows are non-critical to environment creation, so
          // surface the failure but don't abort the whole flow.
          steps.push(
            "⚠️ Could not generate/commit delete workflows: " +
              errorMessage(delErr)
          );
        }

        // Step 4c: If any workflow commit fell back to a PR branch, open the
        // pull request now so the user can merge it. Until it's merged, the
        // workflows don't exist on the default branch, so we skip dispatching
        // the verify run (it would 404) and tell the user to merge first.
        let pullRequestUrl = "";
        if (prState) {
          const prTitle =
            "Add Radius deploy workflows for environment " + envName;
          const prBody = [
            "This PR adds the GitHub Actions workflows that power the Radius extension for the **" +
              envName +
              "** environment:",
            "",
            "- `.github/workflows/radius-verify-credentials.yml`",
            "- Radius deploy workflow(s) under `.github/workflows/`",
            "- Radius delete workflow(s) under `.github/workflows/`",
            "",
            "They were committed to `" +
              prState.branch +
              "` because direct pushes to `" +
              prState.base +
              "` are not permitted. Merge this PR to enable deploying and deleting the application from the Radius canvas."
          ].join("\n");
          const pr = await createPullRequestApi(
            targetRepo,
            prState.branch,
            prState.base,
            prTitle,
            prBody
          );
          if (pr.ok) {
            pullRequestUrl = pr.url || "";
            steps.push("✅ Opened pull request #" + pr.number + ": " + pr.url);
            steps.push(
              '👉 Merge the pull request above to finish setup; credential verification and deploys run once it lands on "' +
                prState.base +
                '".'
            );
          } else {
            steps.push(
              '⚠️ Committed workflows to branch "' +
                prState.branch +
                '" but could not open a pull request automatically: ' +
                ((pr.stderr || "").trim() || "GitHub API request failed.") +
                ' Open one manually from that branch into "' +
                prState.base +
                '".'
            );
          }
        }

        // Step 5: Dispatch the verify workflow. Skipped when the workflows
        // only exist on a PR branch — the workflow file isn't on the
        // default branch yet, so `workflow run` would 404. It runs
        // automatically once the PR merges.
        let verifyRunUrl = "";
        let verifyRunId = null;
        const dispatchedAt = Date.now();
        if (prState) {
          steps.push(
            "Skipping credential verification until the pull request is merged."
          );
        } else {
          steps.push("Dispatching verify-credentials workflow...");
          // Wait briefly for GitHub to index the workflow, then dispatch with
          // a few retries to ride out indexing/propagation races.
          await new Promise((r) => setTimeout(r, 3000));
          const dispatchDelays = [0, 2000, 5000];
          let dispatchResult: CommandResult = {
            code: 1,
            stdout: "",
            stderr: ""
          };
          for (const delay of dispatchDelays) {
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
            dispatchResult = await runGhWorkflow([
              "workflow",
              "run",
              "radius-verify-credentials.yml",
              "-f",
              "environment=" + envName,
              "--repo",
              targetRepo
            ]);
            if (dispatchResult.code === 0) break;
          }

          if (dispatchResult.code === 0) {
            steps.push("✅ Verify workflow dispatched.");
            await new Promise((r) => setTimeout(r, 5000));
            const runsResult = await runGh([
              "run",
              "list",
              "--workflow=radius-verify-credentials.yml",
              "--limit",
              "1",
              "--json",
              "databaseId,status,url",
              "--repo",
              targetRepo
            ]);
            try {
              const parsed: unknown = JSON.parse(runsResult.stdout);
              const runs = Array.isArray(parsed) ? parsed : [];
              if (runs.length > 0) {
                verifyRunId = runs[0].databaseId;
                verifyRunUrl =
                  "https://github.com/" +
                  targetRepo +
                  "/actions/runs/" +
                  verifyRunId;
                steps.push("Verify run: " + verifyRunUrl);
              }
            } catch {}
            steps.push(
              "Credentials verification dispatched. Deploy your application from the Environments list when ready."
            );
          } else {
            const detail =
              (dispatchResult.stderr || dispatchResult.stdout || "").trim() ||
              "The GitHub CLI request failed.";
            steps.push("❌ Could not dispatch verify workflow: " + detail);
            res.setHeader("Content-Type", "application/json");
            res.writeHead(200);
            res.end(
              JSON.stringify({
                error:
                  "Environment and state package were configured, but the verify workflow could not be dispatched after multiple attempts. " +
                  detail,
                environment: envName,
                provider,
                repo: targetRepo,
                stateBackend: OCI_STATE_BACKEND,
                stateRegistry,
                stateArchive: DEFAULT_STATE_ARCHIVE,
                steps
              })
            );
            return;
          }
        }

        // Record dispatch markers so the deploy monitor can track the
        // correct (newly-triggered) runs rather than any stale runs.
        {
          const entry = servers.get(instanceId);
          if (entry) {
            entry.state.deployDispatchedAt = dispatchedAt;
            entry.state.verifyRunId = verifyRunId;
            entry.state.verifyRunUrl = verifyRunUrl;
          }
        }

        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            success: true,
            environment: envName,
            provider,
            repo: targetRepo,
            stateBackend: OCI_STATE_BACKEND,
            stateRegistry,
            stateArchive: DEFAULT_STATE_ARCHIVE,
            verifyRunUrl,
            pullRequestUrl,
            steps
          })
        );
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      }
      return;
    }

    if (pathname === "/api/load-graph-stream" && req.method === "GET") {
      const url = new URL(req.url || "/", `http://127.0.0.1`);
      const repo = url.searchParams.get("repo") || "";
      const entry = servers.get(instanceId);
      if (!entry) {
        res.writeHead(503);
        res.end("Canvas server state is unavailable.");
        return;
      }
      const branch =
        url.searchParams.get("branch") || defaultBranchForState(entry?.state);
      const sourceRefContext =
        entry ?
          prepareSourceRefResources(entry, "graph", { repo, branch })
        : null;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.writeHead(200);

      const sendProgress = (message: string): void => {
        res.write(`event: progress\ndata: ${JSON.stringify({ message })}\n\n`);
      };
      const sendDone = (data: unknown): void => {
        res.write(`event: done\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      };

      if (!repo) {
        sendDone({ error: "Please select a repository." });
        return;
      }

      try {
        sendProgress(`Checking ${repo} for existing app.bicep...`);
        const selection = await fetchBicepSelection(entry, repo, branch);
        const content = selection.content;

        if (content) {
          sendProgress("Found existing app.bicep — parsing resources...");
        } else {
          triggerAppBicepHandoff(entry, repo, branch, "graph");
          sendDone({
            error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
            needsAppBicep: true,
            repo,
            branch
          });
          return;
        }

        const graphJsonPath =
          entry && selection.fromWorkspace ?
            workspaceGraphJsonPath(entry.state, selection.bicepPath)
          : "";
        const { dir: radArtifactsDir, remote: radArtifactsRemote } =
          await radArtifactsDirForSelection({
            isLocal: !!(entry && selection.fromWorkspace),
            state: entry?.state,
            github,
            repo,
            branch,
            bicepRepoPath: selection.bicepPath || ".radius/app.bicep",
            log: sendProgress
          });
        const resources = canvasGraphResources(
          await buildGraphViaRad(
            content,
            selection.bicepPath || ".radius/app.bicep",
            {
              log: sendProgress,
              saveGraphJsonTo: graphJsonPath,
              radArtifactsDir,
              cleanupRadArtifactsDir: radArtifactsRemote
            }
          )
        );
        sendProgress(
          `Mapped ${resources.length} resource(s) — rendering graph...`
        );

        if (entry && sourceRefContext) {
          if (
            !setSourceRefResources(
              entry,
              "graph",
              resources,
              { repo, branch },
              sourceRefContext.token
            )
          ) {
            sendDone({ stale: true });
            return;
          }
          entry.state.graphTargetRepo = repo;
          entry.state.graphBranch = branch;
          // Authoritative provenance: true only when the local workspace
          // actually supplied the app.bicep content (file is on disk).
          entry.state.graphFromWorkspace = selection.fromWorkspace;
          entry.state.activeGraphView = "graph";
        }

        sendDone({ reload: true });
      } catch (e) {
        sendDone({ error: errorMessage(e) });
      }
      return;
    }

    if (pathname === "/api/progress" && req.method === "GET") {
      const entry = servers.get(instanceId);
      const messages = entry?.state?.progressMessages || [];
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ messages }));
      return;
    }

    if (pathname === "/api/deployed-graph" && req.method === "GET") {
      const entry = servers.get(instanceId);
      const reqUrl = new URL(req.url || "/", `http://127.0.0.1`);
      const repo =
        (reqUrl.searchParams.get("repo") || "").trim() ||
        entry?.state?.contextRepo ||
        entry?.state?.deployingRepo ||
        entry?.state?.plannedRepo ||
        entry?.state?.graphTargetRepo ||
        "";
      res.setHeader("Content-Type", "application/json");
      if (!repo) {
        res.writeHead(200);
        res.end(JSON.stringify({ resources: [], repo: "" }));
        return;
      }
      // Prefer the deployed graph published to GHCR by the deploy workflow
      // (radius-project/radius PR #12591), falling back to the legacy
      // radius-deploy-status branch and then any graph captured in state.
      const reader = await deployStatusReaderFromState(
        entry?.state || {},
        repo,
        ""
      );
      let graph = (await reader.graph()).graph;
      if (!graph && entry?.state?.deployedGraph)
        graph = entry.state.deployedGraph;
      const graphRecord = record(graph);
      let resources = canvasGraphResources(
        Array.isArray(graph) ? graph
        : Array.isArray(graphRecord.resources) ? graphRecord.resources
        : []
      );
      // DEMO: present the deployed topology as container → cache → database.
      resources = canvasGraphResources(
        rewireDeployedGraphChain(resources) || []
      );
      // Re-derive connections (e.g. database→secret) that rad app graph
      // omits, so the deployed graph renders connected like the planned one.
      resources = canvasGraphResources(normalizeDeployedGraph(resources) || []);
      // Hide implementation-detail resources (containerImages + their
      // ghcr-registry-creds secret) from the deployed view too, matching
      // every other graph state. Applied last so any edges the rewire/
      // normalize steps synthesized toward those nodes are also stripped.
      // The raw deploy-graph.json on the status branch is left untouched.
      resources = filterGraphVisualizationResources(resources);
      res.writeHead(200);
      res.end(
        JSON.stringify({
          resources,
          repo,
          branch:
            (
              entry?.state?.workspaceBranch &&
              repoMatchesWorkspace(entry.state, repo)
            ) ?
              entry.state.workspaceBranch
            : "main"
        })
      );
      return;
    }

    if (pathname === "/api/deploy-status" && req.method === "GET") {
      const entry = servers.get(instanceId);
      const resources =
        entry?.state?.deployingResources ||
        entry?.state?.plannedResources ||
        [];
      const logs = entry?.state?.deployLogs || [];
      const logBase = entry?.state?.deployLogBase || 0;
      const logTotal = logBase + logs.length;
      const status = entry?.state?.deployStatus || "pending";
      const error = entry?.state?.deployError || null;
      const errorKind = entry?.state?.deployErrorKind || null;
      const errorBranch = entry?.state?.deployErrorBranch || null;
      const startedAt = entry?.state?.deployStartedAt || null;
      const finishedAt = entry?.state?.deployFinishedAt || null;
      const deployedGraph = entry?.state?.deployedGraph || null;
      const deployRunUrl = entry?.state?.deployRunUrl || null;
      // Every failure path converges on this poll, so it is where a failed
      // deploy is handed to the agent to repair (once per repair loop).
      const repairing =
        triggerDeployRepairHandoff(entry, instanceId) ||
        entry?.state?.deployRepairing ||
        false;
      const handoff = deployHandoffStatus(entry?.state || {});
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      // Incremental log delivery: when the client passes ?since=<absolute
      // line index>, send only the new lines instead of re-serializing the
      // entire (bounded) buffer on every 1.5s poll. Callers that omit it
      // (e.g. the deployed-graph poller, which only reads resources) get the
      // bounded buffer for backward compatibility.
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw === null ? NaN : parseInt(sinceRaw, 10);
      if (Number.isFinite(since)) {
        const startIdx = Math.max(0, since - logBase);
        const logsNew = logs.slice(startIdx);
        res.end(
          JSON.stringify({
            resources,
            logsNew,
            logBase,
            logTotal,
            status,
            error,
            errorKind,
            errorBranch,
            startedAt,
            finishedAt,
            deployedGraph,
            deployRunUrl,
            repairing,
            handoff
          })
        );
      } else {
        res.end(
          JSON.stringify({
            resources,
            logs,
            logBase,
            logTotal,
            status,
            error,
            errorKind,
            errorBranch,
            startedAt,
            finishedAt,
            deployedGraph,
            deployRunUrl,
            repairing,
            handoff
          })
        );
      }
      return;
    }

    if (pathname === "/api/load-graph" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const repo = data.repo || "";
        const entry = servers.get(instanceId);
        if (!entry) {
          res.writeHead(503);
          res.end(
            JSON.stringify({ error: "Canvas server state is unavailable." })
          );
          return;
        }
        const state = entry.state;
        const branch = data.branch || defaultBranchForState(state);
        const requestGeneration =
          entry ?
            (entry.state.graphBuildGeneration =
              (entry.state.graphBuildGeneration || 0) + 1)
          : 0;
        if (!repo) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(JSON.stringify({ error: "Please select a repository." }));
          return;
        }
        const sourceRefContext =
          entry ?
            prepareSourceRefResources(entry, "graph", { repo, branch })
          : null;

        const addProgress = (msg: string): void => {
          addGraphProgress(state, requestGeneration, msg);
        };
        // Reset progress
        if (entry) entry.state.progressMessages = [];

        addProgress(`Checking ${repo} for existing app.bicep...`);
        const selection = await fetchBicepSelection(entry, repo, branch);
        const content = selection.content;
        if (content) {
          addProgress("Found existing app.bicep — parsing resources...");
        } else {
          addProgress(
            ".radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill."
          );
          triggerAppBicepHandoff(entry, repo, branch, "graph");
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(
            JSON.stringify({
              error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
              needsAppBicep: true,
              repo,
              branch
            })
          );
          return;
        }

        const graphJsonPath =
          entry && selection.fromWorkspace ?
            workspaceGraphJsonPath(entry.state, selection.bicepPath)
          : "";
        const { dir: radArtifactsDir, remote: radArtifactsRemote } =
          await radArtifactsDirForSelection({
            isLocal: !!(entry && selection.fromWorkspace),
            state: entry?.state,
            github,
            repo,
            branch,
            bicepRepoPath: selection.bicepPath || ".radius/app.bicep",
            log: addProgress
          });
        const definitionHash = graphDefinitionHash(
          content,
          radArtifactsFingerprint(radArtifactsDir)
        );
        if (entry && entry.state.graphBuildGeneration !== requestGeneration) {
          if (radArtifactsRemote && radArtifactsDir) {
            try {
              rmSync(radArtifactsDir, { recursive: true, force: true });
            } catch {
              /* best-effort */
            }
          }
          res.writeHead(409);
          res.end(JSON.stringify({ stale: true }));
          return;
        }
        if (
          data.refresh &&
          entry &&
          canReuseModeledGraph(entry.state, repo, branch, definitionHash)
        ) {
          if (radArtifactsRemote && radArtifactsDir)
            rmSync(radArtifactsDir, { recursive: true, force: true });
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(
            JSON.stringify({
              reload: false,
              resources: entry.state.graphResources,
              cached: true
            })
          );
          return;
        }

        const resources = canvasGraphResources(
          await buildGraphViaRad(
            content,
            selection.bicepPath || ".radius/app.bicep",
            {
              log: addProgress,
              saveGraphJsonTo: graphJsonPath,
              radArtifactsDir,
              cleanupRadArtifactsDir: radArtifactsRemote
            }
          )
        );
        addProgress(
          `Mapped ${resources.length} resource(s) — rendering graph...`
        );

        if (entry && sourceRefContext) {
          if (entry.state.graphBuildGeneration !== requestGeneration) {
            res.setHeader("Content-Type", "application/json");
            res.writeHead(409);
            res.end(JSON.stringify({ stale: true }));
            return;
          }
          if (
            !setSourceRefResources(
              entry,
              "graph",
              resources,
              { repo, branch },
              sourceRefContext.token
            )
          ) {
            res.setHeader("Content-Type", "application/json");
            res.writeHead(409);
            res.end(JSON.stringify({ stale: true }));
            return;
          }
          entry.state.graphTargetRepo = repo;
          entry.state.graphBranch = branch;
          // Authoritative provenance: true only when the local workspace
          // actually supplied the app.bicep content (file is on disk).
          entry.state.graphFromWorkspace = selection.fromWorkspace;
          entry.state.activeGraphView = "graph";
          entry.state.graphLoaded = true;
          entry.state.graphDefinitionHash = definitionHash;
        }
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ reload: !data.refresh, resources }));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      }
      return;
    }

    if (pathname === "/api/list-environments" && req.method === "GET") {
      const repo = url.searchParams.get("repo") || "";
      const respond = (payload: unknown): void => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(200);
        res.end(JSON.stringify(payload));
      };
      if (!repo) {
        respond({ environments: [] });
        return;
      }

      const cached = envListCache.get(repo);
      if (cached && Date.now() - cached.at < ENV_LIST_TTL_MS) {
        respond(cached.payload);
        return;
      }

      const gh = (args: string[], timeout = 12000): Promise<string> =>
        new Promise<string>((resolve) => {
          cliExec("gh", args, { timeout }, (err, stdout) => {
            if (err) {
              resolve("");
              return;
            }
            resolve((stdout || "").trim());
          });
        });

      try {
        // 1) List environment names + ids for the repo. Kick off the
        //    verify-credentials workflow-runs fetch in parallel — it's
        //    independent of the names, so there's no reason to wait.
        const verifyRunsPromise = gh([
          "api",
          `/repos/${repo}/actions/workflows/radius-verify-credentials.yml/runs?per_page=100`,
          "--jq",
          '.workflow_runs[] | (.id|tostring) + "\\t" + (.status // "") + "\\t" + (.conclusion // "")'
        ]);
        const namesRes = await new Promise<EnvironmentListResult>((resolve) => {
          cliExec(
            "gh",
            [
              "api",
              "--paginate",
              `/repos/${repo}/environments?per_page=100`,
              "--jq",
              '.environments[] | (.id|tostring) + "\\t" + .name'
            ],
            { timeout: 12000 },
            (err, stdout, stderr) => {
              if (err) {
                resolve({
                  error:
                    (stderr || err.message || "").trim() ||
                    "Failed to list environments."
                });
                return;
              }
              resolve({ stdout: (stdout || "").trim() });
            }
          );
        });
        // Surface a genuine API/auth/permission failure instead of
        // silently reporting "no environments" (which hides real
        // problems). Failures are not cached so a retry can recover.
        if (namesRes.error) {
          respond({ environments: [], error: namesRes.error });
          return;
        }
        const namesRaw = namesRes.stdout || "";
        const rows =
          namesRaw ?
            namesRaw
              .split("\n")
              .filter(Boolean)
              .map((l) => {
                const tab = l.indexOf("\t");
                return tab === -1 ?
                    { id: "", name: l }
                  : { id: l.slice(0, tab), name: l.slice(tab + 1) };
              })
          : [];
        if (rows.length === 0) {
          const payload = { environments: [] };
          respond(payload);
          envListCache.set(repo, { at: Date.now(), payload });
          return;
        }

        // Index the pre-fetched verify runs by run id. The environment
        // status is derived from these (not from app deployments): an
        // environment is "Success" only once it exists AND its
        // verify-credentials workflow has passed.
        const verifyRunsRaw = await verifyRunsPromise;
        const verifyRuns = new Map<string, VerifyRun>();
        if (verifyRunsRaw) {
          for (const line of verifyRunsRaw.split("\n").filter(Boolean)) {
            const [rid, rstatus, rconclusion] = line.split("\t");
            verifyRuns.set(rid, { status: rstatus, conclusion: rconclusion });
          }
        }
        // Map a verify run's outcome to an environment status.
        const verifyStatusOf = (run?: VerifyRun): string | null => {
          if (!run) return null;
          if (run.status !== "completed") return "pending"; // queued / in_progress
          if (run.conclusion === "success") return "success";
          return "failed"; // failure / cancelled / timed_out / etc.
        };

        // 2) For each environment, derive provider (from stored variables)
        //    and a status from the verify-credentials workflow. Both the
        //    verify and deploy workflows create deployments to the same
        //    environment, so we walk this env's deployments newest-first
        //    until we find one created by a verify-credentials run.
        const environments = await Promise.all(
          rows.map(async ({ id, name }) => {
            // The variables (provider) and deployments (status) lookups are
            // independent, so fire them together.
            const [varsRaw, depIdsRaw] = await Promise.all([
              gh([
                "api",
                `/repos/${repo}/environments/${encodeURIComponent(name)}/variables?per_page=100`,
                "--jq",
                '.variables[] | .name + "\\t" + (.value // "")'
              ]),
              verifyRuns.size > 0 ?
                gh([
                  "api",
                  `/repos/${repo}/deployments?environment=${encodeURIComponent(name)}&per_page=10`,
                  "--jq",
                  ".[].id"
                ])
              : Promise.resolve("")
            ]);
            // Parse the "name<TAB>value" variable lines into a map. Only
            // surface environments created by this extension (tagged with a
            // RADIUS_MANAGED variable at creation time); anything without it
            // was created outside Radius and is filtered out below.
            const vars: Record<string, string> = {};
            for (const line of varsRaw ?
              varsRaw.split("\n").filter(Boolean)
            : []) {
              const tab = line.indexOf("\t");
              if (tab === -1) {
                vars[line] = "";
                continue;
              }
              vars[line.slice(0, tab)] = line.slice(tab + 1);
            }
            if (!("RADIUS_MANAGED" in vars)) return null;

            let provider = "";
            const varNames = Object.keys(vars).join("\n");
            if (/AZURE_/.test(varNames)) provider = "azure";
            else if (/AWS_/.test(varNames)) provider = "aws";

            const credentialProfile = vars.RADIUS_CREDENTIAL_PROFILE || "";

            // Status reflects the verify-credentials workflow only:
            // pending while it runs, success when it passes, failed if it
            // fails. Default to "pending" until we find a matching run.
            let status = "pending";
            if (verifyRuns.size > 0) {
              const depIds =
                depIdsRaw ? depIdsRaw.split("\n").filter(Boolean) : [];
              // Resolve every deployment's originating-run URL in parallel
              // (deployments come back newest-first), then pick the newest
              // one created by a verify-credentials run. Doing this serially
              // was the main source of latency for this endpoint.
              const logUrls = await Promise.all(
                depIds.map((depId) =>
                  gh([
                    "api",
                    `/repos/${repo}/deployments/${depId}/statuses?per_page=1`,
                    "--jq",
                    '.[0].log_url // .[0].target_url // ""'
                  ])
                )
              );
              for (const logUrl of logUrls) {
                const m = /actions\/runs\/(\d+)/.exec(logUrl || "");
                if (!m) continue;
                const run = verifyRuns.get(m[1]);
                if (run) {
                  status = verifyStatusOf(run) || status;
                  break;
                }
              }
            }

            const webUrl =
              id ?
                `https://github.com/${repo}/settings/environments/${id}/edit`
              : `https://github.com/${repo}/settings/environments`;
            return { name, provider, status, webUrl, credentialProfile };
          })
        );

        const managedEnvironments = environments.filter(
          (environment) => environment !== null
        );
        respond({ environments: managedEnvironments });
        envListCache.set(repo, {
          at: Date.now(),
          payload: { environments: managedEnvironments }
        });
        // Background self-heal: update any committed workflow files that
        // have drifted from the upstream Radius templates. Also target the
        // session worktree branch (when it's this repo's) so a
        // worktree-consistent deploy runs the up-to-date workflows, not
        // just the default branch. Fire-and-forget so it never blocks.
        const syncEntry = servers.get(instanceId);
        const workingBranch =
          (
            syncEntry?.state?.workspaceBranch &&
            repoMatchesWorkspace(syncEntry.state, repo)
          ) ?
            syncEntry.state.workspaceBranch
          : "";
        kickoffWorkflowSync(repo, managedEnvironments, workingBranch);
      } catch (e) {
        respond({ environments: [], error: errorMessage(e) });
      }
      return;
    }

    if (pathname === "/api/list-applications" && req.method === "GET") {
      const repo = url.searchParams.get("repo") || "";
      const respond = (payload: unknown): void => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(200);
        res.end(JSON.stringify(payload));
      };
      if (!repo) {
        respond({ applications: [] });
        return;
      }
      try {
        // The application name is defined in the repo's app.bicep (a repo
        // hosts a single Radius application in this model). Shared with the
        // deployments/env-deletion paths via resolveRepoAppName.
        const entry = servers.get(instanceId);
        const branch =
          entry?.state?.contextBranch ||
          entry?.state?.plannedBranch ||
          entry?.state?.graphBranch ||
          "main";
        const appName = await resolveRepoAppName(repo, branch);
        respond({ applications: [{ name: appName }] });
      } catch (e) {
        respond({
          applications: [{ name: repo.split("/").pop() || repo }],
          error: errorMessage(e)
        });
      }
      return;
    }

    if (pathname === "/api/list-deployments" && req.method === "GET") {
      const repo = url.searchParams.get("repo") || "";
      const respond = (payload: unknown): void => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(200);
        res.end(JSON.stringify(payload));
      };
      if (!repo) {
        respond({ deployments: [] });
        return;
      }

      // (A) Serve a fresh cached listing when available. The fan-out below
      // is expensive, so a short TTL keeps re-opens and the workflow poll
      // snappy without showing stale state for long. `?fresh=1` bypasses the
      // cache read so active status pollers (a running deploy/delete) always
      // see live status rather than a value cached before the transition.
      const freshDeploys = url.searchParams.get("fresh") === "1";
      const cachedDeploys = freshDeploys ? null : deployListCache.get(repo);
      if (cachedDeploys && Date.now() - cachedDeploys.at < DEPLOY_LIST_TTL_MS) {
        respond(cachedDeploys.payload);
        return;
      }

      try {
        // Resolve the current deployment per environment from each
        // environment's OWN history (see resolveEnvDeployment). Querying
        // per environment — rather than a single repo-wide, capped page —
        // means a busy environment can never crowd another's latest
        // deploy/delete record out of the results.
        const envNamesRaw = await ghOrThrow([
          "api",
          "--paginate",
          `/repos/${repo}/environments?per_page=100`,
          "--jq",
          ".environments[].name"
        ]);
        const envNames =
          envNamesRaw ?
            [...new Set(envNamesRaw.split("\n").filter(Boolean))]
          : [];
        // Resolve the real app name once (from app.bicep) so every row targets
        // the app declared in the bicep, not the repo basename.
        const listEntry = servers.get(instanceId);
        const listBranch =
          listEntry?.state?.contextBranch ||
          listEntry?.state?.plannedBranch ||
          listEntry?.state?.graphBranch ||
          "main";
        const listAppName = await resolveRepoAppName(repo, listBranch);
        const resolved = await Promise.all(
          envNames.map((name) => resolveEnvDeployment(repo, name, listAppName))
        );
        const payload = { deployments: resolved.filter(Boolean) };
        deployListCache.set(repo, { at: Date.now(), payload });
        respond(payload);
      } catch (e) {
        // A GitHub failure surfaces as an error (not a silently-empty list)
        // so the client keeps its current view / keeps polling rather than
        // treating an incomplete listing as the truth.
        respond({ deployments: [], error: errorMessage(e) });
      }
      return;
    }

    if (pathname === "/api/delete-deployment" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const respond = (code: number, payload: unknown): void => {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(code);
        res.end(JSON.stringify(payload));
      };
      try {
        const data = JSON.parse(body || "{}");
        const repo = data.repo || "";
        const environment = data.environment || "";
        const application = data.application || "";
        if (!repo || !environment || !application) {
          respond(400, {
            error: "repo, environment, and application are required."
          });
          return;
        }

        const gh = (
          args: string[],
          timeout = 20000,
          extraEnv?: NodeJS.ProcessEnv
        ): Promise<CommandResult> =>
          new Promise<CommandResult>((resolve) => {
            const opts: CliOptions = { timeout };
            if (extraEnv) opts.env = extraEnv;
            cliExec("gh", args, opts, (err, stdout, stderr) => {
              resolve({
                code: err ? err.code || 1 : 0,
                stdout: (stdout || "").trim(),
                stderr: stderr || ""
              });
            });
          });
        // Dispatching a workflow requires the `workflow` scope, which an
        // injected GH_TOKEN often lacks. Retry with it stripped so gh falls
        // back to the keyring credential.
        const ghWorkflow = async (args: string[]): Promise<CommandResult> => {
          const first = await gh(args);
          if (first.code === 0) return first;
          if (!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) return first;
          const fallbackEnv = { ...process.env };
          delete fallbackEnv.GH_TOKEN;
          delete fallbackEnv.GITHUB_TOKEN;
          const retry = await gh(args, 20000, fallbackEnv);
          return retry.code === 0 ? retry : first;
        };

        // Deleting a deployment now runs `rad app delete` via the committed
        // delete-application.yml workflow. This tears down the Radius
        // application on the ephemeral control plane while leaving the
        // GitHub Environment (and its credentials) intact.
        //
        // Ensure the delete workflow files are in sync with upstream before
        // dispatching, so the run never executes a drifted copy. Delete
        // workflow content is provider-agnostic, and workflow_dispatch runs
        // from the default branch, so provider/workingBranch aren't needed.
        await ensureWorkflowsCurrent(repo, environment, "", [
          DELETE_APP_DISPATCHER_FILE,
          DELETE_AZURE_FILE
        ]);
        const dispatchedAt = Date.now();
        const dispatch = await ghWorkflow([
          "workflow",
          "run",
          DELETE_APP_DISPATCHER_FILE,
          "-f",
          "environment=" + environment,
          "-f",
          "application=" + application,
          "--repo",
          repo
        ]);
        if (dispatch.code !== 0) {
          const de = (dispatch.stderr || "").trim();
          const hint =
            /workflow.{0,20}scope/i.test(de) ?
              ' Your GitHub token is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.'
            : " Ensure " +
              DELETE_APP_DISPATCHER_FILE +
              " exists on the default branch (recreate the environment to commit it) and that Actions are enabled for " +
              repo +
              ".";
          respond(400, {
            error:
              "Failed to start the delete workflow (" +
              DELETE_APP_DISPATCHER_FILE +
              ") on " +
              repo +
              ". " +
              (de || "The dispatch request failed.") +
              hint
          });
          return;
        }

        // Best-effort: resolve the dispatched run's URL so the client can
        // link to it in GitHub.
        let runUrl = "";
        const runId = await findWorkflowRun(
          repo,
          DELETE_APP_DISPATCHER_FILE,
          dispatchedAt,
          null
        );
        if (runId)
          runUrl = "https://github.com/" + repo + "/actions/runs/" + runId;
        // A delete is now in flight, so the cached listing is stale — drop
        // it so the next poll reflects the "Deleting…" state immediately.
        deployListCache.delete(repo);
        respond(200, { success: true, runUrl });
      } catch (e) {
        respond(400, { error: errorMessage(e) });
      }
      return;
    }

    if (pathname === "/api/verify-status" && req.method === "GET") {
      const repo = url.searchParams.get("repo") || "";
      const respond = (payload: unknown): void => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(200);
        res.end(JSON.stringify(payload));
      };
      if (!repo) {
        respond({ state: "unknown", error: "No repository specified." });
        return;
      }

      try {
        const entry = servers.get(instanceId);
        const dispatchedAt = entry?.state?.deployDispatchedAt || 0;
        let runId = entry?.state?.verifyRunId || null;
        if (!runId) {
          runId = await findWorkflowRun(
            repo,
            "radius-verify-credentials.yml",
            dispatchedAt,
            null
          );
          if (runId && entry) entry.state.verifyRunId = runId;
        }
        if (!runId) {
          respond({ state: "pending", runId: null });
          return;
        }

        const detail = await getRunDetail(repo, runId);
        const runUrl = "https://github.com/" + repo + "/actions/runs/" + runId;
        if (!detail) {
          respond({ state: "pending", runId, runUrl });
          return;
        }

        if (detail.status !== "completed") {
          respond({ state: "in_progress", runId, runUrl });
          return;
        }
        if (detail.conclusion === "success") {
          respond({ state: "success", runId, runUrl });
          return;
        }
        // Failed — surface the failing step + a few error lines.
        const failed = (detail.steps || []).filter(
          (s) =>
            s.conclusion &&
            s.conclusion !== "success" &&
            s.conclusion !== "skipped"
        );
        let errMsg =
          "Credential verification failed" +
          (detail.conclusion ? " (" + detail.conclusion + ")" : "") +
          ".";
        if (failed.length)
          errMsg +=
            " Failed step: " + failed.map((s) => s.name).join(", ") + ".";
        const log = await fetchRunLog(repo, runId);
        const lines = extractErrorLines(log, 8);
        if (lines.length) errMsg += "\n" + lines.join("\n");
        const oidcClaimHelp = explainOidcEnterpriseClaim(log);
        if (oidcClaimHelp)
          errMsg = oidcClaimHelp + "\n\n\u2014 raw error \u2014\n" + errMsg;
        respond({ state: "failed", runId, runUrl, error: errMsg });
      } catch (e) {
        respond({ state: "unknown", error: errorMessage(e) });
      }
      return;
    }

    if (pathname === "/api/user-repos" && req.method === "GET") {
      try {
        // Fetch personal repos and org repos in parallel
        const [personalRepos, orgRepos] = await Promise.all([
          new Promise<string[]>((resolve) => {
            cliExec(
              "gh",
              [
                "repo",
                "list",
                "--limit",
                "30",
                "--json",
                "nameWithOwner",
                "--jq",
                ".[].nameWithOwner"
              ],
              { timeout: 15000 },
              (err, stdout) => {
                if (err) {
                  resolve([]);
                  return;
                }
                resolve(stdout.trim().split("\n").filter(Boolean));
              }
            );
          }),
          new Promise<string[]>((resolve) => {
            // Get orgs the user belongs to, then fetch repos from each
            cliExec(
              "gh",
              ["org", "list"],
              { timeout: 15000 },
              (err, stdout) => {
                if (err || !stdout.trim()) {
                  resolve([]);
                  return;
                }
                const orgs = stdout.trim().split("\n").filter(Boolean);
                const orgPromises = orgs.map(
                  (org) =>
                    new Promise<string[]>((res2) => {
                      cliExec(
                        "gh",
                        [
                          "repo",
                          "list",
                          org,
                          "--limit",
                          "20",
                          "--json",
                          "nameWithOwner",
                          "--jq",
                          ".[].nameWithOwner"
                        ],
                        { timeout: 15000 },
                        (err2, stdout2) => {
                          if (err2) {
                            res2([]);
                            return;
                          }
                          res2(stdout2.trim().split("\n").filter(Boolean));
                        }
                      );
                    })
                );
                Promise.all(orgPromises).then((results) =>
                  resolve(results.flat())
                );
              }
            );
          })
        ]);
        const allRepos = [...new Set([...personalRepos, ...orgRepos])];
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ repos: allRepos }));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ repos: [] }));
      }
      return;
    }

    if (pathname === "/api/repo-branches" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const repo = data.repo;
        if (!repo) {
          res.writeHead(200);
          res.end(JSON.stringify({ branches: [] }));
          return;
        }
        const result = await new Promise<string[]>((resolve) => {
          cliExec(
            "gh",
            [
              "api",
              "--paginate",
              `/repos/${repo}/branches?per_page=100`,
              "--jq",
              ".[].name"
            ],
            { timeout: 15000 },
            (err, stdout) => {
              if (err) {
                resolve([]);
                return;
              }
              resolve(stdout.trim().split("\n").filter(Boolean));
            }
          );
        });
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ branches: result }));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ branches: [] }));
      }
      return;
    }

    if (pathname === "/api/plan-graph" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const repo = data.repo || "";
        const entry = servers.get(instanceId);
        if (!entry) {
          res.writeHead(503);
          res.end(
            JSON.stringify({ error: "Canvas server state is unavailable." })
          );
          return;
        }
        const branch = data.branch || defaultBranchForState(entry.state);
        const provider = data.provider || "azure";
        const sourceRefContext =
          entry ?
            prepareSourceRefResources(entry, "planned", { repo, branch })
          : null;

        const addProgress = (msg: string): void => {
          if (entry) {
            if (!entry.state.progressMessages)
              entry.state.progressMessages = [];
            entry.state.progressMessages.push(msg);
          }
        };
        if (entry) entry.state.progressMessages = [];

        addProgress(`Checking ${repo} for app.bicep...`);
        const selection = await fetchBicepSelection(entry, repo, branch);
        const content = selection.content;
        if (!content) {
          addProgress(
            ".radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill."
          );
          triggerAppBicepHandoff(entry, repo, branch, "graph");
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(
            JSON.stringify({
              error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
              needsAppBicep: true,
              repo,
              branch
            })
          );
          return;
        }
        addProgress("Found app.bicep — parsing resources...");

        const { dir: radArtifactsDir, remote: radArtifactsRemote } =
          await radArtifactsDirForSelection({
            isLocal: !!(entry && selection.fromWorkspace),
            state: entry?.state,
            github,
            repo,
            branch,
            bicepRepoPath: selection.bicepPath || ".radius/app.bicep",
            log: addProgress
          });
        const resources = canvasGraphResources(
          await buildGraphViaRad(
            content,
            selection.bicepPath || ".radius/app.bicep",
            {
              log: addProgress,
              radArtifactsDir,
              cleanupRadArtifactsDir: radArtifactsRemote
            }
          )
        );
        addProgress(
          `Parsed ${resources.length} resource(s) — resolving ${provider} recipes...`
        );

        // Resolve recipes from the default recipe pack (radius-project/resource-types-contrib)
        let recipes: unknown[] = [];
        addProgress("Fetching the default recipe pack from GitHub...");
        recipes = await fetchRecipePack(github, provider);
        addProgress(
          `Loaded ${Array.isArray(recipes) ? recipes.length : 0} recipe(s) from the default recipe pack.`
        );

        // Surface pack recipes we couldn't map to a concrete resource so
        // the gap is visible (rather than silently rendering the abstract
        // type). Empty today for the Azure pack; fires if the pack adds a
        // recipe source the curated map doesn't yet cover.
        const unmappedRecipes = recipes.filter((recipe) => {
          const concrete = record(recipe).concreteResources;
          return !Array.isArray(concrete) || concrete.length === 0;
        });
        if (unmappedRecipes.length) {
          addProgress(
            `Note: ${unmappedRecipes.length} pack recipe(s) have no concrete-resource mapping yet (${unmappedRecipes.map((recipe) => optionalString(record(recipe).resourceType)).join(", ")}); those nodes show their abstract Radius type.`
          );
        }

        // For each abstract resource, resolve its recipe and concrete output resources
        addProgress("Resolving recipe outputs for planned resources...");
        const plannedResources = canvasGraphResources(
          await resolveRecipeOutputs(github, resources, recipes, provider)
        );
        addProgress(
          `Planned ${plannedResources.length} resource(s) — rendering graph...`
        );

        if (entry && sourceRefContext) {
          if (
            !setSourceRefResources(
              entry,
              "planned",
              plannedResources,
              { repo, branch },
              sourceRefContext.token
            )
          ) {
            res.setHeader("Content-Type", "application/json");
            res.writeHead(409);
            res.end(JSON.stringify({ stale: true }));
            return;
          }
          entry.state.plannedRepo = repo;
          entry.state.plannedBranch = branch;
          // Authoritative provenance: true only when the local workspace
          // actually supplied the app.bicep content (file is on disk).
          entry.state.plannedFromWorkspace = selection.fromWorkspace;
          entry.state.plannedProvider = provider;
          entry.state.resolvedRecipes = recipes;
          entry.state.activeGraphView = "planned";
        }
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ reload: true }));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      }
      return;
    }

    if (pathname === "/api/discover-branches" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const repo = data.repo || "";
        const result = await new Promise<BranchResult>((resolve) => {
          cliExec(
            "gh",
            ["api", "--paginate", `/repos/${repo}/branches?per_page=100`],
            { timeout: 15000 },
            (err, stdout, stderr) => {
              if (err) {
                resolve({ error: stderr || err.message });
                return;
              }
              try {
                const raw: unknown = JSON.parse(stdout.trim());
                const branches =
                  Array.isArray(raw) ?
                    raw.map((value) => {
                      const branch = record(value);
                      return {
                        name: optionalString(branch.name),
                        sha: optionalString(record(branch.commit).sha)
                      };
                    })
                  : [];
                resolve({ branches });
              } catch (e) {
                resolve({ error: "Failed to parse branch data" });
              }
            }
          );
        });
        const entry = servers.get(instanceId);
        if (!entry) {
          res.writeHead(503);
          res.end(
            JSON.stringify({ error: "Canvas server state is unavailable." })
          );
          return;
        }
        if (
          entry?.state?.workspaceBranch &&
          repoMatchesWorkspace(entry.state, repo)
        ) {
          const branches = result.branches || [];
          if (!branches.some((b) => b.name === entry.state.workspaceBranch)) {
            branches.unshift({
              name: entry.state.workspaceBranch,
              sha: "worktree"
            });
          }
          result.branches = branches;
          result.workspaceBranch = entry.state.workspaceBranch;
        }
        if (entry && result.branches) {
          entry.state.branches = result.branches.map((b) => b.name);
          entry.state.branchShas = {};
          for (const b of result.branches)
            entry.state.branchShas[b.name] = b.sha;
          entry.state.diffTargetRepo = repo;
        }
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      }
      return;
    }

    if (pathname === "/api/diff-branches" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let sourceRefContext = null;
      try {
        const data = JSON.parse(body);
        const repo = data.repo || "";
        const entry = servers.get(instanceId);
        if (!entry) {
          res.writeHead(503);
          res.end(
            JSON.stringify({ error: "Canvas server state is unavailable." })
          );
          return;
        }
        sourceRefContext = prepareSourceRefResources(entry, "diff", {
          repo,
          baseBranch: data.base,
          headBranch: data.head
        });
        entry.state.diffBase = data.base;
        entry.state.diffHead = data.head;
        entry.state.diffTargetRepo = repo;
        delete entry.state.diffError;

        // Fetch the committed/persisted app.bicep on each branch. app.bicep
        // generation is owned by the Radius app-bicep skill, so branches
        // without one simply contribute nothing to the diff (added/removed).
        const [baseSelection, headSelection] = await Promise.all([
          fetchBicepSelection(entry, repo, data.base),
          fetchBicepSelection(entry, repo, data.head)
        ]);

        if (!baseSelection.content && !headSelection.content) {
          triggerAppBicepHandoff(
            entry,
            repo,
            [data.base, data.head],
            "graph-diff"
          );
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(
            JSON.stringify({
              error: `Copilot is generating .radius/app.bicep with the Radius app-bicep skill.`,
              needsAppBicep: true,
              repo
            })
          );
          return;
        }

        const { dir: baseRadArtifactsDir, remote: baseRadArtifactsRemote } =
          await radArtifactsDirForSelection({
            isLocal: !!(entry && baseSelection.fromWorkspace),
            state: entry?.state,
            github,
            repo,
            branch: data.base,
            bicepRepoPath: baseSelection.bicepPath || ".radius/app.bicep"
          });
        const { dir: headRadArtifactsDir, remote: headRadArtifactsRemote } =
          await radArtifactsDirForSelection({
            isLocal: !!(entry && headSelection.fromWorkspace),
            state: entry?.state,
            github,
            repo,
            branch: data.head,
            bicepRepoPath: headSelection.bicepPath || ".radius/app.bicep"
          });
        const baseResources = canvasGraphResources(
          await buildGraphViaRad(
            baseSelection.content || "",
            baseSelection.bicepPath || ".radius/app.bicep",
            {
              radArtifactsDir: baseRadArtifactsDir,
              cleanupRadArtifactsDir: baseRadArtifactsRemote
            }
          )
        );
        const headResources = canvasGraphResources(
          await buildGraphViaRad(
            headSelection.content || "",
            headSelection.bicepPath || ".radius/app.bicep",
            {
              radArtifactsDir: headRadArtifactsDir,
              cleanupRadArtifactsDir: headRadArtifactsRemote
            }
          )
        );

        // Compute diff using the shared algorithm (see computeGraphDiff).
        const diffResources = computeGraphDiff(baseResources, headResources);

        if (entry && sourceRefContext) {
          if (
            !setSourceRefResources(
              entry,
              "diff",
              diffResources,
              {
                repo,
                baseBranch: data.base,
                headBranch: data.head
              },
              sourceRefContext.token
            )
          ) {
            res.setHeader("Content-Type", "application/json");
            res.writeHead(409);
            res.end(JSON.stringify({ stale: true }));
            return;
          }
          entry.state.diffBaseGenerated = false;
          entry.state.diffHeadGenerated = false;
          entry.state.page = "graphDiff";
          entry.state.activeGraphView = "diff";
          delete entry.state.diffError;
        }

        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            message: `Comparing ${data.base} → ${data.head}`,
            reload: true
          })
        );
      } catch (e) {
        const entry = servers.get(instanceId);
        if (
          entry &&
          isCurrentSourceRefToken(
            entry.state,
            "diff",
            sourceRefContext?.token || ""
          )
        ) {
          entry.state.diffError = errorMessage(e);
        }
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      }
      return;
    }

    if (pathname === "/api/deploy" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const entry = servers.get(instanceId);
        // Store deploy params
        if (entry) {
          entry.state.deployParams = data;
          entry.state.envName = data.environment;
          entry.state.deployProvider = data.provider;
          entry.state.deployingRepo = data.targetRepo;
          entry.state.appFile = data.appFile;

          // Snapshot the planned graph (nodes start as pending). If the
          // planned graph hasn't been resolved yet, it is built on the fly
          // inside the monitor so the deploying page always shows it.
          const cloned: unknown = JSON.parse(
            JSON.stringify(entry.state.plannedResources || [])
          );
          let resources = canvasGraphResources(
            Array.isArray(cloned) ? cloned : []
          );
          resources.forEach((r) => {
            r.deployStatus = "pending";
            if (r.outputResources)
              r.outputResources.forEach((o) => {
                o.deployStatus = "pending";
              });
          });
          entry.state.deployingResources = resources;
          entry.state.deployLogs = [];
          entry.state.deployLogBase = 0;
          entry.state.deployStatus = "in_progress";
          entry.state.deployError = null;
          entry.state.deployErrorKind = null;
          entry.state.deployErrorBranch = null;
          entry.state.deployRunUrl = null;
          entry.state.deployRunId = null;
          // An agent redeploy is already inside a repair loop; a user
          // deploy starts fresh and may hand off again on failure.
          entry.state.deployRepairing = data.agentInitiated === true;
          entry.state.deployHandoffState =
            data.agentInitiated === true ? "delivered" : "idle";
          entry.state.deployHandoffAttempts = 0;

          const repo =
            data.targetRepo ||
            entry.state.plannedRepo ||
            entry.state.contextRepo ||
            "";
          // Resolve the branch to deploy. When the client doesn't specify
          // one, fall back to the repo's real default branch (which may be
          // master/develop, not main) so the dispatch --ref and the
          // "branch not pushed" guard below target a branch that exists.
          let branch = data.branch || "";
          if (!branch) {
            const detectedDefault = (
              (await runCommand("gh", [
                "repo",
                "view",
                repo,
                "--json",
                "defaultBranchRef",
                "--jq",
                ".defaultBranchRef.name"
              ]).catch(() => "")) || ""
            ).trim();
            branch = detectedDefault || "main";
          }
          entry.state.deployingBranch = branch;
          const provider = data.provider || "azure";
          // Immutable identity for this attempt. A canvas panel is reused
          // across deploys, so the repair loop binds to this snapshot
          // instead of the panel: a stale repair cannot redeploy whatever
          // the user started next.
          entry.state.deployAttempt = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            targetRepo: repo,
            environment: entry.state.envName || data.environment || "",
            branch,
            provider,
            appFile: data.appFile || ".radius/app.bicep"
          };
          // Bounded ring buffer: a verbose deploy can stream tens of
          // thousands of recipe/terraform log lines. Keeping them all in
          // memory (and re-serializing the whole array to every 1.5s
          // status poll) grew unbounded and got the extension process
          // OOM-killed mid-deploy. Cap the buffer and track how many
          // lines were dropped so the client can still page through new
          // lines by absolute offset.
          const DEPLOY_LOG_CAP = 4000;
          const addLog = (msg: string): void => {
            const dl = entry.state.deployLogs || [];
            entry.state.deployLogs = dl;
            dl.push(msg);
            if (dl.length > DEPLOY_LOG_CAP) {
              const drop = dl.length - DEPLOY_LOG_CAP;
              dl.splice(0, drop);
              entry.state.deployLogBase =
                (entry.state.deployLogBase || 0) + drop;
            }
          };
          const setStatus = (
            r: CanvasGraphResource,
            s: "pending" | "in_progress" | "success" | "failed"
          ): void => {
            r.deployStatus = s;
            if (r.outputResources)
              r.outputResources.forEach((o) => {
                o.deployStatus = s;
                if (s === "success") {
                  const portalUrlKey = optionalString(
                    provider === "azure" ?
                      o.id || o.type || o.displayType || ""
                    : o.type || o.displayType || o.id || ""
                  );
                  o.portalUrl = generatePortalUrl(
                    portalUrlKey,
                    provider,
                    entry.state
                  );
                }
              });
          };

          // Monitor BOTH workflows in sequence: first verify-credentials,
          // then the deploy workflow. Do NOT dispatch — they were already
          // triggered from the environment page.
          (async () => {
            const delay = (ms: number) =>
              new Promise<void>((resolve) => setTimeout(resolve, ms));

            if (!repo) {
              addLog("❌ No target repository specified.");
              entry.state.deployError =
                "No target repository was specified for the deployment.";
              entry.state.deployStatus = "failed";
              return;
            }

            // Build the planned graph if it wasn't resolved beforehand.
            if (resources.length === 0) {
              addLog("Resolving planned application graph for " + repo + "...");
              const sourceRefContext = prepareSourceRefResources(
                entry,
                "planned",
                { repo, branch }
              );
              try {
                const selection = await fetchBicepSelection(
                  entry,
                  repo,
                  branch
                );
                const content = selection.content;
                if (content) {
                  const { dir: radArtifactsDir, remote: radArtifactsRemote } =
                    await radArtifactsDirForSelection({
                      isLocal: !!(entry && selection.fromWorkspace),
                      state: entry?.state,
                      github,
                      repo,
                      branch,
                      bicepRepoPath: selection.bicepPath || ".radius/app.bicep",
                      log: addLog
                    });
                  const parsed = canvasGraphResources(
                    await buildGraphViaRad(
                      content,
                      selection.bicepPath || ".radius/app.bicep",
                      {
                        log: addLog,
                        radArtifactsDir,
                        cleanupRadArtifactsDir: radArtifactsRemote
                      }
                    )
                  );
                  const recipes = await fetchRecipePack(github, provider);
                  const planned = canvasGraphResources(
                    await resolveRecipeOutputs(
                      github,
                      parsed,
                      recipes,
                      provider
                    )
                  );
                  planned.forEach((r) => {
                    r.deployStatus = "pending";
                    if (r.outputResources)
                      r.outputResources.forEach((o) => {
                        o.deployStatus = "pending";
                      });
                  });
                  const committed = setSourceRefResources(
                    entry,
                    "planned",
                    planned,
                    {
                      repo,
                      branch
                    },
                    sourceRefContext.token
                  );
                  if (committed) entry.state.plannedRepo = repo;
                  resources = planned;
                  entry.state.deployingResources = resources;
                  addLog("Planned " + planned.length + " resource(s).");
                } else {
                  addLog(
                    "⚠ .radius/app.bicep not present — Copilot will generate it with the Radius app-bicep skill to show the planned graph."
                  );
                }
              } catch (e) {
                addLog("⚠ Could not resolve planned graph: " + errorMessage(e));
              }
            }

            // ── Phase 1: Dispatch the run-rad-commands workflow ─────
            // Credentials are verified separately when the environment
            // is created, so deploying is now an explicit action: we
            // dispatch the unified run-rad-commands workflow here (the
            // "Repo Radius" entry point that runs `rad deploy` by
            // default) rather than relying on a verify → deploy chain.
            addLog("━━ Deploying Radius application ━━");
            const envForDeploy =
              entry.state.envName || data.environment || "dev";
            // Persist the resolved environment so the deployed-graph
            // reader (GHCR artifact tag) can be rebuilt from state later.
            entry.state.deployEnvName = envForDeploy;
            const deployWorkflowFile = DEPLOY_WORKFLOW_FILE;
            // Deploy the SELECTED branch's code (worktree-consistent): run
            // the workflow on `branch` so it checks out and `rad deploy`s
            // that branch's app.bicep — the same file the params below are
            // computed from — instead of always deploying the default branch.
            // `branch` is already resolved to the selected branch or the
            // repo's real default above, so it's never empty here.
            const deployRef = branch;

            // Fail fast (with clear, actionable guidance) when the
            // selected branch hasn't been pushed to the remote yet. A
            // worktree/feature branch that only exists locally has no
            // ref on GitHub, so both publishing the workflow files and
            // dispatching the run against `--ref <branch>` are doomed.
            // We confirm the repo itself is reachable (its default
            // branch resolves) before blaming the branch, so a
            // transient/auth error isn't misreported as "not pushed".
            if (deployRef) {
              const refSha = await getBranchHeadSha(repo, deployRef);
              if (!refSha) {
                const repoDefault = await getDefaultBranch(repo);
                if (repoDefault) {
                  const pushCmd = "git push -u origin " + deployRef;
                  addLog(
                    '❌ Branch "' +
                      deployRef +
                      '" has not been pushed to ' +
                      repo +
                      "."
                  );
                  addLog("   Push it and redeploy:  " + pushCmd);
                  entry.state.deployError =
                    'The branch "' +
                    deployRef +
                    "\" hasn't been pushed to " +
                    repo +
                    " yet, so there's nothing on GitHub to deploy. Push it and try again:\n\n    " +
                    pushCmd;
                  entry.state.deployErrorKind = "branch-not-pushed";
                  entry.state.deployErrorBranch = deployRef;
                  entry.state.deployStatus = "failed";
                  return;
                }
              }
            }
            const runGhDeploy = (
              args: string[],
              envOverride?: NodeJS.ProcessEnv
            ): Promise<CommandResult> =>
              new Promise<CommandResult>((resolve) => {
                cliExec(
                  "gh",
                  args,
                  {
                    timeout: 30000,
                    ...(envOverride ? { env: envOverride } : {})
                  },
                  (err, stdout, stderr) => {
                    resolve({
                      code: err ? err.code || 1 : 0,
                      stdout: stdout || "",
                      stderr: stderr || ""
                    });
                  }
                );
              });
            // Like runGhDeploy but feeds a value (e.g. a secret JSON) over
            // stdin so it never lands on the argv/process list.
            const runGhDeployStdin = (
              args: string[],
              stdin: string,
              envOverride?: NodeJS.ProcessEnv
            ): Promise<CommandResult> =>
              new Promise((resolve) => {
                const child = cliExec(
                  "gh",
                  args,
                  {
                    timeout: 30000,
                    ...(envOverride ? { env: envOverride } : {})
                  },
                  (err, stdout, stderr) => {
                    resolve({
                      code: err ? err.code || 1 : 0,
                      stdout: stdout || "",
                      stderr: stderr || ""
                    });
                  }
                );
                if (stdin !== undefined) child.stdin?.end(stdin);
              });
            const dispatchArgs = [
              "workflow",
              "run",
              deployWorkflowFile,
              "--ref",
              deployRef,
              "-f",
              "environment=" + envForDeploy,
              "--repo",
              repo
            ];

            // Recompute the rad commands from the CURRENT app.bicep at
            // dispatch time (rather than relying on the RADIUS_RAD_COMMANDS
            // variable captured when the environment was created) so the
            // deploy always reflects the latest bicep. Also append
            // `rad app graph` so the deployed application graph is rendered
            // as part of the run. Secret params are still appended by the
            // workflow from the RADIUS_DEPLOY_PARAMS secret.
            //
            // A fatal secret-provisioning problem (the deployed bicep needs a
            // secret param the environment can't be made to carry) is recorded
            // here and short-circuits the dispatch below, so we never start a
            // run that is guaranteed to fail `rad deploy` for a missing
            // required parameter.
            let deploySecretError = null;
            try {
              let bicepPath = ".radius/app.bicep";
              let bicepSource = await fetchFileForSelection(
                entry,
                repo,
                branch,
                ".radius/app.bicep"
              );
              if (!bicepSource) {
                bicepSource = await fetchFileForSelection(
                  entry,
                  repo,
                  branch,
                  "app.bicep"
                );
                if (bicepSource) bicepPath = "app.bicep";
              }
              if (bicepSource) {
                const parsed = appParams(bicepSource);
                const resolved = resolveDeployParams(parsed);
                const { public: publicParams, secret: secretParams } =
                  partitionParams(parsed, resolved);
                // Capture the app name (as the producer extracts it) so
                // the deployed-graph reader can derive the GHCR artifact
                // tag "<environment>-<app>-latest".
                entry.state.deployAppName = appNameForGraphTag(bicepSource);
                // Ensure the environment carries the secret params the
                // deployed app.bicep needs (e.g. an @secure() password).
                // The workflow can ONLY read these from the
                // RADIUS_DEPLOY_PARAMS secret — unlike the public rad
                // commands, they can't be passed inline as a dispatch input
                // — so if the secret is absent the deploy fails for a
                // missing required parameter. Env creation seeds it, but
                // that step is skipped when app.bicep isn't present yet, so
                // reconcile here: provision the secret from the SAME branch
                // bicep when the environment has none. If one already
                // exists, leave it untouched so an auto-generated value
                // stays stable across redeploys (we can't read it back to
                // compare).
                if (Object.keys(secretParams).length > 0) {
                  const deployParamsPresent = async () => {
                    const r = await runGhDeploy([
                      "api",
                      `/repos/${repo}/environments/${encodeURIComponent(envForDeploy)}/secrets`,
                      "--jq",
                      ".secrets[].name"
                    ]);
                    return (r.stdout || "")
                      .split("\n")
                      .map((s) => s.trim())
                      .includes("RADIUS_DEPLOY_PARAMS");
                  };
                  if (!(await deployParamsPresent())) {
                    addLog(
                      'Provisioning RADIUS_DEPLOY_PARAMS for "' +
                        envForDeploy +
                        '" (' +
                        Object.keys(secretParams).join(", ") +
                        ")..."
                    );
                    const setArgs = [
                      "secret",
                      "set",
                      "RADIUS_DEPLOY_PARAMS",
                      "--env",
                      envForDeploy,
                      "--repo",
                      repo
                    ];
                    let setRes = await runGhDeployStdin(
                      setArgs,
                      JSON.stringify(secretParams)
                    );
                    if (
                      setRes.code !== 0 &&
                      (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
                    ) {
                      // The injected OAuth token may lack the scope to
                      // write environment secrets; retry with it
                      // stripped so gh falls back to the keyring cred.
                      const fe = { ...process.env };
                      delete fe.GH_TOKEN;
                      delete fe.GITHUB_TOKEN;
                      const retry = await runGhDeployStdin(
                        setArgs,
                        JSON.stringify(secretParams),
                        fe
                      );
                      if (retry.code === 0) setRes = retry;
                    }
                    if (setRes.code !== 0) {
                      deploySecretError =
                        'Could not provision RADIUS_DEPLOY_PARAMS on environment "' +
                        envForDeploy +
                        '": ' +
                        ((setRes.stderr || "").trim() || "unknown error") +
                        ". The deploy would fail for a missing required parameter (" +
                        Object.keys(secretParams).join(", ") +
                        "), so it was not started.";
                      addLog("❌ " + deploySecretError);
                    } else if (!(await deployParamsPresent())) {
                      deploySecretError =
                        'RADIUS_DEPLOY_PARAMS was accepted but is not present on environment "' +
                        envForDeploy +
                        '". The deploy would fail for a missing required parameter (' +
                        Object.keys(secretParams).join(", ") +
                        "), so it was not started.";
                      addLog("❌ " + deploySecretError);
                    } else {
                      addLog(
                        '✅ RADIUS_DEPLOY_PARAMS is set on "' +
                          envForDeploy +
                          '".'
                      );
                    }
                  }
                }

                const deployCmd = buildDeployRadCommand(
                  bicepPath,
                  envForDeploy,
                  publicParams
                );
                const appName = extractAppName(bicepSource);
                const commands = [deployCmd];
                if (appName) commands.push(buildAppGraphRadCommand(appName));
                const radCommandsInput = JSON.stringify(commands);
                dispatchArgs.push("-f", "rad_commands=" + radCommandsInput);
                addLog(
                  "Deploying with rad commands: " + commands.join("  |  ")
                );
              } else {
                addLog(
                  "⚠ Could not read app.bicep at dispatch; falling back to the environment's RADIUS_RAD_COMMANDS / default deploy."
                );
              }
            } catch (e) {
              addLog(
                "⚠ Could not compute rad commands from bicep (" +
                  errorMessage(e) +
                  "); falling back to the environment default."
              );
            }
            // Fail fast: a required secret param couldn't be provisioned, so
            // starting the run would only produce a guaranteed `rad deploy`
            // failure. Surface the reason and stop before dispatching.
            if (deploySecretError) {
              entry.state.deployError = deploySecretError;
              entry.state.deployStatus = "failed";
              return;
            }
            // Make sure the workflow files exist on the branch we're
            // about to dispatch on. The env-creation flow only commits
            // them to the default branch, so a feature/worktree branch
            // usually needs them published first.
            try {
              await ensureDeployWorkflowsOnBranch(
                repo,
                deployRef,
                envForDeploy,
                addLog
              );
            } catch (e) {
              addLog(
                '⚠ Could not publish deploy workflows to branch "' +
                  deployRef +
                  '": ' +
                  errorMessage(e) +
                  ". The dispatch below will fail if the branch has no run-rad-commands workflow."
              );
            }

            // With the deploy workflows present, ensure they're in sync
            // with the upstream Radius templates before running them, so
            // the deploy never executes a drifted copy. Syncs the deploy
            // files on both the default branch and the branch being
            // deployed (deployRef), which a --ref dispatch checks out.
            await ensureWorkflowsCurrent(
              repo,
              envForDeploy,
              provider,
              [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE],
              deployRef
            );

            const deployDispatchedAt = Date.now();
            addLog(
              "🚀 Dispatching run rad commands workflow (" +
                deployWorkflowFile +
                ') on branch "' +
                deployRef +
                '" for environment "' +
                envForDeploy +
                '"...'
            );
            let dispatchDeployRes = await runGhDeploy(dispatchArgs);
            if (
              dispatchDeployRes.code !== 0 &&
              (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)
            ) {
              // The injected OAuth token may lack the `workflow` scope; retry
              // with it stripped so gh falls back to the keyring credential.
              const fallbackEnv = { ...process.env };
              delete fallbackEnv.GH_TOKEN;
              delete fallbackEnv.GITHUB_TOKEN;
              const retry = await runGhDeploy(dispatchArgs, fallbackEnv);
              if (retry.code === 0) dispatchDeployRes = retry;
            }
            if (dispatchDeployRes.code !== 0) {
              const de = (dispatchDeployRes.stderr || "").trim();
              addLog(
                "❌ Failed to dispatch the run rad commands workflow: " + de
              );
              // A "No ref found" (or unresolved ref) dispatch error
              // means the branch isn't on the remote — surface the same
              // clean, actionable "push the branch" guidance/UI.
              if (
                /no ref found|could not resolve|no commit found for the ref/i.test(
                  de
                )
              ) {
                const pushCmd = "git push -u origin " + deployRef;
                addLog("   Push it and redeploy:  " + pushCmd);
                entry.state.deployError =
                  'The branch "' +
                  deployRef +
                  "\" hasn't been pushed to " +
                  repo +
                  " yet, so there's nothing on GitHub to deploy. Push it and try again:\n\n    " +
                  pushCmd;
                entry.state.deployErrorKind = "branch-not-pushed";
                entry.state.deployErrorBranch = deployRef;
                entry.state.deployStatus = "failed";
                return;
              }
              const scopeHint =
                /workflow.{0,20}scope/i.test(de) ?
                  ' Your GitHub token is missing the "workflow" scope. Run `gh auth refresh -h github.com -s workflow` in a terminal, then retry.'
                : " Ensure " +
                  deployWorkflowFile +
                  ' exists on branch "' +
                  deployRef +
                  '" (push the branch so it carries the app.bicep and workflow files) and that GitHub Actions are enabled for ' +
                  repo +
                  ".";
              entry.state.deployError =
                "Failed to start the run rad commands workflow (" +
                deployWorkflowFile +
                ") on " +
                repo +
                ". " +
                (de || "The dispatch request failed.") +
                scopeHint;
              entry.state.deployStatus = "failed";
              return;
            }
            addLog("✅ Run rad commands workflow dispatched.");
            // A new deploy is in flight, so any cached deployments
            // listing is stale — drop it so the deploy page reflects the
            // new run on the next poll.
            deployListCache.delete(repo);

            // ── Phase 2: Monitor the deploy run ─────────────────────
            addLog("Waiting for the deploy workflow to start...");
            let dRunId = null;
            for (let attempt = 0; attempt < 24 && !dRunId; attempt++) {
              dRunId = await findWorkflowRun(
                repo,
                deployWorkflowFile,
                deployDispatchedAt,
                null
              );
              if (!dRunId) await delay(5000);
            }
            if (!dRunId) {
              addLog("⚠ No deploy run found for " + deployWorkflowFile + ".");
              entry.state.deployError =
                "The run rad commands workflow (" +
                deployWorkflowFile +
                ") did not start. Check that the workflow exists on the default branch and that Actions are enabled for " +
                repo +
                ".";
              entry.state.deployStatus = "failed";
              return;
            }
            entry.state.deployRunId = dRunId;
            entry.state.deployRunUrl =
              "https://github.com/" + repo + "/actions/runs/" + dRunId;
            addLog(
              "Tracking deploy run: https://github.com/" +
                repo +
                "/actions/runs/" +
                dRunId
            );
            if (resources.length > 0 && resources[0].deployStatus === "pending")
              setStatus(resources[0], "in_progress");

            const seenD = new Set<string>();
            const startedD = new Set<string>();
            let deployStepStartedAt = 0;
            let beatStep = "";
            let beatStepStartedAt = 0;
            let lastBeatAt = 0;
            // Live `rad deploy` progress (published by the workflow to the
            // radius-deploy-status branch). We track how many raw lines we've
            // already surfaced so we only append new ones.
            let liveLogShown = 0;
            let deployStarted = false;
            // Track which activity-log status changes we've already
            // streamed so we only announce new transitions.
            const activitySeen = new Set<string>();
            // Track how many control-plane / recipe log lines we've surfaced.
            let cpLogShown = 0;
            let cpLogTail = "";
            const DEPLOY_STEP = "Deploy Application";

            // Poll the Azure activity log the workflow publishes and
            // drive FINE-GRAINED per-resource (output) status, coloring
            // each planned graph node individually as Azure creates it.
            const pollActivity = async () => {
              if (provider !== "azure" || resources.length === 0) return;
              const actText = await fetchLiveActivityLog(repo);
              if (!actText) return;
              const entries = reduceActivityLog(actText);
              if (entries.length === 0) return;
              const changes = applyActivityToResources(
                entries,
                resources,
                provider,
                entry.state
              );
              for (const c of changes) {
                if (!activitySeen.has(c)) {
                  activitySeen.add(c);
                  addLog("    ☁ " + c);
                }
              }
            };

            // Stream the Radius control-plane / recipe log (terraform/bicep
            // execution from the radius-system pods). Real-time and carries
            // the precise recipe failure cause. We append only new lines.
            const pollControlPlane = async () => {
              const cpText = await fetchLiveControlPlaneLog(repo);
              if (!cpText) return;
              cpLogTail = cpText;
              const lines = cpText.split(/\r?\n/);
              for (let i = cpLogShown; i < lines.length; i++) {
                const t = lines[i].replace(/\s+$/, "");
                if (t) addLog("    ⚙ " + t);
              }
              cpLogShown = lines.length;
            };

            // Advance per-resource status from any live log text so the
            // graph shows gray→yellow→green/red per node. rad deploy in CI
            // (non-TTY) prints no intermediate per-resource lines, so the
            // control-plane/recipe log + activity log are the real signals.
            const applyProgress = (text: string): void => {
              if (!text) return;
              const prog = parseResourceProgress(text, resources);
              for (const r of resources) {
                if (!r.name) continue;
                const s = prog[r.name];
                if (!s) continue;
                const cur = r.deployStatus;
                // Mid-deployment a node is NEVER painted red: a transient
                // "error"/"failed"/"postponed" line in the live log does not
                // mean the deployment failed. Such resources stay yellow
                // (in_progress). Only the TERMINAL run conclusion (below)
                // decides red vs green, so nodes go red solely on an actual
                // failed deployment.
                if (s === "success" && cur !== "success" && cur !== "failed") {
                  setStatus(r, "success");
                  addLog("  ✓ " + r.name + " deployed");
                } else if (
                  (s === "in_progress" || s === "failed") &&
                  (cur === "pending" || !cur)
                ) {
                  setStatus(r, "in_progress");
                  addLog("  ◐ " + r.name + " provisioning…");
                }
              }
            };

            for (let p = 0; p < 240; p++) {
              const detail = await getRunDetail(repo, dRunId);
              if (!detail) {
                await delay(5000);
                continue;
              }

              // Stream step lifecycle: announce when a step STARTS
              // (in_progress) and again when it COMPLETES so the feed
              // never goes silent during long-running steps.
              for (const s of detail.steps) {
                const stepName = s.name || "";
                if (s.status === "in_progress" && !startedD.has(stepName)) {
                  startedD.add(stepName);
                  addLog("  ▶ " + stepName + "…");
                }
                if (s.status === "completed" && !seenD.has(stepName)) {
                  seenD.add(stepName);
                  addLog(
                    "  " +
                      (s.conclusion === "success" ? "✓"
                      : s.conclusion ? "✗"
                      : "•") +
                      " " +
                      stepName
                  );
                }
              }

              // Heartbeat: emit a "still running" line every ~30s for the
              // currently-executing step so the user sees continuous activity
              // even when GitHub provides no intra-step log lines (gh cannot
              // stream a running job's stdout).
              const running = detail.steps.find(
                (s) => s.status === "in_progress"
              );
              if (running) {
                const runningName = running.name || "";
                if (beatStep !== runningName) {
                  beatStep = runningName;
                  beatStepStartedAt = Date.now();
                  lastBeatAt = Date.now();
                } else if (Date.now() - lastBeatAt > 30000) {
                  lastBeatAt = Date.now();
                  addLog(
                    "    … " +
                      runningName +
                      " still running (" +
                      Math.round((Date.now() - beatStepStartedAt) / 1000) +
                      "s)"
                  );
                }
              }

              // While `rad deploy` runs, consume the live progress log
              // the workflow publishes and drive REAL per-resource state.
              const deployStep = detail.steps.find(
                (s) => s.name === DEPLOY_STEP
              );
              if (
                deployStep &&
                deployStep.status === "in_progress" &&
                resources.length > 0
              ) {
                if (!deployStarted) {
                  deployStarted = true;
                  deployStepStartedAt = Date.now();
                  entry.state.deployStartedAt = deployStepStartedAt;
                  addLog("🚀 rad deploy running — provisioning resources...");
                  addLog(
                    "  ⏱ Deployment started at " +
                      new Date(deployStepStartedAt).toISOString()
                  );
                  // Leave nodes gray; each flips to yellow when its own
                  // recipe/operation actually starts (see applyProgress).
                }
                const live = await fetchLiveDeployLog(repo);
                if (live) {
                  // Append any new raw rad-deploy output lines to the feed.
                  const lines = live.split(/\r?\n/);
                  for (let i = liveLogShown; i < lines.length; i++) {
                    const t = lines[i].replace(/\s+$/, "");
                    if (t) addLog("    │ " + t);
                  }
                  liveLogShown = lines.length;
                  // Flip resources to their real status as the log reports them.
                  applyProgress(live);
                }
                // Fine-grained Azure activity-log status per resource.
                await pollActivity();
                // Real-time control-plane / recipe (terraform) output.
                await pollControlPlane();
                // Drive per-node coloring from the control-plane/recipe log.
                applyProgress(cpLogTail);
                // Fallback: if nothing has advanced past pending ~25s into
                // the deploy (no parseable per-resource signal), mark all
                // pending nodes in_progress so the graph isn't stuck gray.
                if (
                  Date.now() - deployStepStartedAt > 25000 &&
                  !resources.some(
                    (r) => r.deployStatus && r.deployStatus !== "pending"
                  )
                ) {
                  resources.forEach((r) => {
                    if (!r.deployStatus || r.deployStatus === "pending")
                      setStatus(r, "in_progress");
                  });
                }
              }

              if (detail.status === "completed") {
                const conclusion = detail.conclusion;
                // Final fine-grained activity sweep before settling.
                await pollActivity();
                await pollControlPlane();

                // ── Finalize logs without cutting off ───────────
                // The workflow writes the terminal deploy-state marker
                // (succeeded/failed) LAST — only after the complete log
                // and the deployed graph have been pushed to the status
                // branch. Keep fetching the live log until the state is
                // terminal AND its length stops growing, so we never drop
                // the final rad-deploy output (e.g. the summary table).
                let parsed;
                let live = null;
                let prevLen = -1;
                let stableHits = 0;
                for (let f = 0; f < 12; f++) {
                  const ds = await fetchDeployState(repo);
                  const cur = await fetchLiveDeployLog(repo);
                  if (cur) live = cur;
                  const len = cur ? cur.length : 0;
                  const terminal = ds === "succeeded" || ds === "failed";
                  if (len === prevLen) stableHits++;
                  else stableHits = 0;
                  prevLen = len;
                  // Stream any control-plane lines that arrive late too.
                  await pollControlPlane();
                  if (terminal && (stableHits >= 1 || len === 0)) break;
                  if (!terminal || stableHits < 1) await delay(2500);
                }
                if (live) {
                  const lines = live.split(/\r?\n/);
                  for (let i = liveLogShown; i < lines.length; i++) {
                    const t = lines[i].replace(/\s+$/, "");
                    if (t) addLog("    │ " + t);
                  }
                  parsed = parseRadDeployLog(live, resources, {
                    stripPrefix: false
                  });
                } else {
                  const logText = await fetchRunLog(repo, dRunId);
                  parsed = parseRadDeployLog(logText, resources);
                }

                // Record stop time + duration.
                const finishedAt = Date.now();
                entry.state.deployFinishedAt = finishedAt;
                if (deployStepStartedAt) {
                  const secs = Math.round(
                    (finishedAt - deployStepStartedAt) / 1000
                  );
                  addLog(
                    "  ⏱ Deployment finished at " +
                      new Date(finishedAt).toISOString() +
                      " (" +
                      secs +
                      "s)"
                  );
                }

                if (conclusion === "success") {
                  // Overall success ⇒ every resource provisioned. Force all
                  // nodes green; a transient "failed" token in the live log
                  // must never leave a node red on a successful deployment.
                  resources.forEach((r) => setStatus(r, "success"));
                  // Fetch + store the REAL deployed application graph the
                  // deploy published to GHCR (radius-project/radius PR
                  // #12591), falling back to the legacy
                  // radius-deploy-status branch when the artifact is
                  // absent (older producers / git state backend).
                  addLog("🗺  Retrieving deployed application graph…");
                  const graphReader = await deployStatusReaderFromState(
                    entry.state,
                    repo,
                    branch
                  );
                  let deployed = null;
                  let graphSource = "none";
                  let graphStatus = null;
                  for (let g = 0; g < 6 && !deployed; g++) {
                    const gr = await graphReader.graph();
                    graphStatus = gr.status;
                    if (gr.graph) {
                      deployed = gr.graph;
                      graphSource = gr.source;
                      break;
                    }
                    // Permission failures won't resolve by retrying.
                    if (gr.status === "auth") break;
                    await delay(2500);
                  }
                  if (deployed) {
                    entry.state.deployedGraph = deployed;
                    entry.state.deployedGraphRepo = repo;
                    addLog(
                      graphSource === "ghcr" ?
                        "  ✓ Deployed graph saved (from GHCR artifact " +
                          graphReader.tag +
                          ")."
                      : "  ✓ Deployed graph saved (from radius-deploy-status branch)."
                    );
                  } else if (graphStatus === "auth") {
                    addLog(
                      "  ⚠ Deployed graph is published to a private GHCR package but access was denied."
                    );
                    addLog(
                      "    Grant read access: gh auth refresh -s read:packages"
                    );
                  } else if (graphStatus === "malformed") {
                    addLog(
                      "  ⚠ Deployed graph artifact was found but could not be parsed (malformed). Continuing."
                    );
                  } else {
                    addLog(
                      "  ⚠ Deployed graph not available yet (continuing)."
                    );
                  }
                  entry.state.deployStatus = "complete";
                  addLog("");
                  addLog(
                    "🎉 Deployment complete! Application deployed to " +
                      (provider === "aws" ? "AWS" : "Azure") +
                      "."
                  );
                  addLog(
                    "Click on deployed resources to view them in the " +
                      (provider === "aws" ? "AWS Console" : "Azure Portal") +
                      "."
                  );
                } else {
                  resources.forEach((r) => {
                    const resourceName = r.name || "";
                    if (parsed[resourceName] === "success")
                      setStatus(r, "success");
                    else if (
                      parsed[resourceName] === "failed" ||
                      r.deployStatus === "pending" ||
                      r.deployStatus === "in_progress"
                    )
                      setStatus(r, "failed");
                  });
                  entry.state.deployStatus = "failed";
                  addLog("");
                  addLog("❌ Deployment failed. Conclusion: " + conclusion);
                  // Build a user-facing error from the failed step(s) + log.
                  const failedSteps = detail.steps.filter(
                    (s) =>
                      s.conclusion &&
                      s.conclusion !== "success" &&
                      s.conclusion !== "skipped"
                  );
                  let dErr =
                    "Deployment failed" +
                    (conclusion ? " (" + conclusion + ")" : "") +
                    ".";
                  if (failedSteps.length)
                    dErr +=
                      " Failed step: " +
                      failedSteps.map((s) => s.name).join(", ") +
                      ".";
                  // Surface the FULL detailed rad deploy failure block (root cause:
                  // recipe/terraform/ARM operation errors). Prefer the live raw rad
                  // output; fall back to the full run log.
                  let failLog = live;
                  if (!failLog) failLog = await fetchRunLog(repo, dRunId);
                  // The OIDC "enterprise claim" rejection (AADSTS7002381) happens at the Azure Login
                  // step, BEFORE rad runs — so it appears in the run log, not the live rad-deploy log.
                  // A stale live-deploy log from a prior attempt (persisted on the status branch) could
                  // otherwise mask it, so always consult the current run log for THIS run for the claim.
                  const runLogForClaim =
                    live ? await fetchRunLog(repo, dRunId) : failLog;
                  const claimHelp = explainOidcEnterpriseClaim(runLogForClaim);
                  if (claimHelp)
                    dErr = claimHelp + "\n\n\u2014 raw error \u2014\n" + dErr;
                  const detailBlock = extractRadDeployError(failLog);
                  if (detailBlock) {
                    dErr += "\n\n" + detailBlock;
                    addLog("");
                    addLog("──────── failure details ────────");
                    detailBlock.split("\n").forEach((l) => addLog("  " + l));
                    addLog("─────────────────────────────────");
                  }
                  // The exact recipe (terraform/bicep) error is emitted by the
                  // Radius control plane. Surface its tail if we captured it.
                  if (cpLogTail) {
                    const cpLines = cpLogTail
                      .split(/\r?\n/)
                      .filter((l) => l.trim());
                    const cpErr = cpLines
                      .filter((l) =>
                        /error|failed|terraform|tofu|recipe/i.test(l)
                      )
                      .slice(-25);
                    const cpShow = cpErr.length ? cpErr : cpLines.slice(-25);
                    if (cpShow.length) {
                      dErr +=
                        "\n\n──── control-plane / recipe log ────\n" +
                        cpShow.join("\n");
                      addLog("");
                      addLog("──────── control-plane / recipe log ────────");
                      cpShow.forEach((l) => addLog("  " + l));
                      addLog("─────────────────────────────────────────");
                    }
                  }
                  dErr +=
                    "\n\nView the full run: https://github.com/" +
                    repo +
                    "/actions/runs/" +
                    dRunId;
                  entry.state.deployError = dErr;
                }
                return;
              }
              await delay(5000);
            }
            addLog("⚠ Timed out waiting for the deploy workflow to complete.");
            entry.state.deployError =
              "Timed out waiting for the deploy workflow to complete. It may still be running — view it at https://github.com/" +
              repo +
              "/actions/runs/" +
              dRunId;
            entry.state.deployStatus = "failed";
          })().catch((monErr) => {
            // Never let the background monitor die silently (which would
            // leave the page stuck polling an 'in_progress' that never
            // resolves). Surface the error and settle the status.
            try {
              addLog(
                "❌ Deploy monitor stopped unexpectedly: " +
                  (monErr && monErr.message ? monErr.message : monErr)
              );
              if (!entry.state.deployError)
                entry.state.deployError =
                  "Deploy monitoring stopped unexpectedly: " +
                  (monErr && monErr.message ? monErr.message : monErr);
              entry.state.deployStatus = "failed";
            } catch {
              /* ignore */
            }
          });
        }
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(400);
        res.end(JSON.stringify({ error: errorMessage(e) }));
      }
      return;
    }

    if (pathname === "/api/deploy-reset" && req.method === "POST") {
      const entry = servers.get(instanceId);
      if (entry) {
        delete entry.state.deployResult;
      }
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/api/discover" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const data = JSON.parse(body);
        const result: DiscoveryResult = {
          clusters: [],
          resourceGroups: [],
          namespaces: [],
          vpcs: [],
          subnets: []
        };

        // Reject a non-GUID subscriptionId before it reaches the az argv.
        // On Windows cliExec routes az through `cmd.exe /c` and libuv only
        // quotes args with whitespace, so "x&calc" would be split by cmd.exe
        // as a command separator. Empty is allowed (ambient CLI context).
        if (
          data.subscriptionId &&
          !isUuid(String(data.subscriptionId).trim())
        ) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.end(
            JSON.stringify({
              error: `Invalid subscriptionId "${data.subscriptionId}" (expected a GUID).`,
              clusters: [],
              resourceGroups: [],
              namespaces: ["default"],
              vpcs: [],
              subnets: []
            })
          );
          return;
        }

        if (data.provider === "azure") {
          // Set tenant/subscription context before querying
          if (data.subscriptionId) {
            try {
              await runCommand(
                "az",
                ["account", "set", "--subscription", data.subscriptionId],
                { timeout: 10000 }
              );
            } catch (e) {}
          }
          const subArgs =
            data.subscriptionId ? ["--subscription", data.subscriptionId] : [];
          try {
            const aksJson = await runCommand(
              "az",
              [
                "aks",
                "list",
                "--query",
                "[].{id:name, name:name, resourceGroup:resourceGroup}",
                "-o",
                "json",
                ...subArgs
              ],
              { timeout: 30000 }
            );
            result.clusters = discoveryItems(JSON.parse(aksJson));
          } catch (e) {
            result.clusters = [];
            result.errors = result.errors || {};
            result.errors.clusters = errorMessage(e).slice(0, 800);
          }
          try {
            const rgJson = await runCommand(
              "az",
              [
                "group",
                "list",
                "--query",
                "[].{id:name, name:name}",
                "-o",
                "json",
                ...subArgs
              ],
              { timeout: 30000 }
            );
            result.resourceGroups = discoveryItems(JSON.parse(rgJson));
          } catch (e) {
            result.resourceGroups = [];
            result.errors = result.errors || {};
            result.errors.resourceGroups = errorMessage(e).slice(0, 800);
          }
          // If we got a cluster, try to get namespaces from it
          if (result.clusters.length > 0) {
            try {
              const rg =
                result.resourceGroups.length > 0 ?
                  result.resourceGroups[0].id
                : "";
              const clusterName = result.clusters[0].id;
              if (rg && clusterName) {
                await runCommand(
                  "az",
                  [
                    "aks",
                    "get-credentials",
                    "--name",
                    clusterName,
                    "--resource-group",
                    rg,
                    "--overwrite-existing"
                  ],
                  { timeout: 20000 }
                );
                const nsJson = await runCommand(
                  "kubectl",
                  [
                    "get",
                    "namespaces",
                    "-o",
                    "jsonpath={.items[*].metadata.name}"
                  ],
                  { timeout: 10000 }
                );
                result.namespaces = nsJson
                  .replace(/"/g, "")
                  .split(" ")
                  .filter(Boolean);
              } else {
                result.namespaces = ["default", "kube-system", "radius-system"];
              }
            } catch (e) {
              result.namespaces = ["default", "kube-system", "radius-system"];
            }
          } else {
            result.namespaces = ["default", "kube-system", "radius-system"];
          }
        } else {
          try {
            const eksJson = await runCommand(
              "aws",
              [
                "eks",
                "list-clusters",
                "--query",
                "clusters",
                "--output",
                "json"
              ],
              { timeout: 15000 }
            );
            const clusterNames: unknown = JSON.parse(eksJson);
            result.clusters =
              Array.isArray(clusterNames) ?
                clusterNames
                  .filter((name): name is string => typeof name === "string")
                  .map((name) => ({ id: name, name }))
              : [];
          } catch (e) {
            result.clusters = [];
            result.errors = result.errors || {};
            result.errors.clusters = errorMessage(e).slice(0, 800);
          }
          try {
            const vpcJson = await runCommand(
              "aws",
              [
                "ec2",
                "describe-vpcs",
                "--query",
                "Vpcs[].{id:VpcId, name:VpcId}",
                "--output",
                "json"
              ],
              { timeout: 15000 }
            );
            result.vpcs = discoveryItems(JSON.parse(vpcJson));
          } catch (e) {
            result.vpcs = [];
            result.errors = result.errors || {};
            result.errors.vpcs = errorMessage(e).slice(0, 800);
          }
          try {
            const subnetJson = await runCommand(
              "aws",
              [
                "ec2",
                "describe-subnets",
                "--query",
                "Subnets[].{id:SubnetId, name:SubnetId}",
                "--output",
                "json"
              ],
              { timeout: 15000 }
            );
            result.subnets = discoveryItems(JSON.parse(subnetJson));
          } catch (e) {
            result.subnets = [];
            result.errors = result.errors || {};
            result.errors.subnets = errorMessage(e).slice(0, 800);
          }
          result.namespaces = ["default", "kube-system", "radius-system"];
        }

        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch (e) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(
          JSON.stringify({
            error: errorMessage(e),
            clusters: [],
            resourceGroups: [],
            namespaces: ["default"],
            vpcs: [],
            subnets: []
          })
        );
      }
      return;
    }

    // Default: serve the page HTML based on state
    await ensureVendorScripts();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const entry = servers.get(instanceId);
    let page = requestedPage || entry?.page || DEFAULT_CANVAS_PAGE;
    const state = entry?.state || {};
    // While a deployment is actively in progress, an IMPLICIT landing on the
    // environment / credentials page (a bare "/" load with no ?page=, e.g. a
    // panel re-open or a heartbeat reload that lost the query) is redirected
    // to the live deploying page so the user lands on the in-flight run. An
    // EXPLICIT navigation — a top-nav "Environments" click or any URL that
    // carries ?page= — is always honored, so the user can freely leave the
    // deploying view while a deploy is still being monitored.
    if (
      !requestedPage &&
      (page === "environment" || page === "credentials") &&
      state.deployStatus === "in_progress"
    ) {
      page = "deploying";
    }
    const renderer = isCanvasPage(page) ? PAGE_RENDERERS[page] : undefined;
    // Tell the Environments renderer which subtab to activate (Environments vs
    // Credentials) so a direct ?page=credentials load lands on that subtab.
    if (page === "credentials" || page === "environment") {
      state.activeSubtab =
        page === "credentials" ? "credentials" : "environments";
    }
    if (renderer) {
      res.writeHead(200);
      res.end(renderer(state));
    } else {
      res.writeHead(200);
      res.end(environmentPage(state));
    }
  };
}

const PAGE_RENDERERS = {
  credentials: environmentPage,
  graph: graphPage,
  planned: plannedGraphPage,
  "graph-diff": graphDiffPage,
  deployed: deployedGraphPage,
  environment: environmentPage,
  deploying: deployingPage
};

function isCanvasPage(page: string): page is keyof typeof PAGE_RENDERERS {
  return Object.hasOwn(PAGE_RENDERERS, page);
}

async function preferredPortForInstance(instanceId: string): Promise<number> {
  // Namespace the deterministic port by the Copilot session. Every session is
  // told to open the canvas with the same instanceId ("radius-panel"), so
  // hashing instanceId alone makes all concurrent sessions resolve to one
  // global port. Only the first session to bind it wins; the rest fall back to
  // an ephemeral port (listen(0)) while their webviews keep pinging the shared
  // port — which is now owned by a different, independently-churning process.
  // From those webviews' perspective the server appears to flap down/up as the
  // owning process is reaped/respawned, and the client heartbeat reloads the
  // page on every recovery — the "page keeps reloading" symptom. Mixing the
  // session id into the hash gives each session its own stable port. It stays
  // stable across respawns within the same session, so the heartbeat's
  // reconnect-and-reload still restores a live page after a genuine restart.
  const sessionId = await resolveSessionId();
  const hash = createHash("sha256")
    .update(sessionId + "\u0000" + String(instanceId))
    .digest();
  // Map into a high, mostly-unprivileged range (20000–60000) to reduce the
  // chance of clashing with other listeners.
  return 20000 + (hash.readUInt32BE(0) % 40000);
}

function listenOn(server: HttpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function startServer(
  instanceId: string,
  page = DEFAULT_CANVAS_PAGE
): Promise<CanvasServerEntry> {
  const handler = createRequestHandler(instanceId);
  // Restore the user's explicitly chosen GitHub account (if any) before priming
  // so the very first strategy resolution honors it. This is what makes the
  // account choice stable across restarts.
  const persistedLogin = getPreferredGitHubLogin();
  if (persistedLogin) setPreferredGhLogin(persistedLogin);
  // Warm the GitHub identity cache in the background at boot so the first gh
  // calls find the token strategy already resolved instead of paying (or
  // racing) the `gh auth status` probe. Fire-and-forget: single-flight and
  // self-healing, so a failure here just means the next caller re-primes.
  primeGhIdentity().catch(() => {});
  const server = createServer(handler);
  let port: number;
  // Try the stable, instanceId-derived port first; fall back to an ephemeral
  // port (listen(0)) only if it's already taken/unavailable.
  const preferred = await preferredPortForInstance(instanceId);
  try {
    await listenOn(server, preferred);
    port = preferred;
  } catch {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  }
  const baseUrl = `http://127.0.0.1:${port}`;
  const entry: CanvasServerEntry = {
    server,
    baseUrl,
    url: `${baseUrl}/?page=${page}`,
    page,
    state: {}
  };
  servers.set(instanceId, entry);
  return entry;
}

export async function getOrCreateServer(
  instanceId: string,
  page?: string
): Promise<CanvasServerEntry> {
  let entry = servers.get(instanceId);
  if (entry) {
    if (page && entry.page !== page) {
      entry.page = page;
      entry.url = `${entry.baseUrl}/?page=${page}`;
    }
    return entry;
  }
  return await startServer(instanceId, page);
}
