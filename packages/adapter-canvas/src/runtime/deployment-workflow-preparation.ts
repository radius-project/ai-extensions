import {
  DEPLOY_DISPATCHER_FILE,
  DEPLOY_AZURE_FILE,
  syncRepoWorkflows,
  type WorkflowSyncPorts
} from "../infra.js";

export function createDeploymentWorkflowPreparation(
  workflows: WorkflowSyncPorts,
  ports: {
    sync: typeof syncRepoWorkflows;
    log(message: string): void;
  }
) {
  return {
    async publish(
      repo: string,
      branch: string,
      environment: string,
      log: (message: string) => void,
      written: (file: string) => void
    ): Promise<void> {
      if (!repo || !branch || !environment)
        throw new Error(
          "Deployment publication requires a repository, branch and environment."
        );
      const wanted = [DEPLOY_DISPATCHER_FILE, DEPLOY_AZURE_FILE];
      const presence = await Promise.all(
        wanted.map(async (file) => {
          const content = await workflows.fetchFileFromRepo(
            repo,
            ".github/workflows/" + file,
            branch
          );
          return content !== null && content !== "";
        })
      );
      const missing = wanted.filter((_, index) => !presence[index]);
      if (missing.length === 0) return;
      log(
        'Publishing deploy workflow(s) to branch "' +
          branch +
          '": ' +
          missing.join(", ")
      );
      const generated = await workflows.generateDeployWorkflow(
        environment,
        ".radius/app.bicep"
      );
      for (const file of missing) {
        const content = generated[file];
        if (!content)
          throw new Error(`The deployment template did not provide ${file}.`);
        const changed = await workflows.commitFileToRepo(
          repo,
          ".github/workflows/" + file,
          content,
          branch,
          "Add Radius deploy workflow (" +
            file +
            ") to " +
            branch +
            " for worktree-consistent deploy"
        );
        if (changed) written(file);
      }
    },
    async synchronize(
      repo: string,
      environment: string,
      provider: string,
      only: string[],
      workingBranch: string
    ) {
      if (!repo || !environment || !workingBranch || only.length === 0)
        throw new Error(
          "Deployment synchronization requires an explicit target and workflow."
        );
      await workflows.generateDeployWorkflow(environment, ".radius/app.bicep");
      const result = await ports.sync(
        repo,
        [{ name: environment, provider }],
        {
          workingBranch,
          only,
          create: true,
          log: (message) =>
            ports.log(`[radius workflow-presync] ${repo}: ${message}`)
        },
        workflows
      );
      if (result.failed.length > 0) {
        throw new Error(
          "Could not prepare deployment workflows: " +
            result.failed
              .map(({ path, branch }) => `${path} on ${branch}`)
              .join(", ")
        );
      }
      const changed = [...result.updated, ...result.created];
      if (changed.length)
        ports.log(
          `[radius workflow-presync] ${repo}: ${changed.join(", ")} before dispatch`
        );
      return {
        created: [
          ...new Set([...result.created, ...(result.registrationPending ?? [])])
        ],
        updated: result.updated
      };
    }
  };
}
