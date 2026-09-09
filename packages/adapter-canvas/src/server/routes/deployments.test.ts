import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createDeploymentsRoutes,
  handleAbandonDeployment,
  handleDeleteDeployment,
  handleDeleteResource,
  handleDeleteRunStatus,
  handleDeploy,
  handleDeployNotification,
  handleDeployReset,
  handleDeployStatus,
  handleListApplications,
  handleListDeployments,
  type DeployListCacheEntry,
  type DeploymentsInstanceEntry,
  type DeploymentsDependencies,
  type DeploymentRow
} from "./deployments.js";
import { buildDeployedInventory } from "../services/deployed-inventory.js";
import type { CanvasState } from "../../shared.js";
import type { StateSaveFailure } from "../../state-save-diagnostics.js";
import type { CanvasServerEntry } from "../types.js";

interface Recording {
  headers: Record<string, string>;
  status: number;
  body: string;
}

function recorder() {
  const recording: Recording = { headers: {}, status: 0, body: "" };
  const target = {
    setHeader(name: string, value: string) {
      recording.headers[name] = value;
      return this;
    },
    writeHead(status: number) {
      recording.status = status;
      return this;
    },
    end(value = "") {
      recording.body += value;
      return this;
    }
  };
  return {
    recording,
    response: target as unknown as ServerResponse<IncomingMessage>
  };
}

function request(method: string, url: string, body = ""): IncomingMessage {
  return Object.assign(Readable.from(body ? [body] : []), {
    url,
    method,
    headers: {}
  }) as unknown as IncomingMessage;
}

function context(method: string, url: string, body = "") {
  const { recording, response } = recorder();
  return {
    recording,
    context: createRequestContext(
      request(method, url, body),
      response,
      "panel-a",
      new Map<string, CanvasServerEntry>()
    )
  };
}

// Every seam throws unless the test opts into it, so a handler that reaches for
// a dependency it should not need fails loudly rather than silently getting a
// benign default.
function dependencies(
  overrides: Partial<DeploymentsDependencies> = {}
): DeploymentsDependencies {
  return {
    isValidRepoSlug: (value) => value === "octo/todolist",
    readInstanceEntry: () => {
      throw new Error("readInstanceEntry not stubbed");
    },
    triggerDeployRepairHandoff: () => {
      throw new Error("triggerDeployRepairHandoff not stubbed");
    },
    triggerDeployFailureNotice: () => false,
    deployHandoffStatus: () => {
      throw new Error("deployHandoffStatus not stubbed");
    },
    resolveRepoAppName: () => {
      throw new Error("resolveRepoAppName not stubbed");
    },
    resolveEnvDeployment: () => {
      throw new Error("resolveEnvDeployment not stubbed");
    },
    ghOrThrow: () => {
      throw new Error("ghOrThrow not stubbed");
    },
    resetDeploymentViewState: () => {
      throw new Error("resetDeploymentViewState not stubbed");
    },
    deployListCache: {
      get: () => {
        throw new Error("deployListCache.get not stubbed");
      },
      set: () => {
        throw new Error("deployListCache.set not stubbed");
      },
      delete: () => {
        throw new Error("deployListCache.delete not stubbed");
      }
    },
    deployListTtlMs: 15000,
    activeDeploymentMutation: () => {
      throw new Error("activeDeploymentMutation not stubbed");
    },
    reserveDeploymentMutation: () => {
      throw new Error("reserveDeploymentMutation not stubbed");
    },
    releaseDeploymentMutation: () => {
      throw new Error("releaseDeploymentMutation not stubbed");
    },
    deploymentStatusBlocksMutation: () => {
      throw new Error("deploymentStatusBlocksMutation not stubbed");
    },
    localDeploymentBlocksMutation: () => {
      throw new Error("localDeploymentBlocksMutation not stubbed");
    },
    ensureWorkflowsCurrent: () => {
      throw new Error("ensureWorkflowsCurrent not stubbed");
    },
    findWorkflowRun: () => {
      throw new Error("findWorkflowRun not stubbed");
    },
    latestWorkflowRunId: () => {
      throw new Error("latestWorkflowRunId not stubbed");
    },
    newCorrelationId: () => {
      throw new Error("newCorrelationId not stubbed");
    },
    runGh: () => {
      throw new Error("runGh not stubbed");
    },
    readProcessEnv: () => ({}),
    repoMatchesWorkspace: () => false,
    reloadModeledGraph: () => {
      throw new Error("reloadModeledGraph not stubbed");
    },
    invalidateDeployedGraphCache: () => {
      throw new Error("invalidateDeployedGraphCache not stubbed");
    },
    readStateSaveFailure: () => {
      throw new Error("readStateSaveFailure not stubbed");
    },
    // Timers run inline so the dispatch retry delays cost nothing; the lease
    // callback is captured rather than fired, matching a real pending timer.
    setTimer: (callback, ms) => {
      if (ms === 0) callback();
      return {};
    },
    deployRequest: {
      deploy: () => {
        throw new Error("deployRequest.deploy not stubbed");
      }
    },
    abandonment: {
      abandon: () => {
        throw new Error("abandonment.abandon not stubbed");
      }
    },
    ...overrides
  };
}

// The delete route needs far more collaborators than the read routes, so its
// happy path is assembled once here and narrowed per test.
function deleteDependencies(
  overrides: Partial<DeploymentsDependencies> = {}
): DeploymentsDependencies {
  return dependencies({
    readInstanceEntry: () => ({ state: {} }),
    activeDeploymentMutation: () => undefined,
    localDeploymentBlocksMutation: () => false,
    reserveDeploymentMutation: () => LEASE,
    releaseDeploymentMutation: () => {},
    deploymentStatusBlocksMutation: () => false,
    resolveEnvDeployment: () => Promise.resolve(null),
    ensureWorkflowsCurrent: () => Promise.resolve({ created: [], failed: [] }),
    // The default reload is a no-op that reports success: the state the test
    // set up IS the current definition unless the test says otherwise.
    reloadModeledGraph: () => Promise.resolve({ status: 200 }),
    runGh: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    findWorkflowRun: () => Promise.resolve(null),
    // A fixed id keeps the dispatch argv assertions readable; the production
    // seam is random.
    newCorrelationId: () => CORRELATION_ID,
    latestWorkflowRunId: () => Promise.resolve(null),
    deployListCache: {
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined
    },
    // Dispatch and run-discovery delays run inline so the retries cost no real
    // time; the reservation lease (twice the listing TTL) stays pending, as a
    // real timer would.
    setTimer: (callback, ms) => {
      if (ms <= 5000) callback();
      return {};
    },
    ...overrides
  });
}

const LEASE = {
  repo: "octo/todolist",
  environment: "dev",
  kind: "delete" as const,
  expiresAt: 0
};

// The per-dispatch correlation id every delete test dispatches with.
const CORRELATION_ID = "del-test-0001";

const IDLE_HANDOFF = {
  state: "idle",
  attempts: 0,
  maxAttempts: 3,
  pending: false
};

function statusDependencies(
  state: CanvasState | undefined,
  overrides: Partial<DeploymentsDependencies> = {}
): DeploymentsDependencies {
  return dependencies({
    readInstanceEntry: () => (state ? { state } : undefined),
    triggerDeployRepairHandoff: () => false,
    deployHandoffStatus: () => IDLE_HANDOFF,
    ...overrides
  });
}

