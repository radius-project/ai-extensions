// Canvas adapter — the graph renderer surface (BU-04, BU-05, BU-06).
//
// The public browser API the graph pages call: render a graph into a container,
// update it in place while a deployment runs, and show the loading and error
// states. Everything it needs — DOM, network, clock, external opening and the
// vendored libraries — arrives through ports, and each rendered container's
// React root, details panel and legend are owned here so a second render on the
// same container replaces them instead of stacking.

import { buildGraph, resolveGraphSettings } from "./build.js";
import { createDetailsPanel, safeExternalUrl } from "./details.js";
import { layoutGraph } from "./layout.js";
import {
  buildCategoryLegendHtml,
  buildStatusLegendHtml,
  collectLegendCategories
} from "./legend.js";
import { mountGraph } from "./view.js";
import type { GraphNodeData, GraphOptions, GraphSettings } from "./build.js";
import type { DetailsPanel } from "./details.js";
import type { GraphResource } from "./model.js";
import type { MountedGraph } from "./view.js";
import type { GraphVendor } from "./vendor.js";
import type { BrowserContext, DomElement, DomParentElement } from "../ports.js";
import { isCallable, isRecord } from "../json.js";

export const GRAPH_LIBRARY_ERROR =
  "The graph library failed to load. Reload the graph to try again.";
export const GRAPH_RENDER_ERROR =
  "The application graph could not be rendered. Reload the graph to try again.";

export const OPEN_SOURCE_PATH = "/api/open-source";

const FLOW_HOST_CLASS = "rad-flow-host";
const FLOW_HOST_STYLE = "position:absolute; inset:0; width:100%; height:100%;";
const LEGEND_CLASS = "legend";

// The panel rendered by src/browser/graph/progress.ts supplies the spinner,
// title, activity line, elapsed clock and stage list, so this fragment only
// mounts the host it draws into.
export const GRAPH_LOADING_HTML =
  '<div style="padding:20px; max-width:560px; margin:0 auto;">' +
  '<div id="progress-steps"></div>' +
  "</div>";

// A rendered graph. update() re-lays out a new resource list and pushes it into
// the mounted view, preserving the viewport; destroy() unmounts everything the
// render created.
export interface GraphController {
  update(resources: readonly GraphResource[] | null): GraphController | null;
  destroy(): void;
}

export function asGraphController(value: unknown): GraphController | null {
  if (
    !isRecord(value) ||
    !isCallable(value.update) ||
    !isCallable(value.destroy)
  ) {
    return null;
  }
  const update = value.update;
  const destroy = value.destroy;
  return {
    update(resources) {
      return asGraphController(update(resources));
    },
    destroy() {
      destroy();
    }
  };
}

function isParentElement(value: unknown): value is DomParentElement {
  return (
    isRecord(value) &&
    isCallable(value.querySelectorAll) &&
    isCallable(value.insertBefore) &&
    isCallable(value.replaceChild)
  );
}

function parentOf(element: DomElement): DomParentElement | null {
  return isParentElement(element.parentNode) ? element.parentNode : null;
}

// Everything one document's graph containers share. Held in the entry's closure,
// so it is per-page state rather than a global or a module-level cache.
export interface GraphSurface {
  render(
    containerId: string,
    resources: readonly GraphResource[] | null,
    options?: GraphOptions
  ): GraphController | null;
  setLoading(containerId: string): void;
  setError(containerId: string, message: string): void;
  openExternal(url: string): void;
  openLocalSource(relPath: string, line: number, fallbackUrl: string): void;
  destroyAll(): void;
}

interface ActiveRender {
  mounted: MountedGraph | null;
  panel: DetailsPanel | null;
  host: DomElement | null;
  legend: DomElement | null;
}

