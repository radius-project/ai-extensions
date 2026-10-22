import type { DeploymentWorkflowTarget } from "./deployment-dispatch.js";

export interface DeploymentPublicationPorts {
  isCurrent(): boolean;
  publish(
    target: DeploymentWorkflowTarget,
    written: (file: string) => void
  ): Promise<void>;
  synchronize(target: DeploymentWorkflowTarget): Promise<{
    created: readonly string[];
    updated: readonly string[];
  }>;
  errorMessage(error: unknown): string;
}

export type DeploymentPublication =
  | { readonly kind: "prepared"; readonly recentlyPublished: boolean }
  | { readonly kind: "refused" | "cancelled"; readonly message: string };

export async function prepareDeploymentWorkflows(
  target: DeploymentWorkflowTarget,
  ports: DeploymentPublicationPorts
): Promise<DeploymentPublication> {
  const selected = { ...target };
  const cancelled = (): DeploymentPublication => ({
    kind: "cancelled",
    message: "Deployment preparation stopped; no workflow was dispatched."
  });
  if (!ports.isCurrent()) return cancelled();
  let published = false;
  let phase = "publish";
  try {
    await ports.publish(selected, (file) => {
      if (file.split("/").pop() === selected.workflowFile) published = true;
    });
    if (!ports.isCurrent()) return cancelled();
    phase = "synchronize";
    const sync = await ports.synchronize(selected);
    if (!ports.isCurrent()) return cancelled();
    return {
      kind: "prepared",
      recentlyPublished:
        published ||
        [...sync.created, ...sync.updated].some(
          (file) => file.split("/").pop() === selected.workflowFile
        )
    };
  } catch (error) {
    if (!ports.isCurrent()) return cancelled();
    return {
      kind: "refused",
      message: `Could not ${phase} deploy workflows on branch "${selected.branch}": ${ports.errorMessage(error)}. No workflow was dispatched.`
    };
  }
}
