import { describe, expect, it, vi } from "vitest";
import {
  createDeployRequestService,
  type DeployRequestDependencies,
  type DeploymentReservation
} from "./deploy-request.js";
import type { DeployMonitorRequest } from "./deploy-monitor.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import { createWorkflowObservationScope } from "./workflow-observation-scope.js";
import { createDeferred } from "../../../test/support/browser/fakes.js";
import type { DeployModelSource } from "./deploy-model-source.js";

// Every seam throws unless a test opts into it, so a path that reaches for a
// dependency it should not need fails loudly instead of getting a benign
// default. The four seams below are the ones nearly every case needs.
function dependencies(
  overrides: Partial<DeployRequestDependencies> = {}
): DeployRequestDependencies {
  return {
    readInstanceEntry: () => {
      throw new Error("readInstanceEntry not stubbed");
    },
    readModelForSelection: () => {
      throw new Error("readModelForSelection not stubbed");
    },
    resolveDeployRepairLoop: () => ({
      repairLoop: false,
      attemptId: "",
      repairAttempt: 0
    }),
    resolveDeploymentEnvironment: (_state, requested) =>
      typeof requested === "string" ? requested : "",
    activeDeploymentMutation: () => undefined,
    localDeploymentBlocksMutation: () => false,
    reserveDeploymentMutation: (_state, reservation) => ({
      ...reservation,
      expiresAt: 1
    }),
    deploymentStatusBlocksMutation: () => false,
    // Releasing is part of every accepted flow's terminal cleanup, so the
    // default is a no-op and the tests that care assert on it explicitly.
    releaseDeploymentMutation: () => {},
    resolveEnvDeployment: () => Promise.resolve(null),
    runCommand: () => {
      throw new Error("runCommand not stubbed");
    },
    canvasGraphResources: (values) => values as CanvasGraphResource[],
    beginDeployAttempt: (state, input) => {
      state.deployStatus = "in_progress";
      state.deployAttempt = {
        id:
          input.repairLoop && input.attemptId ? input.attemptId : "attempt-new",
        targetRepo: input.repo,
        environment: input.environment,
        branch: input.branch,
        provider: input.provider,
        appFile: input.appFile
      };
    },
    triggerDeployRepairHandoff: () => true,
    triggerDeployFailureNotice: () => false,
    monitor: {
      run: () => {
        throw new Error("monitor.run not stubbed");
      }
    },
    unconfirmedRunKind: "run-unconfirmed",
    repairAttemptCap: 5,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  };
}

// Builds a deliberately invalid dependency set so the construction guard can be
// driven. The cast is the point: the type system forbids this shape, and the
// guard is what protects the composition root when a seam is dropped anyway.
function without(
  ...names: (keyof DeployRequestDependencies)[]
): DeployRequestDependencies {
  const partial: Partial<DeployRequestDependencies> = dependencies();
  for (const name of names) delete partial[name];
  return partial as DeployRequestDependencies;
}

interface MonitorControl {
  calls: DeployMonitorRequest[];
  // No argument resolves the monitor; any argument — including `undefined` —
  // rejects it with that value, which is how a non-Error throw is modelled.
  settle(...reason: unknown[]): Promise<void>;
}

// A monitor that stays pending until the test settles it, which is what makes
// "the 200 is written before the deploy finishes" observable.
function controllableMonitor(): {
  monitor: DeployRequestDependencies["monitor"];
  control: MonitorControl;
} {
  const calls: DeployMonitorRequest[] = [];
  let resolveRun: (() => void) | undefined;
  let rejectRun: ((reason: unknown) => void) | undefined;
  let pending: Promise<void> | undefined;
  return {
    monitor: {
      run: (request) => {
        calls.push(request);
        pending = new Promise<void>((resolve, reject) => {
          resolveRun = resolve;
          rejectRun = reject;
        });
        return pending;
      }
    },
    control: {
      calls,
      async settle(...reason) {
        if (reason.length > 0) rejectRun?.(reason[0]);
        else resolveRun?.();
        await pending?.catch(() => {});
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  };
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    targetRepo: "acme/widgets",
    environment: "production",
    branch: "feat",
    provider: "azure",
    appFile: ".radius/app.bicep",
    ...overrides
  });
}

