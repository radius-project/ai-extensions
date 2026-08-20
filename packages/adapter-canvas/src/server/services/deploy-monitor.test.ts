import { describe, expect, it } from "vitest";
import {
  createDeployMonitorService,
  type DeployMonitorDependencies,
  type DeployMonitorRequest,
  type DeployMonitorStatusReader,
  type DeployRunDetail,
  type DeployResourceStatus
} from "./deploy-monitor.js";
import { createDeployDispatchService } from "./deploy-dispatch.js";
import { createDeployOutcomeService } from "./deploy-outcome.js";
import { createPlannedGraphRecoveryService } from "./deploy-planned-graph.js";
import type { DeployOutcomeRequest } from "./deploy-outcome.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";

// A deterministic clock: every read advances by one tick, so the heartbeat and
// the pending-node fallback can be driven without a real timer.
function clock(step = 1000) {
  let value = 1_700_000_000_000;
  return {
    now: () => {
      value += step;
      return value;
    },
    set: (next: number) => {
      value = next;
    }
  };
}

function dependencies(
  overrides: Partial<DeployMonitorDependencies> = {}
): DeployMonitorDependencies {
  return {
    plannedGraph: {
      recover: () => {
        throw new Error("plannedGraph.recover not stubbed");
      }
    },
    dispatch: {
      prepareAndDispatch: () =>
        Promise.resolve({
          dispatched: true,
          workflowFile: "run-rad-commands.yml",
          dispatchedAt: 10,
          environment: "production",
          baselineRunId: null
        })
    },
    outcome: {
      settle: () => {
        throw new Error("outcome.settle not stubbed");
      }
    },
    deployRadCommandsStep: "Run rad commands",
    unconfirmedRunKind: "run-unconfirmed",
    findWorkflowRun: () => Promise.resolve(77),
    getRunDetail: () =>
      Promise.resolve({
        status: "completed",
        conclusion: "success",
        steps: []
      }),
    createStatusReader: () => Promise.resolve(reader()),
    buildDeployStatusMap: () => new Map<string, DeployResourceStatus>(),
    buildDeployMessageMap: () => new Map<string, string>(),
    applyDeployMessages: () => {},
    applyDeployStatusToResources: () => [],
    generatePortalUrl: (resourceType, provider) =>
      `https://portal.test/${provider}/${resourceType}`,
    optionalString: (value) => (typeof value === "string" ? value : ""),
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    sleep: () => Promise.resolve(),
    now: () => 1_700_000_000_000,
    ...overrides
  };
}

function reader(): DeployMonitorStatusReader {
  return {
    progress: () => Promise.resolve(null),
    graph: () => Promise.resolve({ graph: null, status: "missing" }),
    controlPlaneLog: () => Promise.resolve(null)
  };
}

function request(overrides: Partial<DeployMonitorRequest> = {}): {
  request: DeployMonitorRequest;
  logs: string[];
  state: CanvasState;
} {
  const logs: string[] = [];
  const state: CanvasState = {};
  return {
    logs,
    state,
    request: {
      entry: { state },
      repo: "acme/widgets",
      branch: "feat",
      provider: "azure",
      requestedEnvironment: "production",
      resources: [],
      log: (message) => logs.push(message),
      ...overrides
    }
  };
}

function completedRun(steps: DeployRunDetail["steps"] = []): DeployRunDetail {
  return { status: "completed", conclusion: "success", steps };
}

function settleRecorder() {
  const calls: DeployOutcomeRequest[] = [];
  return {
    calls,
    outcome: {
      settle: (call: DeployOutcomeRequest) => {
        calls.push(call);
        return Promise.resolve();
      }
    }
  };
}

describe("deploy monitor construction", () => {
  it.each([
    "findWorkflowRun",
    "getRunDetail",
    "createStatusReader",
    "buildDeployStatusMap",
    "buildDeployMessageMap",
    "applyDeployMessages",
    "applyDeployStatusToResources",
    "generatePortalUrl",
    "optionalString",
    "errorMessage",
    "sleep",
    "now"
  ] as const)("refuses to construct without %s", (name) => {
    const incomplete = dependencies();
    delete incomplete[name];
    expect(() => createDeployMonitorService(incomplete)).toThrow(
      `createDeployMonitorService is missing required dependencies: ${name}`
    );
  });

  it.each([
    ["plannedGraph", "plannedGraph.recover"],
    ["dispatch", "dispatch.prepareAndDispatch"],
    ["outcome", "outcome.settle"]
  ] as const)(
    "refuses to construct without the %s service",
    (name, dependencyName) => {
      const incomplete = dependencies();
      delete incomplete[name];
      expect(() => createDeployMonitorService(incomplete)).toThrow(
        `createDeployMonitorService is missing required dependencies: ${dependencyName}`
      );
    }
  );

  it.each([
    ["plannedGraph", "recover", "plannedGraph.recover"],
    ["dispatch", "prepareAndDispatch", "dispatch.prepareAndDispatch"],
    ["outcome", "settle", "outcome.settle"]
  ] as const)(
    "refuses to construct when %s.%s is missing or not callable",
    (serviceName, methodName, dependencyName) => {
      for (const value of [undefined, "not callable"]) {
        const incomplete = dependencies();
        Object.defineProperty(incomplete[serviceName], methodName, {
          configurable: true,
          value
        });
        expect(() => createDeployMonitorService(incomplete)).toThrow(
          `createDeployMonitorService is missing required dependencies: ${dependencyName}`
        );
      }
    }
  );

  it.each(["deployRadCommandsStep", "unconfirmedRunKind"] as const)(
    "refuses to construct without the %s value seam",
    (name) => {
      const incomplete = dependencies();
      delete incomplete[name];
      expect(() => createDeployMonitorService(incomplete)).toThrow(
        `createDeployMonitorService is missing required dependencies: ${name}`
      );
    }
  );

  it.each(["deployRadCommandsStep", "unconfirmedRunKind"] as const)(
    "refuses to construct when %s is present but empty",
    (name) => {
      const empty = dependencies();
      empty[name] = "" as never;
      expect(() => createDeployMonitorService(empty)).toThrow(
        `createDeployMonitorService is missing required dependencies: ${name}`
      );
    }
  );
});

