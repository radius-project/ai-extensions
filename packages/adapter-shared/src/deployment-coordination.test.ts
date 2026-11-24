import { describe, expect, it } from "vitest";
import { createDeploymentDeferred } from "../test/support/deployment.js";
import {
  classifyDeployDispatchFailure,
  redactCredentials,
  type DeploymentState
} from "@radius-project/core";
import {
  createDeployDispatchService,
  type DeployDispatchDependencies,
  type DeployDispatchRequest
} from "./deployment-dispatch.js";
import {
  createDeployMonitorService,
  type DeployMonitorDependencies,
  type DeployMonitorRequest
} from "./deployment-monitor.js";
import { createDeployOutcomeService } from "./deployment-outcome.js";

const ok = { code: 0, stdout: "", stderr: "" };

function dispatchDependencies(
  overrides: Partial<DeployDispatchDependencies> = {}
): DeployDispatchDependencies {
  return {
    id: () => "execution",
    deployWorkflowFile: "run-rad-commands.yml",
    deployWorkflowFiles: ["run-rad-commands.yml"],
    branchNotPushedKind: "branch-not-pushed",
    oidcSubjectMissingKind: "oidc-subject-missing",
    oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
    getBranchHeadSha: async () => "head",
    getDefaultBranch: async () => {
      throw new Error("unexpected default lookup");
    },
    runGh: async () => ok,
    runGhWithStdin: async () => {
      throw new Error("unexpected secret write");
    },
    runAz: async () => {
      throw new Error("unexpected azure command");
    },
    runGitHubJson: async () => {
      throw new Error("unexpected OIDC read");
    },
    readProcessEnv: () => ({}),
    ghCredentialSource: () => "keyring",
    fetchFileForSelection: async () => "model source",
    appParams: () => [],
    resolveDeployParams: () => ({}),
    partitionParams: () => ({ secret: {}, public: {} }),
    extractAppName: () => "",
    buildDeployRadCommand: () => "rad deploy",
    buildAppGraphRadCommand: () => "rad app graph",
    ensureDeployWorkflowsOnBranch: async () => {},
    ensureWorkflowsCurrent: async () => ({ created: [], updated: [] }),
    verifyAppFileInput: async () => {},
    sleep: async () => {},
    latestWorkflowRunId: async () => 7,
    classifyDeployDispatchFailure,
    uncommittedGeneratedPaths: async () => [],
    invalidateDeployListCache: () => {},
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    now: () => 100,
    ...overrides
  };
}

function monitorDependencies(
  overrides: Partial<DeployMonitorDependencies> = {}
): DeployMonitorDependencies {
  return {
    dispatch: createDeployDispatchService(dispatchDependencies()),
    outcome: createDeployOutcomeService({
      projectSafeGraphResources: () => {
        throw new Error("unexpected graph");
      },
      settleDeployStatuses: () => {},
      fetchRunLog: async () => null,
      redactDiagnostic: redactCredentials,
      cloudAuthDriftKind: "cloud-auth-drift",
      sleep: async () => {},
      now: () => 1000
    }),
    deployRadCommandsStep: "Run rad commands",
    unconfirmedRunKind: "run-unconfirmed",
    findWorkflowRun: async () => 8,
    getRunDetail: async () => ({
      status: "completed",
      conclusion: "success",
      steps: []
    }),
    createStatusReader: async () => ({
      progress: async () => null,
      graph: async () => ({ graph: null, status: "missing" }),
      controlPlaneLog: async () => null
    }),
    buildDeployStatusMap: () => new Map(),
    buildDeployMessageMap: () => new Map(),
    applyDeployMessages: () => {},
    applyDeployStatusToResources: () => [],
    settleDeployStatuses: () => {},
    generatePortalUrl: () => {
      throw new Error("unexpected portal enrichment");
    },
    optionalString: (value) => (typeof value === "string" ? value : ""),
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    sleep: async () => {},
    now: () => 1000,
    ...overrides
  };
}

