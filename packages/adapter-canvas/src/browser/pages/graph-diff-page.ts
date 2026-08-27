import { requireBrowserFunction } from "../globals.js";
import { asGraphController } from "../graph/surface.js";
import { clearGraphProgress, createGraphProgress } from "../graph/progress.js";
import { githubRepositoryUrl } from "../graph/model.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { readArray, readBoolean, readNumber, readString } from "../json.js";
import { populateApplications, populateDiffBranches } from "../repositories.js";
import type { BrowserTeardown, ScopeTimer } from "../lifecycle.js";
import type { GraphController } from "../graph/surface.js";
import type { GraphProgressView } from "../graph/progress.js";
import type {
  AbortHandle,
  BrowserContext,
  DomSelectElement
} from "../ports.js";
import { readPageState } from "./state.js";
import {
  showGraphModelingFailure,
  unsupportedGraphModelMessage
} from "./graph-modeling-failure.js";

const ENTRY_KEY = "graph-diff-page";
export const GRAPH_DIFF_STATE_ID = "radius-graph-diff-state";
export const DIFF_DEBOUNCE_MS = 500;
export const DIFF_PROGRESS_MS = 800;
// How long to wait before asking again while Copilot authors the model. The
// server decides when the wait has run out and answers with an error instead of
// `needsAppBicep`, which ends the loop.
export const DIFF_RETRY_MS = 10_000;
export const DIFF_PROGRESS_STEPS_ID = "diff-progress-steps";

interface DiffState {
  repo: string;
  base: string;
  head: string;
  workspaceBranch: string;
  resources: unknown[];
  modelingError: string;
}

function parseState(context: BrowserContext): DiffState {
  const state = readPageState(context, GRAPH_DIFF_STATE_ID);
  return {
    repo: readString(state, "repo"),
    base: readString(state, "base") || "main",
    head: readString(state, "head"),
    workspaceBranch: readString(state, "workspaceBranch"),
    resources: readArray(state, "resources"),
    modelingError: readString(state, "modelingError")
  };
}

function showStatus(
  context: BrowserContext,
  message: string,
  tone: "info" | "error"
): void {
  const status = context.dom.byId("diff-status");
  if (!status) return;
  status.style.display = "";
  status.className = `status ${tone}`;
  status.textContent = message;
}

