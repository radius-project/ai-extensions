import { redactCredentials } from "@radius-project/core";
import { isValidRepoSlug } from "../azure-oidc.js";
import {
  buildDeployPayload,
  describeDeployStarted,
  summarizeDeployStatus,
  validateDeployPayload,
  type DeployToolArgs
} from "../deploy-tools.js";
import type { CanvasState } from "../shared.js";
import type { createDeploymentController } from "./deployment-controller.js";
import type {
  DeploymentExecution,
  DeploymentExecutionOwner,
  DeploymentResolution
} from "./deployment-execution-owner.js";
import { errorMessage } from "./util.js";

export interface DirectDeploymentToolsPorts {
  owner: DeploymentExecutionOwner;
  controller: ReturnType<typeof createDeploymentController>;
  notifications: readonly ((execution: DeploymentExecution) => unknown)[];
  reportError(error: unknown): void;
  redactDiagnostic(value: string): string;
}

function assertDeploymentInput(
  input: unknown
): asserts input is Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("Deployment arguments must be an object.");
}

function readArguments(
  input: Readonly<Record<string, unknown>>
): DeployToolArgs {
  const result: DeployToolArgs = {};
  for (const key of [
    "attemptId",
    "repo",
    "environment",
    "branch",
    "provider",
    "appFile"
  ] as const) {
    const value = input[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || !value.trim())
      throw new Error(`${key} must be a nonempty string.`);
    result[key] = value;
  }
  if (result.repo && !isValidRepoSlug(result.repo))
    throw new Error("repo must use the owner/repository format.");
  if (
    result.provider &&
    result.provider !== "azure" &&
    result.provider !== "aws"
  )
    throw new Error("provider must be azure or aws.");
  return result;
}

function resolutionMessage(
  resolution: Exclude<DeploymentResolution, { kind: "resolved" }>
): string {
  if (resolution.kind === "ambiguous")
    return (
      "Multiple deployment contexts are available. Specify an attemptId for status or repair, or an explicit deployment target.\n" +
      resolution.choices
        .slice(0, 10)
        .map(
          ({ attemptId, target }) =>
            `${attemptId}: ${target.repo}, ${target.environment}, ${target.branch}`
        )
        .join("\n")
    );
  if (resolution.kind === "shutdown")
    return "The deployment runtime has stopped; no deployment was started or observed.";
  if (resolution.kind === "retargeted")
    return "A repair cannot change the deployment target. Start a new explicit deployment without attemptId instead.";
  if (resolution.kind === "stale")
    return "The requested deployment attempt is no longer active. Select the intended deployment instead of repairing a replacement.";
  return "No deployment context is available. Pass repo and environment to radius_deploy, with branch when selecting a specific committed branch.";
}

export function createDirectDeploymentTools(ports: DirectDeploymentToolsPorts) {
  const diagnostic = (error: unknown) =>
    redactCredentials(ports.redactDiagnostic(errorMessage(error))).slice(
      0,
      4000
    );
  return {
    shutdown: () => ports.owner.shutdown(),
    hasPendingWork: () => ports.owner.hasPendingWork(),
    async start(input: unknown): Promise<string> {
      try {
        assertDeploymentInput(input);
        const args = readArguments(input);
        let resolved = ports.owner.resolve(args);
        if (
          !args.attemptId &&
          !args.repo &&
          !args.environment &&
          resolved.kind === "missing"
        ) {
          const previous = ports.owner.resolve();
          if (previous.kind === "resolved") resolved = previous;
        }
        if (
          resolved.kind !== "resolved" &&
          (resolved.kind !== "missing" || !args.repo || !args.environment)
        )
          return resolutionMessage(resolved);
        const previous =
          resolved.kind === "resolved" ?
            ports.owner.execution(resolved.invocation)
          : undefined;
        if (resolved.kind === "resolved" && !previous)
          return resolutionMessage({ kind: "stale" });
        const source: CanvasState =
          previous ? structuredClone(previous.state) : {};
        if (previous) {
          const target = previous.invocation.target;
          source.deployParams = {
            targetRepo: target.repo,
            environment: target.environment,
            branch: target.branch,
            provider: target.provider,
            appFile: target.appFile
          };
        }
        const payload = buildDeployPayload(args, source);
        const invalid = validateDeployPayload(payload);
        if (invalid) return invalid;
        const result = await ports.controller.start({
          data: payload,
          source,
          isCurrent: () =>
            !ports.owner.stopped &&
            (!previous ||
              ports.owner.execution(previous.invocation) === previous),
          // Presentation subscribes independently; a tool never creates a panel.
          present: () => {},
          notifications: ports.notifications
        });
        if (result.kind === "refused")
          return `Could not start the deploy: ${diagnostic(result.message)}`;
        return (
          describeDeployStarted(
            {
              targetRepo: result.execution.invocation.target.repo,
              environment: result.execution.invocation.target.environment,
              branch: result.execution.invocation.target.branch
            },
            result
          ) + ` Attempt ID: ${result.execution.invocation.attemptId}.`
        );
      } catch (error) {
        return `Could not start the deploy: ${diagnostic(error)}`;
      }
    },
    async status(input: unknown): Promise<string> {
      try {
        assertDeploymentInput(input);
        const args = readArguments(input);
        const resolved = ports.owner.resolve(args);
        if (resolved.kind !== "resolved") return resolutionMessage(resolved);
        const execution = ports.owner.execution(resolved.invocation);
        if (!execution) return resolutionMessage({ kind: "stale" });
        for (const notify of ports.notifications) {
          if (ports.owner.execution(resolved.invocation) !== execution)
            return resolutionMessage({ kind: "stale" });
          try {
            await notify(execution);
          } catch (error) {
            ports.reportError(new Error(diagnostic(error)));
          }
        }
        if (ports.owner.execution(resolved.invocation) !== execution)
          return resolutionMessage({ kind: "stale" });
        const state = ports.owner.snapshot(resolved.invocation);
        if (!state) return resolutionMessage({ kind: "stale" });
        const summary = summarizeDeployStatus(
          {
            status: state.deployStatus,
            errorKind: state.deployErrorKind,
            deployRunUrl: state.deployRunUrl,
            startedAt: state.deployStartedAt,
            finishedAt: state.deployFinishedAt,
            error:
              state.deployError ?
                execution.executor.redact(state.deployError)
              : undefined,
            logs: state.deployLogs?.map(execution.executor.redact)
          },
          typeof input.logLines === "number" ? input.logLines : undefined
        );
        return JSON.stringify({
          ...summary,
          attemptId: resolved.invocation.attemptId
        });
      } catch (error) {
        return `Could not read the deploy status: ${diagnostic(error)}`;
      }
    }
  };
}

export type DirectDeploymentTools = ReturnType<
  typeof createDirectDeploymentTools
>;