function request(): {
  state: DeploymentState;
  input: DeployMonitorRequest;
  logs: string[];
} {
  const state: DeploymentState = { deployStatus: "in_progress" };
  const logs: string[] = [];
  return {
    state,
    logs,
    input: {
      appFile: ".radius/app.bicep",
      entry: { state },
      repo: "example/app",
      branch: "feature",
      provider: "aws",
      requestedEnvironment: "dev",
      resources: [],
      log: (line) => {
        logs.push(line);
      }
    }
  };
}

describe("shared deployment without a frontend", () => {
  it("does not fabricate resource status when an optional projection leaves it unset", async () => {
    const f = request();
    f.input.resources = [{ name: "unprojected" }];
    await createDeployMonitorService(
      monitorDependencies({
        getRunDetail: async () => ({
          status: "completed",
          conclusion: "unknown",
          steps: []
        })
      })
    ).run(f.input);
    expect(f.state.deployStatus).toBe("failed");
    expect(f.state.deployErrorKind).toBe("run-unconfirmed");
    expect(f.input.resources[0].deployStatus).toBeUndefined();
  });

  it("runs the real dispatch, monitor and terminal factories without optional graph enrichment", async () => {
    const calls: string[][] = [];
    const f = request();
    await createDeployMonitorService(
      monitorDependencies({
        dispatch: createDeployDispatchService(
          dispatchDependencies({
            runGh: async (args) => {
              calls.push(args);
              return ok;
            }
          })
        ),
        findWorkflowRun: async (repo, workflow, since, known, baseline) => {
          expect([repo, workflow, since, known, baseline]).toEqual([
            "example/app",
            "run-rad-commands.yml",
            100,
            null,
            7
          ]);
          return 8;
        }
      })
    ).run(f.input);
    expect(calls).toEqual([
      [
        "workflow",
        "run",
        "run-rad-commands.yml",
        "--ref",
        "feature",
        "-f",
        "environment=dev",
        "-f",
        "app_file=.radius/app.bicep",
        "-f",
        "correlation_id=dep-execution",
        "--repo",
        "example/app",
        "-f",
        "application=unknown",
        "-f",
        'rad_commands=["rad deploy"]'
      ]
    ]);
    expect(f.state.deployStatus).toBe("complete");
    expect(f.state.deployRunUrl).toBe(
      "https://github.com/example/app/actions/runs/8"
    );
    expect(f.logs.join("\n")).toContain("Deployed graph not available");
  });

  it("observes an accepted execution without publishing workflows, dispatching, enriching, or repairing", async () => {
    const f = request();
    const unexpected = () => {
      throw new Error("observation issued a mutation");
    };
    await createDeployMonitorService(
      monitorDependencies({
        plannedGraph: { recover: unexpected },
        dispatch: { prepareAndDispatch: unexpected }
      })
    ).observe(f.input, {
      workflowFile: "run-rad-commands.yml",
      dispatchedAt: 100,
      environment: "dev",
      baselineRunId: 7
    });
    expect(f.state.deployStatus).toBe("complete");
    expect(f.state.deployHandoffState).toBeUndefined();
  });

  it("does not turn an unavailable remote outcome into repair eligibility", async () => {
    const f = request();
    let reads = 0;
    await createDeployMonitorService(
      monitorDependencies({
        getRunDetail: async () => {
          reads++;
          return null;
        }
      })
    ).run(f.input);
    expect(reads).toBe(240);
    expect(f.state.deployStatus).toBe("failed");
    expect(f.state.deployErrorKind).toBe("run-unconfirmed");
    expect(f.state.deployHandoffState).toBeUndefined();
  });

  it("does not publish late terminal writes from a replaced invocation", async () => {
    const f = request();
    const detail = createDeploymentDeferred<{
      status: string;
      conclusion: string;
      steps: [];
    }>();
    const started = createDeploymentDeferred<void>();
    let current = true;
    f.input.isCurrent = () => current;
    const operation = createDeployMonitorService(
      monitorDependencies({
        getRunDetail: () => {
          started.resolve();
          return detail.promise;
        }
      })
    ).run(f.input);
    await started.promise;
    current = false;
    detail.resolve({ status: "completed", conclusion: "success", steps: [] });
    await expect(operation).rejects.toMatchObject({ reason: "cancelled" });
    expect(f.state.deployStatus).toBe("in_progress");
    expect(f.state.deployFinishedAt).toBeUndefined();
  });
});

