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
                  // Answer only the run the monitor found and its first jobs
                  // page, as GitHub scopes these reads to one run.
                  const run = `repos/${targetRepo}/actions/runs/42`;
                  const jobs = args[1] === `${run}/jobs?per_page=100&page=1`;
                  if (
                    String(targetRun) !== "42" ||
                    (args[1] !== run && !jobs) ||
                    args.slice(2).join(" ") !== "--include --method GET"
                  )
                    throw new Error(
                      `Unexpected workflow read: ${args.join(" ")}`
                    );
                  if (!jobs) reads.push(args);
                  return {
                    code: 0,
                    stderr: "",
                    stdout:
                      "HTTP/2 200\n\n" +
                      JSON.stringify(
                        jobs ?
                          {
                            total_count: 1,
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
                          }
                        : { status: "completed", conclusion }
                      )
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
