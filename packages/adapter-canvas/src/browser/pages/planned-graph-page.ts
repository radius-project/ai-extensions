import { requireBrowserFunction } from "../globals.js";
import { asGraphController } from "../graph/surface.js";
import { githubRepositoryUrl } from "../graph/model.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { readArray, readBoolean, readString } from "../json.js";
import {
  applyPlanEnvState,
  createPlanState,
  deployPlannedApp,
  populatePlannedSelectors
} from "../repositories.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type { GraphController } from "../graph/surface.js";
import type { AbortHandle, BrowserContext, TimerHandle } from "../ports.js";
import type { EnvironmentProviders } from "../repositories.js";
import { readPageState } from "./state.js";

const ENTRY_KEY = "planned-graph-page";
export const PLANNED_GRAPH_STATE_ID = "radius-planned-graph-state";
export const PLAN_DEBOUNCE_MS = 150;
export const PLAN_PROGRESS_MS = 800;

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
  let generation = 0;
  let activeGeneration: number | null = null;
  let pending: TimerHandle | null = null;
  let progress: TimerHandle | null = null;
  let requestAbort: AbortHandle | null = null;
  let controller: GraphController | null = null;

  const stopProgress = (): void => {
    if (progress !== null) entry.cancel(progress);
    progress = null;
  };

  const run = (): void => {
    pending = null;
    const requestGeneration = generation;
    activeGeneration = requestGeneration;
    const selectedBranch = branch?.value.trim() || page.branch;
    const selectedEnvironment = environment?.value ?? "";
    const selectedProvider =
      typeof providers[selectedEnvironment] === "string" ?
        providers[selectedEnvironment]
      : page.provider;
    const current = (): boolean =>
      entry.active && requestGeneration === generation;

    if (plan.envsStale) {
      status(
        context,
        page.resources.length > 0 ?
          "Environments could not be loaded. The last planned graph is retained."
        : "Environments could not be loaded. Try again before planning a deployment.",
        "error"
      );
      activeGeneration = null;
      return;
    }
    if (!page.repo || !selectedBranch) {
      status(
        context,
        "Select a branch to preview the planned deployment.",
        "info"
      );
      activeGeneration = null;
      return;
    }
    if (!plan.hasEnv || !selectedEnvironment) {
      status(
        context,
        "Create an environment to preview the planned deployment for this application.",
        "info"
      );
      const container = context.dom.byId("graph-container");
      if (container) container.innerHTML = "";
      activeGeneration = null;
      return;
    }

    plan.requestFailed = false;
    if (context.dom.byId("graph-container-wrapper")) {
      controller?.destroy();
      controller = null;
    }
    const containerId = graphContainer(context);
    setLoading(containerId);
    stopProgress();
    requestAbort = context.net.createAbort();
    progress = entry.every(PLAN_PROGRESS_MS, () => {
      void context.net
        .fetch("/api/progress")
        .then((response) => response.json())
        .then((payload) => {
          if (!current()) return;
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
    });
    void context.net
      .fetch("/api/plan-graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: page.repo,
          branch: selectedBranch,
          provider: selectedProvider,
          environment: selectedEnvironment
        }),
        signal: requestAbort?.signal
      })
      .then((response) => response.json())
      .then((payload) => {
        if (requestGeneration !== generation) return;
        if (readBoolean(payload, "reload")) {
          context.nav.reload();
          return;
        }
        plan.requestFailed = true;
        if (readBoolean(payload, "needsAppBicep")) {
          status(
            context,
            "Copilot is generating .radius/app.bicep with the Radius app-bicep skill… the planned graph will appear once it is saved.",
            "info"
          );
          return;
        }
        const error = readString(payload, "error");
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
        if (activeGeneration !== requestGeneration) return;
        stopProgress();
        activeGeneration = null;
        requestAbort = null;
        applyPlanEnvState(context, plan, plan.hasEnv, plan.envsStale);
      });
  };

  const queue = (immediate = false): void => {
    generation++;
    plan.requestFailed = false;
    if (pending !== null) entry.cancel(pending);
    pending = null;
    if (activeGeneration !== null) {
      requestAbort?.abort();
      requestAbort = null;
      activeGeneration = null;
      stopProgress();
    }
    pending = entry.after(immediate ? 0 : PLAN_DEBOUNCE_MS, run);
  };

  for (const selector of [app, branch, environment]) {
    if (!selector) continue;
    entry.on(selector, "change", () => {
      applyPlanEnvState(context, plan, plan.hasEnv, plan.envsStale);
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
        page.provider
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
    defaultEnvironment: page.environment
  }).then(() => {
    if (!entry.active) return;
    if (page.resources.length === 0) queue(true);
    else if (!plan.hasEnv && !plan.envsStale) {
      const container = context.dom.byId("graph-container");
      if (container) {
        container.innerHTML =
          '<div class="status info">Create an environment to preview the planned deployment for this application.</div>';
      }
    }
  });

  entry.onTeardown(() => {
    generation++;
    requestAbort?.abort();
    requestAbort = null;
    activeGeneration = null;
    stopProgress();
    controller?.destroy();
    controller = null;
  });
  return () => entry.teardown();
}