describe("deploy monitor stage sequencing", () => {
  it("refuses to run without a target repository", async () => {
    const { request: input, state, logs } = request({ repo: "" });
    const service = createDeployMonitorService(
      dependencies({
        dispatch: {
          prepareAndDispatch: () => {
            throw new Error("nothing may be dispatched without a repository");
          }
        }
      })
    );

    await service.run(input);

    expect(state.deployStatus).toBe("failed");
    expect(state.deployError).toBe(
      "No target repository was specified for the deployment."
    );
    expect(logs).toEqual(["❌ No target repository specified."]);
  });

  it("recovers the planned graph only when the deploy started without one", async () => {
    const recovered: CanvasGraphResource[] = [{ id: "r1", name: "db" }];
    const recoveries: unknown[] = [];
    const settle = settleRecorder();
    const { request: input } = request();
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: {
          recover: (call) => {
            recoveries.push(call.repo);
            return Promise.resolve(recovered);
          }
        },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(recoveries).toEqual(["acme/widgets"]);
    expect(settle.calls[0].resources).toBe(recovered);
  });

  it("keeps the request's graph when one was already snapshotted", async () => {
    const existing: CanvasGraphResource[] = [
      { id: "r1", deployStatus: "pending" }
    ];
    const settle = settleRecorder();
    const { request: input } = request({ resources: existing });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: {
          recover: () => {
            throw new Error("an existing graph must not be rebuilt");
          }
        },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(settle.calls[0].resources).toBe(existing);
  });

  it("continues with an empty graph when recovery finds nothing", async () => {
    const settle = settleRecorder();
    const { request: input } = request();
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(settle.calls[0].resources).toEqual([]);
  });

  it("stops when the dispatch stage refuses to start a run", async () => {
    const { request: input } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        dispatch: {
          prepareAndDispatch: () => Promise.resolve({ dispatched: false })
        },
        findWorkflowRun: () => {
          throw new Error("a refused dispatch must not be followed");
        }
      })
    );

    await expect(service.run(input)).resolves.toBeUndefined();
  });

  it("hands the dispatch stage the request's environment and branch", async () => {
    const calls: unknown[] = [];
    const settle = settleRecorder();
    const { request: input } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        dispatch: {
          prepareAndDispatch: (call) => {
            calls.push({
              repo: call.repo,
              branch: call.branch,
              provider: call.provider,
              requestedEnvironment: call.requestedEnvironment
            });
            return Promise.resolve({
              dispatched: true,
              workflowFile: "run-rad-commands.yml",
              dispatchedAt: 10,
              environment: "production",
              baselineRunId: null
            });
          }
        },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(calls).toEqual([
      {
        repo: "acme/widgets",
        branch: "feat",
        provider: "azure",
        requestedEnvironment: "production"
      }
    ]);
  });
});

