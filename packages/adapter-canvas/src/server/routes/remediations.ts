import {
  buildRemediation,
  remediationSessionMessage
} from "@radius-project/core";
import type {
  Remediation,
  RemediationResult,
  RemediationSessionMessage
} from "@radius-project/core";
import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";

// Hand a suggested terminal command to the Copilot session on the user's behalf.
//
// The canvas server deliberately does not run these itself. Every remediation it
// offers is an interactive CLI flow — a device-code login, a browser
// authorization, a push that may prompt for credentials — and running one here
// would block the loopback server for as long as the user took to finish it.
// The same reasoning is recorded on /api/verify-azure-login.
//
// The security boundary is the id, not the text. A client names a remediation
// and its parameters; this route rebuilds the command from the registry in
// core and ignores any command text the client sent. A client therefore cannot
// name a command the registry does not already offer, and cannot smuggle one
// through a parameter, because every parameter is validated to a structural
// shape (GUID, GitHub login, git branch) before it reaches an argv.

export interface SessionPromptOutcome {
  status: number;
  error?: string;
}

// Shaped exactly like the session-prompt seam the identity-auth routes use, so
// the composition root can bind both to the same live handler.
export interface RemediationDependencies {
  buildRemediation(id: unknown, params: unknown): RemediationResult;
  remediationSessionMessage(
    remediation: Remediation
  ): RemediationSessionMessage;
  runSessionPrompt(
    message: RemediationSessionMessage
  ): Promise<SessionPromptOutcome>;
  errorMessage(error: unknown): string;
}

export const RUN_REMEDIATION_PATH = "/api/run-remediation";

/**
 * Run a remediation by id.
 *
 * Statuses, and why each one is distinct:
 * - `200` the command was handed to the session.
 * - `400` the body was malformed, or the registry refused the id/parameters.
 * - `409` a high-impact command was requested without explicit confirmation.
 * - `502` the session rejected the prompt.
 * - `503` no session is reachable.
 *
 * The 502/503 split is written dynamically from the session outcome, matching
 * `/api/azure-cli-assist`: collapsing them would hide whether the canvas could
 * not reach Copilot at all or Copilot declined the turn.
 */
export async function handleRunRemediation(
  context: CanvasRequestContext,
  dependencies: RemediationDependencies
): Promise<void> {
  const body = await context.readTextBody();
  let data: unknown;
  try {
    data = JSON.parse(body || "{}");
  } catch (e) {
    context.json(400, {
      error: dependencies.errorMessage(e) || "Bad request."
    });
    return;
  }
  const request =
    typeof data === "object" && data !== null ?
      (data as Record<string, unknown>)
    : {};

  const result = dependencies.buildRemediation(request.id, request.params);
  if (!result.ok) {
    context.json(400, {
      error: result.reason,
      code: "remediation-unavailable"
    });
    return;
  }

  const { remediation } = result;
  // Fail closed on the impact classification rather than on the caller's word:
  // a machine-wide account switch, a token scope grant, or a remote write only
  // proceeds when the client states the user confirmed that specific step.
  if (remediation.impact === "high" && request.confirmed !== true) {
    context.json(409, {
      error: `Running \`${remediation.displayCommand}\` needs an explicit confirmation.`,
      code: "confirmation-required",
      command: remediation.displayCommand
    });
    return;
  }

  const outcome = await dependencies.runSessionPrompt(
    dependencies.remediationSessionMessage(remediation)
  );
  if (outcome.error) {
    context.json(outcome.status, { error: outcome.error });
    return;
  }

  context.json(200, {
    success: true,
    id: remediation.id,
    command: remediation.displayCommand,
    message: `Asked Copilot to run \`${remediation.displayCommand}\`. ${remediation.followUp}`
  });
}

export function createRemediationRoutes(
  dependencies: RemediationDependencies
): RouteHandlerRegistry {
  return {
    [`POST ${RUN_REMEDIATION_PATH}`]: (context) =>
      handleRunRemediation(context, dependencies)
  };
}

/**
 * Production seams for the remediation route: the registry from core plus the
 * session-prompt hook and error formatter bound at the composition root.
 */
export function productionRemediationDependencies(seams: {
  runSessionPrompt(
    message: RemediationSessionMessage
  ): Promise<SessionPromptOutcome>;
  errorMessage(error: unknown): string;
}): RemediationDependencies {
  return {
    buildRemediation,
    remediationSessionMessage,
    runSessionPrompt: seams.runSessionPrompt,
    errorMessage: seams.errorMessage
  };
}
