import { describe, it, expect, vi } from "vitest";
import {
  appModelHandoffKey,
  createAppModelHandoff
} from "./app-model-handoff.js";
import type { AppModelHandoffDependencies } from "./app-model-handoff.js";
import type { AppModelStatus } from "./graph-context.js";
import type { HandoffMessage } from "./hooks.js";
import type {
  AppModelFreshnessStatus,
  AppSourceEvaluation
} from "@radius-project/core";
import type { CanvasState } from "../shared.js";

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
        (status === "unrecorded" || status === "edited"),
      reason: overrides.reason ?? `because it is ${status}`,
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

function harness(
  overrides: Partial<AppModelHandoffDependencies> & {
    statuses?: Record<string, AppModelStatus>;
    sources?: Record<string, AppSourceEvaluation>;
  } = {}
) {
  const sent: HandoffMessage[] = [];
  const logged: string[] = [];
  const requested = new Set<string>();
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
  const deps: AppModelHandoffDependencies = {
    resolveContext,
    resolveStatus,
    evaluateSource,
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
    ...overrides
  };
  return {
    handOff: createAppModelHandoff(deps),
    sent,
    logged,
    resolveContext,
    resolveStatus,
    evaluateSource
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
      [modelStatus("a/b", "feat", { status: "edited" })]
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
    expect(state.appBicepHandoffKey).toBeTruthy();
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
      statuses: { feat: modelStatus("a/b", "feat", { status: "edited" }) }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });

    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("ask whether they want the model");
    expect(sent[0].displayPrompt).toContain("Checking whether");
  });

  it("prefers the confirmation conversation over a plain refresh when both apply", async () => {
    const { handOff, sent } = harness({
      statuses: {
        main: modelStatus("a/b", "main", { status: "source-changed" }),
        feat: modelStatus("a/b", "feat", { status: "edited" })
      }
    });

    await handOff({
      repo: "a/b",
      branches: ["main", "feat"],
      page: "graph-diff"
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].prompt).toContain("could not be verified");
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
    statuses.feat = modelStatus("a/b", "feat", { status: "edited" });
    await handOff({ repo: "a/b", branches: ["feat"], page: "graph", state });

    expect(sent).toHaveLength(2);
  });

  it("reports every render when no panel state carries the previous key", async () => {
    const { handOff, sent } = harness({
      statuses: { feat: modelStatus("a/b", "feat", { status: "missing" }) }
    });

    await handOff({ repo: "a/b", branches: ["feat"], page: "graph" });
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
          status: "edited",
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
      statuses: { feat: modelStatus("a/b", "feat", { status: "edited" }) }
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
    const state: CanvasState = {};
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
    expect(sent[0].prompt).toContain("no longer describes the current source");
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
          status: "edited",
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
    expect(sent[0].prompt).toContain("could not be verified");
  });
});
