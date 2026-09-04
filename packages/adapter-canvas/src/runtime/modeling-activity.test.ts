import { describe, it, expect, vi } from "vitest";
import {
  createModelingActivity,
  MODELING_ANNOUNCEMENT_TTL_MS,
  MODELING_STAGING_ACTIVITY_TTL_MS,
  observeWorkspaceModelingRun
} from "./modeling-activity.js";
import type {
  ModelingActivityDependencies,
  ModelingWorkspace
} from "./modeling-activity.js";
import {
  GRAPH_APP_BICEP_IDLE_TIMEOUT_MS,
  GRAPH_APP_BICEP_MAX_WAIT_MS
} from "../graph-progress-contract.js";

const WORKSPACE = {
  repo: "a/b",
  branch: "feat",
  path: "/workspace"
};

describe("observeWorkspaceModelingRun", () => {
  it("probes workspace staging activity when the repository and one requested branch match", async () => {
    const probe = vi.fn(async () => 42);

    await expect(
      observeWorkspaceModelingRun("a/b", ["main", "feat"], WORKSPACE, probe)
    ).resolves.toBe(42);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledWith("/workspace");
  });

  it.each([
    ["an unnamed target repository", "", ["feat"], WORKSPACE],
    [
      "an unnamed workspace repository",
      "a/b",
      ["feat"],
      { ...WORKSPACE, repo: "" }
    ],
    ["a different repository", "other/repo", ["feat"], WORKSPACE],
    ["a different branch", "a/b", ["main"], WORKSPACE],
    ["no requested branches", "a/b", [], WORKSPACE]
  ])("does not probe for %s", async (_label, repo, branches, workspace) => {
    const probe = vi.fn(async () => 42);

    await expect(
      observeWorkspaceModelingRun(repo, branches, workspace, probe)
    ).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it("propagates a matching workspace probe failure to its caller", async () => {
    const failure = new Error("EACCES");

    await expect(
      observeWorkspaceModelingRun("a/b", ["feat"], WORKSPACE, async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
  });
});

function harness(overrides: Partial<ModelingActivityDependencies> = {}) {
  let nowMs = 1_000_000;
  const observeStagedRun = vi.fn(async () => null as number | null);
  const rawActivity = createModelingActivity({
    now: () => nowMs,
    observeStagedRun,
    ...overrides
  });
  const activity = {
    announce: rawActivity.announce,
    release: rawActivity.release,
    inFlight: (
      repo: string,
      branches: ReadonlyArray<string>,
      workspace: ModelingWorkspace = WORKSPACE
    ) => rawActivity.inFlight(repo, branches, workspace)
  };
  return {
    activity,
    observeStagedRun,
    advance: (ms: number) => {
      nowMs += ms;
    }
  };
}

describe("createModelingActivity", () => {
  it("reports a run in flight from the moment the modeling skill is handed over", async () => {
    const { activity, observeStagedRun } = harness();

    activity.announce({ repo: "a/b", branch: "feat" });

    expect(await activity.inFlight("a/b", ["feat"])).toBe(true);
    // The announcement alone settles it, so the filesystem is never probed for
    // a staging directory the run has not created yet.
    expect(observeStagedRun).not.toHaveBeenCalled();
  });

  it("releases only the terminal modeling run's announcement", async () => {
    const { activity } = harness();
    activity.announce({ repo: "a/b", branch: "feat" });
    activity.announce({ repo: "a/b", branch: "main" });

    activity.release({ repo: "a/b", branch: "feat" });

    expect(await activity.inFlight("a/b", ["feat"])).toBe(false);
    expect(await activity.inFlight("a/b", ["main"])).toBe(true);
  });

  it("does not let one repo's announcement silence another repo or branch", async () => {
    const { activity } = harness();

    activity.announce({ repo: "a/b", branch: "feat" });

    expect(await activity.inFlight("a/b", ["main"])).toBe(false);
    expect(await activity.inFlight("other/repo", ["feat"])).toBe(false);
  });

  it("treats a run for either diff side as sufficient because one model makes the diff renderable", async () => {
    const { activity } = harness();
    activity.announce({ repo: "a/b", branch: "feat" });

    expect(await activity.inFlight("a/b", ["main", "feat"])).toBe(true);
  });

  it("does not let an unresolved branch announcement suppress named branches", async () => {
    const { activity } = harness();

    activity.announce({ repo: "a/b", branch: "" });

    expect(await activity.inFlight("a/b", ["feat"])).toBe(false);
    expect(await activity.inFlight("a/b", ["main"])).toBe(false);
  });

  it("ignores an announcement that cannot name its repository", async () => {
    const { activity } = harness();

    activity.announce({ repo: "", branch: "feat" });

    expect(await activity.inFlight("a/b", ["feat"])).toBe(false);
  });

  it("stops trusting an announcement once its window closes, so a run that died is asked about again", async () => {
    const { activity, advance } = harness();
    activity.announce({ repo: "a/b", branch: "feat" });

    advance(MODELING_ANNOUNCEMENT_TTL_MS - 1);
    expect(await activity.inFlight("a/b", ["feat"])).toBe(true);

    advance(1);
    expect(await activity.inFlight("a/b", ["feat"])).toBe(false);
  });

  it("re-announcing restarts the window rather than inheriting the first run's age", async () => {
    const { activity, advance } = harness();
    activity.announce({ repo: "a/b", branch: "feat" });

    advance(MODELING_ANNOUNCEMENT_TTL_MS - 1);
    activity.announce({ repo: "a/b", branch: "feat" });
    advance(MODELING_ANNOUNCEMENT_TTL_MS - 1);

    expect(await activity.inFlight("a/b", ["feat"])).toBe(true);
  });

  it("carries the rest of the run on the staging directory once the announcement expires", async () => {
    const observeStagedRun = vi.fn(async () => 42);
    const { activity, advance } = harness({ observeStagedRun });
    activity.announce({ repo: "a/b", branch: "feat" });
    advance(MODELING_ANNOUNCEMENT_TTL_MS);

    expect(await activity.inFlight("a/b", ["feat"])).toBe(true);
    expect(observeStagedRun).toHaveBeenCalledWith("a/b", ["feat"], WORKSPACE);
  });

  it("trusts staging activity until its inactivity window closes", async () => {
    const { activity } = harness({
      observeStagedRun: async () =>
        1_000_000 - MODELING_STAGING_ACTIVITY_TTL_MS + 1
    });

    expect(await activity.inFlight("a/b", ["feat"])).toBe(true);
  });

  it("does not let an orphaned staging directory suppress authoring forever", async () => {
    const { activity } = harness({
      observeStagedRun: async () => 1_000_000 - MODELING_STAGING_ACTIVITY_TTL_MS
    });

    expect(await activity.inFlight("a/b", ["feat"])).toBe(false);
  });

  it("expires each suppressing signal before the graph's corresponding wait budget", () => {
    expect(MODELING_ANNOUNCEMENT_TTL_MS).toBeLessThan(
      GRAPH_APP_BICEP_IDLE_TIMEOUT_MS
    );
    expect(MODELING_STAGING_ACTIVITY_TTL_MS).toBeLessThan(
      GRAPH_APP_BICEP_MAX_WAIT_MS
    );
  });

  it("does not suppress recovery after an already-aged graph exhausts the signal budget", async () => {
    const { activity } = harness({
      observeStagedRun: async () => 1_000_000
    });
    activity.announce({ repo: "a/b", branch: "feat" });

    expect(
      await activity.inFlight("a/b", ["feat"], {
        ...WORKSPACE,
        waitStartedAtMs: 1_000_000 - MODELING_STAGING_ACTIVITY_TTL_MS
      })
    ).toBe(false);
  });

  it("reports no run when nothing is staged", async () => {
    const { activity } = harness({ observeStagedRun: async () => null });

    expect(await activity.inFlight("a/b", ["feat"])).toBe(false);
  });

  it("leaves the question askable when the staging probe fails", async () => {
    const { activity } = harness({
      observeStagedRun: async () => {
        throw new Error("EACCES");
      }
    });

    expect(await activity.inFlight("a/b", ["feat"])).toBe(false);
  });

  it("answers no for a request with no repository without probing", async () => {
    const { activity, observeStagedRun } = harness();

    expect(await activity.inFlight("", ["feat"])).toBe(false);
    expect(observeStagedRun).not.toHaveBeenCalled();
  });

  it("answers from the staging probe when no branch is named", async () => {
    const observeStagedRun = vi.fn(async () => 7);
    const { activity } = harness({ observeStagedRun });

    expect(await activity.inFlight("a/b", [])).toBe(true);
  });

  it("keeps the announcement store bounded under repeated runs", async () => {
    const { activity } = harness();
    for (let index = 0; index < 250; index += 1) {
      activity.announce({ repo: "a/b", branch: `feat-${index}` });
    }

    // The newest is still trusted and the oldest has been evicted, which is the
    // only externally visible consequence of the bound.
    expect(await activity.inFlight("a/b", ["feat-249"])).toBe(true);
    expect(await activity.inFlight("a/b", ["feat-0"])).toBe(false);
  });
});
