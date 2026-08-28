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
import type { GraphProgressView } from "../shared.js";
import type { AppSourceEvaluation } from "@radius-project/core";
import type { MissingModelHandoffClaims } from "./missing-model-handoff-claims.js";
import { GRAPH_APP_BICEP_IDLE_TIMEOUT_MS } from "../graph-progress-contract.js";

export interface AppModelHandoffRequest {
  repo: string;
  // Branches the view about to render reads from. One for the graph and planned
  // views, two for a diff. Empty or falsy entries are dropped.
  branches: ReadonlyArray<string | undefined>;
  page: string;
  progressView?: GraphProgressView;
  // The canvas instance's state: the branch context the readers resolve against,
  // the latest request for cancellation, and delivered handoffs keyed by target.
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
  send(message: HandoffMessage): Promise<void>;
  // True when a modeling run targeting these branches is already under way. The
  // handoff is abandoned rather than deferred when it is: the routes re-report
  // on every render, so a run that dies is asked about again.
  modelingInFlight(
    repo: string,
    branches: ReadonlyArray<string>,
    context: CanvasState,
    waitStartedAtMs?: number
  ): Promise<boolean>;
  // Injected so the grace window below is driven by a fake clock in tests, and
  // so nothing here owns a timer.
  wait(ms: number): Promise<void>;
  log(message: string): void;
  // False once the same staleness evidence has already been handed off. Owned by
  // the caller so the memo outlives any single canvas instance.
  shouldRequestRefresh(key: string): boolean;
  // Releases an extension-scoped refresh memo entry. Called when delivery fails
  // so a later attempt can re-deliver the same staleness signal.
  releaseRefreshMemo(key: string): void;
  missingModelHandoffs: MissingModelHandoffClaims;
}

export type AppModelHandoff = (
  request: AppModelHandoffRequest
) => Promise<void>;

// How long a render that found no model waits to see whether something else is
// already generating one before it asks the agent to.
//
// The render that raises the handoff usually happens BEFORE either in-flight
// signal exists: the agent opens the canvas, the graph route reports the model
// missing, and only then does the agent reach for radius_generate_app. Probing
// once at that instant would therefore observe nothing and ask anyway, which is
// exactly the duplicate this gate exists to prevent. The window spans the gap
// between the render and the tool call, which is one agent decision long.
//
// Waiting costs nothing that the user sees. The handoff is fire-and-forget and
// never blocks the HTTP response, the view keeps polling and renders the model
// in place whenever it appears, and a handoff is only ever a request for work
// that has not started.
export const MODELING_GRACE_WINDOW_MS = 15000;
export const MODELING_GRACE_POLL_MS = 1000;
const RECOVERY_WINDOW_MS = 60_000;

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
        origin?.skillVersion ?? "",
        origin ? "" : status.freshness.appBicepHash,
        status.freshness.requiresConfirmation ? "confirm" : "auto"
      ].join("/");
    })
  ].join("::");
}

