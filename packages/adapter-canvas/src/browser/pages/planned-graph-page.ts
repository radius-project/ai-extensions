import { requireBrowserFunction } from "../globals.js";
import { asGraphController } from "../graph/surface.js";
import { clearGraphProgress, createGraphProgress } from "../graph/progress.js";
import { githubRepositoryUrl } from "../graph/model.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { readArray, readBoolean, readNumber, readString } from "../json.js";
import {
  applyPlanEnvState,
  createPlanScheduler,
  createPlanState,
  deployPlannedApp,
  populatePlannedSelectors
} from "../repositories.js";
import type { BrowserTeardown, ScopeTimer } from "../lifecycle.js";
import type { GraphController } from "../graph/surface.js";
import type { GraphProgressView } from "../graph/progress.js";
import type { AbortHandle, BrowserContext } from "../ports.js";
import type { EnvironmentProviders } from "../repositories.js";
import { readPageState } from "./state.js";

const ENTRY_KEY = "planned-graph-page";
export const PLANNED_GRAPH_STATE_ID = "radius-planned-graph-state";
export const PLAN_DEBOUNCE_MS = 150;
export const PLAN_PROGRESS_MS = 800;
// How long to wait before asking again while Copilot authors the model. The
// server decides when the wait has run out and answers with an error instead of
// `needsAppBicep`, which ends the loop.
export const PLAN_RETRY_MS = 10_000;

interface PlannedPageState {
  repo: string;
  branch: string;
  environment: string;
  provider: string;
  resources: unknown[];
  localSource: boolean;
}

function parseState(context: BrowserContext): PlannedPageState {
  const state = readPageState(context, PLANNED_GRAPH_STATE_ID);
  return {
    repo: readString(state, "repo"),
    branch: readString(state, "branch") || "main",
    environment: readString(state, "environment"),
    provider: readString(state, "provider") || "azure",
    resources: readArray(state, "resources"),
    localSource: readBoolean(state, "localSource")
  };
}

function status(
  context: BrowserContext,
  message: string,
  tone: "info" | "error"
): void {
  const element = context.dom.byId("plan-status");
  if (!element) return;
  element.style.display = "";
  element.className = `status ${tone}`;
  element.textContent = message;
}

function graphContainer(context: BrowserContext): string {
  const wrapper = context.dom.byId("graph-container-wrapper");
  if (wrapper) {
    wrapper.innerHTML = '<div id="graph-container"></div>';
  }
  return "graph-container";
}

