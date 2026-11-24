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

import { randomUUID } from "node:crypto";
import {
  appBicepHandoffMessage,
  appModelRadiusCliOutdatedNotice,
  appModelSkillHandoffFailureNotice,
  appModelRefreshMessage,
  appModelStaleNotice,
  appModelUnverifiedMessage,
  refreshRequestKey
} from "./hooks.js";
import type { HandoffMessage } from "./hooks.js";
import type { AppModelStatus } from "./graph-context.js";
import type { CanvasState } from "../shared.js";
import type { GraphProgressView } from "../shared.js";
import {
  appAuthoringRequired,
  findAppModelRefresh,
  hasModelableSource,
  type AppSourceEvaluation
} from "@radius-project/core";
import { WorkspaceGraphBranchChanged } from "@radius-project/adapter-shared";
import type { MissingModelHandoffClaims } from "./missing-model-handoff-claims.js";
import { missingModelHandoffTarget } from "./missing-model-handoff-claims.js";
import { GRAPH_APP_BICEP_IDLE_TIMEOUT_MS } from "../graph-progress-contract.js";
import { appModelTargetKey } from "../app-model-authoring-failure.js";
import { errorMessage } from "./util.js";
import type { createCanvasModelAuthoring } from "./canvas-model-authoring.js";

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
  // Answers whether the render that raised this handoff is still the one on
  // screen. The handoff probes sources and waits out a grace window before it
  // speaks, and the user can change the selection throughout: without this the
  // work started by an abandoned render still mints attempt tokens and asks the
  // agent to model branches nobody is looking at.
  isCurrent?: () => boolean;
  environmentKey?: string;
}

export interface AppModelHandoffDependencies {
  beginManaged: ReturnType<typeof createCanvasModelAuthoring>["begin"];
  cancelManaged(token: string): void;
  // Branch context to read against when no panel state was supplied. Without it
  // the workspace repository would be judged from its remote instead of the
  // worktree the canvas actually renders.
  resolveContext(): Promise<CanvasState>;
  resolveStatus(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppModelStatus>;
  assertWorkspaceSource(source: AppModelStatus["source"]): Promise<void>;
  authorizeMissingModel(
    page: string,
    state: CanvasState | undefined,
    statuses: readonly AppModelStatus[]
  ): void;
  // Consulted only when no branch has a model, because a model that already
  // exists answers "can this repository be modeled" by existing.
  evaluateSource(
    repo: string,
    branch: string,
    state: CanvasState
  ): Promise<AppSourceEvaluation>;
  send(message: HandoffMessage): Promise<void>;
  // The radius-app-bicep skill bootstrap, the same JSON radius_generate_app
  // returns. Each modeling handoff embeds it, so the agent starts the skill
  // without finding and calling the tool. A rejection abandons the handoff the
  // same way a failed send does.
  skillHandoff(): Promise<string>;
  // Source evidence for one branch, captured when an attempt starts so the
  // failure it may report is compared with the source the agent modeled. An
  // empty answer or an error means unknown.
  readSourceRevision(
    repo: string,
    branch: string,
    context: CanvasState
  ): Promise<string>;
  // True when a modeling run targeting these branches is already under way. The
  // handoff is abandoned rather than deferred when it is: the routes re-report
  // on every render, so a run that dies is asked about again.
  modelingInFlight(
    repo: string,
    branches: ReadonlyArray<string>,
    context: CanvasState,
    waitStartedAtMs?: number
  ): Promise<boolean>;
  // Records that a modeling run was requested for these branches, so a later
  // render of an overlapping view, such as a diff that includes one of them,
  // waits for that run instead of asking again. The agent never calls
  // radius_generate_app for a run the Canvas requests, so nothing else records
  // it before the run creates its staging directory.
  announceModelingRun(repo: string, branches: ReadonlyArray<string>): void;
  // Injected so the grace window below is driven by a fake clock in tests, and
  // so nothing here owns a timer.
  wait(ms: number): Promise<void>;
  log(message: string): void;
  // Returns a release function for this exact claim, or undefined if the same
  // staleness evidence is already reserved or delivered across Canvas instances.
  claimRefreshMemo(key: string): (() => void) | undefined;
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
        origin?.radiusVersion ?? "",
        origin ? "" : status.freshness.appBicepHash,
        status.freshness.requiresConfirmation ? "confirm" : "auto"
      ].join("/");
    })
  ].join("::");
}

