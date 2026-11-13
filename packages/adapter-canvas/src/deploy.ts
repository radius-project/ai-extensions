import { createDeploymentObservationBindings } from "@radius-project/adapter-shared";
export { selectDeploymentWorkflowRunId } from "@radius-project/core";
export {
  SelectedGhAuthorizationError,
  isSelectedGhAuthorizationError,
  isGitHubRateLimitError,
  selectedCommandAuthorizationError
} from "@radius-project/adapter-shared";
export {
  extractErrorLines,
  extractGitHubActionsStepLog,
  explainOidcEnterpriseClaim,
  classifyDeployCloudAuthDrift,
  extractRadDeployError
} from "@radius-project/core";
export type { DeployCloudAuthDriftInput } from "@radius-project/core";

// Canvas adapter — deploy monitoring + log parsing.
// Polls GitHub Actions runs for the deploy's step lifecycle and terminal
// conclusion, and extracts a readable failure cause from the completed run log.
// Per-resource deploy status and the deployed application graph come from
// workflow artifacts instead — see ./deploy-artifacts.ts.
// Reads GitHub via the gh CLI; portal links come from ./infra.ts.

import { cliExec, redactGhCredentials } from "./gh.js";
import {
  BARE_GH_COMMAND_PRESENTATION,
  displayGhCommand,
  type GhCommandPresentation
} from "./gh-command-display.js";
import { FORK_REPOSITORY_SETUP_GUIDANCE } from "./repository-access-guidance.js";

export const {
  ghJson,
  latestWorkflowRunId,
  findWorkflowRun,
  getRunDetail,
  fetchRunLog
} = createDeploymentObservationBindings({
  execute: (...args) => cliExec(...args),
  redactDiagnostic: redactGhCredentials
});

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
export { cloudCredentialsComplete } from "@radius-project/core";

// Given the outcome of reading `gh api repos/{repo}` plus the acting gh login,
// return a clear, actionable error string, or '' when the account can read the
// repo AND has admin. Pure — no I/O, never throws. Catches the two bare-404
// failure modes GitHub returns for auth/permission problems during environment
// setup: (1) the wrong gh account is active (repo invisible → read 404), and
// (2) the account can read the repo but lacks the admin needed to create a
// deployment environment (PUT /repos/{repo}/environments → 404).
export function explainRepoAccessForEnvSetup(
  { repo, login, readFailed, permissions }: RepoAccessInput = {},
  ghCommandPresentation: GhCommandPresentation = BARE_GH_COMMAND_PRESENTATION
): string {
  const who = login || "the active gh account";
  if (readFailed) {
    const switchCommand = displayGhCommand(ghCommandPresentation, [
      "auth",
      "switch",
      "--user",
      "<account>"
    ]);
    return (
      'Can\u2019t read repository "' +
      repo +
      '" as GitHub account "' +
      who +
      '". ' +
      "Either this account lacks access, or the wrong account is active (for example a personal account instead of your enterprise one). " +
      (switchCommand ?
        `Switch accounts with: ${switchCommand} (or sign in the account that has access), then retry. ${ghCommandPresentation.installationNote} `
      : `${ghCommandPresentation.installationNote} `) +
      "Note: gh auth switch changes your machine\u2019s active GitHub account for every tool in this terminal until you switch back. " +
      FORK_REPOSITORY_SETUP_GUIDANCE
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
    "Ask a repository or organization admin to grant you Admin (repo Settings \u2192 Collaborators and teams), then retry. " +
    FORK_REPOSITORY_SETUP_GUIDANCE
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