export function createGraphSurface(
  context: BrowserContext,
  resolveVendor: () => GraphVendor | null
): GraphSurface {
  const active = new Map<string, ActiveRender>();

  // Open an external URL the way clicking a native target="_blank" anchor
  // would, which the host opens in the system browser.
  function openExternal(url: string): void {
    const safeUrl = safeExternalUrl(url);
    if (safeUrl) context.external.open(safeUrl);
  }

  // Open a repo-relative worktree file in the Copilot editor canvas. The
  // webview has no SDK session handle, so it asks the local canvas server,
  // which opens the file in the editor. localSource is a coarse page-level flag
  // (repo and branch match the workspace), so a file that is not actually on
  // this checkout answers non-2xx and the page attempts the remote fallback.
  function openLocalSource(
    relPath: string,
    line: number,
    fallbackUrl: string
  ): void {
    if (!relPath) {
      openExternal(fallbackUrl);
      return;
    }
    context.net
      .fetch(OPEN_SOURCE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: relPath, line: line || 0 })
      })
      .then(
        (response) => {
          if (!response.ok) openExternal(fallbackUrl);
        },
        () => openExternal(fallbackUrl)
      );
  }

  function showRenderError(container: DomElement, detail: string): void {
    container.innerHTML = "";
    const error = context.dom.createElement("div");
    error.className = "status error";
    error.textContent = detail;
    const retry = context.dom.createElement("button");
    retry.setAttribute("type", "button");
    retry.className = "rad-btn rad-btn--secondary";
    retry.style.marginTop = "10px";
    retry.textContent = "Reload graph";
    retry.addEventListener("click", () => context.nav.reload());
    container.appendChild(error);
    container.appendChild(retry);
  }

  function teardown(containerId: string, owner?: ActiveRender): void {
    const current = active.get(containerId);
    if (!current) return;
    if (owner !== undefined && current !== owner) return;
    active.delete(containerId);
    if (current.mounted) current.mounted.unmount();
    if (current.panel) current.panel.destroy();
    if (current.host) current.host.remove();
    if (current.legend) current.legend.remove();
  }

  // Clear DOM a prior render created (its React host and details panel) plus any
  // legend left beside the container, so re-rendering never stacks duplicates.
  function clearPriorRender(container: DomElement): void {
    for (const stale of context.dom.all(
      container,
      ".rad-flow-host, #node-popup"
    )) {
      stale.remove();
    }
    const parent = parentOf(container);
    if (!parent) return;
    for (const legend of Array.prototype.slice.call(
      parent.querySelectorAll("." + LEGEND_CLASS)
    ) as DomElement[]) {
      legend.remove();
    }
  }

  function renderLegend(
    container: DomElement,
    settings: GraphSettings,
    resources: readonly GraphResource[]
  ): DomElement | null {
    // Diff mode intentionally shows no legend; status is encoded directly on
    // node borders and edges.
    if (!settings.showLegend || settings.diffMode) return null;
    const parent = parentOf(container);
    if (!parent) return null;
    if (settings.deployMode) {
      const legend = context.dom.createElement("div");
      legend.className = LEGEND_CLASS;
      legend.innerHTML = buildStatusLegendHtml(resources);
      parent.insertBefore(legend, container);
      return legend;
    }
    const categories = collectLegendCategories(resources);
    if (categories.length === 0) return null;
    const legend = context.dom.createElement("div");
    legend.className = LEGEND_CLASS;
    legend.innerHTML = buildCategoryLegendHtml(categories);
    parent.insertBefore(legend, container);
    return legend;
  }

  function emptyController(
    containerId: string,
    container: DomElement,
    options: GraphOptions,
    record: ActiveRender
  ): GraphController {
    const controller: GraphController = {
      update(next) {
        if (active.get(containerId) !== record) return controller;
        if (!next) return controller;
        if (next.length === 0) {
          container.innerHTML = "";
          return controller;
        }
        return render(containerId, next, options) ?? controller;
      },
      destroy() {
        teardown(containerId, record);
      }
    };
    return controller;
  }

  function renderUnsafe(
    containerId: string,
    container: DomElement,
    resources: readonly GraphResource[] | null,
    options: GraphOptions
  ): GraphController | null {
    // The graph libraries are inlined into the page. If that bundle is missing,
    // surface a recoverable message instead of throwing and breaking the panel.
    const vendor = resolveVendor();
    if (!vendor) {
      showRenderError(container, GRAPH_LIBRARY_ERROR);
      return null;
    }

    teardown(containerId);
    clearPriorRender(container);

    const settings = resolveGraphSettings(options);
    if (!resources || resources.length === 0) {
      const record: ActiveRender = {
        mounted: null,
        panel: null,
        host: null,
        legend: null
      };
      active.set(containerId, record);
      container.innerHTML = "";
      return emptyController(containerId, container, options, record);
    }

    container.innerHTML = "";
    // The graph pages set this through CSS; React Flow's absolutely positioned
    // host anchors to the container, so establish the positioning context here
    // as well for any caller that does not.
    container.style.position = "relative";
    container.style.display = "block";
    container.style.minHeight = "450px";

    const built = buildGraph(settings, resources);
    layoutGraph(vendor.dagre, built.nodes, built.edges);

    const record: ActiveRender = {
      mounted: null,
      panel: null,
      host: null,
      legend: null
    };
    active.set(containerId, record);

    // Mount React into a child host so the details panel and legend (siblings
    // of the flow) are never clobbered by React's DOM reconciliation.
    const host = context.dom.createElement("div");
    host.className = FLOW_HOST_CLASS;
    host.setAttribute("style", FLOW_HOST_STYLE);
    container.appendChild(host);
    record.host = host;

    const panel =
      settings.enablePopup ?
        createDetailsPanel(context, container, settings, {
          openExternal,
          openLocalSource
        })
      : null;
    record.panel = panel;

    const openDetails = (
      data: GraphNodeData,
      card: DomElement | null
    ): void => {
      if (panel && card) panel.open(data, card);
    };
    const toggleDetails = (
      data: GraphNodeData,
      card: DomElement | null
    ): void => {
      if (panel && card) panel.toggle(data, card);
    };

    const mounted = mountGraph({
      vendor,
      clock: context.clock,
      host,
      settings,
      deps: { openExternal, openLocalSource, openDetails, toggleDetails },
      reload: () => context.nav.reload(),
      nodes: built.nodes,
      edges: built.edges
    });
    record.mounted = mounted;

    record.legend = renderLegend(container, settings, built.resources);

    const controller: GraphController = {
      update(next) {
        if (active.get(containerId) !== record) return controller;
        if (!next) return controller;
        if (next.length === 0) {
          controller.destroy();
          return render(containerId, [], options);
        }
        const rebuilt = buildGraph(settings, next);
        layoutGraph(vendor.dagre, rebuilt.nodes, rebuilt.edges);
        if (record.legend) {
          record.legend.innerHTML =
            settings.deployMode ?
              buildStatusLegendHtml(rebuilt.resources)
            : buildCategoryLegendHtml(
                collectLegendCategories(rebuilt.resources)
              );
        }
        if (!mounted.update(rebuilt.nodes, rebuilt.edges)) {
          return render(containerId, next, options);
        }
        return controller;
      },
      destroy() {
        teardown(containerId, record);
      }
    };
    return controller;
  }

  function render(
    containerId: string,
    resources: readonly GraphResource[] | null,
    options: GraphOptions = {}
  ): GraphController | null {
    const container = context.dom.byId(containerId);
    if (!container) return null;
    try {
      return renderUnsafe(containerId, container, resources, options);
    } catch (error) {
      context.logger.error("Rendering the application graph failed.", error);
      showRenderError(container, GRAPH_RENDER_ERROR);
      return null;
    }
  }

  return {
    render,
    setLoading(containerId) {
      const container = context.dom.byId(containerId);
      if (!container) return;
      teardown(containerId);
      container.innerHTML = GRAPH_LOADING_HTML;
    },
    setError(containerId, message) {
      const container = context.dom.byId(containerId);
      if (!container) return;
      teardown(containerId);
      // Built as an element with text rather than interpolated markup: the
      // message can carry a server or provider string, which must never be able
      // to become markup.
      container.innerHTML = "";
      const status = context.dom.createElement("div");
      status.className = "status error";
      status.setAttribute("role", "alert");
      status.textContent = message;
      container.appendChild(status);
    },
    openExternal,
    openLocalSource,
    destroyAll() {
      for (const containerId of [...active.keys()]) teardown(containerId);
    }
  };
}