function row(environment: string, status = "deployed"): DeploymentRow {
  return {
    app: "todolist",
    environment,
    provider: "azure",
    status,
    deploymentId: `dep-${environment}`,
    runUrl: `https://example.test/${environment}`
  };
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

describe("deployments routes (SU-06)", () => {
  it("declares exactly the ten routes it owns", () => {
    const routes = createDeploymentsRoutes(dependencies());
    expect(Object.keys(routes)).toEqual([
      "GET /api/deploy-status",
      "GET /api/deploy-notification",
      "GET /api/list-applications",
      "GET /api/list-deployments",
      "POST /api/deploy",
      "POST /api/deploy-reset",
      "POST /api/delete-deployment",
      "POST /api/delete-resource",
      "GET /api/delete-run-status",
      "POST /api/abandon-deployment"
    ]);
  });

  it("dispatches each declared key to its own handler", async () => {
    const state: CanvasState = {};
    const routes = createDeploymentsRoutes(
      dependencies({
        readInstanceEntry: () => ({ state }),
        triggerDeployRepairHandoff: () => false,
        deployHandoffStatus: () => IDLE_HANDOFF,
        resolveRepoAppName: () => Promise.resolve("todolist"),
        deployListCache: {
          get: () => undefined,
          set: () => undefined,
          delete: () => undefined
        },
        ghOrThrow: () => Promise.resolve(""),
        resetDeploymentViewState: () => {},
        deployRequest: {
          deploy: () => Promise.resolve({ status: 200, body: { ok: true } })
        },
        abandonment: {
          abandon: () =>
            Promise.resolve({
              status: 400,
              body: {
                error:
                  "A valid repo, environment, and application are required to abandon deployment tracking."
              }
            })
        }
      })
    );

    const status = context("GET", "/api/deploy-status");
    await routes["GET /api/deploy-status"](status.context);
    expect(JSON.parse(status.recording.body)).toHaveProperty("logs");

    const notification = context("GET", "/api/deploy-notification");
    await routes["GET /api/deploy-notification"](notification.context);
    expect(JSON.parse(notification.recording.body)).toHaveProperty("status");

    const applications = context(
      "GET",
      "/api/list-applications?repo=octo/todolist"
    );
    await routes["GET /api/list-applications"](applications.context);
    expect(JSON.parse(applications.recording.body)).toEqual({
      applications: [{ name: "todolist" }]
    });

    const deployments = context(
      "GET",
      "/api/list-deployments?repo=octo/todolist"
    );
    await routes["GET /api/list-deployments"](deployments.context);
    expect(JSON.parse(deployments.recording.body)).toEqual({
      deployments: []
    });

    const reset = context("POST", "/api/deploy-reset", "{}");
    await routes["POST /api/deploy-reset"](reset.context);
    expect(JSON.parse(reset.recording.body)).toEqual({ ok: true });

    const deploy = context("POST", "/api/deploy", "{}");
    await routes["POST /api/deploy"](deploy.context);
    expect(JSON.parse(deploy.recording.body)).toEqual({ ok: true });

    const remove = context("POST", "/api/delete-deployment", "{}");
    await routes["POST /api/delete-deployment"](remove.context);
    expect(JSON.parse(remove.recording.body)).toEqual({
      error: "A valid repo, environment, and application are required."
    });

    const abandon = context("POST", "/api/abandon-deployment", "{}");
    await routes["POST /api/abandon-deployment"](abandon.context);
    expect(JSON.parse(abandon.recording.body)).toEqual({
      error:
        "A valid repo, environment, and application are required to abandon deployment tracking."
    });
  });

  describe("GET /api/deploy-notification", () => {
    // Every other seam in `dependencies()` throws, so these cases also prove
    // the notification route reads state and nothing else: if it reached
    // `triggerDeployRepairHandoff` the way `/api/deploy-status` does, the chip
    // polling from any page would open a repair loop, and the call would throw
    // here instead of passing quietly.
    it("answers the empty-state defaults when the instance has no entry", () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-notification"
      );
      handleDeployNotification(
        ctx,
        dependencies({ readInstanceEntry: () => undefined })
      );

      expect(recording.status).toBe(200);
      expect(recording.headers).toEqual(JSON_HEADERS);
      expect(JSON.parse(recording.body)).toEqual({
        attemptId: "",
        generation: 0,
        runId: "",
        status: "pending",
        application: "",
        environment: "",
        error: "",
        stateWarning: "",
        runUrl: "",
        repairing: false,
        finishedAt: 0
      });
    });

    it("reports a finished deploy without the resource list or log buffer", () => {
      const state: CanvasState = {
        deployAttempt: {
          id: "attempt-7",
          targetRepo: "octo/todolist",
          environment: "dev"
        },
        deployRunId: 4242,
        deployGeneration: 5,
        deployStatus: "success",
        deployAppName: "todolist",
        deployEnvName: "dev",
        deployRunUrl: "https://github.com/octo/todolist/actions/runs/7",
        deployFinishedAt: 1700,
        deployingResources: [{ id: "db", name: "db", type: "Radius.Data/x" }],
        deployLogs: ["noisy", "log", "lines"]
      };
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-notification"
      );
      handleDeployNotification(
        ctx,
        dependencies({ readInstanceEntry: () => ({ state }) })
      );

      expect(JSON.parse(recording.body)).toEqual({
        attemptId: "attempt-7",
        generation: 5,
        runId: "4242",
        status: "success",
        application: "todolist",
        environment: "dev",
        error: "",
        stateWarning: "",
        runUrl: "https://github.com/octo/todolist/actions/runs/7",
        repairing: false,
        finishedAt: 1700
      });
    });

    // `deployEnvName` is only written during dispatch, so a deploy that failed
    // preflight would otherwise be reported against the previous deploy's
    // environment. The attempt records it when the deploy opens.
    it("names the current attempt's environment rather than the previous deploy's", () => {
      const state: CanvasState = {
        deployAttempt: { id: "attempt-8", environment: "prod" },
        deployStatus: "failed",
        deployEnvName: "dev"
      };
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-notification"
      );
      handleDeployNotification(
        ctx,
        dependencies({ readInstanceEntry: () => ({ state }) })
      );

      expect(JSON.parse(recording.body)).toMatchObject({
        environment: "prod"
      });
    });

    it("falls back to the dispatched environment when the attempt names none", () => {
      const state: CanvasState = {
        deployAttempt: { id: "attempt-8" },
        deployStatus: "failed",
        deployEnvName: "dev"
      };
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-notification"
      );
      handleDeployNotification(
        ctx,
        dependencies({ readInstanceEntry: () => ({ state }) })
      );

      expect(JSON.parse(recording.body)).toMatchObject({ environment: "dev" });
    });

    it.each([
      ["a numeric run id", 99, "99"],
      ["a string run id", "99", "99"],
      ["a cleared run id", null, ""]
    ])("serializes %s", (_name, deployRunId, expected) => {
      const state: CanvasState = { deployStatus: "in_progress", deployRunId };
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-notification"
      );
      handleDeployNotification(
        ctx,
        dependencies({ readInstanceEntry: () => ({ state }) })
      );

      expect(JSON.parse(recording.body)).toMatchObject({ runId: expected });
    });

    // The generation is what separates two deploys that failed before dispatch
    // inside one repair loop: they share an attempt id, have no run, and never
    // update the finish time.
    it("reports the per-invocation generation", () => {
      const state: CanvasState = {
        deployStatus: "failed",
        deployGeneration: 4,
        deployAttempt: { id: "attempt-8" }
      };
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-notification"
      );
      handleDeployNotification(
        ctx,
        dependencies({ readInstanceEntry: () => ({ state }) })
      );

      expect(JSON.parse(recording.body)).toMatchObject({ generation: 4 });
    });

    it("carries the failure message and repair flag a failed deploy needs", () => {
      const state: CanvasState = {
        deployStatus: "failed",
        deployError: "Bicep template failed to compile",
        deployRepairing: true
      };
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-notification"
      );
      handleDeployNotification(
        ctx,
        dependencies({ readInstanceEntry: () => ({ state }) })
      );

      expect(JSON.parse(recording.body)).toMatchObject({
        status: "failed",
        error: "Bicep template failed to compile",
        repairing: true
      });
    });

    it("reports empty-state defaults for a present but blank state", () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-notification"
      );
      handleDeployNotification(
        ctx,
        dependencies({ readInstanceEntry: () => ({ state: {} }) })
      );

      expect(JSON.parse(recording.body)).toEqual({
        attemptId: "",
        generation: 0,
        runId: "",
        status: "pending",
        application: "",
        environment: "",
        error: "",
        stateWarning: "",
        runUrl: "",
        repairing: false,
        finishedAt: 0
      });
    });

    it("normalizes a null run URL and error to empty strings", () => {
      const state: CanvasState = {
        deployStatus: "in_progress",
        deployError: null,
        deployRunUrl: null
      };
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-notification"
      );
      handleDeployNotification(
        ctx,
        dependencies({ readInstanceEntry: () => ({ state }) })
      );

      expect(JSON.parse(recording.body)).toMatchObject({
        status: "in_progress",
        error: "",
        stateWarning: "",
        runUrl: ""
      });
    });
  });

  describe("GET /api/deploy-status", () => {
    it("answers the empty-state defaults when the instance has no entry", () => {
      const { recording, context: ctx } = context("GET", "/api/deploy-status");
      handleDeployStatus(ctx, statusDependencies(undefined));

      expect(recording.status).toBe(200);
      expect(recording.headers).toEqual({
        "Content-Type": "application/json"
      });
      expect(JSON.parse(recording.body)).toEqual({
        resources: [],
        logs: [],
        logBase: 0,
        logTotal: 0,
        status: "pending",
        error: null,
        stateWarning: null,
        errorKind: null,
        errorBranch: null,
        errorPaths: null,
        startedAt: null,
        finishedAt: null,
        deployedGraph: null,
        deployRunUrl: null,
        attempt: null,
        active: false,
        repairing: false,
        handoff: IDLE_HANDOFF
      });
    });

    it("prefers the deploying resources over the planned ones", () => {
      const state: CanvasState = {
        deployingResources: [{ id: "a", name: "a", type: "t" }],
        plannedResources: [{ id: "b", name: "b", type: "t" }]
      };
      const { recording, context: ctx } = context("GET", "/api/deploy-status");
      handleDeployStatus(ctx, statusDependencies(state));

      expect(JSON.parse(recording.body).resources).toEqual([
        { id: "a", name: "a", type: "t" }
      ]);
    });

    it("falls back to the planned resources when a deploy has not started", () => {
      const state: CanvasState = {
        deployingResources: null,
        plannedResources: [{ id: "b", name: "b", type: "t" }]
      };
      const { recording, context: ctx } = context("GET", "/api/deploy-status");
      handleDeployStatus(ctx, statusDependencies(state));

      expect(JSON.parse(recording.body).resources).toEqual([
        { id: "b", name: "b", type: "t" }
      ]);
    });

    it("reports every populated field and marks an in-flight deploy active", () => {
      const state: CanvasState = {
        deployLogs: ["one", "two"],
        deployLogBase: 10,
        deployStatus: "in_progress",
        deployError: "boom",
        deployErrorKind: "branch-not-pushed",
        deployErrorBranch: "feature/x",
        deployErrorPaths: ".radius,app.bicep",
        deployStartedAt: 111,
        deployFinishedAt: 222,
        deployedGraph: [{ id: "g", name: "g", type: "t" }],
        deployRunUrl: "https://example.test/run",
        deployAttempt: { id: "attempt-1" } as CanvasState["deployAttempt"]
      };
      const { recording, context: ctx } = context("GET", "/api/deploy-status");
      handleDeployStatus(ctx, statusDependencies(state));

      const payload = JSON.parse(recording.body);
      expect(payload).toMatchObject({
        logs: ["one", "two"],
        logBase: 10,
        // Absolute index of the next line the client has not seen: base plus
        // the buffered count, not the buffered count alone.
        logTotal: 12,
        status: "in_progress",
        error: "boom",
        errorKind: "branch-not-pushed",
        errorBranch: "feature/x",
        errorPaths: ".radius,app.bicep",
        startedAt: 111,
        finishedAt: 222,
        deployRunUrl: "https://example.test/run",
        attempt: { id: "attempt-1" },
        active: true
      });
    });

    it.each([
      ["success", false],
      ["in_progress", true]
    ])("reports active=%s for status %s", (status, active) => {
      const { recording, context: ctx } = context("GET", "/api/deploy-status");
      handleDeployStatus(
        ctx,
        statusDependencies({ deployStatus: status } as CanvasState)
      );
      expect(JSON.parse(recording.body).active).toBe(active);
    });

    // `||` rather than `??` throughout the projection: an empty string or a
    // zero is "no value" to this poll, and the client renders `null`/"pending"
    // differently from `""`/`0`. `deployErrorKind: ""` is deliberately outside
    // `DeployErrorKind`, so the cast goes through `unknown`: the point of the
    // case is that a value the type forbids still normalizes to `null`.
    it("normalizes empty-string and zero state to the absent values", () => {
      const state: CanvasState = {
        deployStatus: "",
        deployError: "",
        deployErrorBranch: "",
        deployErrorPaths: "",
        deployStartedAt: 0,
        deployFinishedAt: 0,
        deployRunUrl: ""
      };
      // Persisted state can predate the DeployErrorKind union. Inject the
      // malformed legacy value at runtime without weakening CanvasState's type.
      Object.defineProperty(state, "deployErrorKind", {
        value: "",
        enumerable: true
      });
      const { recording, context: ctx } = context("GET", "/api/deploy-status");
      handleDeployStatus(ctx, statusDependencies(state));

      expect(JSON.parse(recording.body)).toMatchObject({
        status: "pending",
        error: null,
        errorKind: null,
        errorBranch: null,
        errorPaths: null,
        startedAt: null,
        finishedAt: null,
        deployRunUrl: null,
        active: false
      });
    });

    it("reports repairing on the very poll that opens the repair loop", () => {
      const state: CanvasState = { deployStatus: "failed" };
      const seen: (DeploymentsInstanceEntry | undefined)[] = [];
      const { recording, context: ctx } = context("GET", "/api/deploy-status");
      handleDeployStatus(
        ctx,
        statusDependencies(state, {
          triggerDeployRepairHandoff: (entry, instanceId) => {
            seen.push(entry);
            expect(instanceId).toBe("panel-a");
            return true;
          },
          deployHandoffStatus: () => IDLE_HANDOFF
        })
      );

      expect(JSON.parse(recording.body).repairing).toBe(true);
      // The trigger receives the live entry, not the request context's `{}`
      // snapshot, because it has to mutate handoff bookkeeping on it.
      expect(seen).toEqual([{ state }]);
    });

    it("relays a run-unconfirmed failure to chat without marking the poll as repairing", () => {
      const state: CanvasState = {
        deployStatus: "failed",
        deployErrorKind: "run-unconfirmed"
      };
      const seen: (DeploymentsInstanceEntry | undefined)[] = [];
      const { recording, context: ctx } = context("GET", "/api/deploy-status");
      handleDeployStatus(
        ctx,
        statusDependencies(state, {
          triggerDeployRepairHandoff: () => false,
          triggerDeployFailureNotice: (entry, instanceId) => {
            seen.push(entry);
            expect(instanceId).toBe("panel-a");
            return true;
          },
          deployHandoffStatus: () => IDLE_HANDOFF
        })
      );

      // The notice is informational: it must not turn on the repairing note.
      expect(JSON.parse(recording.body).repairing).toBe(false);
      // It still receives the live entry so it can record its own bookkeeping.
      expect(seen).toEqual([{ state }]);
    });

    it("keeps reporting repairing from state once the loop is already open", () => {
      const { recording, context: ctx } = context("GET", "/api/deploy-status");
      handleDeployStatus(
        ctx,
        statusDependencies(
          { deployRepairing: true },
          {
            triggerDeployRepairHandoff: () => false
          }
        )
      );
      expect(JSON.parse(recording.body).repairing).toBe(true);
    });

    it("passes an empty state to the handoff summary when the entry is gone", () => {
      const seen: CanvasState[] = [];
      const { context: ctx } = context("GET", "/api/deploy-status");
      handleDeployStatus(
        ctx,
        statusDependencies(undefined, {
          deployHandoffStatus: (state) => {
            seen.push(state);
            return IDLE_HANDOFF;
          }
        })
      );
      expect(seen).toEqual([{}]);
    });

    it("sends only the lines after ?since and never a negative slice", () => {
      const state: CanvasState = {
        deployLogs: ["a", "b", "c"],
        deployLogBase: 10
      };

      const ahead = context("GET", "/api/deploy-status?since=11");
      handleDeployStatus(ahead.context, statusDependencies(state));
      const aheadPayload = JSON.parse(ahead.recording.body);
      expect(aheadPayload.logsNew).toEqual(["b", "c"]);
      expect(aheadPayload).not.toHaveProperty("logs");
      expect(aheadPayload.logBase).toBe(10);
      expect(aheadPayload.logTotal).toBe(13);

      // A client that lost its place and asks from before the buffer's base
      // gets the whole buffer rather than an out-of-range slice. `since` is
      // clamped to 0 first: a bare `logs.slice(since - logBase)` would count
      // backwards from the end and silently drop the oldest lines.
      const behind = context("GET", "/api/deploy-status?since=8");
      handleDeployStatus(behind.context, statusDependencies(state));
      expect(JSON.parse(behind.recording.body).logsNew).toEqual([
        "a",
        "b",
        "c"
      ]);

      const wayBehind = context("GET", "/api/deploy-status?since=0");
      handleDeployStatus(wayBehind.context, statusDependencies(state));
      expect(JSON.parse(wayBehind.recording.body).logsNew).toEqual([
        "a",
        "b",
        "c"
      ]);

      // Caught up: nothing new.
      const caught = context("GET", "/api/deploy-status?since=13");
      handleDeployStatus(caught.context, statusDependencies(state));
      expect(JSON.parse(caught.recording.body).logsNew).toEqual([]);
    });

    it("treats a non-numeric ?since as absent and sends the whole buffer", () => {
      const state: CanvasState = { deployLogs: ["a"], deployLogBase: 3 };
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-status?since=abc"
      );
      handleDeployStatus(ctx, statusDependencies(state));

      const payload = JSON.parse(recording.body);
      expect(payload.logs).toEqual(["a"]);
      expect(payload).not.toHaveProperty("logsNew");
    });

    it("accepts a partially numeric ?since the way parseInt does", () => {
      const state: CanvasState = { deployLogs: ["a", "b"], deployLogBase: 0 };
      const { recording, context: ctx } = context(
        "GET",
        "/api/deploy-status?since=1px"
      );
      handleDeployStatus(ctx, statusDependencies(state));
      expect(JSON.parse(recording.body).logsNew).toEqual(["b"]);
    });
  });

  describe("GET /api/list-applications", () => {
    it("answers an empty list without consulting anything when repo is absent", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-applications"
      );
      // Every dependency throws, so reaching one here would fail the test.
      await handleListApplications(ctx, dependencies());

      expect(recording.status).toBe(200);
      expect(recording.headers).toEqual(JSON_HEADERS);
      expect(recording.body).toBe('{"applications":[]}');
    });

    it("resolves the application name declared in app.bicep", async () => {
      const seen: [string, string][] = [];
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-applications?repo=octo/todolist"
      );
      await handleListApplications(
        ctx,
        dependencies({
          readInstanceEntry: () => ({ state: { contextBranch: "feature/x" } }),
          resolveRepoAppName: (repo, branch) => {
            seen.push([repo, branch]);
            return Promise.resolve("todo-app");
          }
        })
      );

      expect(seen).toEqual([["octo/todolist", "feature/x"]]);
      expect(recording.body).toBe('{"applications":[{"name":"todo-app"}]}');
    });

    it.each([
      [
        "context wins over planned and graph",
        {
          contextBranch: "ctx",
          plannedBranch: "planned",
          graphBranch: "graph"
        },
        "ctx"
      ],
      [
        "planned wins over graph",
        {
          plannedBranch: "planned",
          graphBranch: "graph"
        },
        "planned"
      ],
      [
        "graph is used when nothing else is set",
        { graphBranch: "graph" },
        "graph"
      ],
      ["main is the floor", {}, "main"],
      // An empty string is not a branch: the chain must fall through it rather
      // than resolving app.bicep against "".
      ["an empty context branch falls through", { contextBranch: "" }, "main"]
    ])("resolves the branch so %s", async (_label, state, expected) => {
      const seen: string[] = [];
      const { context: ctx } = context(
        "GET",
        "/api/list-applications?repo=octo/todolist"
      );
      await handleListApplications(
        ctx,
        dependencies({
          readInstanceEntry: () => ({ state: state as CanvasState }),
          resolveRepoAppName: (_repo, branch) => {
            seen.push(branch);
            return Promise.resolve("todo-app");
          }
        })
      );
      expect(seen).toEqual([expected]);
    });

    it("uses main when the instance has no entry at all", async () => {
      const seen: string[] = [];
      const { context: ctx } = context(
        "GET",
        "/api/list-applications?repo=octo/todolist"
      );
      await handleListApplications(
        ctx,
        dependencies({
          readInstanceEntry: () => undefined,
          resolveRepoAppName: (_repo, branch) => {
            seen.push(branch);
            return Promise.resolve("todo-app");
          }
        })
      );
      expect(seen).toEqual(["main"]);
    });

    it("still answers 200 with the repo basename and an error when resolution fails", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-applications?repo=octo/todolist"
      );
      await handleListApplications(
        ctx,
        dependencies({
          readInstanceEntry: () => undefined,
          resolveRepoAppName: () => Promise.reject(new Error("gh exploded"))
        })
      );

      expect(recording.status).toBe(200);
      expect(recording.headers).toEqual(JSON_HEADERS);
      expect(JSON.parse(recording.body)).toEqual({
        applications: [{ name: "todolist" }],
        error: "gh exploded"
      });
    });

    it("stringifies a non-Error rejection into the error field", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-applications?repo=octo/todolist"
      );
      await handleListApplications(
        ctx,
        dependencies({
          readInstanceEntry: () => undefined,
          resolveRepoAppName: () => Promise.reject("plain string")
        })
      );
      expect(JSON.parse(recording.body).error).toBe("plain string");
    });

    it("falls back to the whole slug when the basename is empty", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-applications?repo=octo/"
      );
      await handleListApplications(
        ctx,
        dependencies({
          readInstanceEntry: () => undefined,
          resolveRepoAppName: () => Promise.reject(new Error("nope"))
        })
      );
      expect(JSON.parse(recording.body).applications).toEqual([
        { name: "octo/" }
      ]);
    });
  });

  describe("GET /api/list-deployments", () => {
    it("answers an empty list without consulting anything when repo is absent", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-deployments"
      );
      await handleListDeployments(ctx, dependencies());

      expect(recording.status).toBe(200);
      expect(recording.headers).toEqual(JSON_HEADERS);
      expect(recording.body).toBe('{"deployments":[]}');
    });

    it("serves a cached listing without touching GitHub", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-deployments?repo=octo/todolist"
      );
      const seen: string[] = [];
      await handleListDeployments(
        ctx,
        dependencies({
          deployListCache: {
            get: (repo) => {
              seen.push(repo);
              return { at: Date.now(), payload: { deployments: [row("dev")] } };
            },
            set: () => {
              throw new Error("a cache hit must not rewrite the cache");
            },
            delete: () => undefined
          }
        })
      );

      expect(seen).toEqual(["octo/todolist"]);
      expect(JSON.parse(recording.body)).toEqual({
        deployments: [row("dev")]
      });
    });

    it("recomputes once the cached entry is older than the TTL", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-deployments?repo=octo/todolist"
      );
      const written: DeployListCacheEntry[] = [];
      await handleListDeployments(
        ctx,
        dependencies({
          deployListTtlMs: 15000,
          deployListCache: {
            get: () => ({
              at: Date.now() - 15001,
              payload: { deployments: [row("stale")] }
            }),
            set: (_repo, entry) => written.push(entry),
            delete: () => undefined
          },
          readInstanceEntry: () => undefined,
          ghOrThrow: () => Promise.resolve("dev"),
          resolveRepoAppName: () => Promise.resolve("todolist"),
          resolveEnvDeployment: (_repo, environment) =>
            Promise.resolve(row(environment))
        })
      );

      expect(JSON.parse(recording.body)).toEqual({
        deployments: [row("dev")]
      });
      expect(written).toHaveLength(1);
      expect(written[0].payload).toEqual({ deployments: [row("dev")] });
    });

    // The cache is injected as the live Map rather than owned by this module,
    // because server.ts still invalidates it (`deployListCache.delete(repo)`) on
    // deploy and delete dispatch. A stubbed get/set pair cannot model that, so
    // this case drives a real Map through the full round trip and then deletes
    // from the outside exactly the way server.ts does. If a later refactor moved
    // the cache inward, that external invalidation would silently stop working
    // and this is the test that would catch it.
    it("round-trips a real Map and misses again after an external delete", async () => {
      const cache = new Map<string, DeployListCacheEntry>();
      let ghCalls = 0;
      const shared: Partial<DeploymentsDependencies> = {
        deployListCache: cache,
        readInstanceEntry: () => undefined,
        ghOrThrow: () => {
          ghCalls += 1;
          return Promise.resolve("dev");
        },
        resolveRepoAppName: () => Promise.resolve("todolist"),
        resolveEnvDeployment: (_repo, environment) =>
          Promise.resolve(row(environment))
      };

      const first = context("GET", "/api/list-deployments?repo=octo/todolist");
      await handleListDeployments(first.context, dependencies(shared));
      expect(ghCalls).toBe(1);
      expect(cache.has("octo/todolist")).toBe(true);
      expect(JSON.parse(first.recording.body).deployments).toEqual([
        row("dev")
      ]);

      const second = context("GET", "/api/list-deployments?repo=octo/todolist");
      await handleListDeployments(second.context, dependencies(shared));
      expect(ghCalls).toBe(1);
      expect(JSON.parse(second.recording.body).deployments).toEqual([
        row("dev")
      ]);

      cache.delete("octo/todolist");

      const third = context("GET", "/api/list-deployments?repo=octo/todolist");
      await handleListDeployments(third.context, dependencies(shared));
      expect(ghCalls).toBe(2);
      expect(JSON.parse(third.recording.body).deployments).toEqual([
        row("dev")
      ]);
    });

    it("bypasses the cache read entirely for ?fresh=1", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-deployments?repo=octo/todolist&fresh=1"
      );
      await handleListDeployments(
        ctx,
        dependencies({
          deployListCache: {
            get: () => {
              throw new Error("?fresh=1 must not read the cache");
            },
            set: () => undefined,
            delete: () => undefined
          },
          readInstanceEntry: () => undefined,
          ghOrThrow: () => Promise.resolve("dev"),
          resolveRepoAppName: () => Promise.resolve("todolist"),
          resolveEnvDeployment: (_repo, environment) =>
            Promise.resolve(row(environment))
        })
      );
      expect(JSON.parse(recording.body).deployments).toEqual([row("dev")]);
    });

    it("only treats the literal 1 as a cache bypass", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-deployments?repo=octo/todolist&fresh=true"
      );
      await handleListDeployments(
        ctx,
        dependencies({
          deployListCache: {
            get: () => ({
              at: Date.now(),
              payload: { deployments: [row("cached")] }
            }),
            set: () => undefined,
            delete: () => undefined
          }
        })
      );
      expect(JSON.parse(recording.body).deployments).toEqual([row("cached")]);
    });

    it("queries every environment once, deduped, and drops resolved nulls", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-deployments?repo=octo/todolist"
      );
      const ghCalls: string[][] = [];
      const resolveCalls: [string, string, string][] = [];
      await handleListDeployments(
        ctx,
        dependencies({
          deployListCache: {
            get: () => undefined,
            set: () => undefined,
            delete: () => undefined
          },
          readInstanceEntry: () => ({ state: { plannedBranch: "feature/x" } }),
          ghOrThrow: (args) => {
            ghCalls.push(args);
            // Duplicates and blank lines are exactly what `gh --paginate`
            // produces across page boundaries.
            return Promise.resolve("dev\nprod\ndev\n\n");
          },
          resolveRepoAppName: () => Promise.resolve("todo-app"),
          resolveEnvDeployment: (repo, environment, appName) => {
            resolveCalls.push([repo, environment, appName]);
            return Promise.resolve(
              environment === "prod" ? null : row(environment)
            );
          }
        })
      );

      expect(ghCalls).toEqual([
        [
          "api",
          "--paginate",
          "/repos/octo/todolist/environments?per_page=100",
          "--jq",
          ".environments[].name"
        ]
      ]);
      expect(resolveCalls).toEqual([
        ["octo/todolist", "dev", "todo-app"],
        ["octo/todolist", "prod", "todo-app"]
      ]);
      expect(JSON.parse(recording.body)).toEqual({
        deployments: [row("dev")]
      });
    });

    it("answers an empty list when the repo declares no environments", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-deployments?repo=octo/todolist"
      );
      await handleListDeployments(
        ctx,
        dependencies({
          deployListCache: {
            get: () => undefined,
            set: () => undefined,
            delete: () => undefined
          },
          readInstanceEntry: () => undefined,
          ghOrThrow: () => Promise.resolve(""),
          resolveRepoAppName: () => Promise.resolve("todolist"),
          resolveEnvDeployment: () => {
            throw new Error("no environment to resolve");
          }
        })
      );
      expect(JSON.parse(recording.body)).toEqual({ deployments: [] });
    });

    it("surfaces a GitHub failure as an error rather than an empty listing", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-deployments?repo=octo/todolist"
      );
      await handleListDeployments(
        ctx,
        dependencies({
          deployListCache: {
            get: () => undefined,
            set: () => {
              throw new Error("a failed listing must not be cached");
            },
            delete: () => undefined
          },
          ghOrThrow: () => Promise.reject(new Error("HTTP 502")),
          readInstanceEntry: () => undefined
        })
      );

      expect(recording.status).toBe(200);
      expect(recording.headers).toEqual(JSON_HEADERS);
      expect(JSON.parse(recording.body)).toEqual({
        deployments: [],
        error: "HTTP 502"
      });
    });

    it("stringifies a non-Error failure into the error field", async () => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/list-deployments?repo=octo/todolist"
      );
      await handleListDeployments(
        ctx,
        dependencies({
          deployListCache: {
            get: () => undefined,
            set: () => undefined,
            delete: () => undefined
          },
          ghOrThrow: () => Promise.reject("gh vanished"),
          readInstanceEntry: () => undefined
        })
      );
      expect(JSON.parse(recording.body).error).toBe("gh vanished");
    });
  });

  describe("POST /api/deploy", () => {
    it("hands the raw body and instance id to the admission service and serializes its exact result", async () => {
      const calls: { instanceId: string; body: string }[] = [];
      const { recording, context: ctx } = context(
        "POST",
        "/api/deploy",
        '{"targetRepo":"octo/todolist","environment":"dev"}'
      );

      await handleDeploy(
        ctx,
        dependencies({
          deployRequest: {
            deploy: (input) => {
              calls.push(input);
              return Promise.resolve({
                status: 200,
                body: { ok: true, repairAttempt: 2, repairAttemptCap: 5 }
              });
            }
          }
        })
      );

      // The adapter parses nothing: the body reaches the service byte for byte,
      // so the service owns the single 400 envelope the legacy arm had.
      expect(calls).toEqual([
        {
          instanceId: "panel-a",
          body: '{"targetRepo":"octo/todolist","environment":"dev"}'
        }
      ]);
      expect(recording.status).toBe(200);
      expect(recording.headers).toEqual({
        "Content-Type": "application/json"
      });
      expect(recording.body).toBe(
        '{"ok":true,"repairAttempt":2,"repairAttemptCap":5}'
      );
    });

    it.each([
      [409, { error: "This repair loop has already used its 5 attempts." }],
      [503, { error: "Could not verify whether this environment…" }],
      [400, { error: "targetRepo and environment are required." }]
    ])("passes a %i refusal through unchanged", async (status, body) => {
      const { recording, context: ctx } = context("POST", "/api/deploy", "{}");

      await handleDeploy(
        ctx,
        dependencies({
          deployRequest: { deploy: () => Promise.resolve({ status, body }) }
        })
      );

      expect(recording.status).toBe(status);
      expect(JSON.parse(recording.body)).toEqual(body);
    });

    it("reads an empty body without inventing a default", async () => {
      const bodies: string[] = [];
      const { context: ctx } = context("POST", "/api/deploy", "");

      await handleDeploy(
        ctx,
        dependencies({
          deployRequest: {
            deploy: ({ body }) => {
              bodies.push(body);
              return Promise.resolve({ status: 400, body: { error: "bad" } });
            }
          }
        })
      );

      expect(bodies).toEqual([""]);
    });
  });

  describe("POST /api/deploy-reset", () => {
    it("forwards the requested attempt id to the reset", async () => {
      const state: CanvasState = {};
      const calls: [CanvasState, unknown][] = [];
      const { recording, context: ctx } = context(
        "POST",
        "/api/deploy-reset",
        '{"attemptId":"attempt-1"}'
      );
      await handleDeployReset(
        ctx,
        dependencies({
          readInstanceEntry: () => ({ state }),
          resetDeploymentViewState: (target, attemptId) =>
            calls.push([target, attemptId])
        })
      );

      expect(calls).toEqual([[state, "attempt-1"]]);
      expect(recording.status).toBe(200);
      expect(recording.headers).toEqual({
        "Content-Type": "application/json"
      });
      expect(recording.body).toBe('{"ok":true}');
    });

    it("treats an empty body as an unconditional reset", async () => {
      const calls: unknown[] = [];
      const { recording, context: ctx } = context(
        "POST",
        "/api/deploy-reset",
        ""
      );
      await handleDeployReset(
        ctx,
        dependencies({
          readInstanceEntry: () => ({ state: {} }),
          resetDeploymentViewState: (_state, attemptId) => calls.push(attemptId)
        })
      );

      expect(calls).toEqual([undefined]);
      expect(recording.status).toBe(200);
    });

    it.each([["null"], ["7"], ['["attempt-1"]']])(
      "flattens the non-object JSON body %s to no attempt id",
      async (body) => {
        const calls: unknown[] = [];
        const { recording, context: ctx } = context(
          "POST",
          "/api/deploy-reset",
          body
        );
        await handleDeployReset(
          ctx,
          dependencies({
            readInstanceEntry: () => ({ state: {} }),
            resetDeploymentViewState: (_state, attemptId) =>
              calls.push(attemptId)
          })
        );

        expect(calls).toEqual([undefined]);
        expect(recording.status).toBe(200);
      }
    );

    it("answers 400 for a malformed body and resets nothing", async () => {
      const { recording, context: ctx } = context(
        "POST",
        "/api/deploy-reset",
        "not json"
      );
      await handleDeployReset(
        ctx,
        dependencies({
          readInstanceEntry: () => ({ state: {} }),
          resetDeploymentViewState: () => {
            throw new Error("a malformed body must not reset anything");
          }
        })
      );

      expect(recording.status).toBe(400);
      expect(recording.headers).toEqual({
        "Content-Type": "application/json"
      });
      expect(JSON.parse(recording.body)).toHaveProperty("error");
    });

    it("still answers 200 when the instance entry is already gone", async () => {
      const { recording, context: ctx } = context(
        "POST",
        "/api/deploy-reset",
        '{"attemptId":"attempt-1"}'
      );
      await handleDeployReset(
        ctx,
        dependencies({
          readInstanceEntry: () => undefined,
          resetDeploymentViewState: () => {
            throw new Error("there is no state to reset");
          }
        })
      );

      expect(recording.status).toBe(200);
      expect(recording.body).toBe('{"ok":true}');
    });
  });

  // This is the only destructive route in the family, so the refusal paths are
  // the point: each one must keep its exact status, and must not leave a
  // reservation behind that would deadlock the next attempt.
  describe("POST /api/delete-deployment", () => {
    const BODY = JSON.stringify({
      repo: "octo/todolist",
      environment: "dev",
      application: "todolist"
    });

    function deleteContext(body = BODY) {
      return context("POST", "/api/delete-deployment", body);
    }

    it("refuses a request missing or malformed repo, environment or application", async () => {
      for (const body of [
        // An absent body is not a parse error: it means "{}", which then fails
        // the required-fields check rather than the JSON check.
        "",
        "{}",
        '{"repo":"octo/todolist"}',
        '{"repo":"octo/todolist","environment":"dev"}',
        '{"environment":"dev","application":"todolist"}',
        // Present but empty is the same refusal: the handler coerces with `||`.
        '{"repo":"","environment":"dev","application":"todolist"}',
        '{"repo":"invalid","environment":"dev","application":"todolist"}'
      ]) {
        const { recording, context: ctx } = deleteContext(body);
        await handleDeleteDeployment(
          ctx,
          dependencies({
            readInstanceEntry: () => {
              throw new Error("must refuse before reading the instance");
            }
          })
        );
        expect(recording.status).toBe(400);
        expect(JSON.parse(recording.body)).toEqual({
          error: "A valid repo, environment, and application are required."
        });
      }
    });

    it("answers 503 when the canvas has no instance entry", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({ readInstanceEntry: () => undefined })
      );

      expect(recording.status).toBe(503);
      expect(JSON.parse(recording.body)).toEqual({
        error: "Canvas server state is unavailable."
      });
    });

    it("refuses with 409 while a local deploy is still running", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readInstanceEntry: () => ({
            state: { deployingRepo: "octo/other", envName: "staging" }
          }),
          localDeploymentBlocksMutation: () => true,
          reserveDeploymentMutation: () => {
            throw new Error("must not reserve while blocked");
          }
        })
      );

      expect(recording.status).toBe(409);
      expect(JSON.parse(recording.body).error).toBe(
        "A deploy operation for octo/other in environment staging is already in progress. Wait for it to finish before starting another operation."
      );
    });

    // The conflict message prefers the active attempt over the loose state
    // fields, and only falls back to the request's own values.
    it("names the reserved operation and its target in the conflict message", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readInstanceEntry: () => ({
            state: {
              deployAttempt: {
                id: "attempt-1",
                targetRepo: "octo/attempt",
                environment: "prod"
              }
            }
          }),
          localDeploymentBlocksMutation: () => false,
          activeDeploymentMutation: () => ({
            repo: "octo/reserved",
            environment: "reserved-env",
            kind: "delete",
            expiresAt: 0
          }),
          reserveDeploymentMutation: () => {
            throw new Error("must not reserve while reserved");
          }
        })
      );

      expect(recording.status).toBe(409);
      expect(JSON.parse(recording.body).error).toBe(
        "A delete operation for octo/reserved in environment reserved-env is already in progress. Wait for it to finish before starting another operation."
      );
    });

    it("falls back to the request's own repo and environment when nothing else is known", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readInstanceEntry: () => ({ state: {} }),
          localDeploymentBlocksMutation: () => true
        })
      );

      expect(JSON.parse(recording.body).error).toBe(
        "A deploy operation for octo/todolist in environment dev is already in progress. Wait for it to finish before starting another operation."
      );
    });

    it("answers 409 when the reservation is lost in a race", async () => {
      const { recording, context: ctx } = deleteContext();
      let call = 0;
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          reserveDeploymentMutation: () => null,
          activeDeploymentMutation: () => {
            call += 1;
            return call === 1 ? undefined : (
                {
                  repo: "octo/winner",
                  environment: "dev",
                  kind: "deploy",
                  expiresAt: 0
                }
              );
          }
        })
      );

      expect(recording.status).toBe(409);
      expect(JSON.parse(recording.body).error).toBe(
        "A deploy operation for octo/winner in environment dev is already starting."
      );
    });

    it("answers the generic message when the race leaves no conflict to name", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          reserveDeploymentMutation: () => null,
          activeDeploymentMutation: () => undefined
        })
      );

      expect(recording.status).toBe(409);
      expect(JSON.parse(recording.body).error).toBe(
        "Another deployment operation is already starting."
      );
    });

    it("releases the reservation and answers 503 when GitHub state cannot be read", async () => {
      const { recording, context: ctx } = deleteContext();
      const released: unknown[] = [];
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          resolveEnvDeployment: () => Promise.reject(new Error("offline")),
          releaseDeploymentMutation: (_state, lease) => released.push(lease)
        })
      );

      expect(recording.status).toBe(503);
      expect(JSON.parse(recording.body).error).toBe(
        "Could not verify the current deployment state. Check your GitHub connection and try again."
      );
      expect(released).toEqual([LEASE]);
    });

    it("refuses and releases when GitHub says the deployment is already busy", async () => {
      for (const [status, error] of [
        ["deleting", "This deployment is already being deleted."],
        [
          "in_progress",
          "This application is still being deployed to the selected environment. Wait for the deployment to finish before deleting it."
        ],
        [
          // A resource cleanup is running against this deployment, so deleting
          // the whole application on top of it is refused too.
          "resource-deleting",
          "A resource of this application is being deleted. Wait for that cleanup to finish before deleting it."
        ]
      ]) {
        const { recording, context: ctx } = deleteContext();
        const released: unknown[] = [];
        await handleDeleteDeployment(
          ctx,
          deleteDependencies({
            resolveEnvDeployment: () => Promise.resolve(row("dev", status)),
            deploymentStatusBlocksMutation: () => true,
            releaseDeploymentMutation: (_state, lease) => released.push(lease)
          })
        );

        expect(recording.status).toBe(409);
        expect(JSON.parse(recording.body).error).toBe(error);
        expect(released).toEqual([LEASE]);
      }
    });

    it("releases and answers 400 when the delete workflow cannot be committed", async () => {
      const { recording, context: ctx } = deleteContext();
      const released: unknown[] = [];
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          ensureWorkflowsCurrent: () =>
            Promise.resolve({
              created: [],
              failed: [
                {
                  path: ".github/workflows/delete-application.yml",
                  branch: "main"
                }
              ]
            }),
          releaseDeploymentMutation: (_state, lease) => released.push(lease),
          runGh: () => {
            throw new Error("must not dispatch without a committed workflow");
          }
        })
      );

      expect(recording.status).toBe(400);
      expect(JSON.parse(recording.body).error).toContain(
        'to the "main" branch of octo/todolist'
      );
      expect(released).toEqual([LEASE]);
    });

    // A failure committing some *other* workflow file is not this route's
    // problem, so it must not short-circuit the dispatch.
    it("ignores a commit failure for an unrelated workflow file", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          ensureWorkflowsCurrent: () =>
            Promise.resolve({
              created: [],
              failed: [{ path: ".github/workflows/deploy.yml", branch: "main" }]
            })
        })
      );

      expect(recording.status).toBe(200);
    });

    it("dispatches, evicts the cached listing and reports the run URL", async () => {
      const { recording, context: ctx } = deleteContext();
      const cache = new Map<string, DeployListCacheEntry>();
      cache.set("octo/todolist", { at: Date.now(), payload: {} });
      const dispatched: string[][] = [];
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          deployListCache: cache,
          runGh: (args) => {
            dispatched.push(args);
            return Promise.resolve({ code: 0, stdout: "", stderr: "" });
          },
          findWorkflowRun: () => Promise.resolve(42)
        })
      );

      expect(recording.status).toBe(200);
      expect(recording.headers).toEqual({
        "Content-Type": "application/json"
      });
      expect(JSON.parse(recording.body)).toEqual({
        success: true,
        runId: "42",
        runUrl: "https://github.com/octo/todolist/actions/runs/42"
      });
      expect(dispatched).toEqual([
        [
          "workflow",
          "run",
          "delete-application.yml",
          "-f",
          "environment=dev",
          "-f",
          "application=todolist",
          "-f",
          `correlation_id=${CORRELATION_ID}`,
          "--repo",
          "octo/todolist"
        ]
      ]);
      // The eviction the injection exists for: the reader must miss next time.
      expect(cache.has("octo/todolist")).toBe(false);
    });

    it("looks the run up by this dispatch's correlation id and pre-dispatch baseline", async () => {
      const { context: ctx } = deleteContext();
      const lookups: unknown[][] = [];
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          latestWorkflowRunId: () => Promise.resolve(90),
          findWorkflowRun: (...args) => {
            lookups.push(args);
            return Promise.resolve(91);
          }
        })
      );

      expect(lookups).toHaveLength(1);
      expect(lookups[0][0]).toBe("octo/todolist");
      expect(lookups[0][1]).toBe("delete-application.yml");
      expect(lookups[0][3]).toBeNull();
      expect(lookups[0][4]).toBe(90);
      expect(lookups[0][5]).toBe(CORRELATION_ID);
    });

    it("dispatches without a baseline when GitHub cannot report one", async () => {
      const { recording, context: ctx } = deleteContext();
      const baselines: unknown[] = [];
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          latestWorkflowRunId: () => Promise.reject(new Error("rate limited")),
          findWorkflowRun: (_repo, _file, _since, _known, afterRunId) => {
            baselines.push(afterRunId);
            return Promise.resolve(7);
          }
        })
      );

      expect(recording.status).toBe(200);
      expect(baselines).toEqual([null]);
      expect(JSON.parse(recording.body).runUrl).toBe(
        "https://github.com/octo/todolist/actions/runs/7"
      );
    });

    it("keeps looking for the correlated run while it is not listed yet", async () => {
      const { recording, context: ctx } = deleteContext();
      const waits: number[] = [];
      let lookups = 0;
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          findWorkflowRun: () => {
            lookups += 1;
            return Promise.resolve(lookups < 3 ? null : 55);
          },
          setTimer: (callback, ms) => {
            // The reservation lease is twice the listing TTL and stays pending;
            // only the discovery waits are recorded here.
            if (ms <= 5000) {
              waits.push(ms);
              callback();
            }
            return {};
          }
        })
      );

      expect(lookups).toBe(3);
      expect(waits).toEqual([2000, 4000]);
      expect(JSON.parse(recording.body).runUrl).toBe(
        "https://github.com/octo/todolist/actions/runs/55"
      );
    });

    it("reports an empty run URL when the run cannot be resolved", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({ findWorkflowRun: () => Promise.resolve(null) })
      );

      expect(JSON.parse(recording.body)).toEqual({
        success: true,
        runId: "",
        runUrl: ""
      });
    });

    it("holds the reservation open for twice the listing TTL", async () => {
      const { context: ctx } = deleteContext();
      const timers: number[] = [];
      let unrefs = 0;
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          deployListTtlMs: 15000,
          // Resolved on the first look, so the discovery retry schedules no
          // waits of its own and `timers` is only the lease.
          findWorkflowRun: () => Promise.resolve(1),
          setTimer: (_callback, ms) => {
            timers.push(ms);
            return {
              unref: () => {
                unrefs += 1;
              }
            };
          }
        })
      );

      expect(timers).toEqual([30000]);
      expect(unrefs).toBe(1);
    });

    it("survives a timer handle with no unref", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          findWorkflowRun: () => Promise.resolve(1),
          setTimer: () => ({})
        })
      );

      expect(recording.status).toBe(200);
    });

    it("retries the dispatch without the injected token when the first attempt fails", async () => {
      const { recording, context: ctx } = deleteContext();
      const envs: (NodeJS.ProcessEnv | undefined)[] = [];
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readProcessEnv: () => ({ GH_TOKEN: "t", PATH: "/usr/bin" }),
          runGh: (_args, _timeout, extraEnv) => {
            envs.push(extraEnv);
            return Promise.resolve(
              envs.length === 1 ?
                { code: 1, stdout: "", stderr: "missing workflow scope" }
              : { code: 0, stdout: "", stderr: "" }
            );
          }
        })
      );

      expect(recording.status).toBe(200);
      expect(envs).toHaveLength(2);
      expect(envs[0]).toBeUndefined();
      expect(envs[1]).toEqual({ PATH: "/usr/bin" });
    });

    it("does not retry when there is no injected token to strip", async () => {
      const { recording, context: ctx } = deleteContext();
      let calls = 0;
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          ghCommandPresentation: {
            kind: "absolute",
            shell: "posix",
            executablePath: "/opt/Copilot Tools/gh",
            installationNote: "Install GitHub CLI system-wide."
          },
          readProcessEnv: () => ({}),
          runGh: () => {
            calls += 1;
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "workflow scope missing"
            });
          }
        })
      );

      expect(calls).toBe(1);
      expect(recording.status).toBe(400);
      expect(JSON.parse(recording.body).error).toContain(
        "'/opt/Copilot Tools/gh' auth refresh -h github.com -s workflow"
      );
    });

    it("does not retry for a whitespace-only injected token", async () => {
      const { recording, context: ctx } = deleteContext();
      let calls = 0;
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readProcessEnv: () => ({ GH_TOKEN: "   " }),
          runGh: () => {
            calls += 1;
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "workflow scope missing"
            });
          }
        })
      );

      expect(calls).toBe(1);
      expect(recording.status).toBe(400);
    });

    it("still retries when GH_TOKEN is empty but GITHUB_TOKEN is set", async () => {
      const { recording, context: ctx } = deleteContext();
      let calls = 0;
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readProcessEnv: () => ({ GH_TOKEN: "", GITHUB_TOKEN: "t" }),
          runGh: () => {
            calls += 1;
            return Promise.resolve({
              code: calls === 1 ? 1 : 0,
              stdout: "",
              stderr: calls === 1 ? "workflow scope missing" : ""
            });
          }
        })
      );

      expect(calls).toBe(2);
      expect(recording.status).toBe(200);
    });

    it("keeps the first failure when the retry also fails", async () => {
      const { recording, context: ctx } = deleteContext();
      let calls = 0;
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readProcessEnv: () => ({ GITHUB_TOKEN: "t" }),
          runGh: () => {
            calls += 1;
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr:
                calls === 1 ?
                  "first failure: missing workflow scope"
                : "second failure"
            });
          }
        })
      );

      expect(calls).toBe(2);
      expect(JSON.parse(recording.body).error).toContain("first failure");
      expect(JSON.parse(recording.body).error).not.toContain("second failure");
    });

    it("does not re-dispatch a delete whose first attempt timed out", async () => {
      // A timed-out dispatch may already have been accepted, so a retry could
      // start a second delete run.
      const { recording, context: ctx } = deleteContext();
      let calls = 0;
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readProcessEnv: () => ({ GH_TOKEN: "t" }),
          runGh: () => {
            calls += 1;
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "missing workflow scope",
              timedOut: true
            });
          }
        })
      );

      expect(calls).toBe(1);
      expect(recording.status).toBe(400);
    });

    it("does not re-dispatch a failure the keyring credential cannot fix", async () => {
      const { recording, context: ctx } = deleteContext();
      const stderrs: string[] = [];
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readProcessEnv: () => ({ GH_TOKEN: "t" }),
          runGh: () => {
            stderrs.push("call");
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "HTTP 403: Actions are disabled for this repository"
            });
          }
        })
      );

      expect(stderrs).toHaveLength(1);
      expect(JSON.parse(recording.body).error).toContain(
        "Actions are disabled for this repository"
      );
    });

    it("retries a not-found race only when the workflow was just created", async () => {
      const { recording, context: ctx } = deleteContext();
      let calls = 0;
      const delays: number[] = [];
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          ensureWorkflowsCurrent: () =>
            Promise.resolve({
              created: [".github/workflows/delete-application.yml"],
              failed: []
            }),
          setTimer: (callback, ms) => {
            delays.push(ms);
            callback();
            return {};
          },
          runGh: () => {
            calls += 1;
            return Promise.resolve(
              calls < 3 ?
                { code: 1, stdout: "", stderr: "HTTP 404: Not Found" }
              : { code: 0, stdout: "", stderr: "" }
            );
          }
        })
      );

      expect(recording.status).toBe(200);
      expect(calls).toBe(3);
      // The 3s registration wait, then the 2s and 5s retry backoffs. The lease
      // timer is the trailing entry.
      expect(delays.slice(0, 3)).toEqual([3000, 2000, 5000]);
    });

    it("does not retry a timed-out 404 from the workflow registration race", async () => {
      const { recording, context: ctx } = deleteContext();
      const delays: number[] = [];
      let calls = 0;
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          ensureWorkflowsCurrent: () =>
            Promise.resolve({
              created: [".github/workflows/delete-application.yml"],
              failed: []
            }),
          setTimer: (callback, ms) => {
            delays.push(ms);
            callback();
            return {};
          },
          runGh: () => {
            calls += 1;
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "HTTP 404: Not Found",
              timedOut: true
            });
          }
        })
      );

      expect(recording.status).toBe(400);
      expect(calls).toBe(1);
      expect(delays.filter((delay) => delay < 30_000)).toEqual([3000]);
    });

    it("stops retrying a failure that is not the registration race", async () => {
      const { recording, context: ctx } = deleteContext();
      let calls = 0;
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          ensureWorkflowsCurrent: () =>
            Promise.resolve({
              created: [".github/workflows/delete-application.yml"],
              failed: []
            }),
          setTimer: (callback, ms) => {
            if (ms < 30000) callback();
            return {};
          },
          runGh: () => {
            calls += 1;
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr: "Actions is disabled"
            });
          }
        })
      );

      expect(calls).toBe(1);
      expect(recording.status).toBe(400);
      expect(JSON.parse(recording.body).error).toContain(
        "GitHub Actions is disabled for octo/todolist"
      );
    });

    it("uses the generic message when the dispatch fails with no stderr", async () => {
      const { recording, context: ctx } = deleteContext();
      const released: unknown[] = [];
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readProcessEnv: () => ({}),
          runGh: () => Promise.resolve({ code: 1, stdout: "", stderr: "" }),
          releaseDeploymentMutation: (_state, lease) => released.push(lease)
        })
      );

      expect(recording.status).toBe(400);
      expect(JSON.parse(recording.body).error).toContain(
        "The dispatch request failed."
      );
      expect(released).toEqual([LEASE]);
    });

    // A spawn failure surfaces a string errno, which must still read as a
    // failure rather than accidentally comparing equal to 0.
    it("treats a string exit code as a dispatch failure", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          readProcessEnv: () => ({}),
          runGh: () =>
            Promise.resolve({ code: "ENOENT", stdout: "", stderr: "" })
        })
      );

      expect(recording.status).toBe(400);
    });

    it("answers 400 and releases the reservation when the body is not JSON", async () => {
      const { recording, context: ctx } = deleteContext("{oops");
      await handleDeleteDeployment(ctx, deleteDependencies());

      expect(recording.status).toBe(400);
      expect(JSON.parse(recording.body)).toHaveProperty("error");
    });

    it("releases a held reservation when a later step throws", async () => {
      const { recording, context: ctx } = deleteContext();
      const released: unknown[] = [];
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          releaseDeploymentMutation: (_state, lease) => released.push(lease),
          ensureWorkflowsCurrent: () =>
            Promise.reject(new Error("sync blew up"))
        })
      );

      expect(recording.status).toBe(400);
      expect(JSON.parse(recording.body)).toEqual({ error: "sync blew up" });
      expect(released).toEqual([LEASE]);
    });

    // Nothing is reserved yet at this point, so the catch must not try to
    // release a null lease.
    it("does not release anything when it fails before reserving", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          activeDeploymentMutation: () => {
            throw new Error("state read blew up");
          },
          releaseDeploymentMutation: () => {
            throw new Error("there is no reservation to release");
          }
        })
      );

      expect(recording.status).toBe(400);
      expect(JSON.parse(recording.body)).toEqual({
        error: "state read blew up"
      });
    });

    // The lease timer fires long after the response; releasing twice must stay
    // harmless.
    it("is idempotent when the lease timer fires after an early release", async () => {
      const { context: ctx } = deleteContext();
      const released: unknown[] = [];
      let fire = (): void => {};
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({
          releaseDeploymentMutation: (_state, lease) => released.push(lease),
          findWorkflowRun: () => Promise.resolve(1),
          setTimer: (callback) => {
            fire = callback;
            return {};
          }
        })
      );

      expect(released).toEqual([]);
      fire();
      expect(released).toEqual([LEASE]);
      fire();
      expect(released).toEqual([LEASE]);
    });
  });

  describe("POST /api/abandon-deployment", () => {
    it("rejects malformed JSON without acquiring a lease", async () => {
      const { recording, context: ctx } = context(
        "POST",
        "/api/abandon-deployment",
        "{"
      );
      await handleAbandonDeployment(
        ctx,
        dependencies({
          abandonment: {
            abandon: () => {
              throw new Error("must not delegate malformed input");
            }
          }
        })
      );

      expect(recording.status).toBe(400);
      expect(JSON.parse(recording.body)).toHaveProperty("error");
    });

    it("delegates parsed input and serializes the service result", async () => {
      const calls: unknown[] = [];
      const { recording, context: ctx } = context(
        "POST",
        "/api/abandon-deployment",
        '{"repo":"octo/todolist","environment":"dev","application":"todolist"}'
      );
      await handleAbandonDeployment(
        ctx,
        dependencies({
          abandonment: {
            abandon: (input) => {
              calls.push(input);
              return Promise.resolve({
                status: 200,
                body: { outcome: "abandoned" }
              });
            }
          }
        })
      );

      expect(calls).toEqual([
        {
          instanceId: "panel-a",
          payload: {
            repo: "octo/todolist",
            environment: "dev",
            application: "todolist"
          }
        }
      ]);
      expect(recording.status).toBe(200);
      expect(JSON.parse(recording.body)).toEqual({
        outcome: "abandoned"
      });
    });

    it("delegates an empty body as an empty request object", async () => {
      const calls: unknown[] = [];
      const { recording, context: ctx } = context(
        "POST",
        "/api/abandon-deployment"
      );
      await handleAbandonDeployment(
        ctx,
        dependencies({
          abandonment: {
            abandon: (input) => {
              calls.push(input);
              return Promise.resolve({
                status: 400,
                body: { error: "missing identity" }
              });
            }
          }
        })
      );

      expect(calls).toEqual([
        {
          instanceId: "panel-a",
          payload: {}
        }
      ]);
      expect(recording.status).toBe(400);
    });
  });
});

