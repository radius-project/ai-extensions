import {
  createDeploymentAdmissionStore,
  deploymentAdmissionRunTitle,
  exactTerminalDeploymentRun,
  reconcileDeploymentAdmission,
  type ProductionDeploymentPorts
} from "@radius-project/adapter-shared";
import { DELETE_APP_DISPATCHER_FILE } from "@radius-project/core";
import { findPendingWorkflow } from "./find-pending-workflow.js";

type Acquire = NonNullable<ProductionDeploymentPorts["admission"]>["acquire"];

export function createWorkflowAdmission(
  store: ReturnType<typeof createDeploymentAdmissionStore>,
  readGitHub: (args: string[]) => Promise<unknown>,
  selectedReader?: (
    login: string
  ) => Promise<(args: string[]) => Promise<unknown>>
): { acquire: Acquire } {
  return {
    async acquire({
      repo,
      environment,
      workflowFile,
      application,
      correlation,
      startedAt
    }) {
      const location = await readGitHub(["api", `/repos/${repo}`]);
      if (
        typeof location !== "object" ||
        !location ||
        !("id" in location) ||
        typeof location.id !== "number" ||
        !Number.isSafeInteger(location.id) ||
        location.id < 1 ||
        !("full_name" in location) ||
        typeof location.full_name !== "string" ||
        location.full_name.toLowerCase() !== repo.toLowerCase()
      )
        throw new Error(
          "Could not verify the repository for workflow admission."
        );
      const key = {
        host: "github.com",
        repositoryId: location.id,
        environment
      };
      const readRun = (id: number) =>
        readGitHub(["api", `/repos/${repo}/actions/runs/${id}`]);
      const existing = await store.read(key);
      if (existing) {
        const account =
          existing.record.deploymentId ? existing.record.account : "";
        const readPending =
          account ? await selectedReader?.(account) : readGitHub;
        if (!readPending) return null;
        if (
          !(await reconcileDeploymentAdmission(
            {
              key,
              repo,
              account,
              workflow: DELETE_APP_DISPATCHER_FILE,
              pending: existing
            },
            {
              readRun: (id) =>
                readPending(["api", `/repos/${repo}/actions/runs/${id}`]),
              discover: (correlation, since, workflow) =>
                findPendingWorkflow(
                  readPending,
                  repo,
                  workflow,
                  correlation,
                  since
                ),
              release: store.release
            }
          ))
        )
          return null;
      }
      const record = {
        account: "ambient",
        workflow: workflowFile,
        environment,
        application,
        correlation,
        startedAt
      };
      const lease = await store.acquire(key, record);
      if (!lease) return null;
      return {
        async settle(evidence) {
          if (evidence.kind === "terminal-candidate") {
            const id =
              typeof evidence.runId === "number" ? evidence.runId
              : /^[1-9]\d*$/.test(evidence.runId) ? Number(evidence.runId)
              : 0;
            if (
              !Number.isSafeInteger(id) ||
              id < 1 ||
              !exactTerminalDeploymentRun(await readRun(id), {
                repo,
                repositoryId: key.repositoryId,
                runId: id,
                workflow: workflowFile,
                title: deploymentAdmissionRunTitle(workflowFile, record)
              })
            )
              throw new Error(
                "Cannot verify terminal workflow admission evidence."
              );
          }
          await store.release(key, lease.nonce);
        }
      };
    }
  };
}