export function createAppModelHandoff(
  deps: AppModelHandoffDependencies
): AppModelHandoff {
  const targetKey = missingModelHandoffTarget;

  // The skill handoff failure last shown to the user. Every graph poll retries
  // a handoff that failed, so the same failure is shown once, and again only
  // after a success or a different failure.
  let reportedSkillHandoffFailure: string | undefined;
  async function buildSkillHandoff(): Promise<string> {
    try {
      const skillHandoff = await deps.skillHandoff();
      reportedSkillHandoffFailure = undefined;
      return skillHandoff;
    } catch (error) {
      const detail = errorMessage(error);
      if (detail !== reportedSkillHandoffFailure) {
        reportedSkillHandoffFailure = detail;
        deps.log(appModelSkillHandoffFailureNotice(detail));
      }
      throw error;
    }
  }

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
    state,
    isCurrent,
    environmentKey
  }: AppModelHandoffRequest): Promise<void> {
    if (!repo) return;
    const stillCurrent = (): boolean => isCurrent === undefined || isCurrent();
    const targets = branches.filter((branch): branch is string =>
      Boolean(branch)
    );
    if (!targets.length) return;
    const context = state ? { ...state } : await deps.resolveContext();
    const modelProgressView =
      progressView ?? (page === "graph-diff" ? "diff" : "graph");
    // The app.bicep wait is measured from when the model was first found
    // missing, not from when the graph build began, so the recovery deadline
    // has to share that origin to land inside the wait it belongs to. The
    // field is absent on the very first render, because the wait is only
    // recorded once the outcome settles; the claim then falls back to its
    // ordinary TTL, which is the same length the deadline would have imposed.
    const waitStartedAtMs = (state ?? context).graphProgressRecords?.[
      modelProgressView
    ]?.graphProgressWaitStartedAtMs;
    const recoveryDeadlineAtMs =
      waitStartedAtMs === undefined ? undefined : (
        waitStartedAtMs + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - RECOVERY_WINDOW_MS
      );
    const target = targetKey(repo, targets);
    // Capture only the claim that existed before status resolution began. If
    // this read later reports a model, releasing that token cannot erase a
    // newer missing-model owner that started while the read was in flight.
    const observedClaim = deps.missingModelHandoffs.current(target);

    // Unavailable workspace evidence abandons the handoff rather than allowing
    // regeneration from a partially resolved model or a changed checkout.
    async function resolveStatuses() {
      try {
        return await Promise.all(
          targets.map((branch) => deps.resolveStatus(repo, branch, context))
        );
      } catch (error) {
        if (!(error instanceof WorkspaceGraphBranchChanged)) throw error;
        return null;
      }
    }
    async function sourcesStillCurrent(statuses: AppModelStatus[]) {
      try {
        for (const status of statuses)
          await deps.assertWorkspaceSource(status.source);
        return true;
      } catch (error) {
        if (!(error instanceof WorkspaceGraphBranchChanged)) throw error;
        return false;
      }
    }
    const statuses = await resolveStatuses();
    if (!statuses || !stillCurrent()) return;
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

    if (appAuthoringRequired(statuses)) {
      deps.authorizeMissingModel(page, state, statuses);
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
      if (!hasModelableSource(sources)) {
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
      let settled: AppModelStatus[] | null;
      try {
        settled = await resolveStatuses();
      } catch (error) {
        releaseReservation();
        throw error;
      }
      if (!ownsReservation()) {
        releaseReservation();
        return;
      }
      if (!settled || !appAuthoringRequired(settled)) {
        releaseReservation();
        return;
      }
      let skillHandoff: string;
      try {
        deps.authorizeMissingModel(page, state, settled);
        skillHandoff = await buildSkillHandoff();
      } catch (error) {
        releaseReservation();
        throw error;
      }
      // Read before the attempt token exists, so an edit saved while the agent
      // models is newer than this baseline and a later render can retry it.
      const sourceRevisions = await Promise.all(
        targets.map((branch) =>
          deps.readSourceRevision(repo, branch, context).catch(() => "")
        )
      );
      // Last check before this handoff becomes observable. Everything above is
      // reversible; minting the tokens and sending the turn are not, and both
      // the source probe and the grace window gave the user time to move on.
      let currentSources;
      try {
        currentSources = await sourcesStillCurrent(settled);
      } catch (error) {
        releaseReservation();
        throw error;
      }
      if (!currentSources || !stillCurrent() || !ownsReservation()) {
        releaseReservation();
        return;
      }

      // One token per attempt, recorded under every branch the attempt covers.
      // A diff hands off two branches at once and deliberately reuses this
      // single-branch fencing protocol — an attempt token and a recorded
      // failure are always keyed `repo::branch` — rather than gaining a second,
      // two-branch protocol that could disagree with the first.
      const attemptToken = state?.canvasInstanceId ? randomUUID() : undefined;
      if (state && attemptToken) {
        state.appModelAttemptTokens ??= {};
        state.appModelAttemptClaims ??= {};
        state.appModelAttemptEnvironments ??= {};
        state.appModelAttemptSourceRevisions ??= {};
        for (const [index, branch] of targets.entries()) {
          const tokenKey = appModelTargetKey(repo, branch);
          state.appModelAttemptTokens[tokenKey] = attemptToken;
          state.appModelAttemptClaims[tokenKey] = claim;
          state.appModelAttemptEnvironments[tokenKey] = environmentKey ?? "";
          const sourceRevision = sourceRevisions[index];
          if (sourceRevision) {
            state.appModelAttemptSourceRevisions[tokenKey] = sourceRevision;
          } else {
            delete state.appModelAttemptSourceRevisions[tokenKey];
          }
        }
      }
      try {
        const branch = targets[0];
        if (
          page === "graph" &&
          targets.length === 1 &&
          branch &&
          state &&
          attemptToken &&
          settled[0]?.source.kind === "workspace"
        ) {
          skillHandoff = deps.beginManaged(
            state,
            repo,
            branch,
            attemptToken,
            sourceRevisions[0],
            skillHandoff,
            stillCurrent
          );
        }
        await deps.send(
          appBicepHandoffMessage(
            repo,
            skillHandoff,
            page,
            targets,
            state?.canvasInstanceId,
            attemptToken && state?.canvasInstanceId ?
              {
                attemptToken,
                instanceId: state.canvasInstanceId,
                branches: targets
              }
            : undefined
          )
        );
      } catch (sendError) {
        if (state && attemptToken) {
          deps.cancelManaged(attemptToken);
          for (const branch of targets) {
            const tokenKey = appModelTargetKey(repo, branch);
            if (state.appModelAttemptTokens?.[tokenKey] === attemptToken) {
              delete state.appModelAttemptTokens[tokenKey];
              delete state.appModelAttemptClaims?.[tokenKey];
              delete state.appModelAttemptEnvironments?.[tokenKey];
              delete state.appModelAttemptSourceRevisions?.[tokenKey];
            }
          }
        }
        releaseReservation();
        throw sendError;
      }
      // send() resolves when the handoff is queued, not when the queued turn
      // runs. Keep the extension claim until its bounded expiry, while clearing
      // the panel reservation so this same view can retry after that expiry.
      deps.missingModelHandoffs.markDelivered(claim);
      deps.announceModelingRun(repo, targets);
      releaseStateReservation();
      return;
    }

    if (observedClaim) deps.missingModelHandoffs.release(observedClaim);
    reserveState();
    const present = statuses.filter(
      (status) => status.freshness.status !== "missing"
    );

    // A Radius CLI older than the one that generated the model is reported,
    // never refreshed: the skill cannot regenerate with it, and a regeneration
    // that could would move a shared model back to older types. Logged before
    // any refresh below, which may return early. A panel logs it once per
    // situation, because the key reserved above stops its repeat renders here.
    for (const status of present) {
      if (status.freshness.status === "radius-cli-outdated") {
        deps.log(appModelRadiusCliOutdatedNotice(status));
      }
    }

    // Checked before plain staleness: a model this extension cannot prove it
    // generated needs the user's agreement, because regenerating it destroys
    // whatever they wrote by hand.
    const comparison = page === "graph-diff" || targets.length > 1;
    const refresh = comparison ? undefined : findAppModelRefresh(present);
    if (refresh) {
      const { model } = refresh;
      const refreshKey = refreshRequestKey(model);
      let releaseMemo: (() => void) | undefined;
      let attemptToken: string | undefined;
      const tokenKey = appModelTargetKey(repo, model.branch);
      const releaseRefresh = (): void => {
        if (!attemptToken) {
          releaseStateReservation();
        } else {
          const tokens = state?.appModelAttemptTokens;
          if (tokens?.[tokenKey] === attemptToken) {
            delete tokens[tokenKey];
            releaseStateReservation();
          }
        }
        releaseMemo?.();
        releaseMemo = undefined;
      };
      try {
        if (
          !(await sourcesStillCurrent([model])) ||
          !stillCurrent() ||
          !ownsStateReservation() ||
          !(releaseMemo = deps.claimRefreshMemo(refreshKey))
        ) {
          releaseStateReservation();
          return;
        }
        let skillHandoff = await buildSkillHandoff();
        if (!stillCurrent() || !ownsStateReservation()) {
          releaseRefresh();
          return;
        }
        if (refresh.kind === "confirmation") {
          await deps.send(appModelUnverifiedMessage(model, skillHandoff));
        } else {
          if (state?.canvasInstanceId && model.source.kind === "workspace") {
            const revision = await deps.readSourceRevision(
              repo,
              model.branch,
              context
            );
            const latest = await deps.resolveStatus(
              repo,
              model.branch,
              context
            );
            if (
              !(await sourcesStillCurrent([latest])) ||
              !stillCurrent() ||
              !ownsStateReservation() ||
              latest.source.kind !== "workspace" ||
              state.workspacePath !== context.workspacePath ||
              latest.freshness.appBicepHash !== model.freshness.appBicepHash ||
              findAppModelRefresh([latest])?.kind !== "refresh" ||
              refreshRequestKey(latest) !== refreshKey
            ) {
              releaseRefresh();
              return;
            }
            attemptToken = randomUUID();
            state.appModelAttemptTokens ??= {};
            state.appModelAttemptTokens[tokenKey] = attemptToken;
            delete state.appModelAttemptClaims?.[tokenKey];
            delete state.appModelAttemptEnvironments?.[tokenKey];
            delete state.appModelAttemptSourceRevisions?.[tokenKey];
            skillHandoff = deps.beginManaged(
              state,
              repo,
              model.branch,
              attemptToken,
              revision,
              skillHandoff,
              stillCurrent,
              releaseRefresh
            );
          }
          await deps.send(appModelRefreshMessage(model, skillHandoff));
        }
      } catch (error) {
        try {
          if (attemptToken) deps.cancelManaged(attemptToken);
        } finally {
          releaseRefresh();
        }
        throw error;
      }
      return;
    }

    // Stale on a branch modeling is not allowed to rewrite. Refreshing it would
    // need a commit and a push, so there is nothing to hand off — say it drifted
    // and stop.
    for (const status of present) {
      if (status.freshness.stale && (comparison || !status.refreshable)) {
        deps.log(appModelStaleNotice(status, comparison));
      }
    }
  };
}
