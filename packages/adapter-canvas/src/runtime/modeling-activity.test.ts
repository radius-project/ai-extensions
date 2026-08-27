import { describe, it, expect, vi } from "vitest";
import {
  createModelingActivity,
  MODELING_ANNOUNCEMENT_TTL_MS,
  MODELING_STAGING_ACTIVITY_TTL_MS
} from "./modeling-activity.js";
import type { ModelingActivityDependencies } from "./modeling-activity.js";

function harness(overrides: Partial<ModelingActivityDependencies> = {}) {
  let nowMs = 1_000_000;
  const observeStagedRun = vi.fn(async () => null as number | null);
  const activity = createModelingActivity({
    now: () => nowMs,
    observeStagedRun,
    ...overrides
  });
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

  it("does not let one repo's announcement silence another repo or branch", async () => {
    const { activity } = harness();

    activity.announce({ repo: "a/b", branch: "feat" });

    expect(await activity.inFlight("a/b", ["main"])).toBe(false);
    expect(await activity.inFlight("other/repo", ["feat"])).toBe(false);
  });

  it("treats an announcement with no resolvable branch as covering the repo", async () => {
    const { activity } = harness();

    activity.announce({ repo: "a/b", branch: "" });

    expect(await activity.inFlight("a/b", ["feat"])).toBe(true);
    expect(await activity.inFlight("a/b", ["main"])).toBe(true);
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
    expect(observeStagedRun).toHaveBeenCalledWith("a/b", ["feat"]);
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
