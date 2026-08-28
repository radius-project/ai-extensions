// Whether a modeling run is already under way for a repo and branch.
//
// The graph routes ask the agent to author .radius/app.bicep whenever a render
// finds no model. That question is only worth asking when nobody is already
// answering it: a handoff raised while a run is in flight arrives after the run
// finishes and asks for work that was just done, which regenerates the model
// and overwrites what the first run wrote.
//
// Two signals, because neither covers the whole run on its own:
//
//   * `radius_generate_app` handing the skill over is the earliest moment the
//     extension can observe, but it says nothing about when the run ends, so it
//     is only trusted for a bounded window.
//   * `.radius/.staging-<runId>/` is definitive at both ends — a run creates it
//     before it writes anything and removes it when it publishes or aborts —
//     but it does not exist until the run calls `--begin`, and it exists only
//     for a run staging into the workspace checkout.
//
// The announcement therefore bridges the gap up to the staging directory, and
// the staging directory carries the rest of the run.

import {
  GRAPH_APP_BICEP_IDLE_TIMEOUT_MS,
  GRAPH_APP_BICEP_MAX_WAIT_MS
} from "../graph-progress-contract.js";

// These signals suppress the recovery handoff, so each must expire before the
// graph's corresponding wait budget. The remaining minute lets the live page
// poll again and enqueue recovery before its own terminal timeout.
export const MODELING_ANNOUNCEMENT_TTL_MS =
  GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - 60_000;
export const MODELING_STAGING_ACTIVITY_TTL_MS =
  GRAPH_APP_BICEP_MAX_WAIT_MS - 60_000;

export interface ModelingAnnouncement {
  repo: string;
  branch: string;
}

export interface ModelingWorkspace {
  repo: string;
  branch: string;
  path?: string | null;
  waitStartedAtMs?: number;
}

export interface ModelingActivityDependencies {
  now(): number;
  // Newest filesystem activity from a run staging into the workspace checkout,
  // or null when none is observable. Must answer null for a target that is not
  // the workspace, because local staging directories say nothing about a remote
  // branch or a different repository.
  observeStagedRun(
    repo: string,
    branches: ReadonlyArray<string>,
    workspace: ModelingWorkspace
  ): Promise<number | null>;
}

export interface ModelingActivity {
  announce(announcement: ModelingAnnouncement): void;
  inFlight(
    repo: string,
    branches: ReadonlyArray<string>,
    workspace: ModelingWorkspace
  ): Promise<boolean>;
}

// Bounds the announcement map. One entry per repo+branch modeled in this
// process, so this is a ceiling against a pathological caller rather than an
// expected limit.
const ANNOUNCEMENT_LIMIT = 100;

export function createModelingActivity(
  deps: ModelingActivityDependencies
): ModelingActivity {
  const announcements = new Map<string, number>();
  const keyFor = (repo: string, branch: string): string => `${repo}::${branch}`;

  // Bounds the map against a pathological caller. Expiry itself is enforced when
  // an announcement is read, so this only has to stop unbounded growth.
  const trim = (): void => {
    for (const key of announcements.keys()) {
      if (announcements.size <= ANNOUNCEMENT_LIMIT) break;
      announcements.delete(key);
    }
  };

  const announced = (
    nowMs: number,
    repo: string,
    branches: ReadonlyArray<string>,
    workspace: ModelingWorkspace
  ): boolean => {
    if (
      workspace.waitStartedAtMs !== undefined &&
      nowMs - workspace.waitStartedAtMs >= MODELING_ANNOUNCEMENT_TTL_MS
    ) {
      return false;
    }
    return branches.some((branch) => {
      const atMs = announcements.get(keyFor(repo, branch));
      return atMs !== undefined && nowMs - atMs < MODELING_ANNOUNCEMENT_TTL_MS;
    });
  };

  return {
    announce({ repo, branch }: ModelingAnnouncement): void {
      if (!repo || !branch) return;
      const nowMs = deps.now();
      announcements.delete(keyFor(repo, branch));
      announcements.set(keyFor(repo, branch), nowMs);
      trim();
    },

    async inFlight(
      repo: string,
      branches: ReadonlyArray<string>,
      workspace: ModelingWorkspace
    ): Promise<boolean> {
      if (!repo) return false;
      const nowMs = deps.now();
      if (announced(nowMs, repo, branches, workspace)) return true;
      // A probe that cannot answer must not claim a run is in flight: this
      // suppresses the authoring handoff, so an unreadable workspace has to
      // leave the question askable rather than silence it.
      try {
        const activityAtMs = await deps.observeStagedRun(
          repo,
          branches,
          workspace
        );
        return (
          activityAtMs !== null &&
          deps.now() - activityAtMs < MODELING_STAGING_ACTIVITY_TTL_MS &&
          (workspace.waitStartedAtMs === undefined ||
            deps.now() - workspace.waitStartedAtMs <
              MODELING_STAGING_ACTIVITY_TTL_MS)
        );
      } catch {
        return false;
      }
    }
  };
}