function parseError(body: string): string {
  try {
    JSON.parse(body);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected JSON.parse to fail");
}

function entryWith(state: CanvasState = {}) {
  return { state };
}

function entryReader(state: CanvasState = {}) {
  const entry = entryWith(state);
  return () => entry;
}

describe("deploy request service construction", () => {
  it.each([
    "readInstanceEntry",
    "readModelForSelection",
    "resolveDeployRepairLoop",
    "resolveDeploymentEnvironment",
    "activeDeploymentMutation",
    "localDeploymentBlocksMutation",
    "reserveDeploymentMutation",
    "releaseDeploymentMutation",
    "deploymentStatusBlocksMutation",
    "resolveEnvDeployment",
    "runCommand",
    "canvasGraphResources",
    "beginDeployAttempt",
    "triggerDeployRepairHandoff",
    "triggerDeployFailureNotice",
    "errorMessage"
  ] as const)("refuses to construct without %s", (name) => {
    expect(() => createDeployRequestService(without(name))).toThrow(
      `createDeployRequestService is missing required dependencies: ${name}`
    );
  });

  it("names every missing seam at once rather than the first", () => {
    expect(() =>
      createDeployRequestService(without("runCommand", "errorMessage"))
    ).toThrow(
      "createDeployRequestService is missing required dependencies: runCommand, errorMessage"
    );
  });

  it("refuses to construct without a monitor or a repair cap", () => {
    expect(() => createDeployRequestService(without("monitor"))).toThrow(
      "createDeployRequestService is missing required dependencies: monitor"
    );
    expect(() =>
      createDeployRequestService(without("repairAttemptCap"))
    ).toThrow(
      "createDeployRequestService is missing required dependencies: repairAttemptCap"
    );
  });

  it("refuses to construct without the unconfirmed-run marking", () => {
    expect(() =>
      createDeployRequestService(without("unconfirmedRunKind"))
    ).toThrow(
      "createDeployRequestService is missing required dependencies: unconfirmedRunKind"
    );
  });
});

describe("deploy request admission", () => {
  it.each([
    ["a malformed body", "not json"],
    ["an empty body", ""]
  ])(
    "answers 400 with the raw JSON.parse error for %s",
    async (_name, body) => {
      const service = createDeployRequestService(
        dependencies({
          readInstanceEntry: () => {
            throw new Error(
              "the entry must not be read before the body parses"
            );
          }
        })
      );

      const result = await service.deploy({ instanceId: "a", body });

      expect(result).toEqual({
        status: 400,
        body: { error: parseError(body) }
      });
    }
  );

  it("answers 400 when the instance entry is gone", async () => {
    const service = createDeployRequestService(
      dependencies({ readInstanceEntry: () => undefined })
    );

    expect(await service.deploy({ instanceId: "a", body: body() })).toEqual({
      status: 400,
      body: { error: "Canvas server state is unavailable." }
    });
  });

  it("refuses a repair-loop error with 409 before any state is touched", async () => {
    const state: CanvasState = { deployStatus: "failed" };
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        resolveDeployRepairLoop: () => ({
          repairLoop: false,
          attemptId: "",
          repairAttempt: 0,
          error: "already used its 5 automatic repair attempts"
        }),
        resolveDeploymentEnvironment: () => {
          throw new Error("the refusal must precede environment resolution");
        },
        reserveDeploymentMutation: () => {
          throw new Error("the refusal must precede the reservation");
        }
      })
    );

    expect(
      await service.deploy({
        instanceId: "a",
        body: body({ attemptId: "attempt-A" })
      })
    ).toEqual({
      status: 409,
      body: { error: "already used its 5 automatic repair attempts" }
    });
    expect(state).toEqual({ deployStatus: "failed" });
  });

  it("reads the attempt id off the parsed body, so a JSON null fails as it always did", async () => {
    const service = createDeployRequestService(
      dependencies({ readInstanceEntry: entryReader() })
    );

    const result = await service.deploy({ instanceId: "a", body: "null" });

    expect(result.status).toBe(400);
    expect(String((result.body as { error: string }).error)).toMatch(/null/i);
  });

  it.each([
    ["the request target", { targetRepo: "acme/widgets" }, {}, "acme/widgets"],
    ["the planned repo", {}, { plannedRepo: "acme/planned" }, "acme/planned"],
    ["the context repo", {}, { contextRepo: "acme/context" }, "acme/context"],
    [
      "the request target over both",
      { targetRepo: "acme/widgets" },
      { plannedRepo: "acme/planned", contextRepo: "acme/context" },
      "acme/widgets"
    ],
    [
      "the planned repo over the context repo",
      {},
      { plannedRepo: "acme/planned", contextRepo: "acme/context" },
      "acme/planned"
    ]
  ])(
    "resolves the repository from %s",
    async (_name, request, seed, expected) => {
      const state: CanvasState = { ...seed };
      const { monitor, control } = controllableMonitor();
      const service = createDeployRequestService(
        dependencies({ readInstanceEntry: entryReader(state), monitor })
      );

      const result = await service.deploy({
        instanceId: "a",
        body: JSON.stringify({
          environment: "production",
          branch: "feat",
          appFile: ".radius/app.bicep",
          ...request
        })
      });

      expect(result.status).toBe(200);
      expect(state.deployingRepo).toBe(expected);
      expect(control.calls[0].repo).toBe(expected);
      await control.settle();
    }
  );

  it("prefers the instance environment when the request omits one", async () => {
    const state: CanvasState = { envName: "staging" };
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        // The real resolver's precedence, reproduced here as the port contract.
        resolveDeploymentEnvironment: (current, requested) =>
          (typeof requested === "string" && requested) ||
          (typeof current.envName === "string" && current.envName) ||
          "",
        monitor
      })
    );

    const result = await service.deploy({
      instanceId: "a",
      body: body({ environment: undefined })
    });

    expect(result.status).toBe(200);
    expect(state.envName).toBe("staging");
    expect(state.deployAttempt?.environment).toBe("staging");
    await control.settle();
  });

  it.each([
    ["no repository", { targetRepo: "" }],
    ["no environment", { environment: "" }]
  ])("answers 400 when the request names %s", async (_name, overrides) => {
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        reserveDeploymentMutation: () => {
          throw new Error("nothing may be reserved for an invalid request");
        }
      })
    );

    expect(
      await service.deploy({ instanceId: "a", body: body(overrides) })
    ).toEqual({
      status: 400,
      body: { error: "targetRepo and environment are required." }
    });
  });

  it("refuses while this canvas already has a deploy running", async () => {
    const state: CanvasState = {
      deployStatus: "in_progress",
      deployingRepo: "acme/running",
      envName: "qa"
    };
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        localDeploymentBlocksMutation: () => true,
        reserveDeploymentMutation: () => {
          throw new Error("a blocked request must not reserve");
        }
      })
    );

    expect(await service.deploy({ instanceId: "a", body: body() })).toEqual({
      status: 409,
      body: {
        error:
          "A deploy operation for acme/running in environment qa is already in progress. Wait for it to finish before starting another operation."
      }
    });
  });

  it("names the active lease's own repo, environment and kind in the conflict", async () => {
    const lease: DeploymentReservation = {
      repo: "acme/leased",
      environment: "leased-env",
      kind: "delete",
      expiresAt: 1
    };
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        activeDeploymentMutation: () => lease
      })
    );

    expect(await service.deploy({ instanceId: "a", body: body() })).toEqual({
      status: 409,
      body: {
        error:
          "A delete operation for acme/leased in environment leased-env is already in progress. Wait for it to finish before starting another operation."
      }
    });
  });

  it("falls back to the stored attempt when the block carries no lease", async () => {
    const state: CanvasState = {
      deployAttempt: {
        id: "attempt-A",
        targetRepo: "acme/attempt",
        environment: "attempt-env",
        branch: "feat",
        provider: "azure",
        appFile: ".radius/app.bicep"
      }
    };
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        localDeploymentBlocksMutation: () => true
      })
    );

    expect(await service.deploy({ instanceId: "a", body: body() })).toEqual({
      status: 409,
      body: {
        error:
          "A deploy operation for acme/attempt in environment attempt-env is already in progress. Wait for it to finish before starting another operation."
      }
    });
  });

  it("falls back to the request itself when nothing else identifies the block", async () => {
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        localDeploymentBlocksMutation: () => true
      })
    );

    expect(await service.deploy({ instanceId: "a", body: body() })).toEqual({
      status: 409,
      body: {
        error:
          "A deploy operation for acme/widgets in environment production is already in progress. Wait for it to finish before starting another operation."
      }
    });
  });

  it("refuses when the reservation is lost to a concurrent request", async () => {
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        reserveDeploymentMutation: () => null,
        resolveEnvDeployment: () => {
          throw new Error("a lost reservation must not reach GitHub");
        }
      })
    );

    expect(await service.deploy({ instanceId: "a", body: body() })).toEqual({
      status: 409,
      body: { error: "Another deployment operation is already starting." }
    });
  });

  it("fails closed and releases the reservation when GitHub cannot be read", async () => {
    const released: DeploymentReservation[] = [];
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        resolveEnvDeployment: () => Promise.reject(new Error("gh down")),
        releaseDeploymentMutation: (_state, reservation) => {
          released.push(reservation);
        }
      })
    );

    expect(await service.deploy({ instanceId: "a", body: body() })).toEqual({
      status: 503,
      body: {
        error:
          "Could not verify whether this environment already has an operation in progress. Check your GitHub connection and try again."
      }
    });
    expect(released).toEqual([
      {
        repo: "acme/widgets",
        environment: "production",
        kind: "deploy",
        expiresAt: 1
      }
    ]);
  });

  it("looks the persisted deployment up by the repository's short name", async () => {
    const lookups: string[][] = [];
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        resolveEnvDeployment: (repo, environment, application) => {
          lookups.push([repo, environment, application]);
          return Promise.resolve(null);
        },
        monitor
      })
    );

    await service.deploy({ instanceId: "a", body: body() });
    // A repo slug with no owner is its own short name.
    await service.deploy({
      instanceId: "a",
      body: body({ targetRepo: "widgets" })
    });
    // A trailing slash leaves an empty short name, which falls back to the slug.
    await service.deploy({
      instanceId: "a",
      body: body({ targetRepo: "acme/" })
    });

    expect(lookups).toEqual([
      ["acme/widgets", "production", "widgets"],
      ["widgets", "production", "widgets"],
      ["acme/", "production", "acme/"]
    ]);
    await control.settle();
  });

  it.each([
    [
      "deleting",
      "This deployment is currently being deleted. Wait for it to finish before deploying again."
    ],
    ["in_progress", "A deployment to this environment is already in progress."]
  ])(
    "refuses a %s persisted deployment and releases",
    async (status, error) => {
      let released = 0;
      const service = createDeployRequestService(
        dependencies({
          readInstanceEntry: entryReader(),
          resolveEnvDeployment: () => Promise.resolve({ status }),
          deploymentStatusBlocksMutation: () => true,
          releaseDeploymentMutation: () => {
            released += 1;
          }
        })
      );

      expect(await service.deploy({ instanceId: "a", body: body() })).toEqual({
        status: 409,
        body: { error }
      });
      expect(released).toBe(1);
    }
  );

  it("ignores a persisted deployment that does not block", async () => {
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        resolveEnvDeployment: () => Promise.resolve({ status: "deployed" }),
        deploymentStatusBlocksMutation: () => false,
        monitor
      })
    );

    expect(
      (await service.deploy({ instanceId: "a", body: body() })).status
    ).toBe(200);
    await control.settle();
  });
});

