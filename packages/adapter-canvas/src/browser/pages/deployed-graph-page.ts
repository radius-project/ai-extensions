import { optionalBrowserFunction, requireBrowserFunction } from "../globals.js";
import { asGraphController } from "../graph/surface.js";
import { createGraphProgress } from "../graph/progress.js";
import { githubRepositoryUrl, parseGraphResources } from "../graph/model.js";
import { createEnvironmentConfirmDialog } from "../environment/confirm-dialog.js";
import {
  DELETE_FAILED_STATUS,
  FORCE_DELETE_ORPHAN_NOTICE,
  forceDeletePrompt,
  probeDeleteConflict
} from "../force-delete.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { queryValue } from "../query.js";
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
import type { BrowserTeardown, ScopeTimer } from "../lifecycle.js";
import type { GraphController } from "../graph/surface.js";
import type { GraphProgressView } from "../graph/progress.js";
import type { AbortHandle, BrowserContext, DomInputElement } from "../ports.js";
import type { EnvironmentProviders } from "../repositories.js";
import { readPageState } from "./state.js";

const ENTRY_KEY = "deployed-graph-page";
export const DEPLOYED_GRAPH_STATE_ID = "radius-deployed-graph-state";
export const DEPLOYED_GRAPH_POLL_MS = 15_000;
export const DEPLOYED_PROGRESS_STEPS_ID = "deployed-progress-steps";
export const DEPLOYED_STATE_POLL_MS = 4_000;
export const DEPLOYED_LOG_POLL_MS = 1_500;
export const DEPLOYED_STATE_POLL_LIMIT = 45;

interface DeployedPageState {
  repo: string;
  branch: string;
  graphBranch: string;
  provider: string;
  mutationNonce: string;
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
    provider: readString(state, "provider") || "azure",
    mutationNonce: readString(state, "mutationNonce")
  };
}

function deploymentKey(application: string, environment: string): string {
  return `${encodeURIComponent(application)}|${encodeURIComponent(environment)}`;
}

