import type {
  DeploymentRuntime,
  DeploymentWorkspace,
  DeploymentStartInput
} from "@radius-project/adapter-shared";
import {
  describeDeployStarted,
  summarizeDeployStatus
} from "../deploy-tools.js";
import { errorMessage } from "./util.js";

export interface DeploymentToolsPorts {
  runtime: DeploymentRuntime;
  workspace(): Promise<DeploymentWorkspace | undefined>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalText(
  input: Record<string, unknown>,
  name: string
): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string.`);
  return value;
}

export function createDeploymentTools(ports: DeploymentToolsPorts) {
  return {
    async start(args: Record<string, unknown> = {}): Promise<string> {
      try {
        const input: DeploymentStartInput = {
          repo: optionalText(args, "repo"),
          branch: optionalText(args, "branch"),
          environment: optionalText(args, "environment"),
          provider: optionalText(args, "provider"),
          appFile: optionalText(args, "appFile"),
          attemptId: optionalText(args, "attemptId")
        };
        if (args.observationId !== undefined)
          throw new Error(
            "An observationId only reads status; it cannot authorize a repair."
          );
        const workspace = await ports.workspace();
        const result: unknown = await ports.runtime.start(input, { workspace });
        if (!record(result))
          throw new Error(
            "The deployment service returned an invalid start result."
          );
        if (result.ok === false && typeof result.error === "string")
          return `Could not start the deploy: ${result.error}`;
        if (
          result.ok !== true ||
          !record(result.invocation) ||
          typeof result.invocation.observationId !== "string"
        )
          throw new Error(
            "The deployment service did not confirm an admitted attempt."
          );
        const observationId = result.invocation.observationId;
        const current = ports.runtime.owner.lookup({ observationId });
        if (
          current.kind !== "found" ||
          !Object.is(current.invocation, result.invocation)
        )
          throw new Error("The admitted deployment is no longer current.");
        const { target } = current.invocation;
        return (
          describeDeployStarted(
            {
              targetRepo: target.repo,
              branch: target.branch,
              environment: target.environment
            },
            result
          ) +
          ` Observe this invocation with radius_deploy_status using observationId "${observationId}".`
        );
      } catch (error) {
        return `Could not start the deploy: ${errorMessage(error)}`;
      }
    },

    async status(args: Record<string, unknown> = {}): Promise<string> {
      try {
        if (args.attemptId !== undefined && args.observationId !== undefined)
          throw new Error("Pass either attemptId or observationId, not both.");
        const attemptId = optionalText(args, "attemptId");
        const observationId = optionalText(args, "observationId");
        if (
          args.logLines !== undefined &&
          (typeof args.logLines !== "number" || !Number.isFinite(args.logLines))
        )
          throw new Error("logLines must be a finite number.");
        const current = ports.runtime.owner.lookup({
          attemptId,
          observationId
        });
        if (current.kind === "ambiguous")
          return "More than one deployment is known. Pass the observationId returned when this deployment started.";
        if (current.kind !== "found")
          return "No matching deployment attempt is available. Start a deployment or use its current observationId.";
        const { invocation } = current;
        const state = invocation.state;
        if (
          state.deployAttempt?.id !== invocation.attemptId ||
          state.deployGeneration !== invocation.generation
        )
          throw new Error(
            "The deployment service returned an inconsistent attempt."
          );
        return JSON.stringify({
          observationId: invocation.observationId,
          ...summarizeDeployStatus(
            {
              status: state.deployStatus,
              errorKind: state.deployErrorKind,
              deployRunUrl: state.deployRunUrl,
              startedAt: state.deployStartedAt,
              finishedAt: state.deployFinishedAt,
              error: state.deployError,
              logs: state.deployLogs
            },
            args.logLines
          )
        });
      } catch (error) {
        return `Could not read the deploy status: ${errorMessage(error)}`;
      }
    }
  };
}