export function initializeGraphDiffPage(
  context: BrowserContext,
  globalScope: unknown
): BrowserTeardown {
  const stateElement = context.dom.byId(GRAPH_DIFF_STATE_ID);
  if (!stateElement) return NOOP_TEARDOWN;
  const state = parseState(context);
  const renderGraph =
    state.resources.length > 0 ?
      requireBrowserFunction(globalScope, "radiusRenderGraph")
    : null;
  const setError = requireBrowserFunction(globalScope, "radiusSetGraphError");
  const entry = beginEntry(context, ENTRY_KEY);
  if (!entry) return NOOP_TEARDOWN;
  const baseSelect = context.dom.selectById("base-branch");
  const headSelect = context.dom.selectById("head-branch");
  const repoInput = context.dom.inputById("diff-repo-select");
  let generation = 0;
  let pending: ScopeTimer | null = null;
  let requestAbort: AbortHandle | null = null;
  let controller: GraphController | null = null;
  let progress: ScopeTimer | null = null;
  let progressView: GraphProgressView | null = null;
  let appBicepRetry: ScopeTimer | null = null;
  let initialRefresh = state.resources.length > 0;
  let restartWait = true;

  const stopAppBicepRetry = (): void => {
    if (appBicepRetry !== null) entry.cancel(appBicepRetry);
    appBicepRetry = null;
  };
  let modelingFailureVisible = Boolean(state.modelingError);
  const showModelingFailure = (message: string): void => {
    controller?.destroy();
    controller = null;
    showGraphModelingFailure(context, setError, message, {
      containerId: "graph-container",
      statusIds: ["diff-status"],
      staleContentIds: ["graph-diff-summary"]
    });
    modelingFailureVisible = true;
  };
  if (state.modelingError) showModelingFailure(state.modelingError);

  const stopProgress = (): void => {
    if (progress !== null) entry.cancel(progress);
    progress = null;
    progressView?.stop();
    progressView = null;
    // The page states a terminal outcome in its own error surface, so a frozen
    // panel left underneath would repeat it as a second box.
    clearGraphProgress(context, DIFF_PROGRESS_STEPS_ID);
  };

  const pollProgress = (
    requestGeneration: number,
    view: GraphProgressView
  ): void => {
    void context.net
      .fetch("/api/progress?view=diff")
      .then((response) => response.json())
      .then((payload) => {
        if (!entry.active || requestGeneration !== generation) return;
        const events = readArray(payload, "events");
        if (events.length > 0) {
          view.sync(
            events,
            readNumber(payload, "generation") ?? 0,
            readNumber(payload, "elapsedMs")
          );
        }
      })
      .catch((error: unknown) => {
        if (!entry.active || requestGeneration !== generation) return;
        context.logger.error("Radius graph diff progress failed.", error);
      });
  };

  const compare = (
    headElement: DomSelectElement,
    refresh = state.resources.length > 0
  ): void => {
    pending = null;
    stopAppBicepRetry();
    const base = baseSelect?.value ?? "";
    const head = headElement.value;
    const repo = repoInput?.value ?? state.repo;
    const restartExpiredWait = restartWait;
    restartWait = false;
    if (!repo || !base || !head) return;
    if (modelingFailureVisible) {
      const graphContainer = context.dom.byId("graph-container");
      if (graphContainer) graphContainer.innerHTML = "";
      const summary = context.dom.byId("graph-diff-summary");
      if (summary) summary.style.display = "";
      modelingFailureVisible = false;
    }
    const requestGeneration = ++generation;
    requestAbort = context.net.createAbort();
    showStatus(context, `Comparing ${base} → ${head}…`, "info");
    stopProgress();
    const view = createGraphProgress(context, entry, {
      hostId: DIFF_PROGRESS_STEPS_ID,
      title: "Comparing application graphs",
      initial: {
        sequence: 0,
        stage: "building_base_graph",
        state: "running",
        detail: `Comparing ${base} → ${head}…`
      }
    });
    progressView = view;
    // Poll once immediately rather than waiting a full interval. A build that is
    // already in flight — one this page did not start, or one it started before
    // the user navigated away — is adopted straight away instead of showing an
    // empty panel reading 0:00 until the first tick.
    pollProgress(requestGeneration, view);
    progress = entry.every(DIFF_PROGRESS_MS, () =>
      pollProgress(requestGeneration, view)
    );
    void context.net
      .fetch("/api/diff-branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base,
          head,
          repo,
          refresh,
          restartWait: restartExpiredWait
        }),
        signal: requestAbort?.signal
      })
      .then((response) => response.json())
      .then((payload) => {
        if (requestGeneration !== generation) return;
        stopProgress();
        const unsupported = unsupportedGraphModelMessage(payload);
        if (unsupported) {
          showModelingFailure(unsupported);
        } else if (readBoolean(payload, "needsAppBicep")) {
          showStatus(
            context,
            "Copilot is generating .radius/app.bicep with the Radius app-bicep skill… the diff will appear once it is saved.",
            "info"
          );
          // Nothing announces the model's arrival, so the diff only learns by
          // asking again. Without this the page reported the wait once and then
          // sat there permanently, even after the model landed.
          appBicepRetry = entry.after(DIFF_RETRY_MS, () => {
            appBicepRetry = null;
            compare(headElement, refresh);
          });
        } else {
          const error = readString(payload, "error");
          if (error) {
            if (readBoolean(payload, "modelingFailed")) {
              showModelingFailure(error);
            } else {
              showStatus(
                context,
                `Error computing diff: ${error}. Please ensure both branches exist and contain a valid .radius/app.bicep.`,
                "error"
              );
            }
          } else if (readBoolean(payload, "reload")) {
            context.nav.reload();
          } else if (readBoolean(payload, "refreshed")) {
            showStatus(context, "The graph comparison is current.", "info");
          } else {
            const message = readString(payload, "message");
            if (message) showStatus(context, message, "info");
          }
        }
      })
      .catch((error: unknown) => {
        if (!entry.active || requestGeneration !== generation) return;
        stopProgress();
        context.logger.error("Radius graph diff request failed.", error);
        showStatus(
          context,
          "Failed to compute diff. Please verify network connectivity and that .radius/app.bicep is valid on both branches.",
          "error"
        );
      })
      .then(() => {
        if (requestGeneration === generation) requestAbort = null;
      });
  };

  const queue = (headElement: DomSelectElement): void => {
    generation++;
    requestAbort?.abort();
    requestAbort = null;
    stopAppBicepRetry();
    stopProgress();
    if (pending !== null) entry.cancel(pending);
    restartWait = true;
    const refresh = initialRefresh;
    initialRefresh = false;
    pending = entry.after(DIFF_DEBOUNCE_MS, () =>
      compare(headElement, refresh)
    );
  };

  if (headSelect) {
    entry.on(headSelect, "change", () => queue(headSelect));
    if (baseSelect) {
      entry.on(baseSelect, "change", () => {
        if (headSelect.value) queue(headSelect);
      });
    }
  }

  void populateApplications(context, state.repo, "diff-app");
  void populateDiffBranches(context, state.repo, {
    preferBase: state.base,
    preferHead: state.head,
    autoCompare: !state.modelingError,
    lifecycle: entry
  });

  if (renderGraph && !state.modelingError) {
    controller = asGraphController(
      renderGraph("graph-container", state.resources, {
        diffMode: true,
        repoUrl: githubRepositoryUrl(state.repo),
        branch: state.head,
        baseBranch: state.base,
        // A diff renders two branches at once and the worktree holds at most
        // one of them, so locality is decided per node rather than for the
        // page. Without this every node links to github.com, which resolves to
        // nothing when the compared branch was never pushed.
        workspaceBranch: state.workspaceBranch
      })
    );
  }

  entry.onTeardown(() => {
    generation++;
    requestAbort?.abort();
    requestAbort = null;
    controller?.destroy();
    controller = null;
  });
  return () => entry.teardown();
}
