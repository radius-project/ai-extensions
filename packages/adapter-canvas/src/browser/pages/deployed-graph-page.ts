import { optionalBrowserFunction, requireBrowserFunction } from "../globals.js";
import { asGraphController } from "../graph/surface.js";
import { githubRepositoryUrl, parseGraphResources } from "../graph/model.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import {
  isCallable,
  isRecord,
  readArray,
  readNumber,
  readString,
  readStringArray
} from "../json.js";
import {
  applyDeployedEnvState,
  buildEnvironmentOptions,
  createDeployedState,
  deployDeployedApp,
  parseApplicationListing,
  parseEnvironmentListing
} from "../repositories.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type { GraphController } from "../graph/surface.js";
import type { AbortHandle, BrowserContext, TimerHandle } from "../ports.js";
import type { EnvironmentProviders } from "../repositories.js";
import { readPageState } from "./state.js";

const ENTRY_KEY = "deployed-graph-page";
export const DEPLOYED_GRAPH_STATE_ID = "radius-deployed-graph-state";
export const DEPLOYED_GRAPH_POLL_MS = 15_000;
export const DEPLOYED_STATE_POLL_MS = 4_000;
export const DEPLOYED_LOG_POLL_MS = 1_500;
export const DEPLOYED_STATE_POLL_LIMIT = 45;

interface DeployedPageState {
  repo: string;
  branch: string;
  graphBranch: string;
  provider: string;
}

interface DeploymentState {
  app: string;
  environment: string;
  status: string;
}

interface DeleteDialog {
  open(application: string, environment: string): void;
  teardown?: () => void;
}

function asDeleteDialog(value: unknown): DeleteDialog | null {
  if (!isRecord(value) || !isCallable(value.open)) return null;
  const open = value.open;
  const teardown = value.teardown;
  return {
    open: (application, environment) => {
      open(application, environment);
    },
    teardown:
      isCallable(teardown) ?
        () => {
          teardown();
        }
      : undefined
  };
}

function parseState(context: BrowserContext): DeployedPageState {
  const state = readPageState(context, DEPLOYED_GRAPH_STATE_ID);
  return {
    repo: readString(state, "repo"),
    branch: readString(state, "branch") || "main",
    graphBranch: readString(state, "graphBranch") || "main",
    provider: readString(state, "provider") || "azure"
  };
}

function queryValue(search: string, name: string): string {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of query.split("&")) {
    const separator = pair.indexOf("=");
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (decodeURIComponent(key) !== name) continue;
    return decodeURIComponent(
      (separator < 0 ? "" : pair.slice(separator + 1)).replace(/\+/g, " ")
    );
  }
  return "";
}

function deploymentKey(application: string, environment: string): string {
  return `${encodeURIComponent(application)}|${encodeURIComponent(environment)}`;
}

function parseDeployments(payload: unknown): DeploymentState[] {
  return readArray(payload, "deployments")
    .map((deployment) => ({
      app: readString(deployment, "app"),
      environment: readString(deployment, "environment"),
      status: readString(deployment, "status") || "unknown"
    }))
    .filter(
      (deployment) => deployment.app !== "" && deployment.environment !== ""
    );
}

function setInline(
  context: BrowserContext,
  kind: "info" | "error",
  message: string
): void {
  const element = context.dom.byId("deployed-inline-status");
  if (!element) return;
  element.style.display = "block";
  element.className = `status ${kind}`;
  element.textContent = message;
}

