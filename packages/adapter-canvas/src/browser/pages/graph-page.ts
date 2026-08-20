import { requireBrowserFunction } from "../globals.js";
import { asGraphController } from "../graph/surface.js";
import { githubRepositoryUrl, parseGraphResources } from "../graph/model.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { isRecord, readArray, readBoolean, readString } from "../json.js";
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

function showStatus(
  context: BrowserContext,
  message: string,
  tone: "info" | "error"
): void {
  const status =
    context.dom.byId("graph-status") ??
    context.dom.byId("graph-refresh-status");
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
  const entry = beginEntry(context, ENTRY_KEY);
  if (!entry) return NOOP_TEARDOWN;
  let hasLoadedGraph = page.loaded;
  let generation = 0;
  let requestActive = false;
  let retry: ScopeTimer | null = null;
  let progress: ScopeTimer | null = null;
  let requestAbort: AbortHandle | null = null;
  let controller: GraphController | null = null;
  let renderedOptions: GraphOptions | null = null;

  const stopProgress = (): void => {
    if (progress !== null) entry.cancel(progress);
    progress = null;
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

  const pollProgress = (requestGeneration: number): void => {
    void context.net
      .fetch("/api/progress")
      .then((response) => response.json())
      .then((payload) => {
        if (!entry.active || requestGeneration !== generation) return;
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

  const load = (): void => {
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
    showStatus(
      context,
      "Checking the selected branch for .radius/app.bicep…",
      "info"
    );
    stopProgress();
    progress = entry.every(GRAPH_PROGRESS_MS, () =>
      pollProgress(requestGeneration)
    );
    void context.net
      .fetch("/api/load-graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo: page.repo, branch }),
        signal: requestAbort?.signal
      })
      .then((response) => response.json())
      .then((payload) => {
        if (requestGeneration !== generation) return;
        stopProgress();
        if (isRecord(payload) && Array.isArray(payload.resources)) {
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
          showStatus(context, "Application graph ready.", "info");
          context.nav.reload();
          return;
        }
        if (readBoolean(payload, "needsAppBicep")) {
          showStatus(
            context,
            "Copilot is generating .radius/app.bicep with the Radius app-bicep skill…",
            "info"
          );
          retry = entry.after(GRAPH_RETRY_MS, () => {
            retry = null;
            load();
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
            load();
          });
          return;
        }
        const error = readString(payload, "error");
        if (error) {
          setError("graph-container", error);
          showStatus(context, `Error: ${error}`, "error");
        }
      })
      .catch((error: unknown) => {
        if (!entry.active || requestGeneration !== generation) return;
        stopProgress();
        context.logger.error("Radius graph request failed.", error);
        setError(
          "graph-container",
          "Failed to generate the application graph."
        );
        showStatus(
          context,
          "Failed to generate the application graph.",
          "error"
        );
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
      if (button && button.dataset.mode !== "create-env") {
        button.disabled = !branchSelect.value;
      }
      if (branchSelect.value) {
        load();
      }
    });
  }
  if (button) {
    entry.on(button, "click", () => modeledPrimaryAction(context, button));
  }

  if (page.loaded) {
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
          refresh: true
        }),
        signal: requestAbort?.signal
      })
      .then((response) => response.json())
      .then((payload) => {
        if (refreshGeneration !== generation) return;
        if (isRecord(payload) && Array.isArray(payload.resources)) {
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
        } else {
          const error = readString(payload, "error");
          if (error) {
            showStatus(
              context,
              `Unable to refresh the application graph: ${error}`,
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
      if (button && button.dataset.mode !== "create-env")
        button.disabled = false;
      load();
    })
    .catch((error: unknown) => {
      context.logger.error("Radius could not load graph branches.", error);
      showStatus(context, "Unable to load branches.", "error");
    });
  loadModeledEnvState(context, page.repo, () => entry.active);

  entry.onTeardown(() => {
    stopRequest();
    controller?.destroy();
    controller = null;
  });
  return () => entry.teardown();
}
