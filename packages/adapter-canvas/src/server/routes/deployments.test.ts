import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createDeploymentsRoutes,
  handleAbandonDeployment,
  handleDeleteDeployment,
  handleDeploy,
  handleDeployReset,
  handleDeployStatus,
  handleListApplications,
  handleListDeployments,
  type DeployListCacheEntry,
  type DeploymentsInstanceEntry,
  type DeploymentsDependencies,
  type DeploymentRow
} from "./deployments.js";
import type { CanvasState } from "../../shared.js";
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
    runGh: () => {
      throw new Error("runGh not stubbed");
    },
    readProcessEnv: () => ({}),
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
    runGh: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    findWorkflowRun: () => Promise.resolve(null),
    deployListCache: {
      get: () => undefined,
      set: () => undefined,
      delete: () => undefined
    },
    setTimer: () => ({}),
    ...overrides
  });
}

const LEASE = {
  repo: "octo/todolist",
  environment: "dev",
  kind: "delete" as const,
  expiresAt: 0
};

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
  it("declares exactly the seven routes it owns", () => {
    const routes = createDeploymentsRoutes(dependencies());
    expect(Object.keys(routes)).toEqual([
      "GET /api/deploy-status",
      "GET /api/list-applications",
      "GET /api/list-deployments",
      "POST /api/deploy",
      "POST /api/deploy-reset",
      "POST /api/delete-deployment",
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
        errorKind: null,
        errorBranch: null,
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
          "--repo",
          "octo/todolist"
        ]
      ]);
      // The eviction the injection exists for: the reader must miss next time.
      expect(cache.has("octo/todolist")).toBe(false);
    });

    it("reports an empty run URL when the run cannot be resolved", async () => {
      const { recording, context: ctx } = deleteContext();
      await handleDeleteDeployment(
        ctx,
        deleteDependencies({ findWorkflowRun: () => Promise.resolve(null) })
      );

      expect(JSON.parse(recording.body)).toEqual({
        success: true,
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
        deleteDependencies({ setTimer: () => ({}) })
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
        'missing the "workflow" scope'
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