export function initializePlannedGraphPage(
  context: BrowserContext,
  globalScope: unknown
): BrowserTeardown {
  if (!context.dom.byId(PLANNED_GRAPH_STATE_ID)) return NOOP_TEARDOWN;
  const page = parseState(context);
  const plan = createPlanState();
  const providers: EnvironmentProviders = {};
  const renderGraph = requireBrowserFunction(globalScope, "radiusRenderGraph");
  const setLoading = requireBrowserFunction(
    globalScope,
    "radiusSetGraphLoading"
  );
  const entry = beginEntry(context, ENTRY_KEY);
  if (!entry) return NOOP_TEARDOWN;
  const app = context.dom.selectById("planned-app");
  const branch = context.dom.selectById("planned-branch");
  const environment = context.dom.selectById("planned-env");
  const button = context.dom.inputById("plan-btn");
  let progress: ScopeTimer | null = null;
  let requestAbort: AbortHandle | null = null;
  let controller: GraphController | null = null;
  let progressView: GraphProgressView | null = null;
  let selectionQueuedWhileLoading = false;
  let appBicepRetry: ScopeTimer | null = null;
  let nextRequestRefresh = page.resources.length > 0;
  let restartWait = true;
  // Re-issues the current selection. Assigned once the scheduler exists, since
  // the retry must go through the same serialization as a user-driven request
  // rather than starting a second overlapping compile.
  let requeue: (() => void) | null = null;

  const stopAppBicepRetry = (): void => {
    if (appBicepRetry !== null) entry.cancel(appBicepRetry);
    appBicepRetry = null;
  };
  const showModelingFailure = (message: string): void => {
    controller?.destroy();
    controller = null;
    const wrapper = context.dom.byId("graph-container-wrapper");
    if (wrapper) wrapper.innerHTML = '<div id="graph-container"></div>';
    requireBrowserFunction(globalScope, "radiusSetGraphError")(
      "graph-container",
      message
    );
    const statusElement = context.dom.byId("plan-status");
    if (statusElement) statusElement.style.display = "none";
    if (button) {
      button.disabled = true;
      button.setAttribute(
        "title",
        "Deploy Application is unavailable until the application model compiles."
      );
    }
  };

  const stopProgress = (): void => {
    if (progress !== null) entry.cancel(progress);
    progress = null;
    progressView?.stop();
    progressView = null;
    // The page states a terminal outcome in its own status surface, so a frozen
    // panel left underneath would repeat it as a second box.
    clearGraphProgress(context);
  };

  const run = (isCurrent: () => boolean): Promise<void> => {
    if (!entry.active) return Promise.resolve();
    stopAppBicepRetry();
    const selectedBranch = branch?.value.trim() || page.branch;
    const selectedEnvironment = environment?.value ?? "";
    const selectedProvider =
      typeof providers[selectedEnvironment] === "string" ?
        providers[selectedEnvironment]
      : page.provider;
    const refresh = nextRequestRefresh;
    nextRequestRefresh = false;
    const restartExpiredWait = restartWait;
    restartWait = false;
    const current = (): boolean => entry.active && isCurrent();

    if (plan.envsStale && !refresh) {
      status(
        context,
        page.resources.length > 0 ?
          "Environments could not be loaded. The last planned graph is retained."
        : "Environments could not be loaded. Try again before planning a deployment.",
        "error"
      );
      return Promise.resolve();
    }
    if (!page.repo || !selectedBranch) {
      status(
        context,
        "Select a branch to preview the planned deployment.",
        "info"
      );
      return Promise.resolve();
    }
    if ((!plan.hasEnv || !selectedEnvironment) && !refresh) {
      status(
        context,
        "Create an environment to preview the planned deployment for this application.",
        "info"
      );
      const container = context.dom.byId("graph-container");
      if (container) container.innerHTML = "";
      return Promise.resolve();
    }

    plan.requestFailed = false;
    if (context.dom.byId("graph-container-wrapper")) {
      controller?.destroy();
      controller = null;
    }
    const containerId = graphContainer(context);
    setLoading(containerId);
    stopProgress();
    const abort = context.net.createAbort();
    requestAbort = abort;
    const view = createGraphProgress(context, entry, {
      title: "Planning the deployment",
      initial: {
        sequence: 0,
        stage: "checking_model",
        state: "running",
        detail: `Preparing the planned deployment for ${selectedEnvironment}…`
      }
    });
    progressView = view;
    const pollProgress = (): void => {
      void context.net
        .fetch("/api/progress?view=planned")
        .then((response) => response.json())
        .then((payload) => {
          if (!current()) return;
          const events = readArray(payload, "events");
          if (events.length > 0) {
            view.sync(
              events,
              readNumber(payload, "generation") ?? 0,
              readNumber(payload, "elapsedMs")
            );
            return;
          }
          const messages = readArray(payload, "messages").filter(
            (message): message is string => typeof message === "string"
          );
          const latest = messages.at(-1);
          if (latest) status(context, latest, "info");
        })
        .catch((error: unknown) => {
          if (!current()) return;
          context.logger.error("Radius planned graph progress failed.", error);
        });
    };
    progress = entry.every(PLAN_PROGRESS_MS, pollProgress);
    // Poll once immediately rather than waiting a full interval. A build that is
    // already in flight — one this page did not start, or one it started before
    // the user navigated away — is adopted straight away instead of showing an
    // empty panel reading 0:00 until the first tick.
    pollProgress();
    return context.net
      .fetch("/api/plan-graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: page.repo,
          branch: selectedBranch,
          provider: selectedProvider,
          ...(selectedEnvironment ? { environment: selectedEnvironment } : {}),
          refresh,
          restartWait: restartExpiredWait
        }),
        signal: abort?.signal
      })
      .then((response) => response.json())
      .then((payload) => {
        if (!current()) return;
        if (readBoolean(payload, "reload")) {
          context.nav.reload();
          return;
        }
        if (readBoolean(payload, "refreshed")) {
          plan.requestFailed = false;
          if (plan.envsStale) {
            status(
              context,
              "Environments could not be loaded. The last planned graph is retained.",
              "error"
            );
          } else if (!plan.hasEnv || !selectedEnvironment) {
            status(
              context,
              "Create an environment to preview the planned deployment for this application.",
              "info"
            );
          } else {
            status(context, "The planned deployment is current.", "info");
          }
          return;
        }
        plan.requestFailed = true;
        if (readBoolean(payload, "needsAppBicep")) {
          nextRequestRefresh = refresh;
          status(
            context,
            "Copilot is generating .radius/app.bicep with the Radius app-bicep skill… the planned graph will appear once it is saved.",
            "info"
          );
          // Nothing announces the model's arrival, so the planned graph only
          // learns by asking again. Without this the page reported the wait once
          // and then sat there permanently, even after the model landed.
          appBicepRetry = entry.after(PLAN_RETRY_MS, () => {
            appBicepRetry = null;
            requeue?.();
          });
          return;
        }
        const error = readString(payload, "error");
        if (readBoolean(payload, "modelingFailed") && error) {
          showModelingFailure(error);
          return;
        }
        status(
          context,
          error ?
            `Error: ${error}`
          : "The planned deployment response was incomplete. Try again.",
          "error"
        );
      })
      .catch((error: unknown) => {
        if (!current()) return;
        plan.requestFailed = true;
        context.logger.error("Radius planned graph request failed.", error);
        status(
          context,
          "The planned deployment could not be generated. Try again.",
          "error"
        );
      })
      .then(() => {
        stopProgress();
        if (requestAbort === abort) requestAbort = null;
      });
  };

  // Serialize plan requests. Aborting the browser fetch does not stop the
  // server's compile, so starting a replacement before the previous response
  // arrives duplicates that work and mixes its progress into the new selection.
  const schedule = createPlanScheduler(
    context,
    run,
    () => {
      if (entry.active) {
        plan.planPending = false;
        applyPlanEnvState(context, plan, plan.hasEnv, plan.envsStale);
      }
    },
    PLAN_DEBOUNCE_MS
  );
  requeue = () => {
    schedule(true);
  };

  // Hold the deploy action closed while a plan is pending: the preview it would
  // deploy does not exist yet, and the request may still fail.
  const queue = (immediate = false): void => {
    stopAppBicepRetry();
    plan.requestFailed = false;
    plan.planPending = true;
    applyPlanEnvState(context, plan, plan.hasEnv, plan.envsStale);
    if (plan.selectorsPending) {
      selectionQueuedWhileLoading = true;
      return;
    }
    schedule(immediate);
  };

  for (const selector of [app, branch, environment]) {
    if (!selector) continue;
    entry.on(selector, "change", () => {
      nextRequestRefresh = false;
      restartWait = true;
      queue();
    });
  }
  if (button) {
    entry.on(button, "click", () => {
      if (button.dataset.mode === "create-env") {
        context.nav.assign("/?page=environment&new=1");
        return;
      }
      void deployPlannedApp(
        context,
        button,
        page.repo,
        providers,
        page.provider,
        () => entry.active
      );
    });
  }

  if (page.resources.length > 0) {
    controller = asGraphController(
      renderGraph("graph-container", page.resources, {
        repoUrl: githubRepositoryUrl(page.repo),
        branch: page.branch,
        localSource: page.localSource,
        plannedMode: true
      })
    );
  }

  void populatePlannedSelectors(context, plan, {
    repo: page.repo,
    environmentProviders: providers,
    defaultBranch: page.branch,
    defaultEnvironment: page.environment,
    onSelectorsReady: () => {
      if (!entry.active || !selectionQueuedWhileLoading) return;
      selectionQueuedWhileLoading = false;
      schedule();
    }
  }).then(() => {
    if (!entry.active) return;
    // Always invoke the plan workflow to reconcile freshness, even when
    // preloaded resources are displayed. The visible cached graph is preserved
    // while the HTTP workflow checks whether the model is missing or stale.
    queue(true);
  });

  entry.onTeardown(() => {
    requestAbort?.abort();
    requestAbort = null;
    stopProgress();
    controller?.destroy();
    controller = null;
  });
  return () => entry.teardown();
}
