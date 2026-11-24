import { describe, it, expect, vi } from "vitest";
import { WorkspaceGraphBranchChanged } from "@radius-project/adapter-shared";
import {
  appModelHandoffKey,
  createAppModelHandoff,
  MODELING_GRACE_POLL_MS,
  MODELING_GRACE_WINDOW_MS
} from "./app-model-handoff.js";
import type { AppModelHandoffDependencies } from "./app-model-handoff.js";
import type { AppModelStatus } from "./graph-context.js";
import type { HandoffMessage } from "./hooks.js";
import type {
  AppModelFreshnessStatus,
  AppSourceEvaluation
} from "@radius-project/core";
import type {
  CanvasState,
  GraphProgressRecord,
  GraphProgressView
} from "../shared.js";
import {
  createMissingModelHandoffClaims,
  MISSING_MODEL_HANDOFF_CLAIM_TTL_MS
} from "./missing-model-handoff-claims.js";
import { GRAPH_APP_BICEP_IDLE_TIMEOUT_MS } from "../graph-progress-contract.js";
import { createModelingActivity } from "./modeling-activity.js";
import { createDeferred } from "../../test/support/browser/fakes.js";

interface StatusOverrides {
  status?: AppModelFreshnessStatus;
  refreshable?: boolean;
  requiresConfirmation?: boolean;
  reason?: string;
  sourceCommit?: string;
  radiusVersion?: string;
}

function modelStatus(
  repo: string,
  branch: string,
  overrides: StatusOverrides = {}
): AppModelStatus {
  const status = overrides.status ?? "up-to-date";
  return {
    repo,
    branch,
    source: {
      kind: "workspace",
      repo,
      ref: branch,
      definitionPath: ".radius/app.bicep",
      workspacePath: "/workspace"
    },
    refreshable: overrides.refreshable ?? true,
    freshness: {
      status,
      stale:
        status !== "up-to-date" &&
        status !== "missing" &&
        status !== "radius-cli-outdated",
      requiresConfirmation:
        overrides.requiresConfirmation ??
        (status === "unrecorded" || status === "manually-edited"),
      reason: overrides.reason ?? `because it is ${status}`,
      appBicepHash: "sha256:abc",
      origin:
        overrides.sourceCommit === undefined ?
          null
        : {
            generatedAt: "2026-08-11T05:32:32.000Z",
            sourceCommit: overrides.sourceCommit,
            skillVersion: "0.1.0-test",
            radiusVersion: overrides.radiusVersion ?? "0.60",
            appBicepHash: "sha256:abc"
          }
    }
  };
}

const MODELABLE: AppSourceEvaluation = {
  status: "single",
  dockerfiles: ["Dockerfile"]
};
const UNMODELABLE: AppSourceEvaluation = { status: "none", dockerfiles: [] };
// Stands in for the skill bootstrap each handoff embeds.
const SKILL_HANDOFF = '{"skill":"radius-app-bicep","skillBase":"/plugin"}';

function progressRecord(
  view: GraphProgressView,
  waitStartedAtMs: number
): GraphProgressRecord {
  return {
    graphBuildEvents: [],
    graphProgressGeneration: 1,
    // Deliberately earlier than the wait. The build starts when the page asks
    // for a graph; the wait starts only once that build finds no model, and it
    // is the wait the app.bicep timeout is measured against.
    graphProgressStartedAtMs: waitStartedAtMs - 120_000,
    graphProgressWaitStartedAtMs: waitStartedAtMs,
    graphProgressActive: true,
    graphProgressView: view,
    graphProgressKey: `${view}-key`,
    graphProgressOwner: 1,
    graphProgressAwaitingModel: true
  };
}

function harness(
  overrides: Partial<AppModelHandoffDependencies> & {
    statuses?: Record<string, AppModelStatus>;
    sources?: Record<string, AppSourceEvaluation>;
  } = {}
) {
  const sent: HandoffMessage[] = [];
  const logged: string[] = [];
  const waits: number[] = [];
  const requested = new Set<string>();
  let nowMs = 1_000_000;
  const resolveContext = vi.fn(async (): Promise<CanvasState> => ({
    workspaceRepo: "a/b",
    workspaceBranch: "feat"
  }));
  const resolveStatus = vi.fn(
    async (repo: string, branch: string): Promise<AppModelStatus> =>
      overrides.statuses?.[branch] ?? modelStatus(repo, branch)
  );
  const evaluateSource = vi.fn(
    async (_repo: string, branch: string): Promise<AppSourceEvaluation> =>
      overrides.sources?.[branch] ?? MODELABLE
  );
  const modelingInFlight = vi.fn(async () => false);
  const announced: Array<{ repo: string; branches: string[] }> = [];
  const deps: AppModelHandoffDependencies = {
    beginManaged: vi.fn(
      (_state, _repo, _branch, _token, _revision, handoff) => handoff
    ),
    cancelManaged: vi.fn(),
    resolveContext,
    resolveStatus,
    assertWorkspaceSource: vi.fn(async () => {}),
    authorizeMissingModel: vi.fn(),
    evaluateSource,
    modelingInFlight,
    announceModelingRun: (repo, branches) => {
      announced.push({ repo, branches: [...branches] });
    },
    // Resolves immediately: the grace window's duration is expressed in the
    // recorded waits, so no test has to spend real time on it.
    wait: async (ms: number) => {
      waits.push(ms);
    },
    send: async (message) => {
      sent.push(message);
    },
    skillHandoff: async () => SKILL_HANDOFF,
    readSourceRevision: async (_repo, branch) => `remote:${branch}-sha`,
    log: (message) => {
      logged.push(message);
    },
    claimRefreshMemo: (key: string) => {
      if (requested.has(key)) return undefined;
      requested.add(key);
      return () => {
        requested.delete(key);
      };
    },
    missingModelHandoffs: createMissingModelHandoffClaims(() => nowMs),
    ...overrides
  };
  return {
    handOff: createAppModelHandoff(deps),
    sent,
    announced,
    logged,
    waits,
    modelingInFlight,
    resolveContext,
    resolveStatus,
    evaluateSource,
    advance: (ms: number) => {
      nowMs += ms;
    }
  };
}

