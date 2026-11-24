import {
  createDeploymentAdmissionStore,
  reconcileDeploymentAdmission
} from "@radius-project/adapter-shared";
import { DELETE_APP_DISPATCHER_FILE } from "@radius-project/core";
import { findPendingWorkflow } from "./find-pending-workflow.js";
import type { GuardedDeletionAdmission } from "./selected-application-deletion.js";

export function createGuardedDeletionAdmission(
  store: ReturnType<typeof createDeploymentAdmissionStore>
): GuardedDeletionAdmission {
  return {
    async acquire({
      executor,
      target,
      approvedRunId,
      dispatch,
      assertCurrent
    }) {
      async function read(args: string[]): Promise<unknown> {
        const result = await executor.run(args, {
          timeout: 10000,
          beforeExecute: assertCurrent
        });
        if (result.code !== 0)
          throw new Error("Could not verify GitHub deployment admission.");
        return JSON.parse(result.stdout);
      }

      const repo = await read(["api", `/repos/${target.repo}`]);
      if (
        !repo ||
        typeof repo !== "object" ||
        !("id" in repo) ||
        typeof repo.id !== "number" ||
        !Number.isSafeInteger(repo.id) ||
        repo.id < 1 ||
        !("full_name" in repo) ||
        typeof repo.full_name !== "string" ||
        repo.full_name.toLowerCase() !== target.repo.toLowerCase() ||
        !target.deploymentId
      )
        throw new Error("Could not verify the repository for deletion.");
      const key = {
        host: "github.com",
        repositoryId: repo.id,
        environment: target.environment
      };
      const pending = await store.read(key);
      const conflict = () =>
        new Error(
          "A same-host deployment admission is pending. Wait for its verified GitHub outcome before retrying."
        );
      if (pending) {
        const released = await reconcileDeploymentAdmission(
          {
            key,
            repo: target.repo,
            account: executor.login,
            workflow: DELETE_APP_DISPATCHER_FILE,
            pending
          },
          {
            discover: (correlation, since, workflow) =>
              findPendingWorkflow(
                read,
                target.repo,
                workflow,
                correlation,
                since
              ),
            readRun: (id) =>
              read(["api", `/repos/${target.repo}/actions/runs/${id}`]),
            release: store.release
          }
        );
        if (!released) throw conflict();
      }
      assertCurrent();
      const lease = await store.acquire(key, {
        ...dispatch,
        account: executor.login,
        application: target.application,
        environment: target.environment,
        deploymentId: target.deploymentId,
        approvedRunId
      });
      if (!lease) throw conflict();
      return {
        repositoryId: key.repositoryId,
        async release() {
          await store.release(key, lease.nonce);
        }
      };
    }
  };
}
