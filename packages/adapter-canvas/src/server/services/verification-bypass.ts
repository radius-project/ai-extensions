import { WORKFLOW_READ_LIMITS } from "@radius-project/core";
import { createWorkflowReadBudget } from "@radius-project/adapter-shared";
import { classifyVerifyFailure } from "../routes/verify-failure-classification.js";
import type {
  EnvironmentsDependencies,
  EnvironmentRunStep
} from "../routes/environments-types.js";
import type { WorkflowObservationScope } from "./workflow-observation-scope.js";
import type { OperationControlResult } from "./operation-control.js";

const VERIFICATION_BYPASS_VARIABLE = "RADIUS_VERIFICATION_BYPASSED";
// The exception categories a user is allowed to bypass: a permissions gap (4.4)
// or an unreachable cluster / cloud endpoint (4.5) can be resolved after the
// environment record exists. An OIDC-trust gap (4.3) and any unclassified
// ("generic") failure must be fixed first and are never bypassable.
const BYPASSABLE_VERIFY_CATEGORIES: ReadonlySet<string> = new Set([
  "permissions",
  "cluster-unreachable",
  "cloud-unreachable"
]);

// Records a verification bypass for an environment by writing the durable marker
// variable, then invalidates the repo's cached listing so the picker re-derives
// the environment as usable on its next read.
//
// The bypass is a mutation that makes a failed environment deployable, so it is
// authorized entirely server-side rather than trusting the caller's word that
// the failure is bypassable. The request must name the tracked verification
// operation and the exact run it observed; the handler resolves that operation's
// pinned GitHub executor, re-fetches and re-classifies the run under that
// identity, and confirms the target is a Radius-managed environment whose latest
// verify run genuinely reached a terminal, bypassable failure (4.4 / 4.5) for
// that same run id. The marker's value is that run id, so the listing only
// treats the environment as bypassed for the specific failed run the user
// accepted — a different later failure (new run id) is not silently inherited,
// and a real later success supersedes it.
//
// The narrow shape handleBypassVerification reads from the (unknown-typed)
// tracked operation. Every field is optional and defensively re-checked at the
// use site so a shape change fails closed instead of throwing.
interface BypassVerificationOperation {
  repo?: unknown;
  environment?: unknown;
  verification?: { runId?: unknown } | null;
  context?: { githubLogin?: unknown } | null;
}

