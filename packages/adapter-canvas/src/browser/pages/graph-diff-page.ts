import { requireBrowserFunction } from "../globals.js";
import { asGraphController } from "../graph/surface.js";
import { createGraphProgress } from "../graph/progress.js";
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

const ENTRY_KEY = "graph-diff-page";
export const GRAPH_DIFF_STATE_ID = "radius-graph-diff-state";
export const DIFF_DEBOUNCE_MS = 500;
export const DIFF_PROGRESS_MS = 800;
export const DIFF_PROGRESS_STEPS_ID = "diff-progress-steps";

interface DiffState {
  repo: string;
  base: string;
  head: string;
  resources: unknown[];
}

function parseState(context: BrowserContext): DiffState {
  const state = readPageState(context, GRAPH_DIFF_STATE_ID);
  return {
    repo: readString(state, "repo"),
    base: readString(state, "base") || "main",
    head: readString(state, "head"),
    resources: readArray(state, "resources")
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

  const stopProgress = (): void => {
    if (progress !== null) entry.cancel(progress);
    progress = null;
    progressView?.stop();
    progressView = null;
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
        }
      })
      .catch((error: unknown) => {
        if (!entry.active || requestGeneration !== generation) return;
        context.logger.error("Radius graph diff progress failed.", error);
      });
  };

  const compare = (headElement: DomSelectElement): void => {
    pending = null;
    const base = baseSelect?.value ?? "";
    const head = headElement.value;
    const repo = repoInput?.value ?? state.repo;
    if (!repo || !base || !head) return;
    const requestGeneration = ++generation;
    requestAbort = context.net.createAbort();
    showStatus(context, `Comparing ${base} → ${head}…`, "info");
    stopProgress();
    const view = createGraphProgress(context, entry, {
      hostId: DIFF_PROGRESS_STEPS_ID,
      initial: {
        sequence: 0,
        stage: "building_base_graph",
        state: "running",
        detail: `Comparing ${base} → ${head}…`
      }
    });
    progressView = view;
    progress = entry.every(DIFF_PROGRESS_MS, () =>
      pollProgress(requestGeneration, view)
    );
    void context.net
      .fetch("/api/diff-branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base, head, repo }),
        signal: requestAbort?.signal
      })
      .then((response) => response.json())
      .then((payload) => {
        if (requestGeneration !== generation) return;
        stopProgress();
        if (readBoolean(payload, "needsAppBicep")) {
          showStatus(
            context,
            "Copilot is generating .radius/app.bicep with the Radius app-bicep skill… the diff will appear once it is saved.",
            "info"
          );
        } else {
          const error = readString(payload, "error");
          if (error) {
            showStatus(
              context,
              `Error computing diff: ${error}. Please ensure both branches exist and contain a valid .radius/app.bicep.`,
              "error"
            );
          } else if (readBoolean(payload, "reload")) {
            context.nav.reload();
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
    stopProgress();
    if (pending !== null) entry.cancel(pending);
    pending = entry.after(DIFF_DEBOUNCE_MS, () => compare(headElement));
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
    autoCompare: state.resources.length === 0,
    lifecycle: entry
  });

  if (renderGraph) {
    controller = asGraphController(
      renderGraph("graph-container", state.resources, {
        diffMode: true,
        repoUrl: githubRepositoryUrl(state.repo),
        branch: state.head,
        baseBranch: state.base
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
