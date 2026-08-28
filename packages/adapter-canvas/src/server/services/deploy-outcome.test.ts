import { describe, expect, it } from "vitest";
import {
  createDeployOutcomeService,
  type DeployOutcomeDependencies,
  type DeployOutcomeRequest,
  type DeployOutcomeStatusReader,
  type DeployGraphRead
} from "./deploy-outcome.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";

function dependencies(
  overrides: Partial<DeployOutcomeDependencies> = {}
): DeployOutcomeDependencies {
  return {
    settleDeployStatuses: () => {},
    fetchRunLog: () => Promise.resolve(null),
    extractGitHubActionsStepLog: () => "",
    explainOidcEnterpriseClaim: () => "",
    extractRadDeployError: () => "",
    classifyDeployCloudAuthDrift: () => "",
    cloudAuthDriftKind: "cloud-auth-drift",
    sleep: () => Promise.resolve(),
    now: () => 1_700_000_060_000,
    ...overrides
  };
}

// A reader that replays a scripted sequence of graph reads and throws on any
// call the scenario did not model.
// Three reads, because the terminal stage retries a missing artifact twice
// before giving up.
function missingReads(): DeployGraphRead[] {
  return [
    { graph: null, status: "missing" },
    { graph: null, status: "missing" },
    { graph: null, status: "missing" }
  ];
}

function statusReader(
  graphs: DeployGraphRead[],
  controlPlane?: string | (() => never)
): DeployOutcomeStatusReader {
  let index = 0;
  return {
    graph: () => {
      const next = graphs[index++];
      if (!next) throw new Error("unscripted graph read");
      return Promise.resolve(next);
    },
    controlPlaneLog: () => {
      if (typeof controlPlane === "function") return controlPlane();
      return Promise.resolve(controlPlane ?? null);
    }
  };
}

function outcomeRequest(overrides: Partial<DeployOutcomeRequest> = {}): {
  request: DeployOutcomeRequest;
  logs: string[];
  state: CanvasState;
  statusCalls: [CanvasGraphResource, string][];
  polls: boolean[];
} {
  const logs: string[] = [];
  const state: CanvasState = {};
  const statusCalls: [CanvasGraphResource, string][] = [];
  const polls: boolean[] = [];
  const request: DeployOutcomeRequest = {
    entry: { state },
    repo: "acme/widgets",
    runId: 42,
    provider: "azure",
    resources: [],
    conclusion: "success",
    steps: [],
    statusReader: statusReader(missingReads()),
    deployStepStartedAt: 0,
    log: (message) => logs.push(message),
    setStatus: (resource, status) => statusCalls.push([resource, status]),
    pollDeployStatus: (force) => {
      polls.push(force);
      return Promise.resolve();
    },
    ...overrides
  };
  return { request, logs, state, statusCalls, polls };
}

describe("deploy outcome construction", () => {
  it.each([
    "settleDeployStatuses",
    "fetchRunLog",
    "extractGitHubActionsStepLog",
    "explainOidcEnterpriseClaim",
    "extractRadDeployError",
    "classifyDeployCloudAuthDrift",
    "sleep",
    "now"
  ] as const)("refuses to construct without %s", (name) => {
    const incomplete = dependencies();
    delete incomplete[name];
    expect(() => createDeployOutcomeService(incomplete)).toThrow(
      `createDeployOutcomeService is missing required dependencies: ${name}`
    );
  });
});