export async function verificationBypass(
  input: {
    data: Record<string, unknown>;
    scope?: WorkflowObservationScope;
    isCurrent(): boolean;
    permissionsOnly?: boolean;
  },
  dependencies: Pick<
    EnvironmentsDependencies,
    | "getOperation"
    | "hasCompleteVerificationIdentity"
    | "getSelectedGitHubExecutor"
    | "getRunDetail"
    | "fetchRunLog"
    | "extractGitHubActionsStepLog"
    | "explainOidcEnterpriseClaim"
    | "explainNoSubscriptions"
    | "envListCacheDelete"
    | "errorMessage"
  >
): Promise<OperationControlResult> {
  const { data, scope } = input;
  const result = (
    status: number,
    body: Record<string, unknown>
  ): OperationControlResult => ({ status, body });
  try {
    // Every identifier is a JSON boundary value. Validate types explicitly so a
    // non-string field yields a clean 400 rather than a coerced value or a
    // "trim is not a function" TypeError. A GitHub run id may arrive as either a
    // JSON number or a string; the rest must be strings.
    const readStringField = (value: unknown): string =>
      typeof value === "string" ? value.trim() : "";
    const repo = readStringField(data.repo);
    const envName = readStringField(data.environment);
    const operationId = readStringField(data.operationId);
    const runId =
      typeof data.runId === "number" || typeof data.runId === "string" ?
        String(data.runId).trim()
      : "";
    if (!repo || !envName || !operationId || !runId) {
      return result(400, {
        error: "repo, environment, operationId and runId are required."
      });
    }

    // 1. The request must reference the live verification operation for this
    //    exact repo, environment and run. This binds the bypass to a tracked
    //    operation instead of an arbitrary caller-supplied target. getOperation
    //    is typed unknown, so read it through a narrow shape rather than `any`.
    const verifyOp = dependencies.getOperation(operationId) as
      BypassVerificationOperation | null | undefined;
    if (
      !verifyOp ||
      verifyOp.repo !== repo ||
      verifyOp.environment !== envName ||
      String(verifyOp.verification?.runId ?? "") !== runId
    ) {
      return result(409, {
        error:
          "The verification operation does not match this bypass request. Re-run verification and try again."
      });
    }
    if (!dependencies.hasCompleteVerificationIdentity(verifyOp)) {
      return result(409, {
        error:
          "The verification operation has incomplete dispatch identity and cannot be bypassed."
      });
    }

    // 2. Resolve the pinned executor / login that started verification and
    //    re-fetch the run under that identity, so the server — not the browser —
    //    decides the run's outcome and classification.
    const pinnedLogin =
      typeof verifyOp.context?.githubLogin === "string" ?
        verifyOp.context.githubLogin.trim()
      : "";
    const selectedExecutor =
      dependencies.getSelectedGitHubExecutor(operationId) || undefined;
    if (!pinnedLogin || !selectedExecutor) {
      return result(409, {
        error:
          "Radius cannot confirm the GitHub account that ran verification, so the failure cannot be bypassed."
      });
    }

    if (!scope) {
      return result(503, { error: "Workflow observation stopped." });
    }
    const observationStopped = (): boolean =>
      scope.stopped || !input.isCurrent();
    if (observationStopped()) {
      return result(503, { error: "Workflow observation stopped." });
    }
    const observation = scope.observe(
      selectedExecutor,
      WORKFLOW_READ_LIMITS.verificationMs
    );
    const readVariables = createWorkflowReadBudget(
      (args, options) => selectedExecutor.run(args, options),
      20000,
      undefined,
      observation.context
    );

    // 3. Confirm the target is a Radius-managed environment, reading under the
    //    pinned executor so the check runs as the authorized identity — not the
    //    server's ambient gh auth. Anything without the RADIUS_MANAGED marker
    //    was not created by this extension and is not a valid bypass target.
    let managed = false;
    try {
      const varsResult = await readVariables(
        [
          "api",
          `/repos/${repo}/environments/${encodeURIComponent(
            envName
          )}/variables?per_page=100`,
          "--jq",
          ".variables[].name"
        ],
        { timeout: 20000 }
      );
      if (varsResult.code !== 0 && varsResult.code !== "0") {
        throw new Error(
          varsResult.stderr || varsResult.stdout || "gh api failed"
        );
      }
      managed = (varsResult.stdout || "")
        .split("\n")
        .map((line) => line.trim())
        .includes("RADIUS_MANAGED");
    } catch (e) {
      if (observationStopped()) {
        return result(503, { error: "Workflow observation stopped." });
      }
      return result(502, {
        error:
          "Could not confirm the environment before recording a bypass: " +
          dependencies.errorMessage(e)
      });
    }
    if (observationStopped()) {
      return result(503, { error: "Workflow observation stopped." });
    }
    if (!managed) {
      return result(409, {
        error:
          "That environment is not managed by Radius and cannot be bypassed."
      });
    }

    // 4. Re-fetch and re-classify the run server-side under the pinned identity.
    //    A GitHub read failure fails closed (502) like the checks above, never
    //    falling through to the outer client-error handler. Only a terminal run
    //    that genuinely *failed* (not cancelled, timed out or skipped) and whose
    //    classification is a bypassable category is allowed through.
    let detail: Awaited<ReturnType<typeof dependencies.getRunDetail>>;
    try {
      detail = await dependencies.getRunDetail(
        repo,
        runId,
        selectedExecutor,
        observation
      );
    } catch (e) {
      if (observationStopped()) {
        return result(503, { error: "Workflow observation stopped." });
      }
      return result(502, {
        error:
          "Could not read the verification run to confirm the bypass: " +
          dependencies.errorMessage(e)
      });
    }
    if (observationStopped()) {
      return result(503, { error: "Workflow observation stopped." });
    }
    if (!detail) {
      return result(502, {
        error:
          "Could not read the verification run to confirm the bypass. Try again."
      });
    }
    if (detail.status !== "completed") {
      return result(409, {
        error:
          "Credential verification is still running. Wait for it to finish before bypassing."
      });
    }
    if (detail.conclusion === "success") {
      return result(409, {
        error:
          "Credential verification passed, so there is nothing to bypass. Reload the environment list."
      });
    }
    if (detail.conclusion !== "failure") {
      return result(409, {
        error:
          "Credential verification did not fail cleanly (it may have been cancelled or timed out). Re-run verification before deciding whether to bypass."
      });
    }
    const failed = (detail.steps || []).filter(
      (s: EnvironmentRunStep) =>
        s.conclusion && s.conclusion !== "success" && s.conclusion !== "skipped"
    );
    let log: string;
    try {
      log =
        (await dependencies.fetchRunLog(
          repo,
          runId,
          selectedExecutor,
          observation
        )) || "";
    } catch (e) {
      if (observationStopped()) {
        return result(503, { error: "Workflow observation stopped." });
      }
      return result(502, {
        error:
          "Could not read the verification run log to confirm the bypass: " +
          dependencies.errorMessage(e)
      });
    }
    if (observationStopped()) {
      return result(503, { error: "Workflow observation stopped." });
    }
    const azureLoginLog = dependencies.extractGitHubActionsStepLog(
      log,
      "Azure Login (OIDC)"
    );
    const oidcHelp = dependencies.explainOidcEnterpriseClaim(azureLoginLog);
    const noSubscriptionsHelp =
      oidcHelp === "" ? dependencies.explainNoSubscriptions(log) : "";
    const classification = classifyVerifyFailure({
      failedSteps: failed,
      log,
      oidcHelp,
      noSubscriptionsHelp
    });
    if (
      !BYPASSABLE_VERIFY_CATEGORIES.has(classification.category) ||
      (input.permissionsOnly === true &&
        classification.category !== "permissions")
    ) {
      return result(409, {
        error:
          "This verification failure must be fixed before the environment can be used; it cannot be bypassed."
      });
    }

    if (observationStopped()) {
      return result(503, { error: "Workflow observation stopped." });
    }

    // 5. Record the bypass under the pinned executor, keyed to the specific run
    //    the user accepted.
    try {
      const writeResult = await selectedExecutor.run(
        [
          "variable",
          "set",
          VERIFICATION_BYPASS_VARIABLE,
          "--body",
          runId,
          "--env",
          envName,
          "--repo",
          repo
        ],
        { timeout: 20000 }
      );
      if (writeResult.code !== 0 && writeResult.code !== "0") {
        throw new Error(
          writeResult.stderr || writeResult.stdout || "gh variable set failed"
        );
      }
    } catch (e) {
      return result(500, {
        error:
          "Could not record the verification bypass: " +
          dependencies.errorMessage(e)
      });
    }
    dependencies.envListCacheDelete(repo);
    return result(200, { success: true, category: classification.category });
  } catch (e) {
    // The body already parsed; anything thrown here is a server-side failure.
    return result(500, { error: dependencies.errorMessage(e) });
  }
}
