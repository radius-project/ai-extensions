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

const ENTRY_KEY = "graph-page";
export const GRAPH_PAGE_STATE_ID = "radius-graph-page-state";
export const GRAPH_RETRY_MS = 10_000;
export const GRAPH_STALE_RETRY_MS = 1_000;
export const GRAPH_PROGRESS_MS = 800;
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
}

function parseState(context: BrowserContext): GraphPageState {
  const state = readPageState(context, GRAPH_PAGE_STATE_ID);
  return {
    repo: readString(state, "repo"),
    branch: readString(state, "branch") || "main",
    resources: parseGraphResources(readArray(state, "resources")),
    loaded: readBoolean(state, "loaded"),
    localSource: readBoolean(state, "localSource")
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

// The status strip sits directly above the graph surface, so a failure written
// to both renders as two identical error boxes. Clearing the strip leaves the
// surface itself as the single place a failure is reported.
function hideStatus(context: BrowserContext): void {
  const status = statusElement(context);
  if (!status) return;
  status.style.display = "none";
  status.textContent = "";
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
    setError("graph-container", message);
    hideStatus(context);
  };
  const entry = beginEntry(context, ENTRY_KEY);
  if (!entry) return NOOP_TEARDOWN;
  let hasLoadedGraph = page.loaded;
  let generation = 0;
  let requestActive = false;
  let retry: ScopeTimer | null = null;
  let progress: ScopeTimer | null = null;
  let requestAbort: AbortHandle | null = null;
  let controller: GraphController | null = null;
  let progressView: GraphProgressView | null = null;
  let renderedOptions: GraphOptions | null = null;
  // Whether the selected branch's model has compiled. It starts pending even
  // for a server-rendered graph, because that page immediately re-requests the
  // graph and the refresh decides the real state.
  let modelState: "pending" | "ready" | "failed" = "pending";

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

  const showLoadedGraph = (): void => {
    const wrapper = context.dom.byId("graph-container-wrapper");
    if (wrapper) {
      const container = context.dom.createElement("div");
      container.id = "graph-container";
      const hint = context.dom.createElement("div");
      hint.setAttribute(
        "style",
        "margin-top:8px; font-size:12px; color:var(--rad-text-tertiary);"
      );
      hint.textContent = "Click a node to view source code links.";
      wrapper.replaceChildren(container, hint);
    }
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
          restartWait: options.continuing !== true
        }),
        signal: requestAbort?.signal
      })
      .then((response) => response.json())
      .then((payload) => {
        if (requestGeneration !== generation) return;
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
        if (readBoolean(payload, "reload")) {
          stopProgress();
          showStatus(context, "Application graph ready.", "info");
          context.nav.reload();
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
          retry = entry.after(GRAPH_RETRY_MS, () => {
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
        stopProgress();
        if (error) {
          if (readBoolean(payload, "modelingFailed")) {
            modelState = "failed";
            syncPrimaryButton();
          }
          showFailure(error);
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
    const refreshGeneration = ++generation;
    requestAbort = context.net.createAbort();
    void context.net
      .fetch("/api/load-graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: page.repo,
          branch: page.branch,
          refresh: true,
          restartWait: true
        }),
        signal: requestAbort?.signal
      })
      .then((response) => response.json())
      .then((payload) => {
        if (refreshGeneration !== generation) return;
        if (isRecord(payload) && Array.isArray(payload.resources)) {
          modelState = "ready";
          syncPrimaryButton();
          renderOrUpdate(parseGraphResources(payload.resources), {
            ...graphOptions,
            localSource: sourceProvenance(payload)
          });
        } else if (readBoolean(payload, "needsAppBicep")) {
          showStatus(
            context,
            "Copilot is rebuilding the application graph from .radius/app.bicep with the Radius app-bicep skill.",
            "info"
          );
          // A preloaded graph refresh can discover that the model disappeared
          // just like the initial load can. Re-enter the ordinary retrying path
          // so the page recovers when Copilot publishes the replacement model.
          retry = entry.after(GRAPH_RETRY_MS, () => {
            retry = null;
            load({ continuing: true });
          });
        } else {
          const error = readString(payload, "error");
          if (error) {
            if (readBoolean(payload, "modelingFailed")) {
              modelState = "failed";
              syncPrimaryButton();
              showFailure(error);
            } else {
              showStatus(
                context,
                `Unable to refresh the application graph: ${error}`,
                "error"
              );
            }
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
  }
  void populateApplications(context, page.repo, "graph-app");
  void populateBranches(
    context,
    ["graph-branch"],
    page.repo,
    [page.branch],
    () => entry.active
  )
    .then(() => {
      if (!entry.active || hasLoadedGraph || !branchSelect?.value) return;
      syncPrimaryButton();
      load();
    })
    .catch((error: unknown) => {
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