const MODELED = [
  {
    id: "/planes/radius/local/api",
    name: "api",
    type: "Radius.Compute/containers"
  }
];
const DEPLOYED = {
  resources: [
    ...MODELED,
    {
      id: "/planes/radius/local/cache",
      name: "cache",
      type: "Radius.Data/redisCaches"
    }
  ]
};

function inventory(overrides: Record<string, unknown> = {}) {
  return {
    ...buildDeployedInventory({
      repo: "octo/todolist",
      branch: "main",
      environment: "dev",
      application: "todolist",
      modeled: MODELED,
      deployed: DEPLOYED,
      now: 1_700_000_000_000
    }),
    ...overrides
  };
}

// The instance state a confirmed removed-resource delete needs: the derived
// inventory plus the modeled graph the route re-checks the removal against.
function stateWithInventory(overrides: Partial<CanvasState> = {}): CanvasState {
  return {
    graphTargetRepo: "octo/todolist",
    graphBranch: "main",
    graphResources: structuredClone(MODELED),
    contextRepo: "octo/todolist",
    contextBranch: "main",
    deployedInventory: inventory(),
    ...overrides
  } as CanvasState;
}

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    repo: "octo/todolist",
    environment: "dev",
    application: "todolist",
    resourceName: "cache",
    resourceType: "Radius.Data/redisCaches",
    revision: inventory().revision,
    ...overrides
  });
}