describe("deploy request branch resolution", () => {
  it("uses the requested branch without shelling out", async () => {
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        runCommand: () => {
          throw new Error("an explicit branch must not be looked up");
        },
        monitor
      })
    );

    await service.deploy({ instanceId: "a", body: body({ branch: "feat" }) });

    expect(control.calls[0].branch).toBe("feat");
    await control.settle();
  });

  it.each([
    ["a detected default", "  release/7\n", "release/7"],
    ["an empty answer", "   ", "main"]
  ])("falls back to %s", async (_name, stdout, expected) => {
    const calls: [string, string[]][] = [];
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        runCommand: (command, args) => {
          calls.push([command, args]);
          return Promise.resolve(stdout);
        },
        monitor
      })
    );

    await service.deploy({ instanceId: "a", body: body({ branch: "" }) });

    expect(calls).toEqual([
      [
        "gh",
        [
          "repo",
          "view",
          "acme/widgets",
          "--json",
          "defaultBranchRef",
          "--jq",
          ".defaultBranchRef.name"
        ]
      ]
    ]);
    expect(control.calls[0].branch).toBe(expected);
    await control.settle();
  });

  it("falls back to main when the lookup fails", async () => {
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        runCommand: () => Promise.reject(new Error("gh missing")),
        monitor
      })
    );

    await service.deploy({ instanceId: "a", body: body({ branch: "" }) });

    expect(control.calls[0].branch).toBe("main");
    await control.settle();
  });

  it("resolves the branch before the attempt is opened", async () => {
    const order: string[] = [];
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        runCommand: () => {
          order.push("branch-lookup");
          return Promise.resolve("main");
        },
        beginDeployAttempt: (state) => {
          order.push("begin-attempt");
          state.deployAttempt = {
            id: "attempt-new",
            targetRepo: "acme/widgets",
            environment: "production",
            branch: "main",
            provider: "azure",
            appFile: ".radius/app.bicep"
          };
        },
        monitor
      })
    );

    await service.deploy({ instanceId: "a", body: body({ branch: "" }) });

    expect(order).toEqual(["branch-lookup", "begin-attempt"]);
    await control.settle();
  });
});

