import {
  admitEnvironmentDeletion,
  type EnvironmentDeletionTarget
} from "@radius-project/core";
import { isValidRepoSlug } from "@radius-project/core/platforms";
import type { DeleteOperationRecord } from "../server/routes/environments-types.js";
import {
  registerEnvironmentDeletion,
  scheduleRegisteredEnvironmentDeletion,
  type EnvironmentDeletionRegistrationPorts
} from "../server/services/environment-deletion-start.js";
import { environmentDiagnostic } from "./environment-tool-result.js";

export const ENVIRONMENT_DELETION_TOOL = {
  name: "radius_delete_environment",
  description:
    "Start, inspect, or retry deletion of an Azure-backed Radius environment in the current repository. Starting or retrying requires trusted user confirmation. Delete all deployed applications first; use the exact operation ID for status and retry.",
  parameters: {
    type: "object",
    required: ["repo", "environment"],
    additionalProperties: false,
    properties: {
      repo: { type: "string", description: "Current repository (owner/name)." },
      environment: {
        type: "string",
        description: "Exact name of the Azure-backed deployment environment."
      },
      mode: { type: "string", enum: ["delete", "status", "retry"] },
      operationId: {
        type: "string",
        description:
          "Exact saved deletion operation ID; required for status and retry."
      }
    }
  }
} as const;

export interface EnvironmentDeletionToolPorts {
  // Resolve the trusted workspace and account, and bind all reads, registration
  // and scheduling to that invocation. A workspace/account change invalidates
  // the scope; durable execution must use the operation's exact saved owner.
  openScope(target: EnvironmentDeletionTarget): Promise<{
    repo: string;
    login: string;
    registration: EnvironmentDeletionRegistrationPorts;
    isCurrent(): boolean;
    schedule(operation: DeleteOperationRecord): boolean;
  } | null>;
  control(
    request: EnvironmentDeletionTarget & {
      mode: "status" | "retry";
      operationId: string;
    }
  ): Promise<unknown>;
  confirm(
    target: Readonly<
      EnvironmentDeletionTarget & { provider: "azure"; repoId: number }
    >
  ): Promise<"approved" | "declined" | "unavailable">;
  redact(value: string): string;
}

export function createEnvironmentDeletionTool(
  ports: EnvironmentDeletionToolPorts
) {
  return async (args: unknown) => {
    const refusal = (code: string) => ({ kind: "refused" as const, code });
    if (
      typeof args !== "object" ||
      args === null ||
      !("repo" in args) ||
      !("environment" in args) ||
      typeof args.repo !== "string" ||
      typeof args.environment !== "string"
    ) {
      return {
        kind: "requires_input" as const,
        fields: ["repo", "environment"]
      };
    }
    const repo = args.repo.trim();
    const environment = args.environment.trim();
    if (
      !isValidRepoSlug(repo) ||
      environment.length === 0 ||
      environment.length > 255 ||
      [...environment].some((character) => character.charCodeAt(0) < 32)
    ) {
      return refusal("invalid-target");
    }
    const mode =
      "mode" in args && args.mode !== undefined ? args.mode : "delete";
    const operationId = "operationId" in args ? args.operationId : undefined;
    if (mode !== "delete" && mode !== "status" && mode !== "retry")
      return refusal("invalid-mode");
    if (mode === "delete" && operationId !== undefined)
      return refusal("unexpected-operation-id");
    const diagnostic = (error: unknown) =>
      environmentDiagnostic(
        error instanceof Error ? error.message : String(error),
        ports.redact
      );
    try {
      if (mode !== "delete") {
        if (
          typeof operationId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(operationId)
        )
          return { kind: "requires_input" as const, fields: ["operationId"] };
        return await ports.control({ repo, environment, mode, operationId });
      }
      const scope = await ports.openScope({ repo, environment });
      if (
        !scope ||
        scope.repo.toLowerCase() !== repo.toLowerCase() ||
        !scope.isCurrent()
      ) {
        return refusal("workspace-target-unavailable");
      }
      const target = { repo: scope.repo, environment };
      const admission = await admitEnvironmentDeletion(
        target,
        scope.registration,
        false
      );
      if (admission.kind !== "ready") return refusal(admission.kind);
      const { repoId, environmentId, clientId, tenantId } =
        admission.configuration;
      if (
        !Number.isSafeInteger(repoId) ||
        repoId <= 0 ||
        typeof environmentId !== "number" ||
        !Number.isSafeInteger(environmentId) ||
        environmentId <= 0 ||
        !clientId ||
        !tenantId ||
        !scope.isCurrent()
      ) {
        return refusal("target-identity-unavailable");
      }
      const confirmation = await ports.confirm({
        ...target,
        provider: "azure",
        repoId
      });
      if (confirmation === "unavailable") {
        return { kind: "requires_confirmation" as const, target };
      }
      if (confirmation !== "approved") return refusal("confirmation-declined");
      const result = await registerEnvironmentDeletion(
        target,
        scope.registration,
        false,
        {
          login: scope.login,
          acceptsConfiguration: (configuration) =>
            scope.isCurrent() &&
            configuration.repoId === repoId &&
            configuration.environmentId === environmentId &&
            configuration.clientId === clientId &&
            configuration.tenantId === tenantId
        }
      );
      if (result.kind !== "registered") return refusal(result.kind);
      const operation = result.operation;
      const scheduled = await scheduleRegisteredEnvironmentDeletion(
        operation,
        () => scope.isCurrent() && scope.schedule(operation),
        scope.registration,
        "The tool invocation no longer had an authorized runtime execution scope."
      );
      return scheduled ?
          {
            kind: "accepted" as const,
            operationId: operation.operationId,
            target
          }
        : {
            kind: "failed" as const,
            code: "operation-scheduling-failed",
            operationId: operation.operationId
          };
    } catch (error) {
      return {
        kind: "failed" as const,
        code: "environment-deletion-unavailable",
        message: diagnostic(error)
      };
    }
  };
}