describe("deploy monitor run discovery", () => {
  it("polls until the run appears and records its url", async () => {
    const sleeps: number[] = [];
    const lookups: [string, string, number][] = [];
    const settle = settleRecorder();
    const { request: input, state, logs } = request({ resources: [] });
    let attempts = 0;
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        findWorkflowRun: (repo, workflowFile, sinceMs) => {
          lookups.push([repo, workflowFile, sinceMs]);
          attempts += 1;
          return Promise.resolve(attempts < 3 ? null : 77);
        },
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(lookups).toHaveLength(3);
    expect(lookups[0]).toEqual(["acme/widgets", "run-rad-commands.yml", 10]);
    expect(sleeps.slice(0, 2)).toEqual([5000, 5000]);
    expect(state.deployRunId).toBe(77);
    expect(state.deployRunUrl).toBe(
      "https://github.com/acme/widgets/actions/runs/77"
    );
    expect(logs).toContain(
      "Tracking deploy run: https://github.com/acme/widgets/actions/runs/77"
    );
  });

  it("passes the dispatch baseline run id to run discovery", async () => {
    const afterRunIds: (number | string | null | undefined)[] = [];
    const settle = settleRecorder();
    const { request: input } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        dispatch: {
          prepareAndDispatch: () =>
            Promise.resolve({
              dispatched: true,
              workflowFile: "run-rad-commands.yml",
              dispatchedAt: 10,
              environment: "production",
              baselineRunId: 101
            })
        },
        findWorkflowRun: (
          _repo,
          _workflowFile,
          _sinceMs,
          _knownId,
          afterRunId
        ) => {
          afterRunIds.push(afterRunId);
          return Promise.resolve(102);
        },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(afterRunIds).toEqual([101]);
  });

  it("marks a run it never found as unconfirmed rather than failed", async () => {
    let lookups = 0;
    const { request: input, state, logs } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        findWorkflowRun: () => {
          lookups += 1;
          return Promise.resolve(null);
        },
        getRunDetail: () => {
          throw new Error("no run means nothing to follow");
        }
      })
    );

    await service.run(input);

    expect(lookups).toBe(24);
    expect(state.deployStatus).toBe("failed");
    expect(state.deployErrorKind).toBe("run-unconfirmed");
    expect(state.deployError).toContain("did not start");
    expect(logs).toContain("⚠ No deploy run found for run-rad-commands.yml.");
  });

  it("lights up the first pending node once the run is being tracked", async () => {
    const first: CanvasGraphResource = {
      id: "r1",
      deployStatus: "pending",
      outputResources: [{ id: "o1" }]
    };
    const settle = settleRecorder();
    const { request: input } = request({ resources: [first] });
    const service = createDeployMonitorService(
      dependencies({ outcome: settle.outcome })
    );

    await service.run(input);

    expect(first.deployStatus).toBe("in_progress");
    expect(first.outputResources?.[0].deployStatus).toBe("in_progress");
  });

  it("leaves a graph whose first node already advanced", async () => {
    const first: CanvasGraphResource = { id: "r1", deployStatus: "success" };
    const settle = settleRecorder();
    const { request: input } = request({ resources: [first] });
    const service = createDeployMonitorService(
      dependencies({ outcome: settle.outcome })
    );

    await service.run(input);

    expect(first.deployStatus).toBe("success");
  });
});