describe("deploy model admission", () => {
  it.each([
    { explicit: false, repair: false, reuse: true },
    { explicit: true, repair: false, reuse: false },
    { explicit: false, repair: true, reuse: false },
    { explicit: true, repair: true, reuse: false }
  ])(
    "isolates selected-model graphs (explicit: $explicit, repair: $repair)",
    async ({ explicit, repair, reuse }) => {
      const state: CanvasState = {
        plannedResources: [{ id: "cached", name: "cached" }],
        deployParams: explicit ? { appFile: "app.bicep" } : {},
        deployAttempt: { id: "attempt", appFile: "app.bicep" }
      };
      const { monitor, control } = controllableMonitor();
      const service = createDeployRequestService(
        dependencies({
          readInstanceEntry: entryReader(state),
          monitor,
          readModelForSelection: async () => ({ status: "missing" }),
          resolveDeployRepairLoop: () => ({
            repairLoop: repair,
            attemptId: repair ? "attempt" : "",
            repairAttempt: repair ? 1 : 0
          })
        })
      );
      expect(
        (
          await service.deploy({
            instanceId: "a",
            body: body({
              appFile: explicit ? "app.bicep" : undefined,
              attemptId: repair ? "attempt" : undefined
            })
          })
        ).status
      ).toBe(200);
      expect(control.calls[0].resources).toEqual(
        reuse ? [{ id: "cached", name: "cached", deployStatus: "pending" }] : []
      );
      expect(state.plannedResources).toEqual([
        { id: "cached", name: "cached" }
      ]);
      await control.settle();
    }
  );

  it("reselects a newly available managed model on an ordinary automatic repeat", async () => {
    const state: CanvasState = {};
    let managed = false;
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        monitor,
        readModelForSelection: async () =>
          managed ?
            {
              status: "available",
              content: "managed model",
              fromWorkspace: true
            }
          : { status: "missing" }
      })
    );
    expect(
      (
        await service.deploy({
          instanceId: "a",
          body: body({ appFile: undefined })
        })
      ).status
    ).toBe(200);
    expect(state.deployAttempt?.appFile).toBe("app.bicep");
    await control.settle();
    managed = true;
    expect(
      (
        await service.deploy({
          instanceId: "a",
          body: JSON.stringify(state.deployParams)
        })
      ).status
    ).toBe(200);
    expect(state.deployAttempt?.appFile).toBe(".radius/app.bicep");
    expect(state.deployParams).not.toHaveProperty("appFile");
    await control.settle();
  });

  it.each([
    { source: null, expected: "app.bicep" },
    { source: "", expected: "app.bicep" },
    { source: "  \n", expected: ".radius/app.bicep" },
    { source: "managed model", expected: ".radius/app.bicep" }
  ])(
    "selects $expected from managed content $source before creating the attempt",
    async ({ source, expected }) => {
      const state: CanvasState = {};
      const { monitor, control } = controllableMonitor();
      const readModelForSelection = vi.fn(
        async (): Promise<DeployModelSource> => {
          expect(state.deployAttempt).toBeUndefined();
          return source === null ?
              { status: "missing" }
            : { status: "available", content: source, fromWorkspace: false };
        }
      );
      const service = createDeployRequestService(
        dependencies({
          readInstanceEntry: entryReader(state),
          monitor,
          readModelForSelection
        })
      );
      const result = await service.deploy({
        instanceId: "a",
        body: body({ appFile: undefined })
      });
      expect(result.status).toBe(200);
      expect(readModelForSelection).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ state }),
        "acme/widgets",
        "feat",
        ".radius/app.bicep"
      );
      expect(state.appFile).toBe(expected);
      expect(state.deployAttempt?.appFile).toBe(expected);
      expect(state.deployParams).not.toHaveProperty("appFile");
      expect(control.calls[0].appFile).toBe(expected);
      await control.settle();
    }
  );

  it.each([
    null,
    3,
    {},
    "",
    " ",
    "../app.bicep",
    "/app.bicep",
    "C:\\app.bicep",
    "-app.bicep",
    "radius-environment.bicep"
  ])(
    "rejects invalid explicit path %j before reserving or reading",
    async (appFile) => {
      const reserveDeploymentMutation = vi.fn(() => {
        throw new Error("Must not reserve");
      });
      const state: CanvasState = {};
      const service = createDeployRequestService(
        dependencies({
          readInstanceEntry: entryReader(state),
          reserveDeploymentMutation
        })
      );
      const result = await service.deploy({
        instanceId: "a",
        body: body({ appFile })
      });
      expect(result.status).toBe(400);
      expect(result.body).toHaveProperty("error");
      expect(reserveDeploymentMutation).not.toHaveBeenCalled();
      expect(state).toEqual({});
    }
  );

  it("normalizes explicit paths and never probes another model", async () => {
    const state: CanvasState = {};
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        monitor
      })
    );
    expect(
      (
        await service.deploy({
          instanceId: "a",
          body: body({ appFile: ".\\models\\app.bicep" })
        })
      ).status
    ).toBe(200);
    expect(control.calls[0].appFile).toBe("models/app.bicep");
    expect(state.deployParams?.appFile).toBe("models/app.bicep");
    await control.settle();
  });

  it.each([false, true])(
    "fails closed and releases its reservation on unavailable selection (throws: %s)",
    async (throws) => {
      const state: CanvasState = {};
      const releaseDeploymentMutation = vi.fn();
      const service = createDeployRequestService(
        dependencies({
          readInstanceEntry: entryReader(state),
          releaseDeploymentMutation,
          readModelForSelection: async () => {
            if (throws) throw new Error("GitHub is unavailable");
            return { status: "unavailable", error: "GitHub is unavailable" };
          }
        })
      );
      const result = await service.deploy({
        instanceId: "a",
        body: body({ appFile: undefined })
      });
      expect(result).toEqual({
        status: 503,
        body: {
          error: "Could not select the deployment model: GitHub is unavailable"
        }
      });
      expect(state).toEqual({});
      expect(releaseDeploymentMutation).toHaveBeenCalledExactlyOnceWith(
        state,
        expect.objectContaining({ kind: "deploy" })
      );
    }
  );

  it.each([
    "removed",
    "entry",
    "attempt",
    "generation",
    "observation",
    "stopped"
  ] as const)(
    "does not publish stale selection after a changed %s",
    async (change) => {
      const state: CanvasState = {
        deployGeneration: 1,
        deployAttempt: { id: "original" }
      };
      const noReader = () => {
        throw new Error("No workflow reader expected during admission");
      };
      const original = {
        state,
        observation: createWorkflowObservationScope(noReader)
      };
      let live: typeof original | undefined = original;
      const reading = createDeferred<void>();
      const selected = createDeferred<DeployModelSource>();
      const releaseDeploymentMutation = vi.fn();
      const service = createDeployRequestService(
        dependencies({
          readInstanceEntry: () => live,
          releaseDeploymentMutation,
          readModelForSelection: () => {
            reading.resolve();
            return selected.promise;
          }
        })
      );
      const pending = service.deploy({
        instanceId: "a",
        body: body({ appFile: undefined })
      });
      await reading.promise;
      if (change === "removed") live = undefined;
      else if (change === "entry") live = { ...original };
      else if (change === "attempt")
        state.deployAttempt = { id: "replacement" };
      else if (change === "generation") state.deployGeneration = 2;
      else if (change === "observation")
        original.observation = createWorkflowObservationScope(noReader);
      else original.observation.stop();
      selected.resolve({ status: "missing" });
      expect((await pending).status).toBe(409);
      expect(state.appFile).toBeUndefined();
      expect(state.deployStatus).toBeUndefined();
      expect(releaseDeploymentMutation).toHaveBeenCalledExactlyOnceWith(
        state,
        expect.objectContaining({ kind: "deploy" })
      );
      original.observation.stop();
    }
  );

  it.each([undefined, "./app.bicep", ".radius/app.bicep"])(
    "pins direct repair requests to the immutable model (supplied: %s)",
    async (appFile) => {
      const state: CanvasState = {
        deployAttempt: { id: "repair", appFile: "app.bicep" },
        deployParams: { targetRepo: "acme/widgets", branch: "feat" }
      };
      const { monitor, control } = controllableMonitor();
      const service = createDeployRequestService(
        dependencies({
          readInstanceEntry: entryReader(state),
          monitor,
          resolveDeployRepairLoop: () => ({
            repairLoop: true,
            attemptId: "repair",
            repairAttempt: 1
          })
        })
      );
      const result = await service.deploy({
        instanceId: "a",
        body: body({ appFile, attemptId: "repair" })
      });
      if (appFile === ".radius/app.bicep") {
        expect(result.status).toBe(409);
        expect(control.calls).toEqual([]);
      } else {
        expect(result.status).toBe(200);
        expect(control.calls[0].appFile).toBe("app.bicep");
        expect(state.deployAttempt?.id).toBe("repair");
        expect(state.deployParams).not.toHaveProperty("appFile");
      }
      await control.settle();
    }
  );
});