describe("POST /api/delete-resource (RF-07, exception 7.1)", () => {
  it("dispatches its own delete-resource workflow for a confirmed removal", async () => {
    const dispatches: string[][] = [];
    const evicted: string[] = [];
    const synced: string[][] = [];
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state: stateWithInventory() }),
        ensureWorkflowsCurrent: (_repo, _environment, _provider, only) => {
          synced.push(only);
          return Promise.resolve({ created: [], failed: [] });
        },
        runGh: (args) => {
          dispatches.push(args);
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
        findWorkflowRun: () => Promise.resolve(4242),
        deployListCache: {
          get: () => undefined,
          set: () => undefined,
          delete: (repo) => evicted.push(repo)
        }
      })
    );

    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toEqual({
      success: true,
      runId: "4242",
      runUrl: "https://github.com/octo/todolist/actions/runs/4242",
      resource: { name: "cache", type: "Radius.Data/redisCaches" }
    });
    // A resource cleanup never runs the application dispatcher, whose GitHub
    // deployment record would retire the application's row on success.
    expect(dispatches).toEqual([
      [
        "workflow",
        "run",
        "delete-resource.yml",
        "-f",
        "environment=dev",
        "-f",
        "application=todolist",
        "-f",
        "resource_name=cache",
        "-f",
        "radius_resource_type=Radius.Data/redisCaches",
        "-f",
        `correlation_id=${CORRELATION_ID}`,
        "--repo",
        "octo/todolist"
      ]
    ]);
    expect(synced).toEqual([["delete-resource.yml", "delete-azure.yml"]]);
    expect(evicted).toEqual(["octo/todolist"]);
  });

  it.each([
    ["no repo", { repo: "" }],
    ["an unknown repo slug", { repo: "not-a-slug" }],
    ["no environment", { environment: "" }],
    ["no application", { application: "" }],
    ["no resource name", { resourceName: "" }],
    ["no resource type", { resourceType: "" }],
    ["no revision", { revision: "" }],
    ["a non-string resource name", { resourceName: 7 }],
    ["a whitespace resource type", { resourceType: "   " }]
  ])("refuses %s without dispatching", async (_label, overrides) => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body(overrides)
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => {
          throw new Error("input validation must run before any state read");
        }
      })
    );

    expect(recording.status).toBe(400);
    expect(JSON.parse(recording.body).error).toContain(
      "A valid repo, environment, application, resource name, resource type, and deployed-graph revision are required."
    );
  });

  it("refuses a malformed body", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      "{"
    );

    await handleDeleteResource(ctx, deleteDependencies());

    expect(recording.status).toBe(400);
    expect(JSON.parse(recording.body).error).toBeTruthy();
  });

  it("fails closed when the canvas has no server state", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({ readInstanceEntry: () => undefined })
    );

    expect(recording.status).toBe(503);
    expect(JSON.parse(recording.body).error).toBe(
      "Canvas server state is unavailable."
    );
  });

  // Every stale-confirmation case fails closed BEFORE the reservation, so a
  // refused delete never even holds the mutation lease.
  const refusalDependencies = (
    state: CanvasState
  ): Partial<DeploymentsDependencies> => ({
    readInstanceEntry: () => ({ state }),
    reserveDeploymentMutation: () => {
      throw new Error("identity must be confirmed before reserving");
    },
    runGh: () => {
      throw new Error("an unconfirmed resource must never be dispatched");
    }
  });

  it.each([
    [
      "no inventory has been derived",
      stateWithInventory({ deployedInventory: null }),
      "has not been read on this canvas"
    ],
    [
      "the inventory belongs to another repository",
      stateWithInventory({
        deployedInventory: inventory({ repo: "octo/other" })
      }),
      "has not been read on this canvas"
    ],
    [
      "the inventory belongs to another environment",
      stateWithInventory({
        deployedInventory: inventory({ environment: "prod" })
      }),
      "has not been read on this canvas"
    ],
    [
      "the deployed graph could not be read",
      stateWithInventory({
        deployedInventory: inventory({ complete: false })
      }),
      "could not be read"
    ]
  ])("refuses to delete when %s", async (_label, state, message) => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies(refusalDependencies(state))
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(message);
  });

  // The core stale-snapshot regression: the confirmation was taken on `main`,
  // but the canvas has since moved to another branch and therefore to another
  // application definition.
  it("refuses a confirmation taken on a different branch", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies(
        refusalDependencies(
          stateWithInventory({
            contextBranch: "feature/remove-cache",
            graphBranch: "feature/remove-cache"
          })
        )
      )
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      'but the canvas is now on "feature/remove-cache"'
    );
  });

  it("refuses a revision the deployed graph has moved past", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body({ revision: "deadbeef" })
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies(refusalDependencies(stateWithInventory()))
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "changed after this delete was confirmed"
    );
  });

  // The resource was put back into `app.bicep` after the confirmation opened.
  // The snapshot still lists it; the current definition does not.
  it("refuses a resource the current definition declares again", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies(
        refusalDependencies(
          stateWithInventory({
            graphResources: structuredClone(DEPLOYED.resources)
          })
        )
      )
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "no longer a removed resource"
    );
  });

  it("refuses when the canvas no longer holds the branch's definition", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies(
        refusalDependencies(stateWithInventory({ graphResources: null }))
      )
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain("no longer loaded");
  });

  it.each([
    [
      "a resource that was never removed",
      { resourceName: "api", resourceType: "Radius.Compute/containers" }
    ],
    [
      "a resource type that does not match exactly",
      { resourceType: "Radius.Data/postgreSQLDatabases" }
    ],
    ["a resource name that does not match exactly", { resourceName: "Cache" }]
  ])("refuses %s", async (_label, overrides) => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body(overrides)
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies(refusalDependencies(stateWithInventory()))
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "not in the list of removed resources"
    );
  });

  it("matches the inventory's environment and application case-insensitively", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body({ environment: "DEV", application: "ToDoList" })
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state: stateWithInventory() }),
        findWorkflowRun: () => Promise.resolve(null)
      })
    );

    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body).runUrl).toBe("");
  });

  it("refuses while another deployment mutation is in progress", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state: stateWithInventory() }),
        activeDeploymentMutation: () => ({
          repo: "octo/todolist",
          environment: "dev",
          kind: "deploy" as const,
          expiresAt: 0
        }),
        runGh: () => {
          throw new Error("a conflicting mutation must not dispatch");
        }
      })
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "A deploy operation for octo/todolist in environment dev is already in progress."
    );
  });

  it("refuses when a local deployment blocks mutation", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state: stateWithInventory() }),
        localDeploymentBlocksMutation: () => true,
        activeDeploymentMutation: () => undefined
      })
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain("already in progress");
  });

  it("refuses when the reservation is lost to a concurrent request", async () => {
    let reserved = false;
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state: stateWithInventory() }),
        activeDeploymentMutation: () =>
          reserved ?
            {
              repo: "octo/todolist",
              environment: "dev",
              kind: "delete" as const,
              expiresAt: 0
            }
          : undefined,
        reserveDeploymentMutation: () => {
          reserved = true;
          return null;
        },
        runGh: () => {
          throw new Error("an unreserved delete must not dispatch");
        }
      })
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "A delete operation for octo/todolist in environment dev is already starting."
    );
  });

  it("fails closed and releases the lease when GitHub state cannot be read", async () => {
    const released: unknown[] = [];
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state: stateWithInventory() }),
        resolveEnvDeployment: () => Promise.reject(new Error("gh down")),
        releaseDeploymentMutation: (_state, lease) => released.push(lease),
        runGh: () => {
          throw new Error("an unverified deployment must not dispatch");
        }
      })
    );

    expect(recording.status).toBe(503);
    expect(JSON.parse(recording.body).error).toContain(
      "Could not verify the current deployment state."
    );
    expect(released).toEqual([LEASE]);
  });

  it.each([
    ["deleting", "This deployment is already being deleted."],
    [
      "pending",
      "This application is still being deployed to the selected environment. Wait for the deployment to finish before deleting one of its resources."
    ],
    [
      // Exception 7.1: another canvas instance started a resource cleanup on
      // this deployment. It is only visible through GitHub's record, and it
      // blocks exactly as an application delete does.
      "resource-deleting",
      "A resource of this application is being deleted. Wait for that cleanup to finish before deleting one of its resources."
    ]
  ])("refuses while the deployment status is %s", async (status, message) => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state: stateWithInventory() }),
        resolveEnvDeployment: () => Promise.resolve(row("dev", status)),
        deploymentStatusBlocksMutation: () => true,
        releaseDeploymentMutation: () => {},
        runGh: () => {
          throw new Error("a busy deployment must not dispatch");
        }
      })
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toBe(message);
  });

  it("surfaces a dispatch failure and releases the lease", async () => {
    const released: unknown[] = [];
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state: stateWithInventory() }),
        runGh: () =>
          Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "HTTP 403: Resource not accessible"
          }),
        releaseDeploymentMutation: (_state, lease) => released.push(lease),
        deployListCache: {
          get: () => undefined,
          set: () => undefined,
          delete: () => {
            throw new Error("a failed dispatch must not evict the listing");
          }
        }
      })
    );

    expect(recording.status).toBe(400);
    expect(JSON.parse(recording.body).error).toContain(
      "Failed to start the delete workflow (delete-resource.yml) on octo/todolist."
    );
    expect(released).toEqual([LEASE]);
  });

  it("reports a workflow the sync could not commit", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state: stateWithInventory() }),
        ensureWorkflowsCurrent: () =>
          Promise.resolve({
            created: [],
            failed: [
              { path: ".github/workflows/delete-resource.yml", branch: "main" }
            ]
          }),
        releaseDeploymentMutation: () => {},
        runGh: () => {
          throw new Error("an uncommitted workflow must not be dispatched");
        }
      })
    );

    expect(recording.status).toBe(400);
    expect(JSON.parse(recording.body).error).toContain(
      "Couldn't commit the delete workflow (delete-resource.yml)"
    );
  });
});

