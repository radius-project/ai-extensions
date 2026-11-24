import { createEnvironmentDeletionTool } from "./environment-deletion-tool.js";
import type { EnvironmentDeletionToolPorts } from "./environment-deletion-tool.js";
import type { createDeletionWorkspace } from "./deletion-workspace.js";

interface EnvironmentDeletionBinding {
  workspace: ReturnType<typeof createDeletionWorkspace>;
  openScope(
    repo: string,
    login: string,
    isCurrent: () => boolean
  ): ReturnType<EnvironmentDeletionToolPorts["openScope"]>;
  control(input: {
    command: "status" | "retry";
    operationId: string;
    repo: string;
    environment: string;
    login: string;
    retryEvidence?: string;
    isCurrent(): boolean;
  }): Promise<{ status: number; body: unknown }>;
  confirm(message: string): Promise<boolean | undefined>;
  redact(message: string): string;
}

export function bindEnvironmentDeletion(ports: EnvironmentDeletionBinding) {
  return async (args: unknown) => {
    let workspace: Awaited<ReturnType<EnvironmentDeletionBinding["workspace"]>>;
    const tool = createEnvironmentDeletionTool({
      async openScope(target) {
        workspace = await ports.workspace(target);
        return workspace && (await workspace.validate()) ?
            ports.openScope(
              workspace.repo,
              workspace.login,
              workspace.isCurrent
            )
          : null;
      },
      async confirm(target) {
        if (!workspace) return "unavailable";
        const decision = await ports.confirm(
          `Delete Azure-backed Radius environment ${JSON.stringify(target.environment)} in ${target.repo} (repository ID ${target.repoId}) as ${workspace.login}? This removes the Radius environment, GitHub environment, and dedicated state package, and can remove its Radius-owned federated credential.`
        );
        if (decision === undefined) return "unavailable";
        return decision && (await workspace.validate()) ?
            "approved"
          : "declined";
      },
      async control({ mode, operationId, environment, repo }) {
        const scope = await ports.workspace({ repo, environment });
        if (!scope || !(await scope.validate())) {
          return { kind: "refused", code: "workspace-target-unavailable" };
        }
        const input = {
          operationId,
          environment,
          repo: scope.repo,
          login: scope.login,
          isCurrent: scope.isCurrent
        };
        const status = await ports.control({ ...input, command: "status" });
        if (mode === "status" || status.status !== 200)
          return { kind: "operation_status", ...status };
        if (
          typeof status.body !== "object" ||
          status.body === null ||
          !("retryable" in status.body) ||
          status.body.retryable !== true
        ) {
          return { kind: "refused", code: "deletion-not-retryable" };
        }
        const retryEvidence =
          (
            "retryEvidence" in status.body &&
            typeof status.body.retryEvidence === "string"
          ) ?
            status.body.retryEvidence
          : undefined;
        const action =
          retryEvidence ?
            "Dispatch another delete workflow for"
          : "Retry unresolved deletion stages for";
        const decision = await ports.confirm(
          `${action} Azure-backed Radius environment ${JSON.stringify(environment)} in ${scope.repo} as ${scope.login} (operation ${operationId})?`
        );
        if (decision === undefined) {
          return {
            kind: "requires_confirmation",
            target: { repo: scope.repo, environment, operationId }
          };
        }
        if (!decision)
          return { kind: "refused", code: "confirmation-declined" };
        if (!(await scope.validate())) {
          return { kind: "refused", code: "workspace-target-unavailable" };
        }
        const result = await ports.control({
          ...input,
          command: "retry",
          ...(retryEvidence === undefined ? {} : { retryEvidence })
        });
        return { kind: "operation_retry", ...result };
      },
      redact: ports.redact
    });
    return tool(args);
  };
}