describe("deploy request attempt setup", () => {
  it("passes an explicitly selected root model to the monitor", async () => {
    const state: CanvasState = {};
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({ readInstanceEntry: entryReader(state), monitor })
    );
    const result = await service.deploy({
      instanceId: "a",
      body: body({ appFile: "app.bicep" })
    });
    expect(result.status).toBe(200);
    expect(control.calls[0].appFile).toBe("app.bicep");
    expect(state.deployAttempt?.appFile).toBe("app.bicep");
    await control.settle();
  });

  it("records the deploy parameters, clones the planned graph as pending, and resets the log buffer", async () => {
    const state: CanvasState = {
      deployLogs: ["stale"],
      deployLogBase: 99,
      plannedResources: [
        {
          id: "r1",
          name: "db",
          deployStatus: "success",
          outputResources: [{ id: "o1", deployStatus: "success" }]
        },
        { id: "r2", name: "api", deployStatus: "failed" }
      ]
    };
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        monitor,
        readModelForSelection: async () => ({
          status: "available",
          content: "managed model",
          fromWorkspace: true
        })
      })
    );

    await service.deploy({
      instanceId: "a",
      body: body({ appFile: undefined })
    });

    expect(state.deployParams).toEqual({
      targetRepo: "acme/widgets",
      environment: "production",
      branch: "feat",
      provider: "azure"
    });
    expect(state.envName).toBe("production");
    expect(state.deployProvider).toBe("azure");
    expect(state.deployingRepo).toBe("acme/widgets");
    expect(state.appFile).toBe(".radius/app.bicep");
    expect(state.deployLogs).toEqual([]);
    expect(state.deployLogBase).toBe(0);
    // A clone, not the planned array itself, with every node reset to pending.
    expect(state.deployingResources).not.toBe(state.plannedResources);
    expect(state.deployingResources).toEqual([
      {
        id: "r1",
        name: "db",
        deployStatus: "pending",
        outputResources: [{ id: "o1", deployStatus: "pending" }]
      },
      { id: "r2", name: "api", deployStatus: "pending" }
    ]);
    expect(state.plannedResources?.[0].deployStatus).toBe("success");
    await control.settle();
  });

  it.each([
    ["an absent planned graph", undefined],
    ["a null planned graph", null]
  ])("starts from an empty graph for %s", async (_name, planned) => {
    const state: CanvasState = { plannedResources: planned };
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        monitor,
        readModelForSelection: async () => ({ status: "missing" })
      })
    );

    await service.deploy({
      instanceId: "a",
      body: body({ appFile: undefined })
    });

    expect(state.deployingResources).toEqual([]);
    expect(control.calls[0].resources).toEqual([]);
    await control.settle();
  });

  it("ignores a persisted planned graph that is not an array", async () => {
    const state: CanvasState = {};
    // The state survives a JSON round trip through storage, so a corrupted
    // value can be any shape by the time it is read back.
    Object.assign(state, { plannedResources: { nope: true } });
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        monitor,
        readModelForSelection: async () => ({ status: "missing" })
      })
    );

    await service.deploy({
      instanceId: "a",
      body: body({ appFile: undefined })
    });

    expect(state.deployingResources).toEqual([]);
    await control.settle();
  });

  it("defaults the provider and app file the attempt is opened with", async () => {
    const attempts: unknown[] = [];
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        readModelForSelection: async () => ({
          status: "available",
          content: "managed model",
          fromWorkspace: true
        }),
        beginDeployAttempt: (state, input) => {
          attempts.push(input);
          state.deployAttempt = { id: "attempt-new", targetRepo: input.repo };
        },
        monitor
      })
    );

    await service.deploy({
      instanceId: "a",
      body: JSON.stringify({
        targetRepo: "acme/widgets",
        environment: "production",
        branch: "feat"
      })
    });

    expect(attempts).toEqual([
      {
        repo: "acme/widgets",
        branch: "feat",
        provider: "azure",
        environment: "production",
        appFile: ".radius/app.bicep",
        repairLoop: false,
        attemptId: ""
      }
    ]);
    await control.settle();
  });

  it("binds the reservation to the attempt the deploy just opened", async () => {
    const reservations: DeploymentReservation[] = [];
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        reserveDeploymentMutation: (_state, reservation) => {
          const lease = { ...reservation, expiresAt: 1 };
          reservations.push(lease);
          return lease;
        },
        monitor
      })
    );

    await service.deploy({ instanceId: "a", body: body() });

    expect(reservations[0].attemptId).toBe("attempt-new");
    await control.settle();
  });

  it("reports the repair budget only for a loop redeploy", async () => {
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader({
          deployAttempt: { id: "attempt-A", appFile: ".radius/app.bicep" }
        }),
        resolveDeployRepairLoop: () => ({
          repairLoop: true,
          attemptId: "attempt-A",
          repairAttempt: 3
        }),
        repairAttemptCap: 5,
        monitor
      })
    );

    expect(
      await service.deploy({
        instanceId: "a",
        body: body({ attemptId: "attempt-A" })
      })
    ).toEqual({
      status: 200,
      body: { ok: true, repairAttempt: 3, repairAttemptCap: 5 }
    });
    await control.settle();
  });
});