// The window this guards is real: resolveEnvDeployment and the workflow sync
// are network round trips, and the canvas keeps running during them. An
// authorization taken before those awaits describes the past, so the delete is
// re-authorized against a freshly reloaded definition immediately before the
// dispatch — and refuses with nothing dispatched when anything moved.
describe("POST /api/delete-resource re-authorization at dispatch", () => {
  // Every mutation below happens INSIDE an awaited dependency, which is exactly
  // when the real races happen.
  const duringPreflight = (
    mutate: (state: CanvasState) => void,
    overrides: Partial<DeploymentsDependencies> = {}
  ) => {
    const state = stateWithInventory();
    const dispatches: string[][] = [];
    const released: unknown[] = [];
    return {
      state,
      dispatches,
      released,
      dependencies: deleteDependencies({
        readInstanceEntry: () => ({ state }),
        resolveEnvDeployment: () => {
          mutate(state);
          return Promise.resolve(null);
        },
        releaseDeploymentMutation: (_state, lease) => released.push(lease),
        runGh: (args) => {
          dispatches.push(args);
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
        findWorkflowRun: () => Promise.resolve(1),
        ...overrides
      })
    };
  };

  it("refuses when the canvas switches branch while GitHub state is read", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );
    const harness = duringPreflight((state) => {
      state.contextBranch = "feature/remove-cache";
      state.graphBranch = "feature/remove-cache";
    });

    await handleDeleteResource(ctx, harness.dependencies);

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      'This confirmation was made against branch "main", but the canvas is now on "feature/remove-cache"'
    );
    expect(harness.dispatches).toEqual([]);
    expect(harness.released).toEqual([LEASE]);
  });

  it("refuses when the definition declares the resource again during the workflow sync", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );
    const harness = duringPreflight(() => {});
    // The sync is the last await before the dispatch, so a definition that
    // changes here is the tightest race the route can lose. The reload that
    // follows re-reads exactly this state.
    harness.dependencies.ensureWorkflowsCurrent = () => {
      harness.state.graphResources = structuredClone(DEPLOYED.resources);
      return Promise.resolve({ created: [], failed: [] });
    };

    await handleDeleteResource(ctx, harness.dependencies);

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "no longer a removed resource"
    );
    expect(harness.dispatches).toEqual([]);
    expect(harness.released).toEqual([LEASE]);
  });

  it("refuses when the reload itself brings the resource back", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );
    const harness = duringPreflight(() => {});
    harness.dependencies.reloadModeledGraph = () => {
      harness.state.graphResources = structuredClone(DEPLOYED.resources);
      return Promise.resolve({ status: 200 });
    };

    await handleDeleteResource(ctx, harness.dependencies);

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "no longer a removed resource"
    );
    expect(harness.dispatches).toEqual([]);
    expect(harness.released).toEqual([LEASE]);
  });

  it("refuses when the definition gains another resource before dispatch", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );
    const harness = duringPreflight(() => {});
    harness.dependencies.reloadModeledGraph = () => {
      harness.state.graphResources = [
        ...structuredClone(MODELED),
        {
          id: "/planes/radius/local/worker",
          name: "worker",
          type: "Radius.Compute/containers"
        }
      ];
      return Promise.resolve({ status: 200 });
    };

    await handleDeleteResource(ctx, harness.dependencies);

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "The application definition for todolist in environment dev changed after this delete was confirmed."
    );
    expect(harness.dispatches).toEqual([]);
  });

  it("refuses when a newer deployed inventory replaces the confirmed one", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );
    const harness = duringPreflight((state) => {
      // A concurrent `/api/deployed-graph` poll recorded a different deployed
      // set, so the revision the client confirmed no longer describes anything.
      state.deployedInventory = inventory({
        resources: [
          {
            id: "/planes/radius/local/api",
            name: "api",
            type: "Radius.Compute/containers"
          }
        ],
        revision: "feedface"
      });
    });

    await handleDeleteResource(ctx, harness.dependencies);

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "changed after this delete was confirmed"
    );
    expect(harness.dispatches).toEqual([]);
  });

  it("fails closed when the definition cannot be re-read", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );
    const harness = duringPreflight(() => {}, {
      reloadModeledGraph: () =>
        Promise.resolve({ status: 400, error: "app.bicep is missing" })
    });

    await handleDeleteResource(ctx, harness.dependencies);

    expect(recording.status).toBe(503);
    expect(JSON.parse(recording.body).error).toBe(
      'The application definition of octo/todolist on "main" could not be re-read: app.bicep is missing Nothing was deleted; reload the deployed graph and try again.'
    );
    expect(harness.dispatches).toEqual([]);
    expect(harness.released).toEqual([LEASE]);
  });

  it("reloads the exact repository and branch, after the workflow sync", async () => {
    const order: string[] = [];
    const reloads: Array<[string, string, string]> = [];
    const state = stateWithInventory();
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state }),
        resolveEnvDeployment: () => {
          order.push("resolveEnvDeployment");
          return Promise.resolve(null);
        },
        ensureWorkflowsCurrent: () => {
          order.push("ensureWorkflowsCurrent");
          return Promise.resolve({ created: [], failed: [] });
        },
        reloadModeledGraph: (instanceId, repo, branch) => {
          order.push("reloadModeledGraph");
          reloads.push([instanceId, repo, branch]);
          return Promise.resolve({ status: 200 });
        },
        runGh: () => {
          order.push("dispatch");
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
        findWorkflowRun: () => Promise.resolve(4242)
      })
    );

    expect(recording.status).toBe(200);
    expect(order).toEqual([
      "resolveEnvDeployment",
      "ensureWorkflowsCurrent",
      "reloadModeledGraph",
      "dispatch"
    ]);
    expect(reloads).toEqual([["panel-a", "octo/todolist", "main"]]);
  });

  it("re-authorizes before every dispatch attempt of a just-created workflow", async () => {
    let reloads = 0;
    const dispatches: string[][] = [];
    const state = stateWithInventory();
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );

    await handleDeleteResource(
      ctx,
      deleteDependencies({
        readInstanceEntry: () => ({ state }),
        ensureWorkflowsCurrent: () =>
          Promise.resolve({
            created: [".github/workflows/delete-resource.yml"],
            failed: []
          }),
        reloadModeledGraph: () => {
          reloads += 1;
          // The registration race retries after a sleep; the branch moves
          // during the second of those sleeps.
          if (reloads === 2) state.contextBranch = "feature/elsewhere";
          return Promise.resolve({ status: 200 });
        },
        runGh: (args) => {
          dispatches.push(args);
          return Promise.resolve({
            code: 1,
            stdout: "",
            stderr: "HTTP 404: Not Found (workflow not yet registered)"
          });
        },
        setTimer: (callback, ms) => {
          if (ms > 0) callback();
          return {};
        }
      })
    );

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      'The canvas moved from branch "main" to "feature/elsewhere" while the application definition was being re-read.'
    );
    // One dispatch attempt happened, then the branch moved and the retry was
    // refused rather than sent.
    expect(dispatches).toHaveLength(1);
    expect(reloads).toBe(2);
  });

  // The credential fallback is a SECOND dispatch of a destructive command, sent
  // as a different GitHub identity, and it is separated from its own
  // authorization by an awaited scope-rejected attempt. These cover that gap.
  const scopeRejectingHarness = (
    onFirstDispatch: (state: CanvasState) => void
  ) => {
    const state = stateWithInventory();
    const dispatches: { args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    const released: unknown[] = [];
    let reloads = 0;
    return {
      state,
      dispatches,
      released,
      reloadCount: () => reloads,
      dependencies: deleteDependencies({
        readInstanceEntry: () => ({ state }),
        readProcessEnv: () => ({ GH_TOKEN: "injected", PATH: "/usr/bin" }),
        releaseDeploymentMutation: (_state, lease) => released.push(lease),
        reloadModeledGraph: () => {
          reloads += 1;
          return Promise.resolve({ status: 200 });
        },
        runGh: (args, _timeout, extraEnv) => {
          dispatches.push({ args, env: extraEnv });
          if (dispatches.length === 1) {
            // The definition/inventory moves while this rejection is awaited,
            // which is exactly when the fallback would otherwise dispatch.
            onFirstDispatch(state);
            return Promise.resolve({
              code: 1,
              stdout: "",
              stderr:
                "HTTP 403: Refusing to allow an OAuth App to create or update workflow without `workflow` scope"
            });
          }
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
        findWorkflowRun: () => Promise.resolve(9001)
      })
    };
  };

  it("refuses the keyring-credential fallback when the branch moved during the scope rejection", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );
    const harness = scopeRejectingHarness((state) => {
      state.contextBranch = "feature/elsewhere";
      state.graphBranch = "feature/elsewhere";
    });

    await handleDeleteResource(ctx, harness.dependencies);

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      'This confirmation was made against branch "main", but the canvas is now on "feature/elsewhere"'
    );
    // The decisive assertion: exactly ONE dispatch reached GitHub. The fallback
    // re-authorized first, was refused, and never re-ran the command as the
    // keyring identity.
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0].env).toBeUndefined();
    expect(harness.reloadCount()).toBe(2);
    expect(harness.released).toEqual([LEASE]);
  });

  it("refuses the fallback when the definition declares the resource again during the scope rejection", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );
    const harness = scopeRejectingHarness((state) => {
      state.graphResources = structuredClone(DEPLOYED.resources);
    });

    await handleDeleteResource(ctx, harness.dependencies);

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "no longer a removed resource"
    );
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.released).toEqual([LEASE]);
  });

  it("refuses the fallback when a newer deployed inventory replaces the confirmed one", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );
    const harness = scopeRejectingHarness((state) => {
      state.deployedInventory = inventory({
        resources: [
          {
            id: "/planes/radius/local/api",
            name: "api",
            type: "Radius.Compute/containers"
          }
        ],
        revision: "feedface"
      });
    });

    await handleDeleteResource(ctx, harness.dependencies);

    expect(recording.status).toBe(409);
    expect(JSON.parse(recording.body).error).toContain(
      "changed after this delete was confirmed"
    );
    expect(harness.dispatches).toHaveLength(1);
  });

  it("re-authorizes and dispatches the fallback when nothing moved", async () => {
    const { recording, context: ctx } = context(
      "POST",
      "/api/delete-resource",
      body()
    );
    const harness = scopeRejectingHarness(() => {});

    await handleDeleteResource(ctx, harness.dependencies);

    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body).runUrl).toBe(
      "https://github.com/octo/todolist/actions/runs/9001"
    );
    // Two dispatches: the scope-rejected one and the keyring retry, each with
    // its own re-authorization immediately before it.
    expect(harness.dispatches).toHaveLength(2);
    expect(harness.dispatches[1].env).toEqual({ PATH: "/usr/bin" });
    expect(harness.reloadCount()).toBe(2);
  });
});

