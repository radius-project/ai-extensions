import { observeWorkflowRun } from "@radius-project/core";
import { readWorkflowRun } from "@radius-project/adapter-shared";
import {
  createDeployMonitorService,
  type DeployMonitorDependencies
} from "../../../src/server/services/deploy-monitor.js";
import { settleDeployStatuses } from "../../../src/deploy-artifacts.js";

export function createUnconfirmedMonitor(
  conclusion: string | null,
  dispatch?: DeployMonitorDependencies["dispatch"]
) {
  const reads: string[][] = [];
  const sleeps: number[] = [];
  let dispatches = 0;
  const monitor = createDeployMonitorService({
    plannedGraph: { recover: async () => null },
    dispatch: dispatch ?? {
      prepareAndDispatch: async () => {
        dispatches++;
        return {
          dispatched: true,
          workflowFile: "run-rad-commands.yml",
          dispatchedAt: 1,
          environment: "production",
          baselineRunId: null
        };
      }
    },
    outcome: {
      settle: () => {
        throw new Error("Unconfirmed outcome must not settle");
      }
    },
    deployRadCommandsStep: "Run rad commands",
    unconfirmedRunKind: "run-unconfirmed",
    findWorkflowRun: async () => 42,
    getRunDetail: (repo, runId) =>
      observeWorkflowRun(
        { repo, runId },
        {
          readRun: (targetRepo, targetRun) =>
            readWorkflowRun(
              {
                mode: "ambient",
                run: async (args) => {
                  reads.push(args);
                  return {
                    code: 0,
                    stderr: "",
                    stdout: JSON.stringify({
                      status: "completed",
                      conclusion,
                      jobs: [
                        {
                          name: "deploy",
                          steps: [
                            {
                              name: "Run rad commands",
                              status: "completed",
                              conclusion: "failure"
                            }
                          ]
                        }
                      ]
                    })
                  };
                }
              },
              targetRepo,
              targetRun
            )
        }
      ),
    createStatusReader: async () => ({
      graph: () => {
        throw new Error("No terminal graph read");
      },
      progress: () => {
        throw new Error("No resource progress read");
      },
      controlPlaneLog: () => {
        throw new Error("No confirmed failure diagnostics");
      }
    }),
    buildDeployStatusMap: () => new Map(),
    buildDeployMessageMap: () => new Map(),
    applyDeployMessages: () => {},
    applyDeployStatusToResources: () => [],
    settleDeployStatuses,
    generatePortalUrl: () => "",
    optionalString: () => "",
    errorMessage: String,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => 1700000000000
  });
  return {
    monitor,
    reads,
    sleeps,
    get dispatches() {
      return dispatches;
    }
  };
}
