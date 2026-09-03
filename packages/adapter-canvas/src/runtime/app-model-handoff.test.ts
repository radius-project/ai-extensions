import { describe, it, expect, vi } from "vitest";
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

interface StatusOverrides {
  status?: AppModelFreshnessStatus;
  refreshable?: boolean;
  requiresConfirmation?: boolean;
  reason?: string;
  sourceCommit?: string;
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
    refreshable: overrides.refreshable ?? true,
    freshness: {
      status,
      stale: status !== "up-to-date" && status !== "missing",
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
  const deps: AppModelHandoffDependencies = {
    resolveContext,
    resolveStatus,
    evaluateSource,
    modelingInFlight,
    // Resolves immediately: the grace window's duration is expressed in the
    // recorded waits, so no test has to spend real time on it.
    wait: async (ms: number) => {
      waits.push(ms);
    },
    send: async (message) => {
      sent.push(message);
    },
    log: (message) => {
      logged.push(message);
    },
    shouldRequestRefresh: (key: string) => {
      if (requested.has(key)) return false;
      requested.add(key);
      return true;
    },
    releaseRefreshMemo: (key: string) => {
      requested.delete(key);
    },
    missingModelHandoffs: createMissingModelHandoffClaims(() => nowMs),
    ...overrides
  };
  return {
    handOff: createAppModelHandoff(deps),
    sent,
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
    expect(resolveStatus).toHaveBeenCalledWith("a/b", "feat", state);
  });

  it("asks the agent to author a model when no branch has one", async () => {
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("radius_generate_app");
    expect(sent[0].prompt).toContain("`feat`");
    expect(sent[0].displayPrompt).toContain("Generating the application model");
  });

  it("watches for a run starting before it asks, and abandons the handoff when one does", async () => {
    const state: CanvasState = {};
    const modelingInFlight = vi
      .fn(async () => false)
      // The render that found no model runs BEFORE the agent reaches for
      // radius_generate_app, so the first probe legitimately sees nothing.
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { handOff, sent, waits } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) },
      modelingInFlight
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(sent).toHaveLength(0);
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
      state
    });

    const token = state.appModelAttemptTokens?.["a/b::feat"];
    expect(token).toBeTruthy();
    expect(state.appModelAttemptGeneration).toBe(1);
    expect(sent[0].prompt).toContain("radius_report_modeling_failure");
    expect(sent[0].prompt).toContain(`attemptToken \`${token}\``);
    expect(sent[0].prompt).toContain("instanceId `radius-app`");
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
    const { handOff, sent } = harness({
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
    expect(sent[0].displayPrompt).toContain("Asking before regenerating");
  });

  it("prefers the confirmation conversation over a plain refresh when both apply", async () => {
    const { handOff, sent } = harness({
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

    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("would discard content");
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
      shouldRequestRefresh: () => false,
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
      shouldRequestRefresh: () => false,
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

    expect(seen).toEqual([state]);
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

  it("releases the panel reservation when send fails for a missing model, allowing retry", async () => {
    const state: CanvasState = { canvasInstanceId: "radius-panel" };
    let sendAttempt = 0;
    const { handOff, sent } = harness({
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

    await handOff(request);
    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("radius_generate_app");
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

  it("retries a superseding stale-model handoff after the shared delivery fails", async () => {
    const state: CanvasState = {};
    let rejectFirstSend!: (error: Error) => void;
    let sendAttempt = 0;
    const { handOff, sent } = harness({
      statuses: {
        main: modelStatus("a/b", "main", {
          status: "source-changed",
          sourceCommit: "aaa"
        }),
        feature: modelStatus("a/b", "feature", { status: "up-to-date" })
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
      branches: ["main", "feature"],
      page: "graph-diff",
      state
    });
    expect(state.appBicepHandoffKey).toBeUndefined();

    rejectFirstSend(new Error("session closed"));
    await expect(first).rejects.toThrow("session closed");

    await handOff({
      repo: "a/b",
      branches: ["main", "feature"],
      page: "graph-diff",
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
});
