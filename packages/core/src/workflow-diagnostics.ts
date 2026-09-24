import type {
  WorkflowRunDetail,
  WorkflowTarget
} from "./workflow-observation.js";

export interface WorkflowFailureReads {
  readLog(repo: string, runId: number | string): Promise<string | null>;
  readControlPlaneLog(): Promise<string | null>;
}

export interface WorkflowFailure {
  message: string;
  radiusError: string;
  authDriftMessage: string;
  narration: string[];
}

export async function collectWorkflowFailure(
  target: WorkflowTarget,
  run: Pick<WorkflowRunDetail, "conclusion" | "steps">,
  context: Pick<
    DeployCloudAuthDriftInput,
    "provider" | "resourcesTouched" | "environmentPreviouslyVerified"
  >,
  reads: WorkflowFailureReads
): Promise<WorkflowFailure> {
  const { conclusion, steps } = run;
  const failedSteps = steps.filter(
    (step) =>
      step.conclusion &&
      step.conclusion !== "success" &&
      step.conclusion !== "skipped"
  );
  const authDriftMessage =
    conclusion === "failure" ?
      classifyDeployCloudAuthDrift({
        ...context,
        failedStepNames: failedSteps.map((step) => step.name)
      })
    : "";
  const lead =
    "Deployment failed" + (conclusion ? " (" + conclusion + ")" : "") + ".";
  const url =
    "https://github.com/" + target.repo + "/actions/runs/" + target.runId;
  const narration: string[] = [];
  let message = lead;
  let radiusError = "";
  try {
    if (failedSteps.length) {
      message +=
        " Failed step: " +
        failedSteps.map((step) => step.name).join(", ") +
        ".";
    }
    const log = await reads.readLog(target.repo, target.runId);
    const claimHelp = explainOidcEnterpriseClaim(
      extractGitHubActionsStepLog(log, "Azure Login (OIDC)")
    );
    if (claimHelp)
      message = claimHelp + "\n\n\u2014 raw error \u2014\n" + message;
    const detail = extractRadDeployError(log);
    if (detail) {
      message += "\n\n" + detail;
      narration.push(
        "",
        "──────── failure details ────────",
        ...detail.split("\n").map((line) => "  " + line),
        "─────────────────────────────────"
      );
    }
    let controlPlaneLog: string | null = null;
    try {
      controlPlaneLog = await reads.readControlPlaneLog();
    } catch {
      // Best-effort evidence must not mask the run's failure.
    }
    if (controlPlaneLog) {
      const tail = controlPlaneLog
        .replace(/\s+$/, "")
        .split("\n")
        .slice(-40)
        .join("\n");
      if (tail.trim()) {
        message += "\n\n— control-plane log —\n" + tail;
        narration.push(
          "",
          "──────── control-plane log ────────",
          ...tail.split("\n").map((line) => "  " + line),
          "───────────────────────────────────"
        );
      }
    }
    message += "\n\nView the full run: " + url;
    radiusError = detail;
  } catch {
    message =
      lead +
      " The failure details could not be read; see the full run: " +
      url +
      ".";
  }
  return { message, radiusError, authDriftMessage, narration };
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

// The deploy workflow signs in to the cloud in a single, named step that runs
// *before* any Radius/cluster mutation: "Azure Login (OIDC)" for Azure and
// "Configure AWS Credentials (OIDC)" (or an assume-role step) for AWS. These are
// matched exactly rather than with a broad keyword regex, because the deploy
// workflow's *mutation* steps also mention "credentials"/"oidc" (for example
// "Register cloud credentials with Radius" or "Project cloud OIDC tokens into
// Radius pods"), and a broad match would misread a failure in one of those —
// which happens after state has already been changed — as pre-mutation drift.
const AZURE_LOGIN_STEP = /^\s*azure login(?:\s*\(oidc\))?\s*$/i;
const AWS_LOGIN_STEP =
  /^\s*(?:configure aws credentials(?:\s*\(oidc\))?|assume[\s-]*role)\s*$/i;

// Steps that mutate cluster or Radius control-plane state. They all run after
// cloud login and up to / including "Run rad commands". If any of them is among
// the failed steps, a mutation was attempted, so the run is not a clean
// pre-mutation credential drift regardless of the login step's outcome.
const DEPLOY_MUTATION_STEPS: readonly RegExp[] = [
  /project cloud oidc tokens/i,
  /refresh external deployment target credentials/i,
  /restore radius state/i,
  /register cloud credentials with radius/i,
  /create radius environment/i,
  /apply custom recipe pack/i,
  /prepare live deployment progress/i,
  /run rad commands/i,
  /publish deployed graph/i
];

export interface DeployCloudAuthDriftInput {
  // "aws" or "azure". Any other value cannot be tied to a provider-specific
  // login step and is never classified as drift.
  provider?: string | null;
  // Whether `rad deploy` began touching resources. When true this is a
  // mid-deploy resource failure (exception 5.1), never auth drift.
  resourcesTouched: boolean;
  // Names of the run's failed (non-success, non-skipped) steps.
  failedStepNames: readonly (string | undefined)[];
  // Whether the environment previously passed credential verification. Drift
  // (5.2) means credentials that *worked before* stopped working; an environment
  // that never verified (its verification failed and was bypassed) has no prior
  // good state to drift from, so when this is explicitly false the failure is not
  // classified as drift. Undefined leaves the classification to the step
  // evidence, preserving the caller that cannot determine prior state.
  environmentPreviouslyVerified?: boolean;
}

// Exception 5.2: a redeploy to an environment that verified earlier now fails
// cloud authentication or authorization *before any resource is touched*,
// meaning the trust or permissions drifted since setup (the IAM role's trust
// policy or permissions, or the Azure federated credential or role assignment,
// was changed or removed). Detected from the run shape — the provider's cloud
// login step failed, no mutation step ran, and `rad deploy` never touched a
// resource — so it is distinct from a mid-deploy resource failure (5.1). Returns
// a readable, actionable message, or '' when the failure is not auth drift.
// Pure — no I/O, never throws.
export function classifyDeployCloudAuthDrift(
  input: DeployCloudAuthDriftInput
): string {
  if (input.resourcesTouched) return "";
  if (input.environmentPreviouslyVerified === false) return "";
  const failedNames = input.failedStepNames.filter(
    (name): name is string => !!name
  );
  // A failed mutation step means state was already being changed — not drift.
  if (
    failedNames.some((name) =>
      DEPLOY_MUTATION_STEPS.some((pattern) => pattern.test(name))
    )
  ) {
    return "";
  }
  const loginStep =
    input.provider === "aws" ? AWS_LOGIN_STEP
    : input.provider === "azure" ? AZURE_LOGIN_STEP
    : null;
  if (!loginStep) return "";
  const failedAtLogin = failedNames.some((name) => loginStep.test(name));
  if (!failedAtLogin) return "";
  const cloud = input.provider === "aws" ? "AWS" : "Azure";
  const drift =
    input.provider === "aws" ?
      "the IAM role's trust policy or permissions were changed or removed"
    : "the federated credential or role assignment was changed or removed";
  // Only assert that the environment verified earlier when the caller can prove
  // it. An environment can now be deployable via the "bypassed" status without
  // ever passing verification, so when prior success is unknown the message must
  // not claim a good state that may never have existed.
  const driftCause =
    input.environmentPreviouslyVerified === true ?
      "This environment verified earlier, so its " +
      cloud +
      " credentials appear to have drifted since setup (for example " +
      drift +
      ")."
    : "If this environment authenticated before, its " +
      cloud +
      " credentials may have drifted since setup (for example " +
      drift +
      ").";
  return [
    "Cloud authentication or authorization failed before any resource was deployed.",
    driftCause,
    "Re-verify the environment's credentials, then redeploy."
  ].join("\n");
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
    return out.slice(0, maxChars);
  }
  // Fallback: collect trailing error-ish lines.
  return extractErrorLines(lines.join("\n"), 20).join("\n").slice(0, maxChars);
}