function isTerminalDeployStatus(value: string): boolean {
  return value === "complete" || value === "success" || value === "failed";
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
  const stopTrackingAction = context.dom.inputById(
    "deployed-stop-tracking-btn"
  );
  const status = context.dom.byId("deployed-status");
  const label = context.dom.byId("deployed-graph-label");
  const note = context.dom.byId("deployed-mode-note");
  const logSection = context.dom.byId("deployed-log-section");
  const logOutput = context.dom.byId("deployed-log-output");
  const renderGraph = requireBrowserFunction(globalScope, "radiusRenderGraph");
  const entry = beginEntry(context, ENTRY_KEY);
  if (!entry) return NOOP_TEARDOWN;
  const providers: EnvironmentProviders = {};
  const environmentStatuses: Record<string, string> = {};
  const adaptive = createDeployedState();
  const deployments = new Map<string, string>();
  let hasEnvironments = false;
  let environmentsUnavailable = false;
  let deploymentStatesStale = false;
  let statePolls = 0;
  let stateTimer: ScopeTimer | null = null;
  let graphTimer: ScopeTimer | null = null;
  let logTimer: ScopeTimer | null = null;
  let logStreamStarted = false;
  let logRequestInFlight = false;
  let logGeneration = 0;
  let logAttemptId: string | null | undefined;
  let graphAbort: AbortHandle | null = null;
  let graphGeneration = 0;
  let logTotal = 0;
  let lastMode = "";
  let modeledGraphPending = false;
  let controller: GraphController | null = null;
  let renderedBranch = "";
  let renderedLegend: boolean | null = null;
  let resumeGraphOnVisible = false;
  let graphRequestInFlight = false;
  let progressView: GraphProgressView | null = null;

  const stopProgress = (): void => {
    progressView?.stop();
    progressView = null;
    const host = context.dom.byId(DEPLOYED_PROGRESS_STEPS_ID);
    if (host) host.replaceChildren();
  };

  // Leave the panel on screen showing which stage failed, rather than clearing
  // it and leaving only the status banner to explain the outcome.
  const failProgress = (detail: string): void => {
    progressView?.fail(detail);
    progressView = null;
  };

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
      deploymentStatesStale,
      environmentsUnavailable,
      environmentStatuses[environment] ?? ""
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
    renderedLegend = null;
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
      (lastMode !== "live" && !modeledGraphPending) ||
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
    // Only the first load makes the user wait. Background refreshes of an
    // already-rendered graph must not flash a progress panel over it.
    if (!controller) {
      stopProgress();
      progressView = createGraphProgress(context, entry, {
        hostId: DEPLOYED_PROGRESS_STEPS_ID,
        title: "Loading the deployed graph",
        initial: {
          sequence: 0,
          stage: "loading_deployment",
          state: "running",
          detail: "Reading the resources deployed to this environment."
        }
      });
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
        stopProgress();
        const loadError = readString(payload, "error");
        if (loadError) {
          modeledGraphPending = isRecord(payload) && payload.retry === true;
          if (!controller && status) {
            status.style.display = "";
            status.className = "status error";
            status.textContent = loadError;
          } else {
            setModeNote(loadError);
          }
          scheduleGraphPoll();
          return;
        }
        modeledGraphPending = false;
        const resources = parseGraphResources(readArray(payload, "resources"));
        lastMode = readString(payload, "mode") || "greyed";
        if (resources.length === 0) {
          showNothing("Nothing deployed yet");
          setModeNote("");
        } else {
          if (status) status.style.display = "none";
          const branch = readString(payload, "branch") || page.graphBranch;
          const showLegend = lastMode !== "greyed";
          if (
            controller &&
            renderedBranch === branch &&
            renderedLegend === showLegend
          ) {
            controller = controller.update(resources) ?? controller;
          } else {
            controller?.destroy();
            controller = asGraphController(
              renderGraph("graph-container", resources, {
                repoUrl: githubRepositoryUrl(page.repo),
                branch,
                showLegend,
                deployMode: true
              })
            );
            renderedBranch = branch;
            renderedLegend = showLegend;
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
        const message = "The deployed application graph could not be loaded.";
        // Report the failure once: in the status banner when there is one, and
        // otherwise on the panel, which is the only surface a rendered graph
        // leaves available.
        if (!controller && status) {
          stopProgress();
          status.style.display = "";
          status.className = "status error";
          status.textContent = message;
        } else {
          failProgress(message);
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
    logStreamStarted = false;
    logRequestInFlight = false;
    logGeneration++;
  };

  const appendLogLines = (lines: readonly string[]): void => {
    if (!logOutput || lines.length === 0) return;
    logOutput.textContent = `${logOutput.textContent ?? ""}${lines.join("\n")}\n`;
    context.dom.scrollToEnd(logOutput);
  };

  const readDeployAttemptId = (payload: unknown): string | null =>
    readString(isRecord(payload) ? payload.attempt : null, "id") || null;

  const trackLogAttempt = (attemptId: string | null): boolean => {
    if (logAttemptId === undefined) {
      logAttemptId = attemptId;
      logTotal = 0;
      return false;
    }
    if (logAttemptId === attemptId) return false;
    logAttemptId = attemptId;
    logTotal = 0;
    return true;
  };

  const fetchLogs = (since: number, generation: number): Promise<void> =>
    context.net
      .fetch(`/api/deploy-status?since=${since}`)
      .then((response) => response.json())
      .then((payload) => {
        if (!entry.active || generation !== logGeneration) return;
        if (trackLogAttempt(readDeployAttemptId(payload)) && since !== 0) {
          return fetchLogs(0, generation);
        }
        const lines = readStringArray(payload, "logsNew");
        appendLogLines(lines);
        logTotal = Math.max(
          logTotal,
          readNumber(payload, "logTotal") ?? since + lines.length
        );
        if (isTerminalDeployStatus(readString(payload, "status"))) {
          stopLogStream();
        }
      })
      .catch((error: unknown) => {
        if (!entry.active || generation !== logGeneration) return;
        context.logger.error("Radius deployment log request failed.", error);
      });

  const pollLogs = (): void => {
    if (!logStreamStarted || logRequestInFlight) return;
    const generation = logGeneration;
    logRequestInFlight = true;
    void fetchLogs(logTotal, generation).finally(() => {
      if (generation === logGeneration) logRequestInFlight = false;
    });
  };

  // Pull the retained buffer once, then stream incrementally. The interval is
  // armed only after that first response resolves, because two requests sharing
  // the same cursor would each append the whole buffer. The attempt identity
  // decides when that cursor resets; reopening the same feed resumes it.
  const startLogStream = (attemptId?: string | null): void => {
    const identifiesActiveStream =
      attemptId !== undefined && logAttemptId === undefined && logStreamStarted;
    const attemptChanged =
      attemptId === undefined ? false : trackLogAttempt(attemptId);
    if (logStreamStarted && (identifiesActiveStream || attemptChanged)) {
      stopLogStream();
    }
    if (logStreamStarted) return;
    logStreamStarted = true;
    const generation = ++logGeneration;
    logRequestInFlight = true;
    if (logSection) logSection.style.display = "block";
    void fetchLogs(logTotal, generation).finally(() => {
      if (!entry.active || !logStreamStarted || generation !== logGeneration) {
        return;
      }
      logRequestInFlight = false;
      logTimer = entry.every(DEPLOYED_LOG_POLL_MS, pollLogs);
    });
  };

  // Show the deploy feed whenever this session produced one, including after the
  // run finished — a failed deployment explains itself in that log, and its
  // graph is never "live".
  const maybeStartLogStream = (): Promise<void> =>
    context.net
      .fetch("/api/deploy-status")
      .then((response) => response.json())
      .then((payload) => {
        if (!entry.active) return;
        const deployStatus = readString(payload, "status");
        if (
          deployStatus === "in_progress" ||
          isTerminalDeployStatus(deployStatus) ||
          (readNumber(payload, "logTotal") ?? 0) > 0
        ) {
          startLogStream(readDeployAttemptId(payload));
        }
      })
      .catch((error: unknown) => {
        context.logger.error("Radius deployment status could not load.", error);
      });

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

  const markEnvironmentsUnavailable = (error: unknown): void => {
    hasEnvironments = false;
    environmentsUnavailable = true;
    context.logger.error("Radius environments could not load.", error);
    if (envSelect) {
      context.dom.setOptions(envSelect, [
        { value: "", label: "Could not load" }
      ]);
    }
  };

  const loadEnvironments = (): Promise<void> =>
    context.net
      .fetch(`/api/list-environments?repo=${encodeURIComponent(page.repo)}`)
      .then((response) => response.json())
      .then((payload) => {
        const listing = parseEnvironmentListing(payload);
        if (listing.error !== "") {
          markEnvironmentsUnavailable(listing.error);
          return;
        }
        environmentsUnavailable = false;
        hasEnvironments = listing.environments.length > 0;
        for (const environment of listing.environments) {
          providers[environment.name] = environment.provider;
          environmentStatuses[environment.name] = environment.status;
        }
        if (!envSelect) return;
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
        markEnvironmentsUnavailable(error);
      });

  const runDelete = (
    application: string,
    environment: string,
    force = false
  ): void => {
    const modal = context.dom.byId("deployed-deleting-modal");
    const text = context.dom.byId("deployed-deleting-text");
    if (text) {
      text.textContent =
        force ?
          `Force deleting application ${application} from ${environment} with rad app delete --force. ${FORCE_DELETE_ORPHAN_NOTICE}`
        : `Deleting application ${application} from ${environment} with rad app delete. This may take a few minutes.`;
    }
    if (modal) modal.style.display = "flex";
    void context.net
      .fetch("/api/delete-deployment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: page.repo,
          environment,
          application,
          force
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
        // The Deployments page owns the delete from here, and a forced delete
        // has to stay forced across the navigation: its completion message
        // repeats the orphan caution the user confirmed. The dispatched run
        // travels with it, since the deleting row carries no run URL.
        context.nav.assign(
          force ?
            `/?page=deploying&delete=forced&application=${encodeURIComponent(application)}&environment=${encodeURIComponent(environment)}&run=${encodeURIComponent(readString(payload, "runUrl"))}`
          : "/?page=deploying"
        );
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

  const runAbandon = (application: string, environment: string): void => {
    // This callback is reachable only from the stop-tracking control registered
    // below, so the control exists whenever the callback can run.
    /* v8 ignore next */
    if (stopTrackingAction) {
      stopTrackingAction.disabled = true;
      stopTrackingAction.textContent = "Stopping tracking…";
    }
    void context.net
      .fetch("/api/abandon-deployment", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Radius-Mutation-Nonce": page.mutationNonce
        },
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
        if (!response.ok || readString(payload, "outcome") !== "abandoned") {
          setInline(
            context,
            "error",
            response.status === 403 ?
              "This Radius Canvas page is out of date. Reload it and try again."
            : readString(payload, "error") ||
                "Could not stop tracking the deployment."
          );
          refreshControls();
          return;
        }
        deployments.delete(deploymentKey(application, environment));
        setInline(
          context,
          "info",
          "Stopped tracking this deployment. Cloud resources were not deleted and may still exist."
        );
        refreshControls();
        loadGraph();
      })
      .catch((error: unknown) => {
        if (!entry.active) return;
        context.logger.error(
          "Radius deployment tracking could not be stopped.",
          error
        );
        setInline(
          context,
          "error",
          "Could not stop tracking the deployment. Please try again."
        );
        refreshControls();
      });
  };

  // A delete that already failed may be stuck behind a resource the control
  // plane still holds. Only a server-proven conflict escalates the button to
  // the forced confirmation; anything else keeps the ordinary one.
  // The probe makes the server list and download a workflow artifact, so the
  // button can sit for seconds before the dialog opens. It is disabled for that
  // whole wait: without it the click looks ignored, and a second click would
  // start a second probe and open a second dialog behind the first.
  let deleteProbeInFlight = false;

  // The button is passed in rather than read from the outer binding: the only
  // caller is its own click handler, so there is always one to mark busy.
  const openDeleteDialog = (
    target: DeleteDialog,
    button: DomInputElement
  ): void => {
    const application = selectedApplication();
    const environment = selectedEnvironment();
    if (selectedStatus() !== DELETE_FAILED_STATUS) {
      target.open(application, environment);
      return;
    }
    if (deleteProbeInFlight) return;
    deleteProbeInFlight = true;
    button.disabled = true;
    void probeDeleteConflict(context, {
      repo: page.repo,
      environment,
      application
    }).then((result) => {
      deleteProbeInFlight = false;
      if (!entry.active) return;
      // `refreshControls` owns the button's enabled state, so the wait is
      // undone by recomputing it rather than by force-enabling a button the
      // page may since have had reason to keep disabled.
      refreshControls();
      if (!result.conflict || !forceConfirm) {
        target.open(application, environment);
        return;
      }
      forceConfirm.show({
        ...forceDeletePrompt(
          application,
          environment,
          result.resourceState,
          result.forced
        ),
        onConfirm: () => runDelete(application, environment, true)
      });
    });
  };

  // The lighter shared confirmation carries the forced-delete question, so it
  // reads like every other confirm in the product rather than repeating the
  // three-step flow the user already completed for the delete that failed.
  const forceConfirm = createEnvironmentConfirmDialog(context);
  if (forceConfirm) entry.onTeardown(() => forceConfirm.teardown());

  const createDialog = optionalBrowserFunction(
    globalScope,
    "radiusCreateDeleteDeploymentDialog"
  );
  const dialog =
    createDialog ?
      asDeleteDialog(
        createDialog({
          onConfirm: (application: string, environment: string) => {
            runDelete(application, environment);
          }
        })
      )
    : null;
  const abandonDialog =
    createDialog ?
      asDeleteDialog(
        createDialog({
          modalId: "deploy-abandon-modal",
          bodyId: "deploy-abandon-body",
          appId: "deploy-abandon-app",
          envId: "deploy-abandon-env",
          closeId: "deploy-abandon-close",
          variant: "abandon",
          onConfirm: runAbandon
        })
      )
    : null;
  if (dialog?.teardown) entry.onTeardown(dialog.teardown);
  if (abandonDialog?.teardown) entry.onTeardown(abandonDialog.teardown);

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
          page.provider,
          () => entry.active
        );
      } else if (dialog && selectedApplication() && selectedEnvironment()) {
        openDeleteDialog(dialog, action);
      }
    });
  }
  if (stopTrackingAction) {
    entry.on(stopTrackingAction, "click", () => {
      if (
        abandonDialog &&
        selectedStatus() === "delete-failed" &&
        selectedApplication() &&
        selectedEnvironment()
      ) {
        abandonDialog.open(selectedApplication(), selectedEnvironment());
      }
    });
  }
  entry.on(context.dom.document, "visibilitychange", () => {
    if (context.dom.document.visibilityState === "hidden") {
      stopGraphPolling();
      resumeGraphOnVisible =
        graphRequestInFlight || lastMode === "live" || modeledGraphPending;
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
    void maybeStartLogStream();
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