export function createAppModelHandoff(
  deps: AppModelHandoffDependencies
): AppModelHandoff {
  const targetKey = (repo: string, branches: ReadonlyArray<string>): string =>
    `${repo}::${branches.join(",")}`;

  // Polls for an in-flight modeling run across the grace window. Answers true
  // as soon as one is observed, so the common case where the agent starts
  // generating immediately costs one extra poll rather than the whole window.
  async function modelingClaimedIt(
    repo: string,
    branches: ReadonlyArray<string>,
    context: CanvasState,
    waitStartedAtMs?: number
  ): Promise<boolean> {
    for (let waitedMs = 0; ; waitedMs += MODELING_GRACE_POLL_MS) {
      if (
        await deps.modelingInFlight(repo, branches, context, waitStartedAtMs)
      ) {
        return true;
      }
      if (waitedMs >= MODELING_GRACE_WINDOW_MS) return false;
      await deps.wait(MODELING_GRACE_POLL_MS);
    }
  }

  return async function handOffAppModel({
    repo,
    branches,
    page,
    progressView,
    state
  }: AppModelHandoffRequest): Promise<void> {
    if (!repo) return;
    const targets = branches.filter((branch): branch is string =>
      Boolean(branch)
    );
    if (!targets.length) return;
    const context = state ?? (await deps.resolveContext());
    const modelProgressView =
      progressView ?? (page === "graph-diff" ? "diff" : "graph");
    const waitStartedAtMs =
      context.graphProgressRecords?.[modelProgressView]
        ?.graphProgressStartedAtMs;
    const recoveryDeadlineAtMs =
      waitStartedAtMs === undefined ? undefined : (
        waitStartedAtMs + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - RECOVERY_WINDOW_MS
      );
    const target = targetKey(repo, targets);
    // Capture only the claim that existed before status resolution began. If
    // this read later reports a model, releasing that token cannot erase a
    // newer missing-model owner that started while the read was in flight.
    const observedClaim = deps.missingModelHandoffs.current(target);

    // resolveStatus absorbs every read failure into a "missing" classification,
    // so a rejection here means the reader itself is broken. Letting it
    // propagate abandons the handoff rather than acting on a half-resolved
    // picture; every caller invokes this fire-and-forget.
    const statuses = await Promise.all(
      targets.map((branch) => deps.resolveStatus(repo, branch, context))
    );
    const key = appModelHandoffKey(repo, targets, statuses);
    if (state?.appBicepHandoffKeys?.[target] === key) return;

    const reserveState = (): void => {
      if (!state) return;
      state.appBicepHandoffKeys ??= {};
      state.appBicepHandoffKeys[target] = key;
      state.appBicepHandoffKey = key;
    };
    const ownsStateReservation = (): boolean =>
      state === undefined ||
      (state.appBicepHandoffKeys?.[target] === key &&
        state.appBicepHandoffKey === key);
    const releaseStateReservation = (): void => {
      if (state?.appBicepHandoffKeys?.[target] === key) {
        delete state.appBicepHandoffKeys[target];
      }
      if (state?.appBicepHandoffKey === key) {
        delete state.appBicepHandoffKey;
      }
    };

    const present = statuses.filter(
      (status) => status.freshness.status !== "missing"
    );

    if (!present.length) {
      // Claim extension-wide before consuming the per-panel reservation. A
      // reopened panel that loses this claim must remain free to retry if the
      // owner later abandons delivery.
      const claim = deps.missingModelHandoffs.claim(
        target,
        key,
        recoveryDeadlineAtMs
      );
      if (!claim) return;
      reserveState();
      const ownsReservation = (): boolean =>
        ownsStateReservation() && deps.missingModelHandoffs.owns(claim);
      const releaseReservation = (): void => {
        releaseStateReservation();
        deps.missingModelHandoffs.release(claim);
      };

      // Reserve the key before the asynchronous source probe. Modeled, Planned,
      // and Diff can all discover the same missing model together; without this
      // reservation they each pass the check above while the first probe is in
      // flight and send duplicate authoring turns.
      let sources: AppSourceEvaluation[];
      try {
        sources = await Promise.all(
          targets.map((branch) => deps.evaluateSource(repo, branch, context))
        );
      } catch (error) {
        releaseReservation();
        throw error;
      }
      // The modeling skill cannot author this repository at all. Deliberately
      // does NOT consume the key: adding a Dockerfile later must make the next
      // render eligible for the handoff.
      if (sources.every((source) => source.status === "none")) {
        releaseReservation();
        return;
      }
      if (!ownsReservation()) {
        releaseReservation();
        return;
      }

      // Nobody is generating this model yet as far as one probe can tell, but
      // the agent that just opened this view may be about to start. Watch for
      // that before speaking, and abandon the handoff if it happens.
      let claimed: boolean;
      try {
        claimed = await modelingClaimedIt(
          repo,
          targets,
          context,
          waitStartedAtMs
        );
      } catch (error) {
        releaseReservation();
        throw error;
      }
      if (claimed || !ownsReservation()) {
        // Deliberately does NOT consume the key: if the run it deferred to dies
        // without publishing, the next render must be free to ask again.
        releaseReservation();
        return;
      }

      // The window is long enough for a run to have both started and finished
      // inside it, so the classification this handoff was built from has to be
      // re-read before it is acted on.
      let settled: AppModelStatus[];
      try {
        settled = await Promise.all(
          targets.map((branch) => deps.resolveStatus(repo, branch, context))
        );
      } catch (error) {
        releaseReservation();
        throw error;
      }
      if (!ownsReservation()) {
        releaseReservation();
        return;
      }
      if (settled.some((status) => status.freshness.status !== "missing")) {
        releaseReservation();
        return;
      }

      try {
        await deps.send(
          appBicepHandoffMessage(repo, page, targets, state?.canvasInstanceId)
        );
      } catch (sendError) {
        releaseReservation();
        throw sendError;
      }
      // send() resolves when the handoff is queued, not when the queued turn
      // runs. Keep the extension claim until its bounded expiry, while clearing
      // the panel reservation so this same view can retry after that expiry.
      deps.missingModelHandoffs.markDelivered(claim);
      releaseStateReservation();
      return;
    }

    if (observedClaim) deps.missingModelHandoffs.release(observedClaim);
    reserveState();

    // Checked before plain staleness: a model this extension cannot prove it
    // generated needs the user's agreement, because regenerating it destroys
    // whatever they wrote by hand.
    const unverified = present.find(
      (status) => status.refreshable && status.freshness.requiresConfirmation
    );
    if (unverified) {
      const refreshKey = refreshRequestKey(unverified);
      if (!deps.shouldRequestRefresh(refreshKey)) {
        releaseStateReservation();
        return;
      }
      try {
        await deps.send(appModelUnverifiedMessage(unverified));
      } catch (sendError) {
        releaseStateReservation();
        deps.releaseRefreshMemo(refreshKey);
        throw sendError;
      }
      return;
    }

    const outdated = present.find(
      (status) => status.refreshable && status.freshness.stale
    );
    if (outdated) {
      const refreshKey = refreshRequestKey(outdated);
      if (!deps.shouldRequestRefresh(refreshKey)) {
        releaseStateReservation();
        return;
      }
      try {
        await deps.send(appModelRefreshMessage(outdated));
      } catch (sendError) {
        releaseStateReservation();
        deps.releaseRefreshMemo(refreshKey);
        throw sendError;
      }
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