describe("deploy request background monitor ownership", () => {
  it.each(["removed", "replaced", "attempt", "stopped"] as const)(
    "fences a %s observer but releases its original reservation after actual settlement",
    async (mode) => {
      const { monitor, control } = controllableMonitor();
      const scope = createWorkflowObservationScope(() => {
        throw new Error("No reader expected");
      });
      const original = { state: {} as CanvasState, observation: scope };
      let live: typeof original | undefined = original;
      let releases = 0;
      let handoffs = 0;
      let notices = 0;
      const service = createDeployRequestService(
        dependencies({
          readInstanceEntry: () => live,
          monitor,
          releaseDeploymentMutation: (state) => {
            expect(state).toBe(original.state);
            releases++;
          },
          triggerDeployRepairHandoff: () => {
            handoffs++;
            return true;
          },
          triggerDeployFailureNotice: () => {
            notices++;
            return true;
          }
        })
      );
      await service.deploy({ instanceId: "a", body: body() });
      if (mode === "removed") live = undefined;
      else if (mode === "replaced") live = { ...original };
      else if (mode === "attempt")
        original.state.deployAttempt = { id: "new-attempt" };
      else scope.stop();
      control.calls[0].log("late observation");
      expect(original.state.deployLogs).toEqual([]);
      expect(releases).toBe(0);
      await control.settle(new Error("late observation rejection"));
      expect(original.state.deployStatus).toBe("in_progress");
      expect(releases).toBe(1);
      expect(handoffs).toBe(0);
      expect(notices).toBe(0);
      scope.stop();
    }
  );
  it("answers before the monitor settles and releases the reservation only afterwards", async () => {
    const released: string[] = [];
    const handoffs: string[] = [];
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        releaseDeploymentMutation: (_state, reservation) => {
          released.push(reservation.repo);
        },
        triggerDeployRepairHandoff: (_entry, instanceId) => {
          handoffs.push(instanceId);
          return true;
        },
        monitor
      })
    );

    const result = await service.deploy({
      instanceId: "panel-a",
      body: body()
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(control.calls).toHaveLength(1);
    expect(released).toEqual([]);
    expect(handoffs).toEqual([]);

    await control.settle();

    expect(handoffs).toEqual(["panel-a"]);
    expect(released).toEqual(["acme/widgets"]);
  });

  it("also relays a run-unconfirmed failure notice once the monitor settles", async () => {
    const notices: string[] = [];
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(),
        releaseDeploymentMutation: () => {},
        triggerDeployRepairHandoff: () => false,
        triggerDeployFailureNotice: (_entry, instanceId) => {
          notices.push(instanceId);
          return true;
        },
        monitor
      })
    );

    await service.deploy({ instanceId: "panel-a", body: body() });
    // The notice fires from the monitor-owned finally, not the answer path.
    expect(notices).toEqual([]);

    await control.settle();

    expect(notices).toEqual(["panel-a"]);
  });

  it("caps the deploy log buffer and counts the lines it dropped", async () => {
    const state: CanvasState = {};
    let log: ((message: string) => void) | undefined;
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        releaseDeploymentMutation: () => {},
        monitor: {
          run: (request) => {
            log = request.log;
            return Promise.resolve();
          }
        }
      })
    );

    await service.deploy({ instanceId: "a", body: body() });
    for (let i = 0; i < 4003; i++) log?.(`line-${i}`);

    expect(state.deployLogs).toHaveLength(4000);
    expect(state.deployLogs?.[0]).toBe("line-3");
    expect(state.deployLogBase).toBe(3);
  });

  it("re-creates the log buffer when the view state was reset underneath it", async () => {
    const state: CanvasState = {};
    let log: ((message: string) => void) | undefined;
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        monitor: {
          run: (request) => {
            log = request.log;
            return Promise.resolve();
          }
        }
      })
    );

    await service.deploy({ instanceId: "a", body: body() });
    delete state.deployLogs;
    log?.("after the reset");

    expect(state.deployLogs).toEqual(["after the reset"]);
  });

  it.each([
    ["an Error", new Error("monitor exploded"), "monitor exploded"],
    [
      "a thrown object carrying a message",
      { message: "plain object failure" },
      "plain object failure"
    ],
    ["a thrown string", "string failure", "string failure"],
    ["a thrown undefined", undefined, "undefined"],
    ["a message-less object", {}, "[object Object]"],
    ["an object whose message is empty", { message: "" }, "[object Object]"]
  ])(
    "settles a deploy whose monitor rejected with %s as unconfirmed",
    async (_name, thrown, expected) => {
      const state: CanvasState = {};
      const { monitor, control } = controllableMonitor();
      const service = createDeployRequestService(
        dependencies({
          readInstanceEntry: entryReader(state),
          releaseDeploymentMutation: () => {},
          monitor
        })
      );

      await service.deploy({ instanceId: "a", body: body() });
      await control.settle(thrown);

      expect(state.deployStatus).toBe("failed");
      expect(state.deployErrorKind).toBe("run-unconfirmed");
      expect(state.deployError).toBe(
        `Deploy monitoring stopped unexpectedly: ${expected}`
      );
      expect(state.deployLogs).toEqual([
        `❌ Deploy monitor stopped unexpectedly: ${expected}`
      ]);
    }
  );

  it("keeps an error the monitor already recorded", async () => {
    const state: CanvasState = {};
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        releaseDeploymentMutation: () => {},
        monitor
      })
    );

    await service.deploy({ instanceId: "a", body: body() });
    state.deployError = "the monitor's own diagnosis";
    await control.settle(new Error("late crash"));

    expect(state.deployError).toBe("the monitor's own diagnosis");
    expect(state.deployErrorKind).toBe("run-unconfirmed");
  });

  it("still runs cleanup when the failure handler itself throws", async () => {
    const state: CanvasState = {};
    const handoffs: string[] = [];
    let released = 0;
    const { monitor, control } = controllableMonitor();
    const service = createDeployRequestService(
      dependencies({
        readInstanceEntry: entryReader(state),
        releaseDeploymentMutation: () => {
          released += 1;
        },
        triggerDeployRepairHandoff: (_entry, instanceId) => {
          handoffs.push(instanceId);
          return true;
        },
        monitor
      })
    );

    await service.deploy({ instanceId: "panel-a", body: body() });
    // A frozen buffer makes the first addLog inside the catch throw, which is
    // the one case the inner try/catch exists for.
    Object.freeze(state.deployLogs);
    await control.settle(new Error("monitor exploded"));

    expect(state.deployStatus).toBe("in_progress");
    expect(handoffs).toEqual(["panel-a"]);
    expect(released).toBe(1);
  });
});