describe("appModelHandoffKey", () => {
  it("distinguishes two situations that differ only in what is wrong", () => {
    const stale = appModelHandoffKey(
      "a/b",
      ["feat"],
      [modelStatus("a/b", "feat", { status: "source-changed" })]
    );
    const edited = appModelHandoffKey(
      "a/b",
      ["feat"],
      [modelStatus("a/b", "feat", { status: "manually-edited" })]
    );

    expect(stale).not.toBe(edited);
  });

  it("distinguishes a worktree model from the same classification on a remote branch", () => {
    const local = appModelHandoffKey(
      "a/b",
      ["feat"],
      [modelStatus("a/b", "feat", { status: "source-changed" })]
    );
    const remote = appModelHandoffKey(
      "a/b",
      ["feat"],
      [
        modelStatus("a/b", "feat", {
          status: "source-changed",
          refreshable: false
        })
      ]
    );

    expect(local).toContain("/local/");
    expect(remote).toContain("/remote/");
    expect(local).not.toBe(remote);
  });

  it("changes when the recorded origin moves to a new commit", () => {
    const before = appModelHandoffKey(
      "a/b",
      ["feat"],
      [
        modelStatus("a/b", "feat", {
          status: "source-changed",
          sourceCommit: "aaa"
        })
      ]
    );
    const after = appModelHandoffKey(
      "a/b",
      ["feat"],
      [
        modelStatus("a/b", "feat", {
          status: "source-changed",
          sourceCommit: "bbb"
        })
      ]
    );

    expect(before).not.toBe(after);
  });

  // After one Radius upgrade regenerates the model, its record saves the new
  // version. The next upgrade has to read as a new situation, or it is never
  // reported.
  it("changes when the recorded Radius version changes", () => {
    const key = (radiusVersion: string) =>
      appModelHandoffKey(
        "a/b",
        ["feat"],
        [
          modelStatus("a/b", "feat", {
            status: "radius-version-changed",
            sourceCommit: "aaa",
            radiusVersion
          })
        ]
      );

    expect(key("0.60")).not.toBe(key("0.61"));
  });

  it("names every branch it covers", () => {
    const key = appModelHandoffKey(
      "a/b",
      ["main", "feat"],
      [modelStatus("a/b", "main"), modelStatus("a/b", "feat")]
    );

    expect(key.startsWith("a/b::main,feat::")).toBe(true);
  });
});

