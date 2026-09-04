import { requireBrowserFunction } from "../globals.js";
import { asGraphController } from "../graph/surface.js";
import { clearGraphProgress, createGraphProgress } from "../graph/progress.js";
import { githubRepositoryUrl, parseGraphResources } from "../graph/model.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import {
  isRecord,
  readArray,
  readBoolean,
  readNumber,
  readString
} from "../json.js";
import type { GraphProgressView } from "../graph/progress.js";
import {
  loadModeledEnvState,
  modeledPrimaryAction,
  populateApplications,
  populateBranches
} from "../repositories.js";
import type { BrowserTeardown, ScopeTimer } from "../lifecycle.js";
import type { GraphOptions } from "../graph/build.js";
import type { GraphResource } from "../graph/model.js";
import type { GraphController } from "../graph/surface.js";
import type { AbortHandle, BrowserContext } from "../ports.js";
import { readPageState } from "./state.js";
import {
  showGraphModelingFailure,
  unsupportedGraphModelMessage
} from "./graph-modeling-failure.js";

const ENTRY_KEY = "graph-page";
export const GRAPH_PAGE_STATE_ID = "radius-graph-page-state";
// The wait between `needsAppBicep` polls, by attempt. Copilot usually finishes
// authoring `.radius/app.bicep` within the first few seconds, so the first polls
// are cheap and fast and only a long-running model generation settles onto the
// steady-state interval. A single fixed delay made the common case pay the
// worst case: the model was already on disk while the page sat idle.
export const GRAPH_RETRY_SCHEDULE_MS: readonly number[] = Object.freeze([
  300, 1_000, 2_000, 5_000
]);
// The last entry of the schedule, which every attempt past its end reuses.
export const GRAPH_RETRY_MAX_MS =
  GRAPH_RETRY_SCHEDULE_MS[GRAPH_RETRY_SCHEDULE_MS.length - 1];
export const GRAPH_STALE_RETRY_MS = 1_000;
export const GRAPH_PROGRESS_MS = 800;

// The delay before the `attempt`-th (0-based) `needsAppBicep` retry. Attempts
// past the end of the schedule hold at its last entry, so polling never stops
// and never grows without bound. Out-of-range and non-integral inputs clamp
// rather than yielding `undefined`, because the delay feeds a timer.
export function graphRetryDelayMs(attempt: number): number {
  const index =
    Number.isFinite(attempt) ?
      Math.min(
        Math.max(Math.trunc(attempt), 0),
        GRAPH_RETRY_SCHEDULE_MS.length - 1
      )
    : 0;
  return GRAPH_RETRY_SCHEDULE_MS[index];
}
// Why the primary button is inert after a modeling failure. The graph surface
// carries the diagnostic; this only explains the disabled control.
export const GRAPH_PLAN_BLOCKED_TITLE =
  "Plan Deployment is unavailable until the application model compiles.";

interface GraphPageState {
  repo: string;
  branch: string;
  resources: GraphResource[];
  loaded: boolean;
  localSource: boolean;
  followWorkspaceBranch: boolean;
}

function parseState(context: BrowserContext): GraphPageState {
  const state = readPageState(context, GRAPH_PAGE_STATE_ID);
  return {
    repo: readString(state, "repo"),
    branch: readString(state, "branch") || "main",
    resources: parseGraphResources(readArray(state, "resources")),
    loaded: readBoolean(state, "loaded"),
    localSource: readBoolean(state, "localSource"),
    followWorkspaceBranch: readBoolean(state, "followWorkspaceBranch")
  };
}

function statusElement(context: BrowserContext) {
  return (
    context.dom.byId("graph-status") ?? context.dom.byId("graph-refresh-status")
  );
}

function showStatus(
  context: BrowserContext,
  message: string,
  tone: "info" | "error"
): void {
  const status = statusElement(context);
  if (!status) return;
  status.style.display = "";
  status.className = `status ${tone}`;
  status.textContent = message;
}

