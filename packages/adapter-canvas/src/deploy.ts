// Canvas adapter — deploy monitoring + log parsing.
// Polls GitHub Actions runs for the deploy's step lifecycle and terminal
// conclusion, and extracts a readable failure cause from the completed run log.
// Per-resource deploy status and the deployed application graph come from
// workflow artifacts instead — see ./deploy-artifacts.ts.
// Reads GitHub via the gh CLI; portal links come from ./infra.ts.

import { cliExec } from "./gh.js";
import type { SelectedGhExecutor } from "./gh.js";

type DeployStatus = "pending" | "in_progress" | "success" | "failed";

export interface DeployedConnection {
  id?: string;
  name?: string;
  direction?: string;
}

export interface DeployedOutputResource {
  id?: string;
  name?: string;
  type?: string;
  displayType?: string;
  deployStatus?: DeployStatus;
  portalUrl?: string;
}

export interface DeployedResource {
  id?: string;
  name?: string;
  type?: string;
  connections?: DeployedConnection[];
  outputResources?: DeployedOutputResource[];
  deployStatus?: DeployStatus;
}

interface WorkflowStep {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface WorkflowRun {
  databaseId?: number;
  createdAt?: string;
  status?: string;
  conclusion?: string | null;
}

interface WorkflowRunDetail extends WorkflowRun {
  jobs: WorkflowJob[];
  steps: WorkflowStep[];
}

interface RepoPermissions {
  admin?: boolean;
  maintain?: boolean;
  push?: boolean;
  triage?: boolean;
  pull?: boolean;
}

interface RepoAccessInput {
  repo?: string;
  login?: string;
  readFailed?: boolean;
  permissions?: RepoPermissions | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseWorkflowRun(value: unknown): WorkflowRun | null {
  if (!isRecord(value)) return null;
  return {
    databaseId:
      typeof value.databaseId === "number" ? value.databaseId : undefined,
    createdAt: stringField(value.createdAt),
    status: stringField(value.status),
    conclusion:
      typeof value.conclusion === "string" || value.conclusion === null ?
        value.conclusion
      : undefined
  };
}

export function ghJson(
  args: string[],
  fallback: unknown = null,
  timeout = 15000,
  executor?: SelectedGhExecutor
): Promise<unknown> {
  if (executor) {
    return executor.run(args, { timeout }).then((result) => {
      if (result.code !== 0) return fallback;
      try {
        return JSON.parse(result.stdout.trim());
      } catch {
        return fallback;
      }
    });
  }
  return new Promise((resolve) => {
    cliExec("gh", args, { timeout }, (err, stdout) => {
      if (err) {
        resolve(fallback);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        resolve(fallback);
      }
    });
  });
}

// Coerce a run id (which state may carry as a string) to a finite number for
// the monotonic-id comparison, or null when it is absent or not numeric.
function numericRunId(
  value: number | string | null | undefined
): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Returns the id of the newest existing run for a workflow, so a dispatcher can
// capture a baseline immediately before it starts a run and later identify the
// run it created as the first one whose id exceeds that baseline. Run ids are
// monotonically increasing on GitHub, which makes this immune to the clock skew
// that a created-at time window has to tolerate.
export async function latestWorkflowRunId(
  repo: string,
  workflowFile: string
): Promise<number | null> {
  const runs = await ghJson(
    [
      "run",
      "list",
      "--workflow=" + workflowFile,
      "--limit",
      "20",
      "--json",
      "databaseId,createdAt",
      "--repo",
      repo
    ],
    []
  );
  if (!Array.isArray(runs)) return null;
  let max: number | null = null;
  for (const value of runs) {
    const r = parseWorkflowRun(value);
    if (r?.databaseId === undefined) continue;
    if (max === null || r.databaseId > max) max = r.databaseId;
  }
  return max;
}

export async function findWorkflowRun(
  repo: string,
  workflowFile: string,
  sinceMs: number,
  knownId?: number | string | null,
  executor?: SelectedGhExecutor,
  afterRunId?: number | string | null
): Promise<number | string | null> {
  if (knownId) return knownId;
  const runs = await ghJson(
    [
      "run",
      "list",
      "--workflow=" + workflowFile,
      "--limit",
      "5",
      "--json",
      "databaseId,status,createdAt",
      "--repo",
      repo
    ],
    [],
    15000,
    executor
  );
  if (!Array.isArray(runs)) return null;
  // Prefer a monotonic run-id baseline when the caller captured one just before
  // dispatch: accept the smallest run id that exceeds it, which is the first run
  // created after the baseline rather than a later overlapping dispatch. This is
  // what keeps a redeploy's "view run" link pointing at its newly started run
  // instead of the last one.
  const baseline = numericRunId(afterRunId);
  if (baseline !== null) {
    let firstRunId: number | null = null;
    for (const value of runs) {
      const r = parseWorkflowRun(value);
      if (r?.databaseId === undefined) continue;
      if (
        r.databaseId > baseline &&
        (firstRunId === null || r.databaseId < firstRunId)
      ) {
        firstRunId = r.databaseId;
      }
    }
    return firstRunId;
  }
  // No baseline (e.g. it could not be captured): fall back to a created-at
  // window, accepting the newest run created within ~60s before dispatch (clock
  // skew tolerance) to avoid picking up clearly stale prior runs.
  const cutoff = (sinceMs || 0) - 60000;
  for (const value of runs) {
    const r = parseWorkflowRun(value);
    if (!r) continue;
    const created = Date.parse(r.createdAt || "") || 0;
    if (created >= cutoff && r.databaseId !== undefined) return r.databaseId;
  }
  return null;
}

export async function getRunDetail(
  repo: string,
  runId: number | string,
  executor?: SelectedGhExecutor
): Promise<WorkflowRunDetail | null> {
  let data = await ghJson(
    [
      "run",
      "view",
      String(runId),
      "--json",
      "status,conclusion,jobs",
      "--repo",
      repo
    ],
    null,
    15000,
    executor
  );
  // The jobs sub-resource (/actions/runs/<id>/jobs) is intermittently flaky
  // (HTTP 503) and, when included, fails the whole `gh run view` call — which
  // would otherwise report the run's status/conclusion just fine. The jobs
  // (steps) are only needed for progress/failure detail, not for detecting
  // completion, so fall back to a status-only read when the combined call
  // fails. This keeps completion detection (e.g. verify-status → success)
  // working even while the jobs endpoint is unavailable.
  if (!isRecord(data)) {
    data = await ghJson(
      [
        "run",
        "view",
        String(runId),
        "--json",
        "status,conclusion",
        "--repo",
        repo
      ],
      null,
      15000,
      executor
    );
    if (!isRecord(data)) return null;
    return {
      status: stringField(data.status),
      conclusion:
        typeof data.conclusion === "string" || data.conclusion === null ?
          data.conclusion
        : undefined,
      jobs: [],
      steps: []
    };
  }
  const jobs: WorkflowJob[] =
    Array.isArray(data.jobs) ?
      data.jobs.filter((job): job is WorkflowJob => isRecord(job))
    : [];
  const steps: WorkflowStep[] = [];
  for (const job of jobs) {
    for (const s of job.steps || []) {
      steps.push({ name: s.name, status: s.status, conclusion: s.conclusion });
    }
  }
  return {
    status: stringField(data.status),
    conclusion:
      typeof data.conclusion === "string" || data.conclusion === null ?
        data.conclusion
      : undefined,
    jobs,
    steps
  };
}

export function fetchRunLog(
  repo: string,
  runId: number | string,
  executor?: SelectedGhExecutor
): Promise<string | null> {
  if (executor) {
    return executor
      .run(["run", "view", String(runId), "--log", "--repo", repo], {
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 20
      })
      .then((result) =>
        result.code === 0 && result.stdout ? result.stdout : null
      );
  }
  return new Promise((resolve) => {
    cliExec(
      "gh",
      ["run", "view", String(runId), "--log", "--repo", repo],
      { timeout: 30000, maxBuffer: 1024 * 1024 * 20 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve(null);
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export function extractErrorLines(logText?: string | null, max = 12): string[] {
  if (!logText) return [];
  const out: string[] = [];
  const re =
    /\b(error|errors|failed|failure|fatal|denied|unauthorized|forbidden|not\s+found|cannot|unable|panic|exception|invalid|timed?\s*out)\b/i;
  for (const raw of logText.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    if (re.test(line)) out.push(line.trim());
  }
  return out.slice(-max);
}

export function extractGitHubActionsStepLog(
  logText: string | null | undefined,
  stepName: string
): string {
  if (!logText || !stepName) return "";
  const lines = logText.split(/\r?\n/);
  const exact = lines.filter((line) => {
    const fields = line.split("\t");
    return fields.length >= 3 && fields[1] === stepName;
  });
  if (exact.length > 0) return exact.join("\n");

  // `gh run view --log` can label every row UNKNOWN STEP even though the jobs
  // API reports real step names. In that format action boundaries survive as
  // runner group markers. Recognize the Azure Login action itself, then retain
  // its group and the adjacent ungrouped CLI-login output until the next group.
  if (stepName !== "Azure Login (OIDC)") return "";
  const out: string[] = [];
  let capturing = false;
  let groupEnded = false;
  for (const line of lines) {
    const fields = line.split("\t");
    if (fields.length < 3 || fields[1] !== "UNKNOWN STEP") continue;
    const message = fields.slice(2).join("\t");
    if (/##\[group\]Run azure\/login@/i.test(message)) {
      capturing = true;
      groupEnded = false;
    } else if (capturing && groupEnded && /##\[group\]/.test(message)) {
      break;
    }
    if (capturing) {
      out.push(line);
      if (/##\[endgroup\]/.test(message)) groupEnded = true;
    }
  }
  return out.join("\n");
}

// Detects the Entra "enterprise claim" rejection (AADSTS7002381) that GitHub
// Actions OIDC hits when a repo is NOT owned by an org in a GitHub Enterprise.
// Tenant-agnostic: the accepted enterprise values and the actual value are parsed
// out of the error text itself, so this works for any tenant policy, not just
// Microsoft's. Returns a friendly multi-line explanation, or '' if not applicable.
export function explainOidcEnterpriseClaim(logText?: string | null): string {
  if (!logText) return "";
  if (
    !/AADSTS7002381/.test(logText) &&
    !/must contain the enterprise claim/i.test(logText)
  )
    return "";
  // Parse: "...enterprise claim with value 'a', 'b' or 'c' but actual value is 'x'..."
  let accepted: string[] = [];
  let actual: string | null = null;
  const m =
    /enterprise claim with value\s+(.+?)\s+but actual value is\s+'([^']*)'/i.exec(
      logText
    );
  if (m) {
    accepted = (m[1].match(/'([^']*)'/g) || []).map((s) => s.replace(/'/g, ""));
    actual = m[2];
  }
  const acceptedLabel =
    accepted.length ?
      accepted.join(", ")
    : "a value required by the target Azure tenant";
  let leadLine: string, actualLabel: string;
  if (actual === "") {
    // Claim present in the issuer config but empty — the classic personal-repo case.
    leadLine =
      'Azure Login (OIDC) was rejected because this repository\u2019s GitHub OIDC token is missing the required "enterprise" claim.';
    actualLabel = "empty (this repository is not part of a GitHub Enterprise)";
  } else if (actual) {
    // Claim present but not one the tenant trusts.
    leadLine =
      'Azure Login (OIDC) was rejected because this repository\u2019s GitHub "enterprise" OIDC claim ("' +
      actual +
      '") is not trusted by the target Azure tenant.';
    actualLabel = '"' + actual + '"';
  } else {
    // Could not parse the actual value from the error text.
    leadLine =
      'Azure Login (OIDC) was rejected by the target Azure tenant over the GitHub OIDC "enterprise" claim.';
    actualLabel = "not reported";
  }
  return [
    leadLine,
    "The target Azure tenant only trusts GitHub Actions tokens whose enterprise claim is one of: " +
      acceptedLabel +
      " (actual: " +
      actualLabel +
      ").",
    "GitHub only includes the enterprise claim for repositories owned by an organization that belongs to a GitHub Enterprise \u2014 personal-account repositories cannot satisfy this policy.",
    "Fix: host this repository under an organization that is part of one of the accepted GitHub Enterprises (" +
      acceptedLabel +
      "), then re-run Create Environment so the federated credential is recreated for the new owner/repo."
  ].join("\n");
}

// Detects the Azure Login (azure/login) "No subscriptions found" failure that
// the verify-credentials workflow hits when the configured identity has no RBAC
// role that makes the target subscription visible. `az login` succeeds against
// the OIDC federation but `az account list` returns empty, so the action aborts
// with `No subscriptions found for <client-id>` and exit code 1. Returns a
// friendly multi-line explanation, or '' if the signature isn't present. Pure —
// no I/O, never throws.
export function explainNoSubscriptions(logText?: string | null): string {
  if (!logText) return "";
  if (!/No subscriptions found/i.test(logText)) return "";
  return [
    "Azure Login succeeded, but the configured identity has no subscriptions it can see, so credential verification failed (\u201cNo subscriptions found\u201d).",
    "This means the app registration / service principal has no Azure role assignment granting access to the subscription \u2014 signing in works, but it has no effective RBAC.",
    "Fix: grant the identity a role (for example, Contributor) scoped to the subscription (or a resource group within it), then re-run credential verification. If you set up credentials manually, assign the role to the same app registration whose client ID is configured on the environment; if you used auto-setup, re-run it so the role assignment is (re)created."
  ].join("\n");
}

// Whether the identifying cloud credentials the verify-credentials workflow
// needs to authenticate are fully configured for the given provider. Azure OIDC
// login requires client ID + tenant ID + subscription ID; AWS OIDC requires the
// IAM role ARN. When these are absent, dispatching verify only produces a run
// that fails at the cloud-login step (issue #219), so the create-environment
// handler skips the dispatch and surfaces actionable guidance instead. Pure.
export function cloudCredentialsComplete(
  provider: string,
  creds: {
    clientId?: string;
    tenantId?: string;
    subscriptionId?: string;
    roleArn?: string;
  }
): boolean {
  if (provider === "azure") {
    return !!(creds.clientId && creds.tenantId && creds.subscriptionId);
  }
  return !!creds.roleArn;
}

// Given the outcome of reading `gh api repos/{repo}` plus the acting gh login,
// return a clear, actionable error string, or '' when the account can read the
// repo AND has admin. Pure — no I/O, never throws. Catches the two bare-404
// failure modes GitHub returns for auth/permission problems during environment
// setup: (1) the wrong gh account is active (repo invisible → read 404), and
// (2) the account can read the repo but lacks the admin needed to create a
// deployment environment (PUT /repos/{repo}/environments → 404).
export function explainRepoAccessForEnvSetup({
  repo,
  login,
  readFailed,
  permissions
}: RepoAccessInput = {}): string {
  const who = login || "the active gh account";
  if (readFailed) {
    return (
      'Can\u2019t read repository "' +
      repo +
      '" as GitHub account "' +
      who +
      '". ' +
      "Either this account lacks access, or the wrong account is active (for example a personal account instead of your enterprise one). " +
      "Switch accounts with: gh auth switch --user <account>  (or sign in the account that has access), then retry. " +
      "Note: gh auth switch changes your machine\u2019s active GitHub account for every tool in this terminal until you switch back."
    );
  }
  if (permissions && permissions.admin === true) return "";
  // Read OK but not admin — report the current best role so the user knows
  // exactly what they have and what to ask for. When none of the role flags is
  // truthy (e.g. jq emitted `{admin:null,...}`) we don't actually know the
  // role, so we avoid claiming a specific "no direct access".
  let role = "";
  if (permissions) {
    if (permissions.maintain) role = "Maintain";
    else if (permissions.push) role = "Write";
    else if (permissions.triage) role = "Triage";
    else if (permissions.pull) role = "Read";
  }
  const account = login || "you";
  const haveClause =
    role ?
      'account "' + account + '" currently has ' + role + " access"
    : 'account "' +
      account +
      '" does not have Admin access (its exact role could not be determined)';
  return (
    'Environment setup needs Admin permission on "' +
    repo +
    '", but ' +
    haveClause +
    ". " +
    "Ask a repository or organization admin to grant you Admin (repo Settings \u2192 Collaborators and teams), then retry."
  );
}

// True when a gh error text indicates the repo/API path was Not Found (HTTP 404) —
// the signal that the active account can't see the repo. Pure, never throws.
//
// The bare `not found` alternate is INTENTIONAL, not an oversight: gh surfaces
// this condition with variable wording (e.g. "gh: Not Found (HTTP 404)" but also
// plain "the repository was not found"), and both must match. The match is
// deliberately allowed to be broad because the sole caller (server.ts, the repo
// preflight) is fail-open — a match only flips an advisory `readFailed` flag and
// GitHub still enforces real permissions server-side — so a false positive here
// costs nothing while a false negative would misdirect the preflight. Narrowing
// to `HTTP 404` only would drop the tested bare-phrase case (deploy.test.ts).
export function isRepoNotFoundError(errText?: string | null): boolean {
  if (!errText) return false;
  return /\bHTTP 404\b/i.test(errText) || /\bnot found\b/i.test(errText);
}

export function extractRadDeployError(
  logText?: string | null,
  maxChars = 4000
): string {
  if (!logText) return "";
  // Strip the "job\tstep\ttimestamp " prefix `gh run view --log` adds, if present,
  // so the structured block is detectable regardless of the log source.
  const lines = logText.split(/\r?\n/).map((raw) => {
    let l = raw.replace(/\s+$/, "");
    // gh run log prefix: tabs separate job/step, then "<ISO timestamp> <text>".
    const m = l.match(/^[^\t]*\t[^\t]*\t\S+\s(.*)$/);
    if (m) l = m[1];
    return l;
  });
  // Find the LAST structured rad error block ("Error: {").
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*Error:\s*\{/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start >= 0) {
    const block = [];
    for (let i = start; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*Error:\s*Process completed/.test(l)) break; // GitHub Actions wrapper line
      block.push(l);
      if (/^\s*TraceId:/.test(l)) break; // end of the rad error
    }
    const out = block.join("\n").trim();
    if (out) return out.slice(0, maxChars);
  }
  // Fallback: collect trailing error-ish lines.
  return extractErrorLines(lines.join("\n"), 20).join("\n").slice(0, maxChars);
}
