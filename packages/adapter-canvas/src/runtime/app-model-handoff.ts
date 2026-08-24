// The one place that decides what to say about a branch's application model.
//
// Four call sites used to discover independently that `.radius/app.bicep` was
// missing or stale — a pre-tool-use hook on `open_canvas`, a second hook on the
// pull-request diff tool, a canvas-open fallback, and the graph HTTP routes —
// and each could raise its own authoring turn for the same model. The routes are
// the only one of those that every render passes through (a tool-driven open, a
// direct panel open, a programmatic reload, the refresh button, plan-graph and
// the diff), and they already narrate the wait through the graph progress
// stages, so they own the decision now and everything else was removed.
//
// This module holds the classification itself, kept free of the SDK and of HTTP
// so it can be tested directly: given a repo, its branches and the injected
// readers, it resolves each branch's model status and sends at most one message.

import {
  appBicepHandoffMessage,
  appModelRefreshMessage,
  appModelStaleNotice,
  appModelUnverifiedMessage,
  refreshRequestKey
} from "./hooks.js";
import type { HandoffMessage } from "./hooks.js";
import type { AppModelStatus } from "./graph-context.js";
import type { CanvasState } from "../shared.js";
import type { AppSourceEvaluation } from "@radius-project/core";

export interface AppModelHandoffRequest {
  repo: string;
  // Branches the view about to render reads from. One for the graph and planned
  // views, two for a diff. Empty or falsy entries are dropped.
  branches: ReadonlyArray<string | undefined>;
  page: string;
  // The canvas instance's state: the branch context the readers resolve against,
  // and the carrier of the last handoff key. Absent when no panel is open, in
  // which case the workspace context is resolved fresh and nothing is
  // deduplicated per panel.
  state?: CanvasState;
}

export interface AppModelHandoffDependencies {
  // Branch context to read against when no panel state was supplied. Without it
  // the workspace repository would be judged from its remote instead of the
  // worktree the canvas actually renders.
  resolveContext(): Promise<CanvasState>;
  resolveStatus(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppModelStatus>;
  // Consulted only when no branch has a model, because a model that already
  // exists answers "can this repository be modeled" by existing.
  evaluateSource(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppSourceEvaluation>;
  send(message: HandoffMessage): void;
  log(message: string): void;
  // False once the same staleness evidence has already been handed off. Owned by
  // the caller so the memo outlives any single canvas instance.
  shouldRequestRefresh(key: string): boolean;
}

export type AppModelHandoff = (
  request: AppModelHandoffRequest
) => Promise<void>;

// Identifies one repo+branches situation *including what is wrong with it*, not
// merely which branches were looked at. A model that changes from stale to
// hand-edited between two renders is therefore still reported the second time,
// while an unchanged situation is reported once.
export function appModelHandoffKey(
  repo: string,
  branches: ReadonlyArray<string>,
  statuses: ReadonlyArray<AppModelStatus>
): string {
  return [
    repo,
    branches.join(","),
    ...statuses.map((status) => {
      const origin = status.freshness.origin;
      return [
        status.branch,
        status.freshness.status,
        status.refreshable ? "local" : "remote",
        origin?.sourceCommit ?? "",
        origin?.skillVersion ?? ""
      ].join("/");
    })
  ].join("::");
}

export function createAppModelHandoff(
  deps: AppModelHandoffDependencies
): AppModelHandoff {
  return async function handOffAppModel({
    repo,
    branches,
    page,
    state
  }: AppModelHandoffRequest): Promise<void> {
    if (!repo) return;
    const targets = branches.filter((branch): branch is string =>
      Boolean(branch)
    );
    if (!targets.length) return;
    const context = state ?? (await deps.resolveContext());

    // resolveStatus absorbs every read failure into a "missing" classification,
    // so a rejection here means the reader itself is broken. Letting it
    // propagate abandons the handoff rather than acting on a half-resolved
    // picture; every caller invokes this fire-and-forget.
    const statuses = await Promise.all(
      targets.map((branch) => deps.resolveStatus(repo, branch, context))
    );
    const key = appModelHandoffKey(repo, targets, statuses);
    if (state?.appBicepHandoffKey === key) return;

    const present = statuses.filter(
      (status) => status.freshness.status !== "missing"
    );

    if (!present.length) {
      const sources = await Promise.all(
        targets.map((branch) => deps.evaluateSource(repo, branch, context))
      );
      // The modeling skill cannot author this repository at all. Deliberately
      // does NOT consume the key: adding a Dockerfile later must make the next
      // render eligible for the handoff.
      if (sources.every((source) => source.status === "none")) return;
      if (state) state.appBicepHandoffKey = key;
      deps.send(appBicepHandoffMessage(repo, page, targets));
      return;
    }

    if (state) state.appBicepHandoffKey = key;

    // Checked before plain staleness: a model this extension cannot prove it
    // generated needs the user's agreement, because regenerating it destroys
    // whatever they wrote by hand.
    const unverified = present.find(
      (status) => status.refreshable && status.freshness.requiresConfirmation
    );
    if (unverified) {
      if (!deps.shouldRequestRefresh(refreshRequestKey(unverified))) return;
      deps.send(appModelUnverifiedMessage(unverified));
      return;
    }

    const outdated = present.find(
      (status) => status.refreshable && status.freshness.stale
    );
    if (outdated) {
      if (!deps.shouldRequestRefresh(refreshRequestKey(outdated))) return;
      deps.send(appModelRefreshMessage(outdated));
      return;
    }

    // Stale on a branch modeling is not allowed to rewrite. Refreshing it would
    // need a commit and a push, so there is nothing to hand off — say it drifted
    // and stop.
    for (const status of present) {
      if (!status.refreshable && status.freshness.stale) {
        deps.log(appModelStaleNotice(status));
      }
    }
  };
}
