import { needsWorkflowScope } from "./setup-workflow-scope.js";

export interface DeploymentWorkflowTarget {
  readonly repo: string;
  readonly branch: string;
  readonly environment: string;
  readonly workflowFile: string;
}

export interface DeploymentWorkflowReference extends DeploymentWorkflowTarget {
  readonly dispatchedAt: number;
  readonly baselineRunId: number | string | null;
}

export interface DeploymentDispatchCommand {
  readonly result: {
    readonly code: number | string;
    readonly stdout: string;
    readonly stderr: string;
    readonly timedOut?: boolean;
  };
  readonly credentialSource: "injected" | "keyring";
}

export type DeploymentDispatchEvidence =
  | {
      readonly kind: "refused";
      readonly reason: "baseline-unavailable" | "cancelled";
      readonly message: string;
    }
  | {
      readonly kind: "accepted";
      readonly reference: DeploymentWorkflowReference;
      readonly command: DeploymentDispatchCommand;
    }
  | {
      readonly kind: "refused" | "uncertain";
      readonly reason: "dispatch";
      readonly reference: DeploymentWorkflowReference;
      readonly message: string;
      readonly command?: DeploymentDispatchCommand;
    };

export interface DeploymentDispatchPorts {
  isCurrent(): boolean;
  latestRunId(): Promise<number | string | null>;
  dispatch(): Promise<DeploymentDispatchCommand>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  errorMessage(error: unknown): string;
}

function validBaseline(value: number | string | null): boolean {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value > 0) ||
    (typeof value === "string" &&
      /^[1-9][0-9]*$/.test(value) &&
      Number.isSafeInteger(Number(value)))
  );
}

function cancelled(): DeploymentDispatchEvidence {
  return {
    kind: "refused",
    reason: "cancelled",
    message: "Deployment observation stopped before dispatch."
  };
}

export function classifyDeploymentDispatchFailure(
  message: string
): "branch-not-pushed" | "run-unconfirmed" {
  return (
      /no ref found|no commit found for the ref|could not resolve (?:ref\b|branch\b|to a commit\b)/i.test(
        message
      )
    ) ?
      "branch-not-pushed"
    : "run-unconfirmed";
}

export async function coordinateDeploymentDispatch(
  target: DeploymentWorkflowTarget,
  recentlyPublished: boolean,
  ports: DeploymentDispatchPorts
): Promise<DeploymentDispatchEvidence> {
  const selectedTarget = { ...target };
  let delay = recentlyPublished ? 3000 : 0;
  let retries = 0;
  while (true) {
    if (!ports.isCurrent()) return cancelled();
    if (delay > 0) await ports.sleep(delay);
    if (!ports.isCurrent()) return cancelled();
    let baselineRunId: number | string | null;
    try {
      baselineRunId = await ports.latestRunId();
      if (!validBaseline(baselineRunId)) {
        throw new Error("The workflow run baseline is malformed.");
      }
    } catch (error) {
      if (!ports.isCurrent()) return cancelled();
      return {
        kind: "refused",
        reason: "baseline-unavailable",
        message: ports.errorMessage(error)
      };
    }
    if (!ports.isCurrent()) return cancelled();
    const reference: DeploymentWorkflowReference = {
      ...selectedTarget,
      baselineRunId,
      dispatchedAt: ports.now()
    };
    let command: DeploymentDispatchCommand;
    try {
      command = await ports.dispatch();
    } catch (error) {
      return {
        kind: "uncertain",
        reason: "dispatch",
        reference,
        message: ports.errorMessage(error)
      };
    }
    if (!ports.isCurrent() || command.result.timedOut) {
      return {
        kind: "uncertain",
        reason: "dispatch",
        reference,
        command,
        message:
          command.result.stderr ||
          "The dispatch may have been accepted; do not dispatch it again."
      };
    }
    if (command.result.code === 0) {
      return { kind: "accepted", reference, command };
    }
    const message = command.result.stderr.trim();
    const registrationRejection = /\bHTTP 404\b/i.test(message);
    if (recentlyPublished && registrationRejection && retries < 2) {
      delay = retries === 0 ? 2000 : 5000;
      retries++;
      continue;
    }
    const rejected =
      /\bHTTP 4(?!08\b|99\b)[0-9]{2}\b/i.test(message) ||
      needsWorkflowScope(message) ||
      classifyDeploymentDispatchFailure(message) === "branch-not-pushed" ||
      command.result.code === "ENOENT";
    return {
      kind: rejected ? "refused" : "uncertain",
      reason: "dispatch",
      reference,
      command,
      message
    };
  }
}