describe("createAppModelHandoff", () => {
  it.each(["outdated", "unrecorded", "missing"] as const)(
    "does not act on a %s model after the final workspace assertion detects drift",
    async (status) => {
      const memo = vi.fn(() => () => {});
      const assertWorkspaceSource = vi.fn(async () => {
        throw new WorkspaceGraphBranchChanged("checkout moved");
      });
      const { handOff, sent } = harness({
        statuses: {
          feat: modelStatus("a/b", "feat", {
            status: status === "outdated" ? "source-changed" : status
          })
        },
        assertWorkspaceSource,
        claimRefreshMemo: memo
      });
      const state: CanvasState = { canvasInstanceId: "panel" };
      await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });
      expect(assertWorkspaceSource).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "workspace", ref: "feat" })
      );
      expect(sent).toHaveLength(0);
      expect(memo).not.toHaveBeenCalled();
      expect(state.appBicepHandoffKeys).toEqual({});
      expect(state.appModelAttemptTokens).toBeUndefined();
    }
  );

  it("releases the missing-model claim and reservation when the final workspace assertion errors", async () => {
    const failure = new Error("Unable to read the current Git branch");
    const assertWorkspaceSource = vi
      .fn(async () => {})
      .mockRejectedValueOnce(failure);
    const missingModelHandoffs = createMissingModelHandoffClaims(() => 0);
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      assertWorkspaceSource,
      missingModelHandoffs
    });
    const state: CanvasState = { canvasInstanceId: "panel" };
    const request = {
      repo: "a/b",
      branches: ["feat"],
      page: "graph" as const,
      state
    };

    await expect(handOff(request)).rejects.toBe(failure);
    expect(missingModelHandoffs.current("a/b::feat")).toBeNull();
    expect(state.appBicepHandoffKeys).toEqual({});
    expect(state.appModelAttemptTokens).toBeUndefined();
    expect(sent).toHaveLength(0);

    await handOff(request);
    await handOff(request);
    expect(state.appModelAttemptTokens?.["a/b::feat"]).toBeDefined();
    expect(sent).toHaveLength(1);
  });

  it("reads against the live workspace context when no panel state is supplied", async () => {
    const { handOff, resolveContext, resolveStatus, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    // Without this the workspace repository would be judged from its remote
    // instead of the worktree the canvas renders.
    expect(resolveContext).toHaveBeenCalledOnce();
    expect(resolveStatus).toHaveBeenCalledWith("a/b", "feat", {
      workspaceRepo: "a/b",
      workspaceBranch: "feat"
    });
    expect(sent).toHaveLength(1);
  });

  it("prefers the panel's own state over a freshly resolved context", async () => {
    const state: CanvasState = {
      workspaceRepo: "a/b",
      workspaceBranch: "main"
    };
    const { handOff, resolveContext, resolveStatus } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(resolveContext).not.toHaveBeenCalled();
    expect(resolveStatus).toHaveBeenCalledWith("a/b", "feat", {
      workspaceRepo: state.workspaceRepo,
      workspaceBranch: state.workspaceBranch
    });
  });

  it("asks the agent to author a model when no branch has one", async () => {
    const { handOff, sent, announced } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(announced).toEqual([{ repo: "a/b", branches: ["feat"] }]);
    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain(SKILL_HANDOFF);
    expect(sent[0].prompt).toContain("`feat`");
    expect(sent[0].displayPrompt).toContain("Generating the application model");
  });

  it.each([
    {
      name: "a diff that includes the requested branch waits for its run",
      second: ["main", "feat"],
      page: "graph-diff",
      expected: 1
    },
    {
      name: "a view of an unrelated branch still asks",
      second: ["release"],
      page: "graph",
      expected: 2
    }
  ])(
    "after the Canvas requests a model, $name",
    async ({ second, page, expected }) => {
      // The agent never calls radius_generate_app for a run the Canvas
      // requests, so the delivered handoff is the only record of that run
      // until it creates its staging directory.
      let nowMs = 1_000_000;
      const activity = createModelingActivity({
        now: () => nowMs,
        observeStagedRun: async () => null
      });
      const workspace = { repo: "a/b", branch: "feat" };
      const { handOff, sent } = harness({
        statuses: {
          main: modelStatus("a/b", "main", { status: "missing" }),
          feat: modelStatus("a/b", "feat", { status: "missing" }),
          release: modelStatus("a/b", "release", { status: "missing" })
        },
        modelingInFlight: (repo, branches) =>
          activity.inFlight(repo, branches, workspace),
        announceModelingRun: (repo, branches) => {
          for (const branch of branches) activity.announce({ repo, branch });
        },
        wait: async (ms) => {
          nowMs += ms;
        }
      });

      await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });
      await handOff({ repo: "a/b", branches: second, page });

      expect(sent).toHaveLength(expected);
    }
  );

  it("watches for a run starting before it asks, and abandons the handoff when one does", async () => {
    const state: CanvasState = {};
    const modelingInFlight = vi
      .fn(async () => false)
      // The render that found no model runs BEFORE the agent reaches for
      // radius_generate_app, so the first probe legitimately sees nothing.
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { handOff, sent, waits, announced } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      modelingInFlight
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(sent).toHaveLength(0);
    expect(announced).toEqual([]);
    expect(waits).toEqual([MODELING_GRACE_POLL_MS]);
  });

  it("leaves the dedupe key unconsumed when it defers, so a run that dies is asked about again", async () => {
    const state: CanvasState = {};
    const modelingInFlight = vi.fn(async () => true);
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      modelingInFlight
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });
    expect(sent).toHaveLength(0);

    modelingInFlight.mockResolvedValue(false);
    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(sent).toHaveLength(1);
  });

  it("does not wait at all when a run is already observable", async () => {
    const { handOff, sent, waits } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      modelingInFlight: async () => true
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toHaveLength(0);
    expect(waits).toHaveLength(0);
  });

  it("gives up watching after the grace window and asks, so a missing model is not waited on forever", async () => {
    const { handOff, sent, waits, modelingInFlight } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toHaveLength(1);
    const polls = MODELING_GRACE_WINDOW_MS / MODELING_GRACE_POLL_MS;
    expect(waits).toHaveLength(polls);
    expect(modelingInFlight).toHaveBeenCalledTimes(polls + 1);
    expect(modelingInFlight).toHaveBeenLastCalledWith(
      "a/b",
      ["feat"],
      expect.objectContaining({
        workspaceRepo: "a/b",
        workspaceBranch: "feat"
      }),
      undefined
    );
  });

  it("gives a single-branch Canvas handoff a fenced permanent-failure callback", async () => {
    const state: CanvasState = { canvasInstanceId: "radius-app" };
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    await handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state,
      environmentKey: '["azure","dev"]'
    });

    const token = state.appModelAttemptTokens?.["a/b::feat"];
    expect(token).toBeTruthy();
    expect(state.appModelAttemptEnvironments?.["a/b::feat"]).toBe(
      '["azure","dev"]'
    );
    expect(sent[0].prompt).toContain("radius_report_modeling_failure");
    expect(sent[0].prompt).toContain(`attemptToken \`${token}\``);
    expect(sent[0].prompt).toContain("instanceId `radius-app`");
  });

  it("fences a two-branch diff handoff with one token recorded under each branch", async () => {
    const state: CanvasState = { canvasInstanceId: "radius-app" };
    const { handOff, sent } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "missing" }),
        feat: modelStatus("a/b", "feat", { status: "missing" })
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff",
      state
    });

    const token = state.appModelAttemptTokens?.["a/b::main"];
    expect(token).toBeTruthy();
    expect(state.appModelAttemptTokens?.["a/b::feat"]).toBe(token);
    expect(state.appModelAttemptEnvironments).toEqual({
      "a/b::main": "",
      "a/b::feat": ""
    });
    expect(sent[0].prompt).toContain("radius_report_modeling_failure");
    expect(sent[0].prompt).toContain(`attemptToken \`${token}\``);
    expect(sent[0].prompt).toContain("(`main`, `feat`) — one call per branch");
  });

  it("withdraws both diff branch tokens when the handoff cannot be delivered", async () => {
    const state: CanvasState = { canvasInstanceId: "radius-app" };
    const { handOff } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "missing" }),
        feat: modelStatus("a/b", "feat", { status: "missing" })
      },
      send: async () => {
        throw new Error("session closed");
      }
    });

    await expect(
      handOff({
        repo: "a/b",
        branches: ["main", "feat"],
        page: "graph-diff",
        state
      })
    ).rejects.toThrow("session closed");

    expect(state.appModelAttemptTokens?.["a/b::main"]).toBeUndefined();
    expect(state.appModelAttemptTokens?.["a/b::feat"]).toBeUndefined();
    expect(state.appModelAttemptEnvironments).toEqual({});
    expect(state.appModelAttemptSourceRevisions).toEqual({});
  });

  it("captures each branch's source baseline when the attempt starts", async () => {
    const state: CanvasState = {
      canvasInstanceId: "radius-app",
      appModelAttemptSourceRevisions: { "a/b::feat": "remote:older" }
    };
    const { handOff } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "missing" }),
        feat: modelStatus("a/b", "feat", { status: "missing" })
      },
      readSourceRevision: async (_repo, branch) => {
        if (branch === "feat") throw new Error("unreadable");
        return "workspace:main-1";
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff",
      state
    });

    expect(state.appModelAttemptSourceRevisions).toEqual({
      "a/b::main": "workspace:main-1"
    });
  });

  it("starts no attempt when the selection changes while the baseline is read", async () => {
    const state: CanvasState = { canvasInstanceId: "radius-app" };
    let current = true;
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      readSourceRevision: async () => {
        current = false;
        return "remote:feat-sha";
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state,
      isCurrent: () => current
    });

    expect(sent).toEqual([]);
    expect(state.appModelAttemptTokens).toBeUndefined();
    expect(state.appModelAttemptSourceRevisions).toBeUndefined();
  });

  it("leaves a superseding attempt's tokens in place when an older diff send fails", async () => {
    const state: CanvasState = { canvasInstanceId: "radius-app" };
    const { handOff } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "missing" }),
        feat: modelStatus("a/b", "feat", { status: "missing" })
      },
      send: async () => {
        // A newer attempt claimed both branches while this send was in flight.
        state.appModelAttemptTokens = {
          "a/b::main": "newer-attempt",
          "a/b::feat": "newer-attempt"
        };
        throw new Error("session closed");
      }
    });

    await expect(
      handOff({
        repo: "a/b",
        branches: ["main", "feat"],
        page: "graph-diff",
        state
      })
    ).rejects.toThrow("session closed");

    expect(state.appModelAttemptTokens).toEqual({
      "a/b::main": "newer-attempt",
      "a/b::feat": "newer-attempt"
    });
  });

  it("re-reads the model before speaking, because a run can start and finish inside the window", async () => {
    const statuses: Record<string, AppModelStatus> = {
      feat: modelStatus("a/b", "feat", { status: "missing" })
    };
    const { handOff, sent } = harness({
      statuses,
      wait: async () => {
        statuses.feat = modelStatus("a/b", "feat", { status: "up-to-date" });
      }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toHaveLength(0);
  });

  it("stops asking once either diff branch gains a model because the route can render the other as added or removed", async () => {
    const statuses: Record<string, AppModelStatus> = {
      main: modelStatus("a/b", "main", { status: "missing" }),
      feat: modelStatus("a/b", "feat", { status: "missing" })
    };
    const { handOff, sent } = harness({
      statuses,
      wait: async () => {
        statuses.feat = modelStatus("a/b", "feat");
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff"
    });

    expect(sent).toHaveLength(0);
  });

  it("propagates a probe that breaks rather than silently asking anyway", async () => {
    const state: CanvasState = {};
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      modelingInFlight: async () => {
        throw new Error("probe exploded");
      }
    });

    await expect(
      handOff({ repo: "a/b", branches: ["feat"], page: "graph", state })
    ).rejects.toThrow("probe exploded");
    expect(sent).toHaveLength(0);
    // The reservation is released, so a later render can retry the whole thing.
    expect(state.appBicepHandoffKeys?.["a/b::feat"]).toBeUndefined();
  });

  it("propagates a re-read that breaks rather than sending on a stale classification", async () => {
    const state: CanvasState = {};
    let reads = 0;
    const { handOff, sent } = harness({
      resolveStatus: async (repo: string, branch: string) => {
        reads += 1;
        if (reads > 1) throw new Error("reader broke");
        return modelStatus(repo, branch, { status: "missing" });
      }
    });

    await expect(
      handOff({ repo: "a/b", branches: ["feat"], page: "graph", state })
    ).rejects.toThrow("reader broke");
    expect(sent).toHaveLength(0);
    expect(state.appBicepHandoffKeys?.["a/b::feat"]).toBeUndefined();
  });

  it("does not send after a newer reservation replaces it during the status re-read", async () => {
    const state: CanvasState = {};
    let reads = 0;
    let finishReRead!: (status: AppModelStatus) => void;
    const resolveStatus = vi.fn(
      async (repo: string, branch: string): Promise<AppModelStatus> => {
        reads += 1;
        if (reads === 1) {
          return modelStatus(repo, branch, { status: "missing" });
        }
        return new Promise<AppModelStatus>((resolve) => {
          finishReRead = resolve;
        });
      }
    );
    const { handOff, sent } = harness({ resolveStatus });
    const pending = handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    });
    await vi.waitFor(() => expect(resolveStatus).toHaveBeenCalledTimes(2));
    state.appBicepHandoffKeys = {
      ...state.appBicepHandoffKeys,
      "a/b::feat": "newer-request"
    };
    state.appBicepHandoffKey = "newer-request";

    finishReRead(modelStatus("a/b", "feat", { status: "missing" }));
    await pending;

    expect(sent).toEqual([]);
    expect(state.appBicepHandoffKeys?.["a/b::feat"]).toBe("newer-request");
    expect(state.appBicepHandoffKey).toBe("newer-request");
  });

  it("starts no attempt when a newer reservation replaces it while the baseline is read", async () => {
    const state: CanvasState = { canvasInstanceId: "radius-app" };
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      readSourceRevision: async () => {
        state.appBicepHandoffKeys = {
          ...state.appBicepHandoffKeys,
          "a/b::feat": "newer-request"
        };
        return "remote:feat-sha";
      }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(sent).toEqual([]);
    expect(state.appModelAttemptTokens).toBeUndefined();
    expect(state.appBicepHandoffKeys?.["a/b::feat"]).toBe("newer-request");
  });

  // The handoff keeps probing and waiting long after the route responded, so a
  // selection change during that window must stop it before it becomes
  // observable — no attempt tokens, no turn.
  it("mints no tokens and sends nothing when the request is superseded during its asynchronous work", async () => {
    const state: CanvasState = { canvasInstanceId: "panel-1" };
    let current = true;
    let releaseProbe!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const { handOff, sent } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "missing" }),
        feat: modelStatus("a/b", "feat", { status: "missing" })
      },
      evaluateSource: async () => {
        releaseProbe();
        await Promise.resolve();
        return MODELABLE;
      }
    });

    const pending = handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff",
      state,
      isCurrent: () => current
    });
    await probeStarted;
    current = false;
    await pending;

    expect(sent).toEqual([]);
    expect(state.appModelAttemptTokens).toBeUndefined();
    expect(state.appBicepHandoffKeys?.["a/b::main:feat"]).toBeUndefined();
  });

  it("still hands off when the request stays current", async () => {
    const state: CanvasState = { canvasInstanceId: "panel-1" };
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    await handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state,
      isCurrent: () => true
    });

    expect(sent).toHaveLength(1);
    expect(state.appModelAttemptTokens?.["a/b::feat"]).toBeDefined();
  });

  it("does not clear a newer shared owner when an older status read reports a model", async () => {
    let finishStatus!: (status: AppModelStatus) => void;
    const missingModelHandoffs = createMissingModelHandoffClaims(
      () => 1_000_000
    );
    const oldOwner = missingModelHandoffs.claim("a/b::feat", "old");
    if (!oldOwner) throw new Error("expected old owner");
    const resolveStatus = vi.fn(
      () =>
        new Promise<AppModelStatus>((resolve) => {
          finishStatus = resolve;
        })
    );
    const { handOff } = harness({
      missingModelHandoffs,
      resolveStatus
    });

    const staleRead = handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph"
    });
    await vi.waitFor(() => expect(resolveStatus).toHaveBeenCalledOnce());
    missingModelHandoffs.release(oldOwner);
    const newOwner = missingModelHandoffs.claim("a/b::feat", "new");
    if (!newOwner) throw new Error("expected new owner");

    finishStatus(modelStatus("a/b", "feat"));
    await staleRead;

    expect(missingModelHandoffs.owns(newOwner)).toBe(true);
  });

  it("sends only once when the canvas is closed and reopened mid-grace-window, producing a second CanvasState for the same target", async () => {
    // The per-CanvasState reservation only dedupes calls sharing one state
    // object. Closing the panel and reopening it while the first handoff is
    // still waiting out the grace window builds a brand-new CanvasState with
    // no memory of the first's reservation — this is what a naive per-state
    // fix misses. The extension-scoped claim is what has to catch it, so this
    // test shares one harness (one claim map) across two independent states.
    const stateA: CanvasState = {};
    const stateB: CanvasState = {};
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    const first = handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state: stateA
    });
    // Simulate the reopen landing after the first render already reserved its
    // own state but before either has resolved: the closed instance's promise
    // is still pending, exactly like a real orphaned poll loop.
    const second = handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state: stateB
    });
    await Promise.all([first, second]);

    expect(sent).toHaveLength(1);
  });

  it("leaves the reopened panel retryable when it loses the shared claim and the owner later defers", async () => {
    const stateA: CanvasState = {};
    const stateB: CanvasState = {};
    let finishProbe!: (inFlight: boolean) => void;
    const modelingInFlight = vi
      .fn<() => Promise<boolean>>()
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishProbe = resolve;
          })
      )
      .mockResolvedValue(false);
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      modelingInFlight
    });

    const owner = handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state: stateA
    });
    await vi.waitFor(() => expect(modelingInFlight).toHaveBeenCalledOnce());
    await handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state: stateB
    });
    expect(stateB.appBicepHandoffKey).toBeUndefined();

    finishProbe(true);
    await owner;
    await handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state: stateB
    });

    expect(sent).toHaveLength(1);
  });

  it("keeps a delivered handoff deduped while queued, then allows retry before the graph idle timeout", async () => {
    const { handOff, sent, advance } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });
    const request = (state: CanvasState) => ({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    });

    await handOff(request({}));
    await handOff(request({}));
    expect(sent).toHaveLength(1);

    advance(MISSING_MODEL_HANDOFF_CLAIM_TTL_MS);
    await handOff(request({}));

    expect(sent).toHaveLength(2);
  });

  // The cap has to bite BELOW the ordinary TTL to mean anything: without it the
  // second render four seconds later is still deduped. The wait start is placed
  // so the deadline falls one second out, which also fails if the deadline is
  // derived from the build start instead — that is two minutes earlier here, so
  // it would already have passed.
  it.each([
    { page: "graph", progressView: "graph" },
    { page: "graph", progressView: "planned" },
    { page: "graph-diff", progressView: "diff" }
  ] as const)(
    "caps a delivered $progressView claim against that view's absolute graph deadline",
    async ({ page, progressView }) => {
      const nowMs = 1_000_000;
      const endsInOneSecond =
        nowMs - (GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - 60_000) + 1_000;
      const records = {
        graph: progressRecord("graph", nowMs),
        planned: progressRecord("planned", nowMs),
        diff: progressRecord("diff", nowMs),
        [progressView]: progressRecord(progressView, endsInOneSecond)
      };
      const { handOff, sent, advance } = harness({
        statuses: {
          main: modelStatus("a/b", "main", { status: "missing" }),
          feat: modelStatus("a/b", "feat", { status: "missing" })
        }
      });
      const branches = progressView === "diff" ? ["main", "feat"] : ["feat"];
      const request = (canvasInstanceId: string) => ({
        repo: "a/b",
        branches,
        page,
        progressView,
        state: {
          canvasInstanceId,
          workspaceRepo: "a/b",
          workspaceBranch: "feat",
          graphProgressRecords: records
        }
      });

      await handOff(request("first"));
      await handOff(request("second"));
      expect(sent).toHaveLength(1);

      advance(1_000);
      await handOff(request("third"));

      expect(sent).toHaveLength(2);
    }
  );

  // A deadline already behind the clock cannot leave room for a retry, and
  // honouring it would expire the claim the moment delivery is recorded. The
  // wait it belongs to can still have most of the thirty-minute ceiling left
  // once staging activity is observed, so every render in that span would ask
  // again.
  it("does not re-send on every render once the recovery deadline has passed", async () => {
    const nowMs = 1_000_000;
    const passed = nowMs - (GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - 60_000) - 60_000;
    const { handOff, sent, advance } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });
    const request = (canvasInstanceId: string) => ({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state: {
        canvasInstanceId,
        workspaceRepo: "a/b",
        workspaceBranch: "feat",
        graphProgressRecords: { graph: progressRecord("graph", passed) }
      }
    });

    await handOff(request("first"));
    await handOff(request("second"));
    await handOff(request("third"));
    expect(sent).toHaveLength(1);

    // Still retryable, just once per TTL rather than once per render.
    advance(MISSING_MODEL_HANDOFF_CLAIM_TTL_MS);
    await handOff(request("fourth"));

    expect(sent).toHaveLength(2);
  });

  it("does not watch for a run at all when the repository cannot be modeled", async () => {
    const { handOff, sent, waits, modelingInFlight } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      sources: { feat: UNMODELABLE }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toHaveLength(0);
    expect(waits).toHaveLength(0);
    expect(modelingInFlight).not.toHaveBeenCalled();
  });

  it("does not watch for a run when the model exists and only needs refreshing", async () => {
    const { handOff, sent, modelingInFlight } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", { status: "source-changed" })
      }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toHaveLength(1);
    expect(modelingInFlight).not.toHaveBeenCalled();
  });

  it("reserves a missing-model handoff while source evaluation is in flight", async () => {
    const state: CanvasState = {};
    let release!: (source: AppSourceEvaluation) => void;
    const source = new Promise<AppSourceEvaluation>((resolve) => {
      release = resolve;
    });
    const evaluateSource = vi.fn(() => source);
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      evaluateSource
    });

    const first = handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    });
    await vi.waitFor(() => expect(evaluateSource).toHaveBeenCalledTimes(1));
    const second = handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "planned",
      state
    });
    release(MODELABLE);
    await Promise.all([first, second]);

    expect(evaluateSource).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("does not redispatch an old target after the same panel observes a renamed branch", async () => {
    const state: CanvasState = {};
    const statuses = {
      original: modelStatus("a/b", "original", { status: "missing" }),
      renamed: modelStatus("a/b", "renamed")
    };
    const { handOff, sent, evaluateSource } = harness({ statuses });

    await handOff({
      repo: "a/b",
      branches: ["original"],
      page: "graph",
      state
    });
    await handOff({
      repo: "a/b",
      branches: ["renamed"],
      page: "graph",
      state
    });
    await handOff({
      repo: "a/b",
      branches: ["original"],
      page: "graph",
      state
    });

    expect(sent).toHaveLength(1);
    expect(evaluateSource).toHaveBeenCalledOnce();
  });

  it("releases a missing-model reservation when source evaluation fails", async () => {
    const state: CanvasState = {};
    const evaluateSource = vi
      .fn<() => Promise<AppSourceEvaluation>>()
      .mockRejectedValueOnce(new Error("source unavailable"))
      .mockResolvedValue(MODELABLE);
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      evaluateSource
    });
    const request = {
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    };

    await expect(handOff(request)).rejects.toThrow("source unavailable");
    expect(state.appBicepHandoffKey).toBeUndefined();
    await handOff(request);

    expect(evaluateSource).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
  });

  it("does not clear a newer reservation when an older source probe fails", async () => {
    const state: CanvasState = {};
    let rejectSource!: (error: Error) => void;
    const evaluateSource = vi.fn(
      () =>
        new Promise<AppSourceEvaluation>((_resolve, reject) => {
          rejectSource = reject;
        })
    );
    const { handOff } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      evaluateSource
    });
    const pending = handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    });
    await vi.waitFor(() => expect(evaluateSource).toHaveBeenCalledOnce());
    state.appBicepHandoffKey = "newer-request";

    rejectSource(new Error("source unavailable"));

    await expect(pending).rejects.toThrow("source unavailable");
    expect(state.appBicepHandoffKey).toBe("newer-request");
  });

  it("does not clear a newer target classification when an older source probe fails", async () => {
    const state: CanvasState = {};
    let rejectSource!: (error: Error) => void;
    let statusCall = 0;
    const evaluateSource = vi.fn(
      () =>
        new Promise<AppSourceEvaluation>((_resolve, reject) => {
          rejectSource = reject;
        })
    );
    const { handOff, sent } = harness({
      resolveStatus: vi.fn(async () => {
        statusCall++;
        return modelStatus("a/b", "feat", {
          status: statusCall === 1 ? "missing" : "up-to-date"
        });
      }),
      evaluateSource
    });
    const request = {
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    };

    const older = handOff(request);
    await vi.waitFor(() => expect(evaluateSource).toHaveBeenCalledOnce());
    await handOff(request);
    rejectSource(new Error("source unavailable"));
    await expect(older).rejects.toThrow("source unavailable");
    await handOff(request);

    expect(sent).toEqual([]);
    expect(evaluateSource).toHaveBeenCalledOnce();
  });

  it("does not send an older handoff after a newer reservation replaces it", async () => {
    const state: CanvasState = {};
    let releaseSource!: (source: AppSourceEvaluation) => void;
    const evaluateSource = vi.fn(
      () =>
        new Promise<AppSourceEvaluation>((resolve) => {
          releaseSource = resolve;
        })
    );
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      evaluateSource
    });
    const pending = handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    });
    await vi.waitFor(() => expect(evaluateSource).toHaveBeenCalledOnce());
    state.appBicepHandoffKey = "newer-request";

    releaseSource(MODELABLE);
    await pending;

    expect(sent).toEqual([]);
    expect(state.appBicepHandoffKey).toBe("newer-request");
  });

  it("names the view it was asked about in the authoring prompt", async () => {
    const { handOff, sent } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "missing" }),
        feat: modelStatus("a/b", "feat", { status: "missing" })
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff"
    });

    expect(sent[0].prompt).toContain("graph-diff");
    expect(sent[0].prompt).toContain("branches `main`, `feat`");
  });

  it("stays silent when every branch's source cannot be modeled at all", async () => {
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      sources: { feat: UNMODELABLE }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toEqual([]);
  });

  it("still hands off when only one of several branches lacks a Dockerfile", async () => {
    const { handOff, sent } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "missing" }),
        feat: modelStatus("a/b", "feat", { status: "missing" })
      },
      sources: { main: UNMODELABLE, feat: MODELABLE }
    });

    await handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff"
    });

    expect(sent).toHaveLength(1);
  });

  it("leaves the dedupe key unconsumed for an unmodelable repository so adding a Dockerfile re-enables the handoff", async () => {
    const state: CanvasState = {};
    const sources: Record<string, AppSourceEvaluation> = {
      feat: UNMODELABLE
    };
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      sources
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });
    expect(state.appBicepHandoffKey).toBeUndefined();

    sources.feat = MODELABLE;
    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(sent).toHaveLength(1);
    expect(state.appBicepHandoffKey).toBeUndefined();
  });

  it("does not consult the source listing when a model already exists", async () => {
    const { handOff, evaluateSource } = harness({
      statuses: { feat: modelStatus("a/b", "feat") }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(evaluateSource).not.toHaveBeenCalled();
  });

  it("says nothing about an up-to-date model", async () => {
    const { handOff, sent, logged } = harness({
      statuses: { feat: modelStatus("a/b", "feat") }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toEqual([]);
    expect(logged).toEqual([]);
  });

  it("asks for a refresh when a worktree model no longer matches its source", async () => {
    const { handOff, sent, announced } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", {
          status: "source-changed",
          reason: "the branch moved to commit deadbeef"
        })
      }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });
    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("the branch moved to commit deadbeef");
    expect(sent[0].prompt).toContain("Do not commit or push");
    expect(sent[0].prompt).toContain(SKILL_HANDOFF);
    // A refresh replaces a model that exists, so no missing-model render can
    // be waiting on it.
    expect(announced).toEqual([]);
  });

  it("asks the user before regenerating a model it cannot verify", async () => {
    const { handOff, sent } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", { status: "manually-edited" })
      }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("ask whether they want the model");
    expect(sent[0].prompt).toContain(SKILL_HANDOFF);
    expect(sent[0].displayPrompt).toContain("Asking before regenerating");
  });

  it("does not start either automatic or confirmation refresh from a comparison", async () => {
    const { handOff, sent, logged } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "source-changed" }),
        feat: modelStatus("a/b", "feat", { status: "manually-edited" })
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff"
    });

    expect(sent).toHaveLength(0);
    expect(logged).toContainEqual(
      expect.stringContaining(
        "The comparison does not regenerate either branch."
      )
    );
  });

  it("asks for a refresh when the installed Radius CLI is newer than the model's", async () => {
    const { handOff, sent, logged } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", {
          status: "radius-version-changed",
          sourceCommit: "aaa",
          reason:
            "The model was generated with Radius 0.60, but the installed Radius CLI uses 0.61, so it may no longer compile."
        })
      }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("the installed Radius CLI uses 0.61");
    expect(logged).toEqual([]);
  });

  // An older CLI cannot regenerate the model, so the user gets a note telling
  // them to update the plugin instead of a refresh that would fail.
  it.each([
    ["the workspace branch", true],
    ["another branch", false]
  ])(
    "notes an older Radius CLI on %s without asking for a refresh",
    async (_label, refreshable) => {
      const { handOff, sent, logged } = harness({
        statuses: {
          feat: modelStatus("a/b", "feat", {
            status: "radius-cli-outdated",
            sourceCommit: "aaa",
            refreshable,
            reason: "Update the Radius plugin to keep working with this model."
          })
        }
      });

      await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

      expect(sent).toEqual([]);
      expect(logged).toEqual([
        "Radius: the application model for a/b on branch `feat` was not refreshed. Update the Radius plugin to keep working with this model."
      ]);
    }
  );

  it("notes both the older Radius CLI and the stale comparison branch without refreshing", async () => {
    const { handOff, sent, logged } = harness({
      statuses: {
        main: modelStatus("a/b", "main", {
          status: "radius-cli-outdated",
          sourceCommit: "aaa"
        }),
        feat: modelStatus("a/b", "feat", { status: "source-changed" })
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff"
    });

    expect(sent).toHaveLength(0);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("on branch `main` was not refreshed");
  });

  it("notes an older Radius CLI once for a panel that renders again", async () => {
    const { handOff, logged } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", {
          status: "radius-cli-outdated",
          sourceCommit: "aaa"
        })
      }
    });
    const state: CanvasState = {};

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });
    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(logged).toHaveLength(1);
  });

  it("only notes a stale model on a branch modeling may not rewrite", async () => {
    const { handOff, sent, logged } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", {
          status: "source-changed",
          refreshable: false
        })
      }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toEqual([]);
    expect(logged).toEqual([
      expect.stringContaining("may be out of date") as unknown as string
    ]);
  });

  it("notes every unrefreshable stale branch, not just the first", async () => {
    const { handOff, logged } = harness({
      statuses: {
        main: modelStatus("a/b", "main", {
          status: "source-changed",
          refreshable: false
        }),
        feat: modelStatus("a/b", "feat", {
          status: "source-changed",
          refreshable: false
        })
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff"
    });

    expect(logged).toHaveLength(2);
  });

  it("reports the same unchanged situation only once for a panel", async () => {
    const state: CanvasState = {};
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });
    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(sent).toHaveLength(1);
  });

  it("reports again when the same branch's problem changes", async () => {
    const state: CanvasState = {};
    const statuses: Record<string, AppModelStatus> = {
      feat: modelStatus("a/b", "feat", { status: "source-changed" })
    };
    const { handOff, sent } = harness({ statuses });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });
    statuses.feat = modelStatus("a/b", "feat", {
      status: "manually-edited"
    });
    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(sent).toHaveLength(2);
  });

  it("dedupes state-free renders while delivery may still be queued, then retries after expiry", async () => {
    const { handOff, sent, advance } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });
    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });
    expect(sent).toHaveLength(1);

    advance(MISSING_MODEL_HANDOFF_CLAIM_TTL_MS);
    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toHaveLength(2);
  });

  it("asks for the same staleness signal once across panels, so a refresh that does not clear it cannot loop", async () => {
    const { handOff, sent } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", {
          status: "source-changed",
          sourceCommit: "aaa"
        })
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state: {}
    });
    await handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state: {}
    });

    expect(sent).toHaveLength(1);
  });

  it("asks about an unverified model once across panels", async () => {
    const { handOff, sent } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", {
          status: "manually-edited",
          sourceCommit: "aaa"
        })
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state: {}
    });
    await handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state: {}
    });

    expect(sent).toHaveLength(1);
  });

  it("releases the panel key when the stale-model memo suppresses the message", async () => {
    const state: CanvasState = {};
    const { handOff, sent } = harness({
      claimRefreshMemo: () => undefined,
      statuses: {
        feat: modelStatus("a/b", "feat", { status: "source-changed" })
      }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(sent).toEqual([]);
    expect(state.appBicepHandoffKey).toBeUndefined();
  });

  it("releases the panel key when an unverified-model memo suppresses the message", async () => {
    const state: CanvasState = {};
    const { handOff, sent } = harness({
      claimRefreshMemo: () => undefined,
      statuses: {
        feat: modelStatus("a/b", "feat", { status: "manually-edited" })
      }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(sent).toEqual([]);
    expect(state.appBicepHandoffKey).toBeUndefined();
  });

  it("does nothing without a repository", async () => {
    const { handOff, resolveStatus, sent } = harness();

    await handOff({ repo: "", branches: ["feat"], page: "graph" });

    expect(resolveStatus).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("does nothing when no branch survives filtering", async () => {
    const { handOff, resolveStatus, sent } = harness();

    await handOff({
      repo: "a/b",
      branches: [undefined, ""],
      page: "graph"
    });

    expect(resolveStatus).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it("resolves each branch against the panel's own state", async () => {
    const state: CanvasState = {
      workspaceRepo: "a/b",
      workspaceBranch: "feat"
    };
    const seen: CanvasState[] = [];
    const { handOff } = harness({
      resolveStatus: async (repo, branch, given) => {
        seen.push(given);
        return modelStatus(repo, branch);
      }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(seen).toEqual([{ workspaceRepo: "a/b", workspaceBranch: "feat" }]);
    expect(seen[0]).not.toBe(state);
  });

  it("propagates a broken reader rather than acting on a half-resolved picture", async () => {
    const { handOff, sent } = harness({
      resolveStatus: async () => {
        throw new Error("reader offline");
      }
    });

    await expect(
      handOff({ repo: "a/b", branches: ["feat"], page: "graph" })
    ).rejects.toThrow("reader offline");
    expect(sent).toEqual([]);
  });

  // The failure message promises the user a refresh. That refresh re-enters the
  // handoff with the same branches and the same missing statuses, so the panel
  // reservation must not still be holding the key from the delivered attempt.
  it("releases the panel reservation after a delivered diff handoff so the promised refresh can ask again", async () => {
    const state: CanvasState = { canvasInstanceId: "panel-1" };
    const statuses = {
      main: modelStatus("a/b", "main", { status: "missing" }),
      feat: modelStatus("a/b", "feat", { status: "missing" })
    };
    const { handOff, sent } = harness({ statuses });

    await handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff",
      state
    });

    expect(sent).toHaveLength(1);
    expect(state.appBicepHandoffKeys?.["a/b::main:feat"]).toBeUndefined();
    expect(state.appBicepHandoffKey).toBeUndefined();
  });

  it("releases the panel reservation when send fails for a missing model, allowing retry", async () => {
    const state: CanvasState = { canvasInstanceId: "radius-panel" };
    let sendAttempt = 0;
    const { handOff, sent, announced } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      send: async (message) => {
        sendAttempt++;
        if (sendAttempt === 1) throw new Error("session closed");
        sent.push(message);
      }
    });
    const request = {
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    };

    await expect(handOff(request)).rejects.toThrow("session closed");
    expect(state.appBicepHandoffKey).toBeUndefined();
    expect(state.appModelAttemptTokens?.["a/b::feat"]).toBeUndefined();
    expect(announced).toEqual([]);

    await handOff(request);
    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain(SKILL_HANDOFF);
  });

  it("does not release a superseding panel reservation when an older send fails for a missing model", async () => {
    const state: CanvasState = {};
    let rejectSend!: (error: Error) => void;
    const send = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectSend = reject;
        })
    );
    const { handOff } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      send
    });

    const pending = handOff({
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    state.appBicepHandoffKey = "newer-request";

    rejectSend(new Error("session closed"));
    await expect(pending).rejects.toThrow("session closed");
    expect(state.appBicepHandoffKey).toBe("newer-request");
  });

  it("releases the panel reservation and refresh memo when send fails for a stale model, allowing retry", async () => {
    const state: CanvasState = {};
    let sendAttempt = 0;
    const { handOff, sent } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", {
          status: "source-changed",
          sourceCommit: "aaa"
        })
      },
      send: async (message) => {
        sendAttempt++;
        if (sendAttempt === 1) throw new Error("session closed");
        sent.push(message);
      }
    });
    const request = {
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    };

    await expect(handOff(request)).rejects.toThrow("session closed");
    expect(state.appBicepHandoffKey).toBeUndefined();

    // Retry succeeds — both the panel reservation and the refresh memo were released.
    await handOff(request);
    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("needs to be regenerated");
  });

  it("abandons a generated-model refresh if the model changes before staging", async () => {
    const original = modelStatus("a/b", "main", { status: "source-changed" });
    const state: CanvasState = { canvasInstanceId: "model-panel" };
    const beginManaged = vi.fn();
    const { handOff, sent } = harness({
      beginManaged,
      resolveStatus: vi
        .fn()
        .mockResolvedValueOnce(original)
        .mockResolvedValueOnce({
          ...original,
          freshness: { ...original.freshness, appBicepHash: "replacement" }
        })
    });

    await handOff({ repo: "a/b", branches: ["main"], page: "graph", state });

    expect(beginManaged).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(state.appBicepHandoffKey).toBeUndefined();
  });

  it("releases a managed refresh if staging throws and retries the same source", async () => {
    const state: CanvasState = { canvasInstanceId: "model-panel" };
    const beginManaged = vi
      .fn<AppModelHandoffDependencies["beginManaged"]>(
        (_state, _repo, _branch, _token, _revision, handoff) => handoff
      )
      .mockImplementationOnce(() => {
        throw new Error("staging unavailable");
      });
    const { handOff, sent } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "source-changed" })
      },
      beginManaged
    });
    const request = { repo: "a/b", branches: ["main"], page: "graph", state };

    await expect(handOff(request)).rejects.toThrow("staging unavailable");
    expect(state.appModelAttemptTokens).toEqual({});
    expect(state.appBicepHandoffKey).toBeUndefined();
    expect(sent).toEqual([]);

    await handOff(request);
    expect(beginManaged).toHaveBeenCalledTimes(2);
    expect(beginManaged.mock.calls[0][3]).not.toBe(
      beginManaged.mock.calls[1][3]
    );
    expect(sent).toHaveLength(1);
  });

  it("does not release a replacement when an ownerless refresh's send fails late", async () => {
    const state: CanvasState = { canvasInstanceId: "model-panel" };
    const stopDelivery = createDeferred<void>();
    const stopStarted = createDeferred<void>();
    let sendCount = 0;
    const { handOff } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "source-changed" })
      },
      beginManaged: vi
        .fn<AppModelHandoffDependencies["beginManaged"]>(
          (_state, _repo, _branch, _token, _revision, handoff) => handoff
        )
        .mockImplementationOnce(
          (
            _state,
            _repo,
            _branch,
            _token,
            _revision,
            handoff,
            _current,
            settled
          ) => {
            settled?.();
            return handoff;
          }
        ),
      send: async () => {
        if (++sendCount !== 1) return;
        stopStarted.resolve();
        await stopDelivery.promise;
      }
    });
    const request = { repo: "a/b", branches: ["main"], page: "graph", state };

    const first = handOff(request);
    await stopStarted.promise;
    await handOff(request);
    const replacement = state.appModelAttemptTokens?.["a/b::main"];
    expect(replacement).toBeTruthy();

    stopDelivery.reject(new Error("SDK failed to deliver stop instruction"));
    await expect(first).rejects.toThrow(
      "SDK failed to deliver stop instruction"
    );
    expect(state.appModelAttemptTokens?.["a/b::main"]).toBe(replacement);
    await handOff({ ...request, state: {} });
    expect(sendCount).toBe(2);
  });

  it("deduplicates a pending single-branch refresh and retries after delivery fails", async () => {
    const state: CanvasState = {};
    let rejectFirstSend!: (error: Error) => void;
    let sendAttempt = 0;
    const { handOff, sent } = harness({
      statuses: {
        main: modelStatus("a/b", "main", {
          status: "source-changed",
          sourceCommit: "aaa"
        })
      },
      send: (message) => {
        sendAttempt++;
        if (sendAttempt === 1) {
          return new Promise<void>((_resolve, reject) => {
            rejectFirstSend = reject;
          });
        }
        sent.push(message);
        return Promise.resolve();
      }
    });

    const first = handOff({
      repo: "a/b",
      branches: ["main"],
      page: "planned",
      state
    });
    await vi.waitFor(() => expect(sendAttempt).toBe(1));

    await handOff({
      repo: "a/b",
      branches: ["main"],
      page: "graph",
      state
    });
    expect(state.appBicepHandoffKey).toBeDefined();

    rejectFirstSend(new Error("session closed"));
    await expect(first).rejects.toThrow("session closed");
    expect(state.appBicepHandoffKey).toBeUndefined();

    await handOff({
      repo: "a/b",
      branches: ["main"],
      page: "graph",
      state
    });
    expect(sent).toHaveLength(1);
  });

  it("releases the panel reservation and refresh memo when send fails for an unverified model, allowing retry", async () => {
    const state: CanvasState = {};
    let sendAttempt = 0;
    const { handOff, sent } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", {
          status: "manually-edited",
          sourceCommit: "aaa"
        })
      },
      send: async (message) => {
        sendAttempt++;
        if (sendAttempt === 1) throw new Error("session closed");
        sent.push(message);
      }
    });
    const request = {
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    };

    await expect(handOff(request)).rejects.toThrow("session closed");
    expect(state.appBicepHandoffKey).toBeUndefined();

    await handOff(request);
    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("would discard content");
  });

  it("sends nothing and frees the missing-model handoff for a retry when the skill handoff cannot be built", async () => {
    const state: CanvasState = { canvasInstanceId: "radius-panel" };
    const skillHandoff = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("no usable radius-app-bicep skill"))
      .mockResolvedValue(SKILL_HANDOFF);
    const { handOff, sent, logged } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      skillHandoff
    });
    const request = {
      repo: "a/b",
      branches: ["feat"],
      page: "graph",
      state
    };

    await expect(handOff(request)).rejects.toThrow(
      "no usable radius-app-bicep skill"
    );
    expect(sent).toEqual([]);
    expect(logged).toEqual([
      "Radius could not start application modeling. no usable radius-app-bicep skill"
    ]);
    expect(state.appBicepHandoffKey).toBeUndefined();
    expect(state.appModelAttemptTokens?.["a/b::feat"]).toBeUndefined();

    await handOff(request);
    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain(SKILL_HANDOFF);
  });

  it.each([
    ["stale", "source-changed", "needs to be regenerated"],
    ["unverified", "manually-edited", "would discard content"]
  ] as const)(
    "sends nothing and frees the %s-model refresh for a retry when the skill handoff cannot be built",
    async (_name, status, expected) => {
      const state: CanvasState = {};
      const skillHandoff = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new Error("no usable radius-app-bicep skill"))
        .mockResolvedValue(SKILL_HANDOFF);
      const { handOff, sent, logged } = harness({
        statuses: {
          feat: modelStatus("a/b", "feat", { status, sourceCommit: "aaa" })
        },
        skillHandoff
      });
      const request = {
        repo: "a/b",
        branches: ["feat"],
        page: "graph",
        state
      };

      await expect(handOff(request)).rejects.toThrow(
        "no usable radius-app-bicep skill"
      );
      expect(sent).toEqual([]);
      expect(logged).toEqual([
        "Radius could not start application modeling. no usable radius-app-bicep skill"
      ]);
      expect(state.appBicepHandoffKey).toBeUndefined();

      // The refresh memo was released too, or this retry would be suppressed.
      await handOff(request);
      expect(sent).toHaveLength(1);
      expect(sent[0].prompt).toContain(expected);
      expect(sent[0].prompt).toContain(SKILL_HANDOFF);
    }
  );

  it("shows a repeated skill handoff failure once, and again after it recovers", async () => {
    const skillHandoff = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("skill files missing"))
      .mockRejectedValueOnce(new Error("skill files missing"))
      .mockRejectedValueOnce(new Error("no Node.js"))
      .mockResolvedValueOnce(SKILL_HANDOFF)
      .mockRejectedValueOnce(new Error("skill files missing"));
    const { handOff, logged } = harness({
      statuses: {
        feat: modelStatus("a/b", "feat", { status: "missing" }),
        main: modelStatus("a/b", "main", { status: "missing" })
      },
      skillHandoff
    });
    const poll = async () => {
      await handOff({ repo: "a/b", branches: ["feat"], page: "graph" }).catch(
        () => undefined
      );
    };

    await poll();
    await poll();
    expect(logged).toHaveLength(1);

    await poll();
    expect(logged).toHaveLength(2);
    expect(logged[1]).toContain("no Node.js");

    await poll();
    await handOff({ repo: "a/b", branches: ["main"], page: "graph" }).catch(
      () => undefined
    );
    expect(logged).toHaveLength(3);
    expect(logged[2]).toContain("skill files missing");
  });
});