describe("deploy monitor progress streaming", () => {
  it("announces each step's start and completion exactly once", async () => {
    const details: DeployRunDetail[] = [
      {
        status: "in_progress",
        conclusion: null,
        steps: [{ name: "Checkout", status: "in_progress" }]
      },
      {
        status: "in_progress",
        conclusion: null,
        steps: [
          { name: "Checkout", status: "completed", conclusion: "success" },
          { name: "Deploy", status: "completed", conclusion: "failure" },
          { name: "Cleanup", status: "completed", conclusion: null }
        ]
      },
      completedRun()
    ];
    let index = 0;
    const settle = settleRecorder();
    const { request: input, logs } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        getRunDetail: () => Promise.resolve(details[index++]),
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(logs).toContain("  ▶ Checkout…");
    expect(logs.filter((line) => line === "  ▶ Checkout…")).toHaveLength(1);
    expect(logs).toContain("  ✓ Checkout");
    expect(logs).toContain("  ✗ Deploy");
    expect(logs).toContain("  • Cleanup");
  });

  it("keeps polling while the run detail is unavailable", async () => {
    const details: (DeployRunDetail | null)[] = [null, null, completedRun()];
    let index = 0;
    const sleeps: number[] = [];
    const settle = settleRecorder();
    const { request: input } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        getRunDetail: () => Promise.resolve(details[index++]),
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(sleeps).toEqual([5000, 5000]);
    expect(settle.calls).toHaveLength(1);
  });

  it("beats once per running step and again after the heartbeat interval", async () => {
    const running = (name: string): DeployRunDetail => ({
      status: "in_progress",
      conclusion: null,
      steps: [{ name, status: "in_progress" }]
    });
    const details = [
      running("Checkout"),
      running("Checkout"),
      running("Deploy"),
      completedRun()
    ];
    let index = 0;
    const time = clock(40_000);
    const settle = settleRecorder();
    const { request: input, logs } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        getRunDetail: () => Promise.resolve(details[index++]),
        now: time.now,
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(logs.filter((line) => line.includes("still running"))).toHaveLength(
      1
    );
    expect(logs.some((line) => line.includes("Checkout still running"))).toBe(
      true
    );
  });

  it("records the rad step's start time once and folds in published status", async () => {
    const resource: CanvasGraphResource = { id: "r1", deployStatus: "pending" };
    const details = [
      {
        status: "in_progress",
        conclusion: null,
        steps: [{ name: "Run rad commands", status: "in_progress" }]
      },
      {
        status: "in_progress",
        conclusion: null,
        steps: [{ name: "Run rad commands", status: "in_progress" }]
      },
      completedRun()
    ];
    let index = 0;
    const settle = settleRecorder();
    const { request: input, state, logs } = request({ resources: [resource] });
    const service = createDeployMonitorService(
      dependencies({
        getRunDetail: () => Promise.resolve(details[index++]),
        applyDeployStatusToResources: (resources) => {
          resources.forEach((r) => {
            r.deployStatus = "success";
          });
          return [{ name: "db", from: "pending", to: "success" }];
        },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(state.deployStartedAt).toBe(1_700_000_000_000);
    expect(
      logs.filter((line) => line.includes("rad deploy running"))
    ).toHaveLength(1);
    expect(logs).toContain("  ✓ db — success");
    // The announcement is deduplicated across polls.
    expect(logs.filter((line) => line === "  ✓ db — success")).toHaveLength(1);
    expect(settle.calls[0].deployStepStartedAt).toBe(1_700_000_000_000);
  });

  it("announces a failed and an unfinished resource transition distinctly", async () => {
    const resource: CanvasGraphResource = { id: "r1", deployStatus: "pending" };
    const details = [
      {
        status: "in_progress",
        conclusion: null,
        steps: [{ name: "Run rad commands", status: "in_progress" }]
      },
      completedRun()
    ];
    let index = 0;
    const settle = settleRecorder();
    const { request: input, logs } = request({ resources: [resource] });
    const service = createDeployMonitorService(
      dependencies({
        getRunDetail: () => Promise.resolve(details[index++]),
        applyDeployStatusToResources: () => [
          { name: "db", from: "pending", to: "failed" },
          { name: undefined, from: "pending", to: "in_progress" }
        ],
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(logs).toContain("  ✗ db — failed");
    expect(logs).toContain("  ◐ resource — in_progress");
  });

  it("surfaces a status read failure without stopping the deploy", async () => {
    const resource: CanvasGraphResource = { id: "r1", deployStatus: "pending" };
    const details = [
      {
        status: "in_progress",
        conclusion: null,
        steps: [{ name: "Run rad commands", status: "in_progress" }]
      },
      completedRun()
    ];
    let index = 0;
    const settle = settleRecorder();
    const { request: input, logs } = request({ resources: [resource] });
    const service = createDeployMonitorService(
      dependencies({
        getRunDetail: () => Promise.resolve(details[index++]),
        createStatusReader: () =>
          Promise.resolve({
            progress: () => Promise.reject(new Error("artifact expired")),
            graph: () => Promise.resolve({ graph: null, status: "missing" }),
            controlPlaneLog: () => Promise.resolve(null)
          }),
        applyDeployStatusToResources: () => {
          throw new Error("a failed read must not reach the merge");
        },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(logs).toContain(
      "    ⚠ Could not read deploy status: artifact expired"
    );
    expect(settle.calls).toHaveLength(1);
  });

  it("announces an unchanged transition only once across polls", async () => {
    const named: CanvasGraphResource = { id: "r1", deployStatus: "pending" };
    const untracked: CanvasGraphResource = { id: "r2" };
    const inFlight: DeployRunDetail = {
      status: "in_progress",
      conclusion: null,
      steps: [{ name: "Run rad commands", status: "in_progress" }]
    };
    const details = [inFlight, inFlight, completedRun()];
    let index = 0;
    let merges = 0;
    // 20s per read, so the 15s publication throttle lets both polls read.
    const time = clock(20_000);
    const settle = settleRecorder();
    const { request: input, logs } = request({
      resources: [named, untracked]
    });
    const service = createDeployMonitorService(
      dependencies({
        getRunDetail: () => Promise.resolve(details[index++]),
        now: time.now,
        buildDeployStatusMap: () => new Map([["r1", "success"]]),
        applyDeployStatusToResources: () => {
          merges += 1;
          return [{ name: "db", from: "pending", to: "success" }];
        },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(merges).toBeGreaterThan(1);
    expect(logs.filter((line) => line === "  ✓ db — success")).toHaveLength(1);
    // A resource the merge left without a status is not pushed onto outputs.
    expect(untracked.deployStatus).toBeUndefined();
  });

  it("streams a step the runner reported without a name", async () => {
    const details: DeployRunDetail[] = [
      {
        status: "in_progress",
        conclusion: null,
        steps: [{ status: "in_progress" }]
      },
      {
        status: "in_progress",
        conclusion: null,
        steps: [{ status: "completed", conclusion: "success" }]
      },
      completedRun()
    ];
    let index = 0;
    const settle = settleRecorder();
    const { request: input, logs } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        getRunDetail: () => Promise.resolve(details[index++]),
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(logs).toContain("  ▶ …");
    expect(logs).toContain("  ✓ ");
  });

  it("beats for a running step the runner reported without a name", async () => {
    const unnamed: DeployRunDetail = {
      status: "in_progress",
      conclusion: null,
      steps: [{ status: "in_progress" }]
    };
    const details = [unnamed, unnamed, completedRun()];
    let index = 0;
    const time = clock(40_000);
    const settle = settleRecorder();
    const { request: input, logs } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        getRunDetail: () => Promise.resolve(details[index++]),
        now: time.now,
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(logs.some((line) => line.startsWith("    …  still running ("))).toBe(
      true
    );
  });

  it("skips the status poll while nothing has been planned", async () => {
    const details = [
      {
        status: "in_progress",
        conclusion: null,
        steps: [{ name: "Run rad commands", status: "in_progress" }]
      },
      completedRun()
    ];
    let index = 0;
    const settle = settleRecorder();
    const { request: input, state } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        getRunDetail: () => Promise.resolve(details[index++]),
        createStatusReader: () =>
          Promise.resolve({
            progress: () => {
              throw new Error("an empty graph must not be polled");
            },
            graph: () => Promise.resolve({ graph: null, status: "missing" }),
            controlPlaneLog: () => Promise.resolve(null)
          }),
        outcome: settle.outcome
      })
    );

    await service.run(input);

    // With no resources the rad-step handling is skipped entirely, so the
    // start time is never recorded either.
    expect(state.deployStartedAt).toBeUndefined();
  });

  it("throttles the status poll to the publication interval", async () => {
    const resource: CanvasGraphResource = { id: "r1", deployStatus: "pending" };
    const inFlight: DeployRunDetail = {
      status: "in_progress",
      conclusion: null,
      steps: [{ name: "Run rad commands", status: "in_progress" }]
    };
    const details = [inFlight, inFlight, completedRun()];
    let index = 0;
    let progressReads = 0;
    const time = clock(1000);
    const settle = settleRecorder();
    const { request: input } = request({ resources: [resource] });
    const service = createDeployMonitorService(
      dependencies({
        getRunDetail: () => Promise.resolve(details[index++]),
        now: time.now,
        createStatusReader: () =>
          Promise.resolve({
            progress: () => {
              progressReads += 1;
              return Promise.resolve(null);
            },
            graph: () => Promise.resolve({ graph: null, status: "missing" }),
            controlPlaneLog: () => Promise.resolve(null)
          }),
        outcome: settle.outcome
      })
    );

    await service.run(input);

    // Two in-flight polls one second apart: only the first reads the artifact.
    expect(progressReads).toBe(1);
  });

  it("advances pending and unset nodes without overwriting advanced output nodes", async () => {
    const advanced: CanvasGraphResource = {
      id: "r1",
      deployStatus: "success"
    };
    const waiting: CanvasGraphResource = {
      id: "r2",
      outputResources: [
        { id: "o1" },
        { id: "o2", deployStatus: "pending" },
        { id: "o3", deployStatus: "success" }
      ]
    };
    const inFlight: DeployRunDetail = {
      status: "in_progress",
      conclusion: null,
      steps: [{ name: "Run rad commands", status: "in_progress" }]
    };
    const details = [inFlight, completedRun()];
    let index = 0;
    const time = clock(30_000);
    const settle = settleRecorder();
    const { request: input } = request({ resources: [advanced, waiting] });
    const service = createDeployMonitorService(
      dependencies({
        getRunDetail: () => Promise.resolve(details[index++]),
        now: time.now,
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(advanced.deployStatus).toBe("success");
    expect(waiting.deployStatus).toBe("in_progress");
    expect(
      waiting.outputResources?.map((output) => output.deployStatus)
    ).toEqual(["in_progress", "in_progress", "success"]);
  });

  it.each([
    ["status", new Map([["resource", "pending" as const]]), new Map()],
    ["message", new Map(), new Map([["resource", "Provisioning"]])]
  ])(
    "does not apply the fallback after artifact %s progress arrives",
    async (_kind, statusMap, messageMap) => {
      const advanced: CanvasGraphResource = {
        id: "r1",
        deployStatus: "success"
      };
      const pending: CanvasGraphResource = {
        id: "r2",
        deployStatus: "pending"
      };
      const inFlight: DeployRunDetail = {
        status: "in_progress",
        conclusion: null,
        steps: [{ name: "Run rad commands", status: "in_progress" }]
      };
      const details = [inFlight, completedRun()];
      let index = 0;
      const time = clock(30_000);
      const settle = settleRecorder();
      const { request: input } = request({ resources: [advanced, pending] });
      const service = createDeployMonitorService(
        dependencies({
          getRunDetail: () => Promise.resolve(details[index++]),
          buildDeployStatusMap: () => statusMap,
          buildDeployMessageMap: () => messageMap,
          now: time.now,
          outcome: settle.outcome
        })
      );

      await service.run(input);

      expect(advanced.deployStatus).toBe("success");
      expect(pending.deployStatus).toBe("pending");
    }
  );

  it("applies the no-artifact fallback only once", async () => {
    const advanced: CanvasGraphResource = { id: "r1", deployStatus: "success" };
    const pending: CanvasGraphResource = { id: "r2", deployStatus: "pending" };
    const inFlight: DeployRunDetail = {
      status: "in_progress",
      conclusion: null,
      steps: [{ name: "Run rad commands", status: "in_progress" }]
    };
    const details = [inFlight, inFlight, completedRun()];
    let index = 0;
    const time = clock(30_000);
    const settle = settleRecorder();
    const { request: input } = request({ resources: [advanced, pending] });
    const service = createDeployMonitorService(
      dependencies({
        getRunDetail: () => {
          // Push the node back to pending between the two in-flight polls: a
          // fallback that re-armed would advance it a second time.
          if (index === 1) pending.deployStatus = "pending";
          return Promise.resolve(details[index++]);
        },
        now: time.now,
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(advanced.deployStatus).toBe("success");
    expect(pending.deployStatus).toBe("pending");
  });
});

describe("deploy monitor settlement", () => {
  it("hands the terminal run to the outcome stage with its own collaborators", async () => {
    const resource: CanvasGraphResource = { id: "r1", deployStatus: "pending" };
    const settle = settleRecorder();
    const statusReader = reader();
    const { request: input, state } = request({ resources: [resource] });
    const service = createDeployMonitorService(
      dependencies({
        getRunDetail: () =>
          Promise.resolve({
            status: "completed",
            conclusion: "failure",
            steps: [{ name: "Run rad commands", conclusion: "failure" }]
          }),
        createStatusReader: (_state, repo, branch, runId) => {
          expect([repo, branch, runId]).toEqual(["acme/widgets", "feat", 77]);
          return Promise.resolve(statusReader);
        },
        outcome: settle.outcome
      })
    );

    await service.run(input);

    expect(settle.calls).toHaveLength(1);
    expect(settle.calls[0]).toMatchObject({
      repo: "acme/widgets",
      runId: 77,
      provider: "azure",
      conclusion: "failure",
      statusReader
    });
    expect(settle.calls[0].entry.state).toBe(state);
  });

  it("generates portal links from the provider's own identifier order", async () => {
    const azure: CanvasGraphResource = {
      id: "r1",
      deployStatus: "pending",
      outputResources: [
        { id: "azure-id", type: "azure-type" },
        { type: "only-type" },
        { displayType: "only-display" },
        {}
      ]
    };
    const settle = settleRecorder();
    const { request: input } = request({ resources: [azure] });
    const service = createDeployMonitorService(
      dependencies({ outcome: settle.outcome })
    );

    await service.run(input);
    // The first node was lit up as in_progress, which does not generate links;
    // drive a success through the outcome stage's setStatus instead.
    settle.calls[0].setStatus(azure, "success");

    expect(azure.outputResources?.map((o) => o.portalUrl)).toEqual([
      "https://portal.test/azure/azure-id",
      "https://portal.test/azure/only-type",
      "https://portal.test/azure/only-display",
      "https://portal.test/azure/"
    ]);
  });

  it("prefers the type over the id for a non-Azure provider", async () => {
    const aws: CanvasGraphResource = {
      id: "r1",
      deployStatus: "pending",
      outputResources: [
        { id: "aws-id", type: "aws-type" },
        { id: "aws-id-2", displayType: "aws-display" },
        { id: "id-only" },
        {}
      ]
    };
    const settle = settleRecorder();
    const { request: input } = request({ resources: [aws], provider: "aws" });
    const service = createDeployMonitorService(
      dependencies({ outcome: settle.outcome })
    );

    await service.run(input);
    settle.calls[0].setStatus(aws, "success");

    expect(aws.outputResources?.map((o) => o.portalUrl)).toEqual([
      "https://portal.test/aws/aws-type",
      "https://portal.test/aws/aws-display",
      "https://portal.test/aws/id-only",
      "https://portal.test/aws/"
    ]);
  });

  it("leaves a node with no outputs alone", async () => {
    const bare: CanvasGraphResource = { id: "r1", deployStatus: "pending" };
    const settle = settleRecorder();
    const { request: input } = request({ resources: [bare] });
    const service = createDeployMonitorService(
      dependencies({ outcome: settle.outcome })
    );

    await service.run(input);
    settle.calls[0].setStatus(bare, "success");

    expect(bare).toEqual({ id: "r1", deployStatus: "success" });
  });

  it("forces the outcome stage's final status sweep through the same poll", async () => {
    let progressReads = 0;
    const resource: CanvasGraphResource = { id: "r1", deployStatus: "success" };
    const settle = settleRecorder();
    const { request: input } = request({ resources: [resource] });
    const service = createDeployMonitorService(
      dependencies({
        createStatusReader: () =>
          Promise.resolve({
            progress: () => {
              progressReads += 1;
              return Promise.resolve(null);
            },
            graph: () => Promise.resolve({ graph: null, status: "missing" }),
            controlPlaneLog: () => Promise.resolve(null)
          }),
        outcome: settle.outcome
      })
    );

    await service.run(input);
    await settle.calls[0].pollDeployStatus(true);

    expect(progressReads).toBe(1);
  });

  it("answers the forced sweep without reading anything when the graph is empty", async () => {
    let progressReads = 0;
    const settle = settleRecorder();
    const { request: input } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        createStatusReader: () =>
          Promise.resolve({
            progress: () => {
              progressReads += 1;
              return Promise.resolve(null);
            },
            graph: () => Promise.resolve({ graph: null, status: "missing" }),
            controlPlaneLog: () => Promise.resolve(null)
          }),
        outcome: settle.outcome
      })
    );

    await service.run(input);
    await settle.calls[0].pollDeployStatus(true);

    expect(progressReads).toBe(0);
  });

  it("marks a run it followed to the poll cap as unconfirmed", async () => {
    let polls = 0;
    const { request: input, state, logs } = request({ resources: [] });
    const service = createDeployMonitorService(
      dependencies({
        plannedGraph: { recover: () => Promise.resolve(null) },
        getRunDetail: () => {
          polls += 1;
          return Promise.resolve({
            status: "in_progress",
            conclusion: null,
            steps: []
          });
        },
        outcome: {
          settle: () => {
            throw new Error("an unfinished run must not be settled");
          }
        }
      })
    );

    await service.run(input);

    expect(polls).toBe(240);
    expect(state.deployStatus).toBe("failed");
    expect(state.deployErrorKind).toBe("run-unconfirmed");
    expect(state.deployError).toContain(
      "https://github.com/acme/widgets/actions/runs/77"
    );
    expect(logs).toContain(
      "⚠ Timed out waiting for the deploy workflow to complete."
    );
  });
});

// ── Composed-pipeline parity ────────────────────────────────────────────────
// The suites above each exercise one stage against fakes of its neighbours,
// which cannot catch a seam that was wired in the wrong order. This one
// composes the four real services and records every external effect and state
// write in the order they happen, then compares that recording against a
// transcript written out by hand from the legacy `/api/deploy` arm. The two
// sides come from different places: one is produced by the code, the other was
// read off the arm this slice removed.
describe("deploy pipeline parity with the legacy arm transcript", () => {
  function composed(effects: string[]) {
    const record = (effect: string): void => {
      effects.push(effect);
    };
    const plannedGraph = createPlannedGraphRecoveryService({
      prepareSourceRefResources: () => {
        record("prepare-source-refs");
        return { token: "planned|acme/widgets|feat" };
      },
      setSourceRefResources: () => {
        record("commit-source-refs");
        return true;
      },
      fetchBicepSelection: () => {
        record("fetch-bicep-selection");
        return Promise.resolve({
          content: "planned bicep",
          fromWorkspace: false,
          branch: "feat",
          bicepPath: ""
        });
      },
      radArtifactsDirForSelection: () => {
        record("stage-rad-artifacts");
        return Promise.resolve({ dir: "/tmp/rad", remote: true });
      },
      buildGraphViaRad: () => {
        record("build-graph-via-rad");
        return Promise.resolve([{ id: "r1", name: "db" }]);
      },
      fetchRecipePack: () => {
        record("fetch-recipe-pack");
        return Promise.resolve({});
      },
      resolveRecipeOutputs: (parsed) => {
        record("resolve-recipe-outputs");
        return Promise.resolve(parsed);
      },
      canvasGraphResources: (values) => values as CanvasGraphResource[],
      errorMessage: (error) => String(error)
    });

    const dispatch = createDeployDispatchService({
      deployWorkflowFile: "run-rad-commands.yml",
      deployWorkflowFiles: [
        "run-rad-commands.yml",
        "run-rad-commands-azure.yml"
      ],
      branchNotPushedKind: "branch-not-pushed",
      oidcSubjectMissingKind: "oidc-subject-missing",
      getBranchHeadSha: () => {
        record("branch-head-sha");
        return Promise.resolve("sha-1");
      },
      getDefaultBranch: () => {
        throw new Error("a resolvable branch must not fall back");
      },
      runGh: (args) => {
        record(`gh:${args.slice(0, 3).join(" ")}`);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      runGhWithStdin: () => {
        throw new Error("no secret params means no secret write");
      },
      runAz: (args) => {
        record(`az:${args.slice(0, 4).join(" ")}`);
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify([
            "repo:acme/widgets:environment:production",
            "repo:acme@101/widgets@202:environment:production"
          ]),
          stderr: ""
        });
      },
      runGitHubJson: (path) => {
        record(`github-json:${path}`);
        if (path.includes("/variables/AZURE_CLIENT_ID")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: { value: "client-123" }
          });
        }
        if (path === "/repos/acme/widgets/environments/production") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: { name: "production" }
          });
        }
        if (path === "/repos/acme/widgets") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: {
              full_name: "acme/widgets",
              id: 202,
              owner: { id: 101 }
            }
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      },
      readProcessEnv: () => ({}),
      fetchFileForSelection: (_entry, _repo, _branch, repoPath) => {
        record(`fetch-file:${repoPath}`);
        return Promise.resolve("deploy bicep");
      },
      appParams: () => [],
      resolveDeployParams: () => ({}),
      partitionParams: () => ({ public: {}, secret: {} }),
      extractAppName: () => "todo-app",
      buildDeployRadCommand: () => "rad deploy",
      buildAppGraphRadCommand: () => "rad app graph",
      ensureDeployWorkflowsOnBranch: () => {
        record("publish-workflows");
        return Promise.resolve();
      },
      ensureWorkflowsCurrent: () => {
        record("sync-workflows");
        return Promise.resolve({ created: [], failed: [] });
      },
      latestWorkflowRunId: () => {
        record("latest-run-id");
        return Promise.resolve(76);
      },
      classifyDeployDispatchFailure: () => "run-unconfirmed",
      invalidateDeployListCache: () => record("evict-deploy-listing"),
      errorMessage: (error) => String(error),
      now: () => 1_700_000_000_000
    });

    const outcome = createDeployOutcomeService({
      settleDeployStatuses: (resources) => {
        record("settle-statuses");
        resources.forEach((r) => {
          r.deployStatus = "success";
        });
      },
      fetchRunLog: () => {
        throw new Error("a successful run has no failure log to read");
      },
      extractGitHubActionsStepLog: () => "",
      explainOidcEnterpriseClaim: () => "",
      extractRadDeployError: () => "",
      sleep: () => Promise.resolve(),
      now: () => 1_700_000_060_000
    });

    return createDeployMonitorService({
      plannedGraph,
      dispatch,
      outcome,
      deployRadCommandsStep: "Run rad commands",
      unconfirmedRunKind: "run-unconfirmed",
      findWorkflowRun: () => {
        record("find-workflow-run");
        return Promise.resolve(77);
      },
      getRunDetail: () => {
        record("get-run-detail");
        return Promise.resolve({
          status: "completed",
          conclusion: "success",
          steps: [
            {
              name: "Run rad commands",
              status: "completed",
              conclusion: "success"
            }
          ]
        });
      },
      createStatusReader: () => {
        record("create-status-reader");
        return Promise.resolve({
          progress: () => {
            record("read-progress");
            return Promise.resolve(null);
          },
          graph: () => {
            record("read-graph");
            return Promise.resolve({ graph: [{ id: "r1" }], status: "ok" });
          },
          controlPlaneLog: () => {
            throw new Error("a successful run has no control-plane tail");
          }
        });
      },
      buildDeployStatusMap: () => new Map<string, DeployResourceStatus>(),
      buildDeployMessageMap: () => new Map<string, string>(),
      applyDeployMessages: () => {},
      applyDeployStatusToResources: () => [],
      generatePortalUrl: () => "https://portal.test/azure/db",
      optionalString: (value) => (typeof value === "string" ? value : ""),
      errorMessage: (error) => String(error),
      sleep: () => Promise.resolve(),
      now: () => 1_700_000_000_000
    });
  }

  it("performs the legacy arm's external effects in the legacy arm's order", async () => {
    const effects: string[] = [];
    const { request: input, state, logs } = request({ resources: [] });
    const service = composed(effects);

    await service.run(input);

    // Hand-written from the removed arm: planned-graph recovery, then the
    // dispatch preflight, then publication and synchronization, then the
    // dispatch and its cache eviction, then run discovery, then monitoring,
    // then the terminal artifact reads.
    expect(effects).toEqual([
      "prepare-source-refs",
      "fetch-bicep-selection",
      "stage-rad-artifacts",
      "build-graph-via-rad",
      "fetch-recipe-pack",
      "resolve-recipe-outputs",
      "commit-source-refs",
      "branch-head-sha",
      "github-json:/repos/acme/widgets/environments/production/variables/AZURE_CLIENT_ID",
      "github-json:/repos/acme/widgets/environments/production",
      "github-json:/repos/acme/widgets",
      "github-json:/repos/acme/widgets/actions/oidc/customization/sub",
      "az:ad app federated-credential list",
      "fetch-file:.radius/app.bicep",
      "publish-workflows",
      "sync-workflows",
      "latest-run-id",
      "gh:workflow run run-rad-commands.yml",
      "evict-deploy-listing",
      "find-workflow-run",
      "create-status-reader",
      "get-run-detail",
      "read-graph",
      "read-progress",
      "settle-statuses"
    ]);
    expect(state.deployStatus).toBe("complete");
    expect(state.deployEnvName).toBe("production");
    expect(state.deployAppName).toBe("todo-app");
    expect(state.deployRunUrl).toBe(
      "https://github.com/acme/widgets/actions/runs/77"
    );
    expect(state.deployedGraph).toEqual([{ id: "r1" }]);
    expect(state.deployedGraphRepo).toBe("acme/widgets");
    expect(state.plannedRepo).toBe("acme/widgets");
    // The log feed is the user-visible half of the same transcript.
    expect(logs).toEqual([
      "Resolving planned application graph for acme/widgets...",
      "Planned 1 resource(s).",
      "━━ Deploying Radius application ━━",
      "Deploying with rad commands: rad deploy  |  rad app graph",
      '🚀 Dispatching run rad commands workflow (run-rad-commands.yml) on branch "feat" for environment "production"...',
      "✅ Run rad commands workflow dispatched.",
      "Waiting for the deploy workflow to start...",
      "Tracking deploy run: https://github.com/acme/widgets/actions/runs/77",
      "  ✓ Run rad commands",
      "🗺  Retrieving deploy status and application graph…",
      // No duration line: the run reported the rad step as already completed,
      // so the monitor never observed it start and the legacy arm's
      // `if (deployStepStartedAt)` guard stays false.
      "  ✓ Deployed graph saved (from workflow artifact).",
      "",
      "🎉 Deployment complete! Application deployed to Azure.",
      "Click on deployed resources to view them in the Azure Portal."
    ]);
  });
});