describe("GET /api/delete-run-status (exception 5.1/5.4)", () => {
  const runStatus = (
    raw: string,
    failure: StateSaveFailure | null = null,
    reads: Array<[string, string, string]> = [],
    invalidations: string[] = []
  ): Partial<DeploymentsDependencies> => ({
    ghOrThrow: () => Promise.resolve(raw),
    // A terminal run has changed what is deployed, so the route drops the
    // cached deployed-graph reads before the page refreshes them.
    invalidateDeployedGraphCache: (repo) => invalidations.push(repo),
    readInstanceEntry: () => ({ state: {} }),
    readStateSaveFailure: (repo, runId, runAttempt) => {
      reads.push([repo, runId, runAttempt]);
      return Promise.resolve(failure);
    }
  });

  it("reports an in-flight run without reading any diagnostic", async () => {
    const { recording, context: ctx } = context(
      "GET",
      "/api/delete-run-status?repo=octo/todolist&runId=99"
    );

    await handleDeleteRunStatus(
      ctx,
      dependencies({
        ghOrThrow: () => Promise.resolve("in_progress\t\t1"),
        readStateSaveFailure: () => {
          throw new Error("an unfinished run has no diagnostic to read");
        }
      })
    );

    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toMatchObject({
      state: "in_progress",
      outcome: null,
      outcomeMessage: null
    });
  });

  it.each([
    ["success", "succeeded", "Deletion succeeded"],
    ["failure", "failed", "Deletion failed"],
    ["cancelled", "cancelled", "Deletion cancelled"],
    ["timed_out", "timed_out", "Deletion timed out"],
    ["", "unknown", "Deletion outcome unknown"]
  ])(
    "reports a completed run concluded %s as %s",
    async (conclusion, outcome, message) => {
      const { recording, context: ctx } = context(
        "GET",
        "/api/delete-run-status?repo=octo/todolist&runId=99"
      );

      await handleDeleteRunStatus(
        ctx,
        dependencies(runStatus(`completed\t${conclusion}\t1`))
      );

      expect(JSON.parse(recording.body)).toMatchObject({
        state: "completed",
        outcome,
        outcomeMessage: message,
        conclusion,
        stateWarning: null,
        runUrl: "https://github.com/octo/todolist/actions/runs/99"
      });
    }
  );

  it("reports the orphan warning of a delete that could not save state", async () => {
    const reads: Array<[string, string, string]> = [];
    const { recording, context: ctx } = context(
      "GET",
      "/api/delete-run-status?repo=octo/todolist&runId=99"
    );

    await handleDeleteRunStatus(
      ctx,
      dependencies(
        runStatus(
          "completed\tsuccess\t2",
          { attempts: 3, runAttempt: 2, error: "push rejected" },
          reads
        )
      )
    );

    const payload = JSON.parse(recording.body);
    expect(payload.outcome).toBe("succeeded");
    expect(payload.stateWarning).toContain(
      "The deletion ran, but Radius could not save its state."
    );
    expect(payload.stateWarning).toContain(
      "rad shutdown failed after 3 attempts."
    );
    // Scoped to the attempt that concluded, not just the run.
    expect(reads).toEqual([["octo/todolist", "99", "2"]]);
  });

  it("reports no warning when the diagnostic read fails", async () => {
    const { recording, context: ctx } = context(
      "GET",
      "/api/delete-run-status?repo=octo/todolist&runId=99"
    );

    await handleDeleteRunStatus(
      ctx,
      dependencies({
        ghOrThrow: () => Promise.resolve("completed\tsuccess\t1"),
        invalidateDeployedGraphCache: () => {},
        readInstanceEntry: () => ({ state: {} }),
        readStateSaveFailure: () => Promise.reject(new Error("gh down"))
      })
    );

    expect(JSON.parse(recording.body)).toMatchObject({
      outcome: "succeeded",
      stateWarning: null
    });
  });

  // Exception 7.1: a delete run republishes the application's inventory, so
  // everything the canvas cached about this repository's deployed state
  // predates it. Both the reader cache and the session's own snapshot are
  // dropped, so the refresh the page performs next reads the new inventory.
  it("invalidates the deployed-graph reads of a concluded run", async () => {
    const invalidations: string[] = [];
    const state: CanvasState = {
      deployedGraphRepo: "octo/todolist",
      deployedGraph: [{ id: "cache", name: "cache" }],
      deployedInventory: inventory()
    };
    const { context: ctx } = context(
      "GET",
      "/api/delete-run-status?repo=octo/todolist&runId=99"
    );

    await handleDeleteRunStatus(
      ctx,
      dependencies({
        ghOrThrow: () => Promise.resolve("completed\tsuccess\t1"),
        invalidateDeployedGraphCache: (repo) => invalidations.push(repo),
        readInstanceEntry: () => ({ state }),
        readStateSaveFailure: () => Promise.resolve(null)
      })
    );

    expect(invalidations).toEqual(["octo/todolist"]);
    expect(state.deployedGraph).toBeNull();
    expect(state.deployedInventory).toBeNull();
  });

  it("keeps another repository's snapshot while invalidating its own reads", async () => {
    const state: CanvasState = {
      deployedGraphRepo: "octo/other",
      deployedGraph: [{ id: "cache", name: "cache" }],
      deployedInventory: inventory({ repo: "octo/other" })
    };
    const { context: ctx } = context(
      "GET",
      "/api/delete-run-status?repo=octo/todolist&runId=99"
    );

    await handleDeleteRunStatus(
      ctx,
      dependencies({
        ghOrThrow: () => Promise.resolve("completed\tsuccess\t1"),
        invalidateDeployedGraphCache: () => {},
        readInstanceEntry: () => ({ state }),
        readStateSaveFailure: () => Promise.resolve(null)
      })
    );

    expect(state.deployedGraph).not.toBeNull();
    expect(state.deployedInventory).not.toBeNull();
  });

  it("invalidates nothing while the run is still going", async () => {
    const { context: ctx } = context(
      "GET",
      "/api/delete-run-status?repo=octo/todolist&runId=99"
    );

    await handleDeleteRunStatus(
      ctx,
      dependencies({
        ghOrThrow: () => Promise.resolve("in_progress\t\t1"),
        invalidateDeployedGraphCache: () => {
          throw new Error("an unfinished run has changed nothing yet");
        },
        readInstanceEntry: () => {
          throw new Error("an unfinished run reads no session snapshot");
        }
      })
    );
  });

  it("survives a concluded run with no instance state to clear", async () => {
    const { recording, context: ctx } = context(
      "GET",
      "/api/delete-run-status?repo=octo/todolist&runId=99"
    );

    await handleDeleteRunStatus(
      ctx,
      dependencies({
        ghOrThrow: () => Promise.resolve("completed\tsuccess\t1"),
        invalidateDeployedGraphCache: () => {},
        readInstanceEntry: () => undefined,
        readStateSaveFailure: () => Promise.resolve(null)
      })
    );

    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body).outcome).toBe("succeeded");
  });

  it("reports an unknown state rather than an outcome when the run cannot be read", async () => {
    const { recording, context: ctx } = context(
      "GET",
      "/api/delete-run-status?repo=octo/todolist&runId=99"
    );

    await handleDeleteRunStatus(
      ctx,
      dependencies({
        ghOrThrow: () => Promise.reject(new Error("gh down"))
      })
    );

    expect(recording.status).toBe(200);
    expect(JSON.parse(recording.body)).toMatchObject({
      state: "unknown",
      outcome: null,
      error: "gh down"
    });
  });

  it.each([
    ["no repo", "/api/delete-run-status?runId=99"],
    ["an unknown repo slug", "/api/delete-run-status?repo=nope&runId=99"],
    ["no run id", "/api/delete-run-status?repo=octo/todolist"],
    [
      "a non-numeric run id",
      "/api/delete-run-status?repo=octo/todolist&runId=abc"
    ]
  ])("refuses %s", async (_label, url) => {
    const { recording, context: ctx } = context("GET", url);

    await handleDeleteRunStatus(
      ctx,
      dependencies({
        ghOrThrow: () => {
          throw new Error("an invalid request must not reach GitHub");
        }
      })
    );

    expect(recording.status).toBe(400);
    expect(JSON.parse(recording.body).error).toBe(
      "A valid repo and numeric runId are required."
    );
  });
});
