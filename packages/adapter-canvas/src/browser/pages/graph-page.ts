import { requireBrowserFunction } from "../globals.js";
import { asGraphController } from "../graph/surface.js";
import { createGraphProgress } from "../graph/progress.js";
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
// How long the page waits for Copilot to author .radius/app.bicep before it
// gives up. Nothing reports back when the modeling skill finishes or refuses —
// the page only learns by asking again — so an unbounded retry would spin
// forever on a repository the skill cannot model at all.
export const GRAPH_APP_BICEP_TIMEOUT_MS = 300_000;
export const GRAPH_APP_BICEP_TIMEOUT_MESSAGE =
  "Copilot has not produced .radius/app.bicep for this branch. It may be unable to model this repository — check the Copilot conversation for the reason, then reload to try again.";

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
  let generation = 0;
  let requestActive = false;
  let retry: ScopeTimer | null = null;
  let progress: ScopeTimer | null = null;
  let requestAbort: AbortHandle | null = null;
  let controller: GraphController | null = null;
  let progressView: GraphProgressView | null = null;
  // When the current wait for Copilot to author .radius/app.bicep began, or
  // null when the page is not waiting on one.
  let appBicepWaitStartedAtMs: number | null = null;

  const stopProgress = (): void => {
    if (progress !== null) entry.cancel(progress);
    progress = null;
    progressView?.stop();
    progressView = null;
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
  };

  const stopRequest = (): void => {
    generation++;
    requestAbort?.abort();
    requestAbort = null;
    requestActive = false;
    appBicepWaitStartedAtMs = null;
    if (retry !== null) entry.cancel(retry);
    retry = null;
    stopProgress();
  };

  const renderOrUpdate = (
    resources: GraphResource[],
    options: GraphOptions
  ): void => {
    if (controller) {
      const updated = controller.update(resources);
      if (updated) {
        controller = updated;
        return;
      }
      controller.destroy();
    }
    controller = asGraphController(
      renderGraph("graph-container", resources, options)
    );
  };

  const pollProgress = (
    requestGeneration: number,
    view: GraphProgressView
  ): void => {
    void context.net
      .fetch("/api/progress")
      .then((response) => response.json())
      .then((payload) => {
        if (!entry.active || requestGeneration !== generation) return;
        const events = readArray(payload, "events");
        if (events.length > 0) {
          view.sync(events, readNumber(payload, "generation") ?? 0);
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
    const wrapper = context.dom.byId("graph-container-wrapper");
    if (wrapper) {
      controller?.destroy();
      controller = null;
      wrapper.innerHTML = '<div id="graph-container"></div>';
    }
    setLoading("graph-container");
    showStatus(
      context,
      "Checking the selected branch for .radius/app.bicep…",
      "info"
    );
    startProgress(
      requestGeneration,
      "Checking the selected branch for .radius/app.bicep…",
      { continuing: options.continuing }
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
        if (readBoolean(payload, "reload")) {
          stopProgress();
          showStatus(context, "Application graph ready.", "info");
          context.nav.reload();
          return;
        }
        // The work continues off-page while Copilot authors the model, so the
        // panel keeps running rather than being torn down and rebuilt.
        if (readBoolean(payload, "needsAppBicep")) {
          const now = context.clock.now();
          if (appBicepWaitStartedAtMs === null) appBicepWaitStartedAtMs = now;
          if (now - appBicepWaitStartedAtMs >= GRAPH_APP_BICEP_TIMEOUT_MS) {
            appBicepWaitStartedAtMs = null;
            progressView?.append(
              "creating_model",
              "failed",
              GRAPH_APP_BICEP_TIMEOUT_MESSAGE
            );
            stopProgress();
            setError("graph-container", GRAPH_APP_BICEP_TIMEOUT_MESSAGE);
            showStatus(context, GRAPH_APP_BICEP_TIMEOUT_MESSAGE, "error");
            return;
          }
          showStatus(
            context,
            "Copilot is generating .radius/app.bicep with the Radius app-bicep skill…",
            "info"
          );
          progressView?.append(
            "creating_model",
            "running",
            "Copilot is generating .radius/app.bicep with the Radius app-bicep skill…"
          );
          retry = entry.after(GRAPH_RETRY_MS, () => {
            retry = null;
            load({ continuing: true });
          });
          return;
        }
        appBicepWaitStartedAtMs = null;
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
        stopProgress();
        const error = readString(payload, "error");
        if (error) {
          setError("graph-container", error);
          showStatus(context, `Error: ${error}`, "error");
        }
      })
      .catch((error: unknown) => {
        if (!entry.active || requestGeneration !== generation) return;
        appBicepWaitStartedAtMs = null;
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

  const reloadForBranch = (branch: string): void => {
    if (!page.repo || !branch) return;
    const requestGeneration = ++generation;
    requestActive = true;
    requestAbort = context.net.createAbort();
    showStatus(context, `Regenerating graph for ${branch}…`, "info");
    const wrapper = context.dom.byId("graph-container-wrapper");
    if (wrapper) {
      controller?.destroy();
      controller = null;
      wrapper.innerHTML = '<div id="graph-container"></div>';
    }
    setLoading("graph-container");
    startProgress(requestGeneration, `Regenerating graph for ${branch}…`);
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
        if (readBoolean(payload, "reload")) context.nav.reload();
        else {
          const error = readString(payload, "error");
          if (error) {
            setError("graph-container", error);
            showStatus(context, `Error: ${error}`, "error");
          }
        }
      })
      .catch((error: unknown) => {
        if (!entry.active || requestGeneration !== generation) return;
        stopProgress();
        context.logger.error("Radius graph regeneration failed.", error);
        setError("graph-container", "Failed to regenerate graph.");
        showStatus(context, "Failed to regenerate graph.", "error");
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
        if (page.loaded) reloadForBranch(branchSelect.value.trim());
        else load();
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
          renderOrUpdate(parseGraphResources(payload.resources), graphOptions);
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
      if (!entry.active || page.loaded || !branchSelect?.value) return;
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