describe("deploy outcome on success", () => {
  it("saves the published graph, settles the resources, and reports the provider", async () => {
    const resource: CanvasGraphResource = {
      id: "r1",
      name: "db",
      deployStatus: "in_progress"
    };
    const { request, logs, state, statusCalls, polls } = outcomeRequest({
      resources: [resource],
      statusReader: statusReader([{ graph: [{ id: "r1" }], status: "ok" }]),
      deployStepStartedAt: 1_700_000_000_000
    });
    const settled: unknown[] = [];
    const service = createDeployOutcomeService(
      dependencies({
        settleDeployStatuses: (resources, conclusion) => {
          settled.push([resources.length, conclusion]);
          resources.forEach((r) => {
            r.deployStatus = "success";
          });
        }
      })
    );

    await service.settle(request);

    expect(state.deployStatus).toBe("complete");
    expect(state.deployedGraph).toEqual([{ id: "r1" }]);
    expect(state.deployedGraphRepo).toBe("acme/widgets");
    expect(state.deployFinishedAt).toBe(1_700_000_060_000);
    expect(settled).toEqual([[1, "success"]]);
    expect(statusCalls).toEqual([[resource, "success"]]);
    // The final sweep is forced past the poll interval.
    expect(polls).toEqual([true]);
    expect(logs).toContain(
      "  ⏱ Deployment finished at 2023-11-14T22:14:20.000Z (60s)"
    );
    expect(logs).toContain(
      "  ✓ Deployed graph saved (from workflow artifact)."
    );
    expect(logs).toContain(
      "🎉 Deployment complete! Application deployed to Azure."
    );
    expect(logs).toContain(
      "Click on deployed resources to view them in the Azure Portal."
    );
  });

  it("names AWS for an AWS deploy", async () => {
    const { request, logs } = outcomeRequest({ provider: "aws" });
    const service = createDeployOutcomeService(dependencies());

    await service.settle(request);

    expect(logs).toContain(
      "🎉 Deployment complete! Application deployed to AWS."
    );
    expect(logs).toContain(
      "Click on deployed resources to view them in the AWS Console."
    );
  });

  it("omits the duration line when the rad step never started", async () => {
    const { request, logs, state } = outcomeRequest({ deployStepStartedAt: 0 });
    const service = createDeployOutcomeService(dependencies());

    await service.settle(request);

    expect(state.deployFinishedAt).toBe(1_700_000_060_000);
    expect(logs.some((line) => line.includes("Deployment finished at"))).toBe(
      false
    );
  });

  it("retries the graph read while the upload is still finalizing", async () => {
    const sleeps: number[] = [];
    const { request, state } = outcomeRequest({
      statusReader: statusReader([
        { graph: null, status: "missing" },
        { graph: null, status: "missing" },
        { graph: [{ id: "late" }], status: "ok" }
      ])
    });
    const service = createDeployOutcomeService(
      dependencies({
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        }
      })
    );

    await service.settle(request);

    expect(sleeps).toEqual([5000, 5000]);
    expect(state.deployedGraph).toEqual([{ id: "late" }]);
  });

  it("gives up after the third graph read", async () => {
    const sleeps: number[] = [];
    const { request, logs, state } = outcomeRequest({
      statusReader: statusReader([
        { graph: null, status: "missing" },
        { graph: null, status: "missing" },
        { graph: null, status: "missing" }
      ])
    });
    const service = createDeployOutcomeService(
      dependencies({
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        }
      })
    );

    await service.settle(request);

    expect(sleeps).toEqual([5000, 5000]);
    expect(state.deployedGraph).toBeUndefined();
    expect(logs).toContain(
      "  ⚠ Deployed graph not available (the deploy may not have published one)."
    );
  });

  it("leaves a resource the settle left without a status alone", async () => {
    // `settleDeployStatuses` is conservative: a node it cannot decide keeps no
    // status at all, and must not be pushed down onto output resources.
    const undecided: CanvasGraphResource = { id: "r1", name: "db" };
    const decided: CanvasGraphResource = {
      id: "r2",
      name: "api",
      deployStatus: "success"
    };
    const { request, statusCalls } = outcomeRequest({
      resources: [undecided, decided]
    });
    const service = createDeployOutcomeService(dependencies());

    await service.settle(request);

    expect(statusCalls).toEqual([[decided, "success"]]);
  });

  it("stops retrying an access-denied artifact read", async () => {
    const { request, logs } = outcomeRequest({
      statusReader: statusReader([{ graph: null, status: "auth" }])
    });
    const service = createDeployOutcomeService(
      dependencies({
        sleep: () => {
          throw new Error("a permission failure must not be retried");
        }
      })
    );

    await service.settle(request);

    expect(logs).toContain(
      "  ⚠ The deploy status artifact could not be read: access denied."
    );
    expect(logs).toContain(
      "    Check that the active gh account can read Actions artifacts for acme/widgets."
    );
  });

  it("explains a malformed artifact after exhausting the retries", async () => {
    const reads = [
      { graph: null, status: "malformed" },
      { graph: null, status: "malformed" },
      { graph: null, status: "malformed" }
    ];
    const { request, logs } = outcomeRequest({
      statusReader: statusReader(reads)
    });
    const service = createDeployOutcomeService(dependencies());

    await service.settle(request);

    expect(logs).toContain(
      "  ⚠ The deploy status artifact was found but could not be parsed. Continuing."
    );
  });
});

