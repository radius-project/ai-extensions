import type { syncRepoWorkflows, WorkflowCommitFailure } from "../../infra.js";

interface WorkflowPresyncResult {
  created: string[];
  updated: string[];
  failed: WorkflowCommitFailure[];
}

export function createWorkflowPresync(ports: {
  synchronize: typeof syncRepoWorkflows;
  log(message: string): void;
  errorMessage(error: unknown): string;
}) {
  async function synchronize(
    repo: string,
    environment: string,
    provider: string,
    only: string[],
    workingBranch = ""
  ): Promise<WorkflowPresyncResult> {
    if (!repo || !environment || only.length === 0)
      return { created: [], updated: [], failed: [] };
    const result = await ports.synchronize(
      repo,
      [{ name: environment, provider: provider || "" }],
      {
        workingBranch: workingBranch || "",
        only,
        create: true,
        log: (message) =>
          ports.log(`[radius workflow-presync] ${repo}: ${message}`)
      }
    );
    const changed = [...result.updated, ...result.created];
    if (changed.length)
      ports.log(
        `[radius workflow-presync] ${repo}: ${changed.join(", ")} before dispatch`
      );
    return {
      // Concurrent creation still needs the dispatcher's registration retry.
      created: [
        ...new Set([...result.created, ...(result.registrationPending || [])])
      ],
      updated: result.updated,
      failed: result.failed
    };
  }

  return {
    async bestEffort(...args: Parameters<typeof synchronize>) {
      try {
        return await synchronize(...args);
      } catch (error) {
        ports.log(
          `[radius workflow-presync] ${args[0]}: ${ports.errorMessage(error)}`
        );
        return { created: [], updated: [], failed: [] };
      }
    },
    async forDeployment(...args: Parameters<typeof synchronize>) {
      const result = await synchronize(...args);
      if (result.failed.length) {
        throw new Error(
          "Could not prepare deployment workflows: " +
            result.failed
              .map(({ path, branch }) => `${path} on ${branch}`)
              .join(", ")
        );
      }
      return result;
    }
  };
}