export function initializeDeployedGraphPage(
  context: BrowserContext,
  globalScope: unknown
): BrowserTeardown {
  if (!context.dom.byId(DEPLOYED_GRAPH_STATE_ID)) return NOOP_TEARDOWN;
  const page = parseState(context);
  const appSelect = context.dom.selectById("deployed-app-select");
  const envSelect = context.dom.selectById("deployed-env-select");
  const action = context.dom.inputById("deployed-delete-btn");
  const status = context.dom.byId("deployed-status");
  const label = context.dom.byId("deployed-graph-label");
  const note = context.dom.byId("deployed-mode-note");
  const logSection = context.dom.byId("deployed-log-section");
  const logOutput = context.dom.byId("deployed-log-output");
  const renderGraph = requireBrowserFunction(globalScope, "radiusRenderGraph");
  const entry = beginEntry(context, ENTRY_KEY);
  if (!entry) return NOOP_TEARDOWN;
  const providers: EnvironmentProviders = {};
  const adaptive = createDeployedState();
  const deployments = new Map<string, string>();
  let hasEnvironments = false;
  let deploymentStatesStale = false;
  let statePolls = 0;
  let stateTimer: TimerHandle | null = null;
  let graphTimer: TimerHandle | null = null;
  let logTimer: TimerHandle | null = null;
  let graphAbort: AbortHandle | null = null;
  let graphGeneration = 0;
  let logTotal = 0;
  let lastMode = "";
  let controller: GraphController | null = null;
  let renderedBranch = "";
  let resumeGraphOnVisible = false;
  let graphRequestInFlight = false;

  const selectedApplication = (): string => appSelect?.value ?? "";
  const selectedEnvironment = (): string => envSelect?.value ?? "";
  const selectedStatus = (): string =>
    deployments.get(
      deploymentKey(selectedApplication(), selectedEnvironment())
    ) ?? "";

  const stopStatePolling = (): void => {
    if (stateTimer !== null) entry.cancel(stateTimer);
    stateTimer = null;
    statePolls = 0;
  };

  const scheduleStatePolling = (load: () => Promise<void>): void => {
    const current = selectedStatus();
    const active =
      current === "pending" || current === "deleting" || deploymentStatesStale;
    if (!active) {
      stopStatePolling();
      return;
    }
    if (stateTimer !== null || statePolls >= DEPLOYED_STATE_POLL_LIMIT) return;
    stateTimer = entry.after(DEPLOYED_STATE_POLL_MS, () => {
      stateTimer = null;
      statePolls++;
      void load().then(() => {
        if (entry.active) refreshControls();
      });
    });
  };

  const refreshControls = (): void => {
    const application = selectedApplication();
    const environment = selectedEnvironment();
    const deploymentStatus = selectedStatus();
    const exists = deploymentStatus !== "";
    applyDeployedEnvState(
      context,
      adaptive,
      hasEnvironments,
      exists,
      deploymentStatus,
      deploymentStatesStale
    );
    if (label) {
      label.textContent =
        application && environment ?
          `Application: ${application}\nEnvironment: ${environment}`
        : "";
    }
    scheduleStatePolling(loadDeploymentStates);
  };

  const loadDeploymentStates = (): Promise<void> =>
    context.net
      .fetch(`/api/list-deployments?repo=${encodeURIComponent(page.repo)}`)
      .then((response) => response.json())
      .then((payload) => {
        const error = readString(payload, "error");
        if (error) {
          deploymentStatesStale = true;
          return;
        }
        deploymentStatesStale = false;
        deployments.clear();
        for (const deployment of parseDeployments(payload)) {
          deployments.set(
            deploymentKey(deployment.app, deployment.environment),
            deployment.status
          );
        }
      })
      .catch((error: unknown) => {
        deploymentStatesStale = true;
        context.logger.error("Radius deployment states could not load.", error);
      });

  const stopGraphPolling = (): void => {
    if (graphTimer !== null) entry.cancel(graphTimer);
    graphTimer = null;
  };

  const showNothing = (message: string): void => {
    if (status) status.style.display = "none";
    controller?.destroy();
    controller = null;
    renderedBranch = "";
    const container = context.dom.byId("graph-container");
    if (container) {
      container.innerHTML = "";
      container.className = "";
      const empty = context.dom.createElement("div");
      empty.className = "status info";
      empty.textContent = message;
      container.appendChild(empty);
    }
  };

  const setModeNote = (message: string): void => {
    if (!note) return;
    note.textContent = message;
    note.style.display = message ? "block" : "none";
  };

  const describeMode = (
    mode: string,
    updatedAt: string,
    shownApplication: string
  ): string => {
    if (mode === "greyed") {
      return "Not deployed yet — showing the modeled application.";
    }
    const timestamp = Date.parse(updatedAt);
    const age =
      Number.isFinite(timestamp) ?
        Math.max(0, Math.round((context.clock.now() - timestamp) / 1000))
      : 0;
    const suffix =
      timestamp ?
        ` · updated ${
          age < 60 ? `${age}s`
          : age < 3600 ? `${Math.round(age / 60)}m`
          : `${Math.round(age / 3600)}h`
        } ago`
      : "";
    const selected = selectedApplication();
    const appNote =
      (
        shownApplication &&
        selected &&
        shownApplication.toLowerCase() !== selected.toLowerCase()
      ) ?
        ` · showing ${shownApplication}`
      : "";
    return mode === "live" ?
        `Deploying${suffix}${appNote} · refreshes every ${DEPLOYED_GRAPH_POLL_MS / 1000}s`
      : `Last deployment${suffix}${appNote}.`;
  };

  const scheduleGraphPoll = (): void => {
    stopGraphPolling();
    if (
      lastMode !== "live" ||
      context.dom.document.visibilityState === "hidden"
    ) {
      return;
    }
    graphTimer = entry.after(DEPLOYED_GRAPH_POLL_MS, loadGraph);
  };

  const loadGraph = (): void => {
    stopGraphPolling();
    if (!page.repo) {
      showNothing("Nothing deployed yet");
      return;
    }
    if (status && !controller) {
      status.style.display = "";
      status.textContent = "Loading deployed application graph…";
    }
    graphAbort?.abort();
    graphAbort = context.net.createAbort();
    const requestGeneration = ++graphGeneration;
    graphRequestInFlight = true;
    let url = `/api/deployed-graph?repo=${encodeURIComponent(page.repo)}`;
    if (selectedApplication()) {
      url += `&application=${encodeURIComponent(selectedApplication())}`;
    }
    if (selectedEnvironment()) {
      url += `&environment=${encodeURIComponent(selectedEnvironment())}`;
    }
    void context.net
      .fetch(url, graphAbort ? { signal: graphAbort.signal } : undefined)
      .then((response) => response.json())
      .then((payload) => {
        if (requestGeneration !== graphGeneration) return;
        const resources = parseGraphResources(readArray(payload, "resources"));
        lastMode = readString(payload, "mode") || "greyed";
        if (resources.length === 0) {
          showNothing("Nothing deployed yet");
          setModeNote("");
        } else {
          if (status) status.style.display = "none";
          const branch = readString(payload, "branch") || page.graphBranch;
          if (controller && renderedBranch === branch) {
            controller = controller.update(resources) ?? controller;
          } else {
            controller?.destroy();
            controller = asGraphController(
              renderGraph("graph-container", resources, {
                repoUrl: githubRepositoryUrl(page.repo),
                branch,
                showLegend: true,
                deployMode: true
              })
            );
            renderedBranch = branch;
          }
          setModeNote(
            describeMode(
              lastMode,
              readString(payload, "updatedAt"),
              readString(payload, "application")
            )
          );
        }
        if (lastMode === "live") startLogStream();
        scheduleGraphPoll();
      })
      .catch((error: unknown) => {
        if (!entry.active || requestGeneration !== graphGeneration) return;
        context.logger.error("Radius deployed graph request failed.", error);
        if (!controller && status) {
          status.style.display = "";
          status.className = "status error";
          status.textContent =
            "The deployed application graph could not be loaded.";
        }
        scheduleGraphPoll();
      })
      .then(() => {
        if (requestGeneration === graphGeneration) {
          graphAbort = null;
          graphRequestInFlight = false;
        }
      });
  };

  const stopLogStream = (): void => {
    if (logTimer !== null) entry.cancel(logTimer);
    logTimer = null;
  };

  const pollLogs = (): void => {
    void context.net
      .fetch(`/api/deploy-status?since=${logTotal}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!entry.active) return;
        const lines = readStringArray(payload, "logsNew");
        if (logOutput && lines.length > 0) {
          logOutput.textContent = `${logOutput.textContent ?? ""}${lines.join("\n")}\n`;
          context.dom.scrollToEnd(logOutput);
        }
        logTotal = readNumber(payload, "logTotal") ?? logTotal;
        const deployStatus = readString(payload, "status");
        if (
          deployStatus === "complete" ||
          deployStatus === "success" ||
          deployStatus === "failed"
        ) {
          stopLogStream();
        }
      })
      .catch((error: unknown) => {
        context.logger.error("Radius deployment log request failed.", error);
      });
  };

  const startLogStream = (): void => {
    if (logTimer !== null) return;
    if (logSection) logSection.style.display = "block";
    pollLogs();
    logTimer = entry.every(DEPLOYED_LOG_POLL_MS, pollLogs);
  };

  const loadApplications = (): Promise<void> =>
    context.net
      .fetch(`/api/list-applications?repo=${encodeURIComponent(page.repo)}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!appSelect) return;
        const applications = parseApplicationListing(payload);
        context.dom.setOptions(
          appSelect,
          applications.length > 0 ?
            applications.map((application) => ({
              value: application.name,
              label: application.name,
              selected:
                application.name ===
                queryValue(context.nav.search, "application")
            }))
          : [{ value: "", label: "No applications" }]
        );
      })
      .catch((error: unknown) => {
        context.logger.error("Radius applications could not load.", error);
        if (appSelect) {
          context.dom.setOptions(appSelect, [
            { value: "", label: "Could not load" }
          ]);
        }
      });

  const loadEnvironments = (): Promise<void> =>
    context.net
      .fetch(`/api/list-environments?repo=${encodeURIComponent(page.repo)}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!envSelect) return;
        const listing = parseEnvironmentListing(payload);
        hasEnvironments = listing.environments.length > 0;
        for (const environment of listing.environments) {
          providers[environment.name] = environment.provider;
        }
        context.dom.setOptions(
          envSelect,
          hasEnvironments ?
            buildEnvironmentOptions(
              listing.environments,
              queryValue(context.nav.search, "environment")
            )
          : [{ value: "", label: "No environments" }]
        );
      })
      .catch((error: unknown) => {
        hasEnvironments = false;
        context.logger.error("Radius environments could not load.", error);
        if (envSelect) {
          context.dom.setOptions(envSelect, [
            { value: "", label: "Could not load" }
          ]);
        }
      });

  const runDelete = (application: string, environment: string): void => {
    const modal = context.dom.byId("deployed-deleting-modal");
    const text = context.dom.byId("deployed-deleting-text");
    if (text) {
      text.textContent = `Deleting application ${application} from ${environment} with rad app delete. This may take a few minutes.`;
    }
    if (modal) modal.style.display = "flex";
    void context.net
      .fetch("/api/delete-deployment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: page.repo,
          environment,
          application
        })
      })
      .then((response) =>
        response.json().then((payload) => ({ response, payload }))
      )
      .then(({ response, payload }) => {
        if (!entry.active) return;
        if (modal) modal.style.display = "none";
        if (!response.ok) {
          setInline(
            context,
            "error",
            readString(payload, "error") ||
              "Could not start the delete workflow."
          );
          return;
        }
        context.nav.assign("/?page=deploying");
      })
      .catch((error: unknown) => {
        if (!entry.active) return;
        if (modal) modal.style.display = "none";
        context.logger.error("Radius deployment delete failed.", error);
        setInline(
          context,
          "error",
          "Could not delete the deployment. Please try again."
        );
      });
  };

  const createDialog = optionalBrowserFunction(
    globalScope,
    "radiusCreateDeleteDeploymentDialog"
  );
  const dialog =
    createDialog ?
      asDeleteDialog(createDialog({ onConfirm: runDelete }))
    : null;
  if (dialog?.teardown) entry.onTeardown(dialog.teardown);

  if (appSelect) {
    entry.on(appSelect, "change", () => {
      refreshControls();
      loadGraph();
    });
  }
  if (envSelect) {
    entry.on(envSelect, "change", () => {
      refreshControls();
      loadGraph();
    });
  }
  if (action) {
    entry.on(action, "click", () => {
      const mode = action.dataset.mode;
      if (mode === "create-env") {
        context.nav.assign("/?page=environment&new=1");
      } else if (mode === "deploy") {
        void deployDeployedApp(
          context,
          action,
          page.repo,
          page.branch,
          providers,
          page.provider
        );
      } else if (dialog && selectedApplication() && selectedEnvironment()) {
        dialog.open(selectedApplication(), selectedEnvironment());
      }
    });
  }
  entry.on(context.dom.document, "visibilitychange", () => {
    if (context.dom.document.visibilityState === "hidden") {
      stopGraphPolling();
      resumeGraphOnVisible = graphRequestInFlight || lastMode === "live";
      graphGeneration++;
      graphAbort?.abort();
      graphAbort = null;
      graphRequestInFlight = false;
    } else if (resumeGraphOnVisible && graphTimer === null) {
      resumeGraphOnVisible = false;
      loadGraph();
    }
  });

  void Promise.all([
    loadApplications(),
    loadEnvironments(),
    loadDeploymentStates()
  ]).then(() => {
    if (!entry.active) return;
    refreshControls();
    loadGraph();
  });

  entry.onTeardown(() => {
    graphGeneration++;
    graphAbort?.abort();
    graphAbort = null;
    graphRequestInFlight = false;
    stopStatePolling();
    stopGraphPolling();
    stopLogStream();
    controller?.destroy();
    controller = null;
  });
  return () => entry.teardown();
}