describe("deploy outcome on failure", () => {
  it("builds the failure from the failed steps, the run log, and the control-plane log", async () => {
    const { request, logs, state } = outcomeRequest({
      conclusion: "failure",
      steps: [
        { name: "Checkout", conclusion: "success" },
        { name: "Setup", conclusion: "skipped" },
        { name: "Run rad commands", conclusion: "failure" },
        { name: "Upload", conclusion: null }
      ],
      statusReader: statusReader(
        missingReads(),
        "noise\nrecipe failed: quota exceeded\n\n"
      )
    });
    const service = createDeployOutcomeService(
      dependencies({
        fetchRunLog: () => Promise.resolve("run log text"),
        extractRadDeployError: (text) =>
          text === "run log text" ? "Error: {\n  code: Conflict\n}" : ""
      })
    );

    await service.settle(request);

    expect(state.deployStatus).toBe("failed");
    expect(state.deployError).toBe(
      [
        "Deployment failed (failure). Failed step: Run rad commands.",
        "",
        "Error: {",
        "  code: Conflict",
        "}",
        "",
        "— control-plane log —",
        "noise",
        "recipe failed: quota exceeded",
        "",
        "View the full run: https://github.com/acme/widgets/actions/runs/42"
      ].join("\n")
    );
    expect(logs).toContain("❌ Deployment failed. Conclusion: failure");
    expect(logs).toContain("──────── failure details ────────");
    expect(logs).toContain("──────── control-plane log ────────");
  });

  it("prefixes the OIDC enterprise-claim explanation when the Azure login was rejected", async () => {
    const { request, state } = outcomeRequest({ conclusion: "failure" });
    const stepLogs: [string | null | undefined, string][] = [];
    const service = createDeployOutcomeService(
      dependencies({
        fetchRunLog: () => Promise.resolve("AADSTS7002381"),
        extractGitHubActionsStepLog: (text, step) => {
          stepLogs.push([text, step]);
          return "azure login log";
        },
        explainOidcEnterpriseClaim: (text) =>
          text === "azure login log" ? "Enterprise claim missing." : ""
      })
    );

    await service.settle(request);

    expect(stepLogs).toEqual([["AADSTS7002381", "Azure Login (OIDC)"]]);
    expect(state.deployError).toBe(
      [
        "Enterprise claim missing.",
        "",
        "\u2014 raw error \u2014",
        "Deployment failed (failure).",
        "",
        "View the full run: https://github.com/acme/widgets/actions/runs/42"
      ].join("\n")
    );
  });

  it("publishes deployError before flipping deployStatus to failed", async () => {
    // Regression for the "flaky error logs" race: the deploy-status poll fires
    // the repair handoff the instant it sees status === "failed", so the error
    // must already be present by then. fetchRunLog is an await point INSIDE
    // describeFailure, so snapshot the status there — it must not be "failed"
    // yet — and confirm the terminal state carries both.
    const { request, state } = outcomeRequest({
      conclusion: "failure",
      steps: [{ name: "Run rad commands", conclusion: "failure" }]
    });
    let statusWhenErrorAssembled: string | undefined;
    const service = createDeployOutcomeService(
      dependencies({
        fetchRunLog: () => {
          statusWhenErrorAssembled = state.deployStatus;
          return Promise.resolve("run log text");
        },
        extractRadDeployError: () => "Error: quota exceeded"
      })
    );

    await service.settle(request);

    expect(statusWhenErrorAssembled).not.toBe("failed");
    expect(state.deployStatus).toBe("failed");
    expect(state.deployError).toContain("Error: quota exceeded");
  });

  it("still settles as failed with a degraded message when describeFailure throws", async () => {
    // describeFailure's run-log read is unguarded. If it throws, settle() must
    // not reject: a rejection would leave the panel non-terminal AND reach the
    // monitor's `.catch`, which reclassifies a concluded "failure" run as
    // run-unconfirmed — routing it to the informational notice instead of the
    // repair path. The run must still land as "failed" with a degraded message.
    const { request, state } = outcomeRequest({ conclusion: "failure" });
    const service = createDeployOutcomeService(
      dependencies({
        fetchRunLog: () => Promise.reject(new Error("network down"))
      })
    );

    await expect(service.settle(request)).resolves.toBeUndefined();

    expect(state.deployStatus).toBe("failed");
    expect(state.deployError).toBe(
      "Deployment failed (failure). The failure details could not be read; " +
        "see the full run: https://github.com/acme/widgets/actions/runs/42."
    );
  });

  it("prefixes the auth-drift message and stamps the kind when a cloud login step fails before any resource is touched", async () => {
    // Exception 5.2: classifier matched, so the readable drift lead is prefixed
    // to describeFailure's message and the kind is stamped so the repair guard
    // leaves it for the user to re-verify.
    const driftInputs: unknown[] = [];
    const { request, state } = outcomeRequest({
      conclusion: "failure",
      provider: "aws",
      deployStepStartedAt: 0,
      steps: [
        { name: "Configure AWS Credentials", conclusion: "failure" },
        { name: "Run rad commands", conclusion: "skipped" }
      ]
    });
    const service = createDeployOutcomeService(
      dependencies({
        classifyDeployCloudAuthDrift: (input) => {
          driftInputs.push(input);
          return "Cloud authentication failed. Re-verify.";
        }
      })
    );

    await service.settle(request);

    expect(driftInputs).toEqual([
      {
        provider: "aws",
        resourcesTouched: false,
        failedStepNames: ["Configure AWS Credentials"]
      }
    ]);
    expect(state.deployStatus).toBe("failed");
    expect(state.deployErrorKind).toBe("cloud-auth-drift");
    expect(state.deployError).toContain(
      "Cloud authentication failed. Re-verify."
    );
    expect(state.deployError).toContain(
      "View the full run: https://github.com/acme/widgets/actions/runs/42"
    );
  });

  it("prefixes the auth-drift message even when describeFailure throws", async () => {
    const { request, state } = outcomeRequest({ conclusion: "failure" });
    const service = createDeployOutcomeService(
      dependencies({
        fetchRunLog: () => Promise.reject(new Error("network down")),
        classifyDeployCloudAuthDrift: () => "Cloud auth drift lead."
      })
    );

    await service.settle(request);

    expect(state.deployErrorKind).toBe("cloud-auth-drift");
    expect(state.deployError).toBe(
      "Cloud auth drift lead.\n\n" +
        "Deployment failed (failure). The failure details could not be read; " +
        "see the full run: https://github.com/acme/widgets/actions/runs/42."
    );
  });

  it("leaves the kind unset when the failure is not auth drift", async () => {
    const { request, state } = outcomeRequest({
      conclusion: "failure",
      deployStepStartedAt: 1_700_000_000_000,
      steps: [{ name: "Run rad commands", conclusion: "failure" }]
    });
    const service = createDeployOutcomeService(dependencies());

    await service.settle(request);

    expect(state.deployStatus).toBe("failed");
    expect(state.deployErrorKind).toBeUndefined();
  });

  it("reports a conclusion-less failure without inventing one", async () => {
    const { request, state } = outcomeRequest({ conclusion: null, steps: [] });
    const service = createDeployOutcomeService(dependencies());

    await service.settle(request);

    expect(state.deployError).toContain("Deployment failed.");
    expect(state.deployError).not.toContain("Failed step:");
  });

  it("omits the conclusion from the degraded message when there was none", async () => {
    // The catch-branch fallback must not print "(null)": a conclusion-less run
    // that also fails its log read gets a degraded message with no parenthetical.
    const { request, state } = outcomeRequest({ conclusion: null });
    const service = createDeployOutcomeService(
      dependencies({
        fetchRunLog: () => Promise.reject(new Error("network down"))
      })
    );

    await service.settle(request);

    expect(state.deployError).toBe(
      "Deployment failed. The failure details could not be read; " +
        "see the full run: https://github.com/acme/widgets/actions/runs/42."
    );
  });

  it("keeps the run-log details when the control-plane log cannot be read", async () => {
    const { request, state } = outcomeRequest({
      conclusion: "failure",
      statusReader: statusReader(missingReads(), () => {
        throw new Error("artifact expired");
      })
    });
    const service = createDeployOutcomeService(
      dependencies({ extractRadDeployError: () => "Error: { code: Boom }" })
    );

    await service.settle(request);

    expect(state.deployError).toContain("Error: { code: Boom }");
    expect(state.deployError).not.toContain("control-plane log");
  });

  it("ignores a control-plane log that is only whitespace", async () => {
    const { request, state } = outcomeRequest({
      conclusion: "failure",
      statusReader: statusReader(missingReads(), "   \n ")
    });
    const service = createDeployOutcomeService(dependencies());

    await service.settle(request);

    expect(state.deployError).not.toContain("control-plane log");
  });

  it("keeps only the tail of a long control-plane log", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}`);
    const { request, state } = outcomeRequest({
      conclusion: "failure",
      statusReader: statusReader(missingReads(), lines.join("\n"))
    });
    const service = createDeployOutcomeService(dependencies());

    await service.settle(request);

    expect(state.deployError).toContain("line-59");
    expect(state.deployError).toContain("line-20");
    expect(state.deployError).not.toContain("line-19");
  });
});
