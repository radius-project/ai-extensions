import {
  checkDeploymentBranch,
  type DeploymentBranchPorts
} from "./deployment-branch.js";
import {
  validateDeploymentAzureIdentity,
  type DeploymentAzurePorts
} from "./deployment-azure-preflight.js";
import {
  prepareDeploymentCommands,
  type DeploymentCommandPorts
} from "./deployment-commands.js";
import {
  prepareDeploymentWorkflows,
  type DeploymentPublicationPorts
} from "./deployment-publication.js";
import {
  coordinateDeploymentDispatch,
  type DeploymentDispatchPorts,
  type DeploymentDispatchEvidence,
  type DeploymentDispatchCommand,
  type DeploymentWorkflowTarget
} from "./deployment-dispatch.js";

export interface DeploymentStartTarget extends DeploymentWorkflowTarget {
  readonly provider: string;
  readonly appFile?: string;
}

export interface DeploymentStartPorts {
  isCurrent(): boolean;
  errorMessage(error: unknown): string;
  branch: Pick<DeploymentBranchPorts, "head" | "defaultBranch">;
  azure: Omit<DeploymentAzurePorts, "errorMessage">;
  commands: Omit<DeploymentCommandPorts, "isCurrent" | "errorMessage">;
  publication: Omit<DeploymentPublicationPorts, "isCurrent" | "errorMessage">;
  dispatch: Omit<
    DeploymentDispatchPorts,
    "isCurrent" | "errorMessage" | "dispatch"
  > & {
    dispatch(
      target: DeploymentWorkflowTarget,
      commands: readonly string[]
    ): Promise<DeploymentDispatchCommand>;
  };
  onCommands(application: string, commands: readonly string[]): void;
  onAzureNote(status: "skipped" | "unverified", message: string): void;
  onDispatchReady(target: DeploymentWorkflowTarget): void;
}

export type DeploymentStartResult =
  | { readonly kind: "cancelled" }
  | {
      readonly kind: "refused";
      readonly reason:
        | "branch-not-pushed"
        | "oidc-subject-missing"
        | "oidc-subject-case-mismatch"
        | "preparation";
      readonly message: string;
    }
  | {
      readonly kind: "dispatch";
      readonly evidence: DeploymentDispatchEvidence;
      readonly recentlyPublished: boolean;
    };

export async function startDeployment(
  target: DeploymentStartTarget,
  ports: DeploymentStartPorts
): Promise<DeploymentStartResult> {
  const selected = { ...target };
  const workflow: DeploymentWorkflowTarget = {
    repo: selected.repo,
    branch: selected.branch,
    environment: selected.environment,
    workflowFile: selected.workflowFile
  };
  const lifetime = {
    isCurrent: ports.isCurrent,
    errorMessage: ports.errorMessage
  };
  const cancelled: DeploymentStartResult = { kind: "cancelled" };
  const refused = (message: string): DeploymentStartResult => ({
    kind: "refused",
    reason: "preparation",
    message
  });
  if (!ports.isCurrent()) return cancelled;
  let prepared: { commands: readonly string[]; recentlyPublished: boolean };
  try {
    const branch = await checkDeploymentBranch(selected.repo, selected.branch, {
      ...ports.branch,
      ...lifetime
    });
    if (branch.kind === "cancelled" || !ports.isCurrent()) return cancelled;
    if (branch.kind === "refused") return refused(branch.message);
    if (branch.kind === "missing") {
      return {
        kind: "refused",
        reason: "branch-not-pushed",
        message: `The branch "${selected.branch}" has not been pushed to ${selected.repo}. Commit and push it before deploying.`
      };
    }
    if (selected.provider === "azure") {
      const azure = await validateDeploymentAzureIdentity(
        selected.repo,
        selected.environment,
        {
          ...ports.azure,
          errorMessage: ports.errorMessage
        }
      );
      if (!ports.isCurrent()) return cancelled;
      if (azure.status === "missing" || azure.status === "case-mismatch") {
        return {
          kind: "refused",
          reason:
            azure.status === "missing" ?
              "oidc-subject-missing"
            : "oidc-subject-case-mismatch",
          message: azure.message
        };
      }
      if (azure.status === "skipped" || azure.status === "unverified")
        ports.onAzureNote(azure.status, azure.message);
    }
    if (!ports.isCurrent()) return cancelled;
    const commands = await prepareDeploymentCommands(selected, {
      ...ports.commands,
      ...lifetime
    });
    if (commands.kind === "cancelled" || !ports.isCurrent()) return cancelled;
    if (commands.kind !== "ready") return refused(commands.message);
    ports.onCommands(commands.application, commands.commands);
    if (!ports.isCurrent()) return cancelled;
    const publication = await prepareDeploymentWorkflows(workflow, {
      ...ports.publication,
      ...lifetime
    });
    if (publication.kind === "cancelled" || !ports.isCurrent())
      return cancelled;
    if (publication.kind !== "prepared") return refused(publication.message);
    ports.onDispatchReady(workflow);
    prepared = {
      commands: commands.commands,
      recentlyPublished: publication.recentlyPublished
    };
  } catch (error) {
    if (!ports.isCurrent()) return cancelled;
    return refused(
      "Could not prepare deployment: " + ports.errorMessage(error)
    );
  }
  const evidence = await coordinateDeploymentDispatch(
    workflow,
    prepared.recentlyPublished,
    {
      ...ports.dispatch,
      ...lifetime,
      dispatch: () => ports.dispatch.dispatch(workflow, prepared.commands)
    }
  );
  return {
    kind: "dispatch",
    evidence,
    recentlyPublished: prepared.recentlyPublished
  };
}
