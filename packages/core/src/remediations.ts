// Remediation registry — the single source of truth for every terminal command
// the Radius canvas suggests a user run.
//
// A warning or failure surface never names a command of its own any more. It
// names a `RemediationId` plus structurally validated parameters, and this
// module resolves that pair into the display text, the argv the agent should
// run, the impact classification, the confirmation copy, and the session
// message handed to Copilot.
//
// The registry exists so the command a user clicks "Run" on is rebuilt
// server-side from an identifier the server trusts, never from text a browser
// supplied. Two rules follow from that and are load-bearing:
//
//   1. Parameters are structurally validated identifiers only — GUIDs, GitHub
//      logins, git branch names. Free text never reaches a command, and a
//      credential value never reaches one at all.
//   2. Commands are modeled as argv arrays. Nothing here composes a shell
//      string for execution; `displayCommand` is presentation only.
//
// This module is PURE: no I/O, no DOM, no process. Execution is always
// delegated to the Copilot session, because the canvas server cannot run an
// interactive login without blocking itself.

/** Every remediation the canvas knows how to offer. */
export const REMEDIATION_IDS = [
  "azure-cli-install",
  "azure-cli-login",
  "azure-subscription-set",
  "aws-cli-login",
  "github-cli-login",
  "github-packages-scope",
  "github-workflow-scope",
  "git-push-branch"
] as const;

export type RemediationId = (typeof REMEDIATION_IDS)[number];

/**
 * Where the command has to run.
 *
 * - `workspace`: the command only makes sense in the repository worktree.
 * - `anywhere`: the command acts on machine- or account-level state.
 */
export type RemediationCwd = "workspace" | "anywhere";

/**
 * How much the command changes beyond the current request.
 *
 * - `low`: establishes an interactive CLI session for the user's own account.
 *   The user asked for exactly this by clicking Verify, so one confirmation is
 *   proportionate.
 * - `high`: mutates state the user did not ask about in this click — a
 *   machine-wide active account, a granted token scope, or a remote write. The
 *   UI must state what changes and take a second, explicit confirmation.
 */
export type RemediationImpact = "low" | "high";

export interface RemediationSessionMessage {
  readonly prompt: string;
  readonly displayPrompt: string;
}

export interface Remediation {
  readonly id: RemediationId;
  /** Normalized parameters, safe to echo back to a client. */
  readonly params: Readonly<Record<string, string>>;
  readonly title: string;
  /** Exactly what the UI shows and copies. Presentation only. */
  readonly displayCommand: string;
  /** One argv array per command, in order. Never a shell string. */
  readonly argv: readonly (readonly string[])[];
  readonly cwd: RemediationCwd;
  readonly impact: RemediationImpact;
  readonly confirmTitle: string;
  readonly confirmBody: string;
  readonly confirmLabel: string;
  /** What the user should do in the canvas once the command finishes. */
  readonly followUp: string;
}

export type RemediationResult =
  | { readonly ok: true; readonly remediation: Remediation }
  | { readonly ok: false; readonly reason: string };

/**
 * The JSON-friendly projection a producer attaches to an error payload and the
 * browser renders. Flat strings only: no optional fields, and never any prompt
 * text, so the agent-facing wording cannot be shaped by a client.
 */