describe("shared dispatch generation fencing", () => {
  it.each([
    "initial",
    "branch",
    "model",
    "publication",
    "sync",
    "baseline",
    "wait"
  ] as const)(
    "stops stale %s work before its next mutation or terminal publication",
    async (stage) => {
      const f = request();
      let current = stage !== "initial";
      let sends = 0;
      const input: DeployDispatchRequest = {
        ...f.input,
        isCurrent: () => current
      };
      const stop = (at: string) => {
        if (stage === at) current = false;
      };
      const service = createDeployDispatchService(
        dispatchDependencies({
          getBranchHeadSha: async () => {
            stop("branch");
            return "head";
          },
          fetchFileForSelection: async () => {
            stop("model");
            return "model source";
          },
          ensureDeployWorkflowsOnBranch: async () => {
            stop("publication");
          },
          ensureWorkflowsCurrent: async () => {
            stop("sync");
            return {
              created: stage === "wait" ? ["run-rad-commands.yml"] : [],
              updated: []
            };
          },
          latestWorkflowRunId: async () => {
            stop("baseline");
            return 7;
          },
          sleep: async () => {
            stop("wait");
          },
          runGh: async () => {
            sends++;
            stop("send");
            return ok;
          }
        })
      );
      await expect(service.prepareAndDispatch(input)).rejects.toMatchObject({
        reason: "cancelled"
      });
      expect(sends).toBe(0);
      expect(f.state.deployStatus).toBe("in_progress");
    }
  );

  it("returns an issued dispatch acknowledgement even when admission closes during the command", async () => {
    const f = request();
    let current = true;
    const service = createDeployDispatchService(
      dispatchDependencies({
        runGh: async () => {
          current = false;
          return ok;
        }
      })
    );
    expect(
      await service.prepareAndDispatch({
        ...f.input,
        isCurrent: () => current
      })
    ).toEqual({
      dispatched: true,
      workflowFile: "run-rad-commands.yml",
      dispatchedAt: 100,
      environment: "dev",
      correlationId: "dep-execution",
      baselineRunId: 7
    });
  });

  it("revalidates after secret existence reads before writing credentials", async () => {
    const f = request();
    let current = true;
    const service = createDeployDispatchService(
      dispatchDependencies({
        fetchFileForSelection: async () => "param password string",
        partitionParams: () => ({
          secret: { password: "synthetic-value" },
          public: {}
        }),
        runGh: async () => {
          current = false;
          return ok;
        }
      })
    );
    await expect(
      service.prepareAndDispatch({
        ...f.input,
        isCurrent: () => current
      })
    ).rejects.toMatchObject({ reason: "cancelled" });
    expect(f.state.deployStatus).toBe("in_progress");
  });

  it("redacts refusal diagnostics before storing or publishing them", async () => {
    const f = request();
    const service = createDeployDispatchService(
      dispatchDependencies({
        runGh: async () => ({
          code: 1,
          stdout: "",
          stderr: "password=synthetic-refusal"
        })
      })
    );
    expect(await service.prepareAndDispatch(f.input)).toEqual({
      dispatched: false
    });
    expect(f.state.deployErrorKind).toBe("run-unconfirmed");
    expect(f.state.deployError).not.toContain("synthetic-refusal");
    expect(f.logs.join("\n")).not.toContain("synthetic-refusal");
  });
});
