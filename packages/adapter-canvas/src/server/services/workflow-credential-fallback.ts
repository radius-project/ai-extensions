// The single decision behind every "retry this gh command with the injected
// GH_TOKEN stripped" fallback in the canvas: workflow-file writes and workflow
// dispatches in `create-environment`, `deployments` and the deploy dispatch
// service.
//
// The fallback exists because the host injects a GH_TOKEN/GITHUB_TOKEN that gh
// prefers over the user's stored login, and that token is often minted without
// the `workflow` scope. Stripping it makes gh fall back to the stored (keyring)
// credential — but that credential belongs to whichever account is ACTIVE
// machine-wide, which on a multi-account machine is frequently NOT the account
// the rest of setup acts as. So a retry is a silent identity change, and it is
// only ever acceptable when all of the following hold:
//
//   1. There is an injected token to strip (otherwise the first attempt already
//      used the stored credential and the retry is the identical command).
//   2. The failure is positively identified as a missing `workflow` scope. Every
//      other failure — 404, protected branch, Actions disabled, rate limit,
//      network error, an unparseable message — is either unrelated to the
//      credential or of unknown cause, and retrying it as a different identity
//      cannot be justified.
//   3. The command did not time out (or otherwise get killed). A dispatch that
//      timed out may already have been accepted by GitHub, so a retry risks a
//      second workflow run; a scope rejection, by contrast, is a definitive
//      response that changed nothing.
//
// Create Environment does not use this fallback at all: it runs every command
// through one pinned selected-account executor, so there is no ambient identity
// for a retry to slip into.

export interface WorkflowCredentialFallbackInput {
  // stderr from the failed attempt. The scope rejection is only ever visible
  // here, so an empty message can never authorise a retry.
  stderr?: string;
  // True when the runner killed the child (its timeout elapsed, or it was
  // signalled), so the request's outcome is unknown.
  timedOut?: boolean;
  // True when GH_TOKEN or GITHUB_TOKEN is present in the environment the retry
  // would strip.
  hasInjectedToken: boolean;
}

// The shape of a failed child process the runners observe. `execFile` reports a
// child it terminated (its timeout elapsed) with `killed` and/or a `signal`.
export interface CommandFailure {
  killed?: boolean;
  signal?: NodeJS.Signals | string | null;
}

// True when the CLI was terminated rather than answered. The command's outcome
// is then unknown — a dispatch may already have been accepted — so callers must
// neither retry it nor read its stderr as a verdict. Defined once because the
// deploy runners, the delete dispatch and the create-environment runner all
// have to agree on it.
export function commandTimedOut(
  error: CommandFailure | null | undefined
): boolean {
  return !!error && (!!error.killed || !!error.signal);
}

// Pure predicate distinguishing a missing token scope (which a pull request
// cannot fix, and which the keyring credential may be able to satisfy) from any
// other refusal. Covers the OAuth-app wording GitHub returns for contents
// writes under `.github/workflows/`, the shorter `gh` phrasings, and the GitHub
// App variant, which names a missing `workflows` permission instead of a scope.
export function needsWorkflowScope(stderr?: string): boolean {
  const text = stderr || "";
  return (
    /workflow.{0,20}scope/i.test(text) ||
    /without .?workflow.? scope/i.test(text) ||
    /workflows.? permission/i.test(text)
  );
}

// Whether a failed workflow-scoped gh command may be retried with the injected
// token stripped. Fails closed: anything not positively recognised as a
// workflow-scope rejection keeps the original failure and its real message.
export function shouldRetryWithKeyringCredential({
  stderr,
  timedOut,
  hasInjectedToken
}: WorkflowCredentialFallbackInput): boolean {
  if (!hasInjectedToken) return false;
  if (timedOut) return false;
  return needsWorkflowScope(stderr);
}
