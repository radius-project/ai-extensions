import type { SetupCoordinatorStageResult } from "@radius-project/core";
import { errorMessage } from "../../runtime/util.js";

export type SetupInput<T> = { data: T } | { error: unknown };

export interface SetupPublicResult {
  status: number;
  body: Record<string, unknown>;
}

export type SetupOutcome = SetupPublicResult & {
  kind:
    | "completed"
    | "stopped"
    | "input-required"
    | "reconciling"
    | "failed"
    | "refused";
};

export interface SetupServices {
  authorizeAzure(request: Record<string, unknown>): Promise<SetupOutcome>;
  configureEnvironment(
    request: Record<string, unknown>,
    instanceId?: string,
    isCurrentPresentation?: () => boolean
  ): Promise<SetupOutcome>;
}

export function setupStageResult(
  outcome: SetupOutcome
): SetupCoordinatorStageResult {
  if (outcome.kind === "reconciling") {
    return { kind: "reconciling", message: outcome.body.message };
  }
  if (outcome.kind === "input-required") {
    return { kind: "input-required", clientId: outcome.body.clientId };
  }
  if (outcome.kind === "failed" || outcome.kind === "refused") {
    throw new Error(
      String(
        outcome.body.error || `Request failed with HTTP ${outcome.status}.`
      )
    );
  }
  return {
    kind: "completed",
    clientId: outcome.kind === "stopped" ? undefined : outcome.body.clientId
  };
}

// Match the former JSON request boundary, including omitted undefined fields
// and isolation of nested request values from mutations in setup callbacks.
export function copySetupRequest(
  request: Record<string, unknown>
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(request));
}

export function setupHandlerFailure(
  error: unknown,
  report: (diagnostic: { code: string; message: string }) => void
): SetupOutcome {
  const code = "setup-handler-failed";
  try {
    report({
      code,
      message: errorMessage(error)
    });
  } catch {
    // Retain the public failure even when diagnostic reporting fails.
  }
  return {
    kind: "failed",
    status: 500,
    body: {
      error:
        "Setup could not finish reporting its outcome. In the Environments panel, open Show details and select Download diagnostic snapshot to review the recorded status before deciding whether to retry.",
      code
    }
  };
}
