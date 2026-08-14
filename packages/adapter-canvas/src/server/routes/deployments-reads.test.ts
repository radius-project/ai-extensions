import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createRequestContext } from "../request-context.js";
import {
  createDeploymentsReadsRoutes,
  handleDeployReset,
  handleDeployStatus,
  handleListApplications,
  handleListDeployments,
  type DeployListCacheEntry,
  type DeploymentsInstanceEntry,
  type DeploymentsReadsDependencies,
  type DeploymentRow
} from "./deployments-reads.js";
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
  overrides: Partial<DeploymentsReadsDependencies> = {}
): DeploymentsReadsDependencies {
  return {
    readInstanceEntry: () => {
      throw new Error("readInstanceEntry not stubbed");
    },
    triggerDeployRepairHandoff: () => {
      throw new Error("triggerDeployRepairHandoff not stubbed");
    },
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
      }
    },
    deployListTtlMs: 15000,
    ...overrides
  };
}

const IDLE_HANDOFF = {
  state: "idle",
  attempts: 0,
  maxAttempts: 3,
  pending: false
};

function statusDependencies(
  state: CanvasState | undefined,
  overrides: Partial<DeploymentsReadsDependencies> = {}
): DeploymentsReadsDependencies {
  return dependencies({
    readInstanceEntry: () => (state ? { state } : undefined),
    triggerDeployRepairHandoff: () => false,
    deployHandoffStatus: () => IDLE_HANDOFF,
    ...overrides
  });
}

function row(environment: string): DeploymentRow {
  return {
    app: "todolist",
    environment,
    provider: "azure",
    status: "deployed",
    deploymentId: `dep-${environment}`,
    runUrl: `https://example.test/${environment}`
  };
}

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

describe("deployments read routes (SU-06)", () => {
  it("declares exactly the four non-mutating routes it owns", () => {
    const routes = createDeploymentsReadsRoutes(dependencies());
    expect(Object.keys(routes)).toEqual([
      "GET /api/deploy-status",
      "GET /api/list-applications",
      "GET /api/list-deployments",
      "POST /api/deploy-reset"
    ]);
  });

  it("dispatches each declared key to its own handler", async () => {
    const state: CanvasState = {};
    const routes = createDeploymentsReadsRoutes(
      dependencies({
        readInstanceEntry: () => ({ state }),
        triggerDeployRepairHandoff: () => false,
        deployHandoffStatus: () => IDLE_HANDOFF,
        resolveRepoAppName: () => Promise.resolve("todolist"),
        deployListCache: {
          get: () => undefined,
          set: () => undefined
        },
        ghOrThrow: () => Promise.resolve(""),
        resetDeploymentViewState: () => {}
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
    // differently from `""`/`0`.
    it("normalizes empty-string and zero state to the absent values", () => {
      const state = {
        deployStatus: "",
        deployError: "",
        deployErrorKind: "",
        deployErrorBranch: "",
        deployStartedAt: 0,
        deployFinishedAt: 0,
        deployRunUrl: ""
      } as CanvasState;
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
            }
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
            set: (_repo, entry) => written.push(entry)
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
            set: () => undefined
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
            set: () => undefined
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
          deployListCache: { get: () => undefined, set: () => undefined },
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
          deployListCache: { get: () => undefined, set: () => undefined },
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
            }
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
          deployListCache: { get: () => undefined, set: () => undefined },
          ghOrThrow: () => Promise.reject("gh vanished"),
          readInstanceEntry: () => undefined
        })
      );
      expect(JSON.parse(recording.body).error).toBe("gh vanished");
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
});