export function initializeGraphPage(
  context: BrowserContext,
  globalScope: unknown
): BrowserTeardown {
  if (!context.dom.byId(GRAPH_PAGE_STATE_ID)) return NOOP_TEARDOWN;
  const page = parseState(context);
  const branchSelect = context.dom.selectById("graph-branch");
  const button = context.dom.inputById("deploy-app-btn");
  const renderGraph = requireBrowserFunction(globalScope, "radiusRenderGraph");
  const setLoading = requireBrowserFunction(
    globalScope,
    "radiusSetGraphLoading"
  );
  const setError = requireBrowserFunction(globalScope, "radiusSetGraphError");
  // Report a failure once, on the graph surface. The surface owns the content
  // area, so writing there also clears whatever loading state was showing.
  const showFailure = (message: string): void => {
    showGraphModelingFailure(context, setError, message, {
      containerId: "graph-container",
      statusIds: ["graph-status", "graph-refresh-status"],
      staleContentIds: ["graph-guidance"]
    });
  };
  const entry = beginEntry(context, ENTRY_KEY);
  if (!entry) return NOOP_TEARDOWN;
  let hasLoadedGraph = page.loaded;
  let generation = 0;
  let branchSelectionGeneration = 0;
  let requestActive = false;
  let retry: ScopeTimer | null = null;
  // How many `needsAppBicep` retries the current wait has already scheduled.
  // Each wait owns its own counter and resets when a fresh (non-continuing)
  // request starts it, so a later wait never inherits a previous one's backoff.
  let loadRetryAttempt = 0;
  let progress: ScopeTimer | null = null;
  let requestAbort: AbortHandle | null = null;
  let controller: GraphController | null = null;
  let progressView: GraphProgressView | null = null;
  let renderedOptions: GraphOptions | null = null;
  // Whether the selected branch's model has compiled. It starts pending even
  // for a server-rendered graph, because that page immediately re-requests the
  // graph and the refresh decides the real state.
  let modelState: "pending" | "ready" | "failed" = "pending";
  let followWorkspaceBranch = page.followWorkspaceBranch;

  // Keep the primary button in step with the compile state. The server renders
  // the button without a mode and loadModeledEnvState assigns "plan" later, so
  // the two inputs settle in either order; re-applying both here is what stops
  // a late environment listing from leaving a compiled model unplannable. The
  // create-env and unavailable modes own their own enablement.
  const syncPrimaryButton = (): void => {
    if (!button) return;
    const mode = button.dataset.mode;
    if (mode === "create-env" || mode === "unavailable") return;
    const branch = branchSelect ? branchSelect.value : page.branch;
    button.disabled = modelState !== "ready" || !branch;
    if (modelState === "failed") {
      button.setAttribute("title", GRAPH_PLAN_BLOCKED_TITLE);
    } else {
      button.removeAttribute("title");
    }
  };

  const stopProgress = (): void => {
    if (progress !== null) entry.cancel(progress);
    progress = null;
    progressView?.stop();
    progressView = null;
    // The page states a terminal outcome on the graph surface, so a frozen
    // panel left underneath would repeat it as a second box.
    clearGraphProgress(context);
  };

  // Start reporting progress for one build. The loading surface must already be
  // mounted so the panel has its host element.
  //
  // A missing app.bicep is answered by re-issuing the request until Copilot has
  // written the file, so those retries continue the same panel: the elapsed
  // clock measures the whole wait and the stages already reported stay on
  // screen, instead of the panel being rebuilt and flashing the same first line
  // every retry.
  const startProgress = (
    requestGeneration: number,
    detail: string,
    options: { readonly continuing?: boolean } = {}
  ): void => {
    if (progress !== null) entry.cancel(progress);
    progress = null;
    const continued = options.continuing ? progressView : null;
    let view: GraphProgressView;
    if (continued) {
      // The loading surface was remounted, so the retained panel has to draw
      // itself into the new host.
      continued.remount();
      view = continued;
    } else {
      progressView?.stop();
      view = createGraphProgress(context, entry, {
        initial: {
          sequence: 0,
          stage: "checking_model",
          state: "running",
          detail
        }
      });
      progressView = view;
    }
    progress = entry.every(GRAPH_PROGRESS_MS, () =>
      pollProgress(requestGeneration, view)
    );
    // Poll once immediately rather than waiting a full interval. A build that is
    // already in flight — one this page did not start, or one it started before
    // the user navigated away — is adopted straight away instead of showing an
    // empty panel reading 0:00 until the first tick.
    pollProgress(requestGeneration, view);
  };

  const stopRequest = (): void => {
    generation++;
    requestAbort?.abort();
    requestAbort = null;
    requestActive = false;
    if (retry !== null) entry.cancel(retry);
    retry = null;
    stopProgress();
  };

  // A live controller keeps the options it was rendered with, so changed
  // provenance or branch only takes effect through a fresh render.
  const carriesOptions = (options: GraphOptions): boolean =>
    renderedOptions !== null &&
    renderedOptions.repoUrl === options.repoUrl &&
    renderedOptions.branch === options.branch &&
    renderedOptions.localSource === options.localSource;

  const renderOrUpdate = (
    resources: GraphResource[],
    options: GraphOptions
  ): void => {
    if (controller) {
      if (carriesOptions(options)) {
        const updated = controller.update(resources);
        if (updated) {
          controller = updated;
          return;
        }
      }
      controller.destroy();
    }
    controller = asGraphController(
      renderGraph("graph-container", resources, options)
    );
    renderedOptions = options;
  };

  // The server recomputes provenance per request, so a response that reports it
  // wins over the value serialized into the initial page render.
  const sourceProvenance = (payload: unknown): boolean =>
    isRecord(payload) && typeof payload.fromWorkspace === "boolean" ?
      payload.fromWorkspace
    : page.localSource;

  const showGuidance = (): void => {
    const guidance = context.dom.byId("graph-guidance");
    if (guidance) guidance.style.display = "";
  };

  const showLoadedGraph = (): void => {
    const wrapper = context.dom.byId("graph-container-wrapper");
    if (wrapper) {
      const container = context.dom.createElement("div");
      container.id = "graph-container";
      const hint = context.dom.createElement("div");
      hint.id = "graph-guidance";
      hint.setAttribute(
        "style",
        "margin-top:8px; font-size:12px; color:var(--rad-text-tertiary);"
      );
      hint.textContent = "Click a node to view source code links.";
      wrapper.replaceChildren(container, hint);
    }
    showGuidance();
    const status =
      context.dom.byId("graph-status") ??
      context.dom.byId("graph-refresh-status");
    if (status) status.style.display = "none";
  };

  const pollProgress = (
    requestGeneration: number,
    view: GraphProgressView
  ): void => {
    void context.net
      .fetch("/api/progress?view=graph")
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
          return;
        }
        // Workflows that report no typed stages still append diagnostic prose,
        // so that path stays readable instead of showing an empty panel.
        const messages = readArray(payload, "messages").filter(
          (message): message is string => typeof message === "string"
        );
        const latest = messages.at(-1);
        if (latest) showStatus(context, latest, "info");
      })
      .catch((error: unknown) => {
        if (!entry.active || requestGeneration !== generation) return;
        context.logger.error("Radius graph progress request failed.", error);
      });
  };

  const load = (options: { readonly continuing?: boolean } = {}): void => {
    if (requestActive || !entry.active) return;
    const branch = branchSelect?.value.trim() || page.branch;
    if (!page.repo || !branch) {
      showStatus(
        context,
        "Select a branch to generate the application graph.",
        "info"
      );
      return;
    }
    requestActive = true;
    if (!options.continuing) loadRetryAttempt = 0;
    const requestGeneration = ++generation;
    requestAbort = context.net.createAbort();
    controller?.destroy();
    controller = null;
    const wrapper = context.dom.byId("graph-container-wrapper");
    if (wrapper) {
      wrapper.innerHTML = '<div id="graph-container"></div>';
    }
    setLoading("graph-container");
    // Automatic retries continue the same wait. Keep its status text stable
    // instead of flashing "Checking…" before every response restores the
    // generating message.
    if (!options.continuing) {
      showStatus(
        context,
        "Checking the selected branch for .radius/app.bicep…",
        "info"
      );
    }
    startProgress(
      requestGeneration,
      "Checking the selected branch for .radius/app.bicep…",
      { continuing: options.continuing }
    );
    void context.net
      .fetch("/api/load-graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: page.repo,
          branch,
          followWorkspaceBranch,
          restartWait: options.continuing !== true
        }),
        signal: requestAbort?.signal
      })
      .then((response) => response.json())
      .then((payload) => {
        if (requestGeneration !== generation) return;
        const resolvedBranch = readString(payload, "resolvedBranch");
        if (resolvedBranch && resolvedBranch !== branch) {
          context.nav.reload();
          return;
        }
        if (isRecord(payload) && Array.isArray(payload.resources)) {
          modelState = "ready";
          syncPrimaryButton();
          stopProgress();
          showStatus(context, "Application graph ready.", "info");
          showLoadedGraph();
          renderOrUpdate(parseGraphResources(payload.resources), {
            repoUrl: githubRepositoryUrl(page.repo),
            branch,
            localSource: sourceProvenance(payload)
          });
          hasLoadedGraph = true;
          return;
        }
        // The work continues off-page while Copilot authors the model, so the
        // panel keeps running rather than being torn down and rebuilt. The
        // server owns how long that wait may last and drops `needsAppBicep`
        // when it expires, which lands the answer on the error path below.
        if (readBoolean(payload, "needsAppBicep")) {
          showStatus(
            context,
            "Copilot is generating .radius/app.bicep with the Radius app-bicep skill…",
            "info"
          );
          retry = entry.after(graphRetryDelayMs(loadRetryAttempt++), () => {
            retry = null;
            load({ continuing: true });
          });
          return;
        }
        if (readBoolean(payload, "stale")) {
          showStatus(
            context,
            "A newer graph request replaced this one. Retrying…",
            "info"
          );
          retry = entry.after(GRAPH_STALE_RETRY_MS, () => {
            retry = null;
            load({ continuing: true });
          });
          return;
        }
        const error = readString(payload, "error");
        const unsupported = unsupportedGraphModelMessage(payload);
        stopProgress();
        if (error || unsupported) {
          if (readBoolean(payload, "modelingFailed") || unsupported !== null) {
            modelState = "failed";
            syncPrimaryButton();
          }
          showFailure(unsupported || error);
        } else {
          showFailure(
            "The application graph response did not include any resources."
          );
        }
      })
      .catch((error: unknown) => {
        if (!entry.active || requestGeneration !== generation) return;
        const message = "Failed to generate the application graph.";
        stopProgress();
        context.logger.error("Radius graph request failed.", error);
        showFailure(message);
      })
      .then(() => {
        if (requestGeneration === generation) {
          requestActive = false;
          requestAbort = null;
        }
      });
  };

  if (branchSelect) {
    entry.on(branchSelect, "change", () => {
      branchSelectionGeneration++;
      followWorkspaceBranch = false;
      stopRequest();
      modelState = "pending";
      syncPrimaryButton();
      if (branchSelect.value) {
        load();
      }
    });
  }
  if (button) {
    entry.on(button, "click", () => modeledPrimaryAction(context, button));
  }

  if (page.loaded) {
    modelState = "pending";
    syncPrimaryButton();
    const graphOptions: GraphOptions = {
      repoUrl: githubRepositoryUrl(page.repo),
      branch: page.branch,
      localSource: page.localSource
    };
    renderOrUpdate(page.resources, graphOptions);
    // Refreshing a preloaded graph keeps the rendered nodes on screen, so the
    // retrying paths below re-enter this request rather than `load`, which
    // blanks the container before it fetches. Only the first request restarts
    // the server-side wait; the polls that continue it must not, or the wait
    // would never age out.
    let refreshRetryAttempt = 0;
    const refreshLoadedGraph = (
      options: { readonly continuing?: boolean } = {}
    ): void => {
      if (!options.continuing) refreshRetryAttempt = 0;
      const refreshGeneration = ++generation;
      requestAbort = context.net.createAbort();
      void context.net
        .fetch("/api/load-graph", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repo: page.repo,
            branch: page.branch,
            followWorkspaceBranch,
            refresh: true,
            restartWait: options.continuing !== true
          }),
          signal: requestAbort?.signal
        })
        .then((response) => response.json())
        .then((payload) => {
          if (refreshGeneration !== generation) return;
          const resolvedBranch = readString(payload, "resolvedBranch");
          if (resolvedBranch && resolvedBranch !== page.branch) {
            context.nav.reload();
            return;
          }
          if (isRecord(payload) && Array.isArray(payload.resources)) {
            modelState = "ready";
            syncPrimaryButton();
            stopProgress();
            showStatus(context, "Application graph ready.", "info");
            renderOrUpdate(parseGraphResources(payload.resources), {
              ...graphOptions,
              localSource: sourceProvenance(payload)
            });
            showGuidance();
            return;
          }
          const unsupported = unsupportedGraphModelMessage(payload);
          if (unsupported) {
            modelState = "failed";
            syncPrimaryButton();
            stopProgress();
            showFailure(
              `Unable to refresh the application graph: ${unsupported}`
            );
          } else if (readBoolean(payload, "needsAppBicep")) {
            // A preloaded graph refresh can discover that the model disappeared
            // just like the initial load can. The server owns how long that wait
            // may last and drops `needsAppBicep` when it expires, which lands the
            // answer on the error path below.
            showStatus(
              context,
              "Copilot is rebuilding the application graph from .radius/app.bicep with the Radius app-bicep skill.",
              "info"
            );
            retry = entry.after(
              graphRetryDelayMs(refreshRetryAttempt++),
              () => {
                retry = null;
                refreshLoadedGraph({ continuing: true });
              }
            );
          } else if (readBoolean(payload, "stale")) {
            showStatus(
              context,
              "A newer graph request replaced this one. Retrying…",
              "info"
            );
            retry = entry.after(GRAPH_STALE_RETRY_MS, () => {
              retry = null;
              refreshLoadedGraph({ continuing: true });
            });
          } else {
            const error = readString(payload, "error");
            if (error) {
              if (readBoolean(payload, "modelingFailed")) {
                modelState = "failed";
                syncPrimaryButton();
              }
              showStatus(
                context,
                `Unable to refresh the application graph: ${error}`,
                "error"
              );
            } else {
              showStatus(
                context,
                "Unable to refresh the application graph: the response did not include any resources.",
                "error"
              );
            }
          }
        })
        .catch((error: unknown) => {
          if (!entry.active || refreshGeneration !== generation) return;
          context.logger.error("Radius graph refresh failed.", error);
          showStatus(
            context,
            "Unable to refresh the application graph.",
            "error"
          );
        })
        .then(() => {
          if (refreshGeneration === generation) requestAbort = null;
        });
    };
    refreshLoadedGraph();
  }
  void populateApplications(context, page.repo, "graph-app");
  const branchListingGeneration = branchSelectionGeneration;
  void populateBranches(
    context,
    ["graph-branch"],
    page.repo,
    [page.branch],
    () => entry.active && branchSelectionGeneration === branchListingGeneration
  )
    .then(() => {
      if (!entry.active || hasLoadedGraph || !branchSelect?.value) return;
      syncPrimaryButton();
      load();
    })
    .catch((error: unknown) => {
      if (
        !entry.active ||
        branchSelectionGeneration !== branchListingGeneration
      ) {
        return;
      }
      context.logger.error("Radius could not load graph branches.", error);
      showStatus(context, "Unable to load branches.", "error");
    });
  void loadModeledEnvState(context, page.repo, () => entry.active).then(() => {
    if (entry.active) syncPrimaryButton();
  });

  entry.onTeardown(() => {
    stopRequest();
    controller?.destroy();
    controller = null;
  });
  return () => entry.teardown();
}