export interface RemediationView {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
  readonly title: string;
  readonly command: string;
  readonly cwd: string;
  readonly impact: RemediationImpact;
  readonly runnable: boolean;
  /** Empty when `runnable`; otherwise why the action is offered disabled. */
  readonly unsupportedReason: string;
  readonly confirmTitle: string;
  readonly confirmBody: string;
  readonly confirmLabel: string;
  readonly followUp: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GitHub logins are 1-39 characters of alphanumerics and single hyphens, and
// cannot start or end with a hyphen.
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

// A deliberately narrow branch shape. Git accepts more than this, but anything
// outside it (whitespace, `..`, a leading `-` that would read as a flag, a
// trailing `.lock`) is refused rather than passed to `git push`.
const GIT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readParams(params: unknown): Readonly<Record<string, unknown>> {
  return typeof params === "object" && params !== null ?
      (params as Record<string, unknown>)
    : {};
}

export function isRemediationId(value: unknown): value is RemediationId {
  return (
    typeof value === "string" &&
    (REMEDIATION_IDS as readonly string[]).includes(value)
  );
}

function guid(value: unknown): string {
  const candidate = text(value);
  return UUID.test(candidate) ? candidate : "";
}

function branchName(value: unknown): string {
  const candidate = text(value);
  if (!GIT_BRANCH.test(candidate)) return "";
  if (candidate.includes("..") || candidate.endsWith(".lock")) return "";
  return candidate;
}

function githubLogin(value: unknown): string {
  const candidate = text(value);
  return GITHUB_LOGIN.test(candidate) ? candidate : "";
}

const RETURN_AND_VERIFY =
  "return to the Radius canvas and click Verify Credentials again";

// Preserved verbatim from the original Azure CLI assist prompt. Azure CLI
// injects COPILOT_AGENT_SESSION_ID into the authentication request when it is
// present, which breaks the device-code flow, so the unset instruction travels
// with every `az login` this registry produces.
function azureLoginInstructions(command: string): string {
  return [
    `Run \`${command}\` in this Copilot session.`,
    "For that command, remove COPILOT_AGENT_SESSION_ID from the az process environment so Azure CLI does not inject it into the authentication request.",
    "Use the shell-appropriate way to unset the variable only for the login invocation, and show me the device code and sign-in URL."
  ].join(" ");
}

function azureLoginCommand(tenantId: string): string {
  return `az login --use-device-code${tenantId ? ` --tenant ${tenantId}` : ""}`;
}

function azureLoginArgv(tenantId: string): readonly string[] {
  const argv = ["az", "login", "--use-device-code"];
  if (tenantId) argv.push("--tenant", tenantId);
  return argv;
}

function buildAzureCliLogin(
  params: Readonly<Record<string, unknown>>
): Remediation {
  const tenantId = guid(params.tenantId);
  return {
    id: "azure-cli-login",
    params: tenantId ? { tenantId } : {},
    title: "Sign in to Azure CLI",
    displayCommand: azureLoginCommand(tenantId),
    argv: [azureLoginArgv(tenantId)],
    cwd: "anywhere",
    impact: "low",
    confirmTitle: "Start Azure login?",
    confirmBody:
      "No active Azure session was found. Would you like Copilot to start the Azure login flow?",
    confirmLabel: "Start Azure login",
    followUp: `After the login finishes, ${RETURN_AND_VERIFY}.`
  };
}

function buildAzureCliInstall(
  params: Readonly<Record<string, unknown>>
): Remediation {
  const tenantId = guid(params.tenantId);
  return {
    id: "azure-cli-install",
    params: tenantId ? { tenantId } : {},
    title: "Install Azure CLI and sign in",
    displayCommand: azureLoginCommand(tenantId),
    argv: [azureLoginArgv(tenantId)],
    cwd: "anywhere",
    impact: "low",
    confirmTitle: "Install Azure CLI?",
    confirmBody:
      "Azure CLI is not installed. Would you like Copilot to attempt to install it and then start Azure login?",
    confirmLabel: "Ask Copilot to install",
    followUp: `After the install and login finish, ${RETURN_AND_VERIFY}.`
  };
}

function buildAzureSubscriptionSet(
  params: Readonly<Record<string, unknown>>
): RemediationResult {
  const subscriptionId = guid(params.subscriptionId);
  if (!subscriptionId) {
    return {
      ok: false,
      reason:
        "Selecting an Azure subscription needs a subscription id in GUID form."
    };
  }
  return {
    ok: true,
    remediation: {
      id: "azure-subscription-set",
      params: { subscriptionId },
      title: "Select the Azure subscription",
      displayCommand: `az account set --subscription ${subscriptionId}`,
      argv: [["az", "account", "set", "--subscription", subscriptionId]],
      cwd: "anywhere",
      impact: "low",
      confirmTitle: "Select this Azure subscription?",
      confirmBody:
        "Copilot will point the Azure CLI at this subscription for your active session.",
      confirmLabel: "Select subscription",
      followUp: `After the subscription is selected, ${RETURN_AND_VERIFY}.`
    }
  };
}

function buildAwsCliLogin(): Remediation {
  return {
    id: "aws-cli-login",
    params: {},
    title: "Sign in to AWS CLI",
    displayCommand: "aws sso login",
    argv: [["aws", "sso", "login"]],
    cwd: "anywhere",
    impact: "low",
    confirmTitle: "Start AWS login?",
    confirmBody:
      "No active AWS session was found. Copilot will start AWS SSO login, or run `aws configure` instead if this machine uses static credentials.",
    confirmLabel: "Start AWS login",
    followUp:
      "After the login finishes, return to the Radius canvas and click Verify again."
  };
}

function buildGithubCliLogin(): Remediation {
  return {
    id: "github-cli-login",
    params: {},
    title: "Sign in to GitHub CLI",
    displayCommand: "gh auth login",
    argv: [["gh", "auth", "login"]],
    cwd: "anywhere",
    impact: "high",
    confirmTitle: "Sign in to GitHub CLI?",
    confirmBody:
      "`gh auth login` changes the active GitHub CLI account for github.com machine-wide until you switch back, which affects every tool on this machine that uses GitHub CLI.",
    confirmLabel: "Sign in to GitHub",
    followUp:
      "After the sign-in finishes, return to the Radius canvas and retry."
  };
}

function buildGithubPackagesScope(
  params: Readonly<Record<string, unknown>>
): RemediationResult {
  const login = githubLogin(params.login);
  if (!login) {
    return {
      ok: false,
      reason:
        "Granting package access needs the GitHub account login Radius detected."
    };
  }
  return {
    ok: true,
    remediation: {
      id: "github-packages-scope",
      params: { login },
      title: "Grant GitHub Packages access",
      displayCommand:
        `gh auth switch -h github.com -u ${login} && ` +
        "gh auth refresh -h github.com -s read:packages -s write:packages",
      argv: [
        ["gh", "auth", "switch", "-h", "github.com", "-u", login],
        [
          "gh",
          "auth",
          "refresh",
          "-h",
          "github.com",
          "-s",
          "read:packages",
          "-s",
          "write:packages"
        ]
      ],
      cwd: "anywhere",
      impact: "high",
      confirmTitle: `Grant package access to @${login}?`,
      confirmBody:
        `\`gh auth switch\` makes @${login} the active GitHub CLI account for ` +
        "github.com machine-wide until you switch back, and `gh auth refresh` " +
        "adds the read:packages and write:packages scopes to its token. You " +
        "will need to complete the GitHub authorization in your browser.",
      confirmLabel: "Grant package access",
      followUp:
        "After the authorization finishes, return to the Radius canvas and click Retry."
    }
  };
}

function buildGithubWorkflowScope(): Remediation {
  return {
    id: "github-workflow-scope",
    params: {},
    title: "Grant the GitHub workflow scope",
    displayCommand: "gh auth refresh -h github.com -s workflow",
    argv: [["gh", "auth", "refresh", "-h", "github.com", "-s", "workflow"]],
    cwd: "anywhere",
    impact: "high",
    confirmTitle: "Grant the workflow scope?",
    confirmBody:
      "`gh auth refresh` adds the workflow scope to your GitHub CLI token, which lets it create and update GitHub Actions workflow files. You will need to complete the GitHub authorization in your browser.",
    confirmLabel: "Grant workflow scope",
    followUp:
      "After the authorization finishes, return to the Radius canvas and retry."
  };
}

function buildGitPushBranch(
  params: Readonly<Record<string, unknown>>
): RemediationResult {
  const branch = branchName(params.branch);
  if (!branch) {
    return {
      ok: false,
      reason:
        "Radius could not read a branch name it can safely push, so it will not run git push for you."
    };
  }
  return {
    ok: true,
    remediation: {
      id: "git-push-branch",
      params: { branch },
      title: "Push the branch to GitHub",
      displayCommand: `git push -u origin ${branch}`,
      argv: [["git", "push", "-u", "origin", branch]],
      cwd: "workspace",
      impact: "high",
      confirmTitle: `Push ${branch} to GitHub?`,
      confirmBody:
        `This writes to the remote repository: every commit on \`${branch}\` ` +
        "is published to origin and the branch starts tracking it. Review what " +
        "you are about to publish before continuing.",
      confirmLabel: "Push branch",
      followUp:
        "After the push finishes, return to the Radius canvas and deploy again."
    }
  };
}

/**
 * Resolve an id and its parameters into a runnable remediation.
 *
 * Returns `ok: false` with a user-facing reason when the id is unknown or a
 * parameter fails validation. Callers must never fall back to a command of
 * their own on that branch — the action is offered disabled instead.
 */
export function buildRemediation(
  id: unknown,
  params: unknown
): RemediationResult {
  if (!isRemediationId(id)) {
    return { ok: false, reason: "Radius does not offer to run this command." };
  }
  const values = readParams(params);
  switch (id) {
    case "azure-cli-install":
      return { ok: true, remediation: buildAzureCliInstall(values) };
    case "azure-cli-login":
      return { ok: true, remediation: buildAzureCliLogin(values) };
    case "azure-subscription-set":
      return buildAzureSubscriptionSet(values);
    case "aws-cli-login":
      return { ok: true, remediation: buildAwsCliLogin() };
    case "github-cli-login":
      return { ok: true, remediation: buildGithubCliLogin() };
    case "github-packages-scope":
      return buildGithubPackagesScope(values);
    case "github-workflow-scope":
      return { ok: true, remediation: buildGithubWorkflowScope() };
    case "git-push-branch":
      return buildGitPushBranch(values);
  }
}

/**
 * Project a remediation request into the flat view a producer attaches to an
 * error payload. A failed build still yields a view so the surface can render
 * the action disabled with a stated reason rather than hiding it or, worse,
 * offering an enabled button that cannot work.
 */
export function remediationView(id: unknown, params: unknown): RemediationView {
  const result = buildRemediation(id, params);
  if (!result.ok) {
    return {
      id: typeof id === "string" ? id : "",
      params: {},
      title: "Run a command",
      command: "",
      cwd: "anywhere",
      impact: "high",
      runnable: false,
      unsupportedReason: result.reason,
      confirmTitle: "",
      confirmBody: "",
      confirmLabel: "",
      followUp: ""
    };
  }
  const { remediation } = result;
  return {
    id: remediation.id,
    params: remediation.params,
    title: remediation.title,
    command: remediation.displayCommand,
    cwd: remediation.cwd,
    impact: remediation.impact,
    runnable: true,
    unsupportedReason: "",
    confirmTitle: remediation.confirmTitle,
    confirmBody: remediation.confirmBody,
    confirmLabel: remediation.confirmLabel,
    followUp: remediation.followUp
  };
}

// The timeline stand-in for each prompt. The canvas starts these turns on the
// user's behalf, so the chat should read as a status line rather than as
// multi-paragraph instructions the user appears to have typed. The agent still
// receives the full prompt.
function displayPromptFor(remediation: Remediation): string {
  switch (remediation.id) {
    case "azure-cli-install":
      return "Installing Azure CLI and signing in so the Radius canvas can verify these Azure credentials.";
    case "azure-cli-login":
      return "Signing in to Azure CLI so the Radius canvas can verify these Azure credentials.";
    case "azure-subscription-set":
      return "Selecting the Azure subscription the Radius canvas needs.";
    case "aws-cli-login":
      return "Signing in to AWS CLI so the Radius canvas can verify these AWS credentials.";
    case "github-cli-login":
      return "Signing in to GitHub CLI so the Radius canvas can continue.";
    case "github-packages-scope":
      return "Granting the GitHub CLI account permission to publish packages for Radius.";
    case "github-workflow-scope":
      return "Granting the GitHub CLI token the workflow scope the Radius canvas needs.";
    case "git-push-branch":
      return `Pushing ${remediation.params.branch} to GitHub so the Radius canvas can deploy it.`;
  }
}

// Why the canvas is asking, in the agent's voice. Paired with the command so a
// prompt cannot describe one remediation while running another.
function reasonFor(remediation: Remediation): string {
  switch (remediation.id) {
    case "azure-cli-install":
      return "Azure CLI is not installed in this environment, so the Radius canvas can't verify Azure credentials yet.";
    case "azure-cli-login":
      return "The Radius canvas needs an active Azure CLI session before it can verify these credentials.";
    case "azure-subscription-set":
      return "The Radius canvas needs the Azure CLI pointed at a specific subscription before it can continue.";
    case "aws-cli-login":
      return "The Radius canvas needs an active AWS CLI session before it can verify these credentials.";
    case "github-cli-login":
      return "The Radius canvas could not detect a signed-in GitHub CLI account.";
    case "github-packages-scope":
      return `The GitHub CLI account @${remediation.params.login} cannot publish packages, which the Radius canvas needs to store environment state.`;
    case "github-workflow-scope":
      return "The GitHub CLI token is missing the workflow scope, which the Radius canvas needs to manage GitHub Actions workflow files.";
    case "git-push-branch":
      return `The branch ${remediation.params.branch} has not been pushed to GitHub yet, so the Radius canvas has nothing to deploy.`;
  }
}

/**
 * Build the `{ prompt, displayPrompt }` pair handed to the Copilot session.
 *
 * Pairing them here means the agent-facing prompt and its timeline stand-in
 * cannot drift apart or be swapped at a call site.
 */
export function remediationSessionMessage(
  remediation: Remediation
): RemediationSessionMessage {
  const instructions =
    (
      remediation.id === "azure-cli-install" ||
      remediation.id === "azure-cli-login"
    ) ?
      azureLoginInstructions(remediation.displayCommand)
    : `Run \`${remediation.displayCommand}\` in this Copilot session.`;
  const lines =
    remediation.id === "azure-cli-install" ?
      [reasonFor(remediation), `Please install Azure CLI, then ${instructions}`]
    : [reasonFor(remediation), instructions];
  if (remediation.cwd === "workspace") {
    lines.push("Run it from the repository worktree for this session.");
  }
  lines.push(remediation.followUp);
  return {
    prompt: lines.join("\n\n"),
    displayPrompt: displayPromptFor(remediation)
  };
}
