import type {
  MountedRadiusGraph,
  RadiusGraphProps
} from "@radius-project/graph-react";
import { safeExternalUrl } from "@radius-project/graph-react/presentation";
import type {
  GraphOptions,
  GraphResource
} from "@radius-project/graph-react/presentation";
import type { BrowserContext, DomElement } from "../ports.js";
import { isCallable, isRecord } from "../json.js";

export const GRAPH_LIBRARY_ERROR =
  "The graph library failed to load. Reload the graph to try again.";
export const GRAPH_RENDER_ERROR =
  "The application graph could not be rendered. Reload the graph to try again.";
export const OPEN_SOURCE_PATH = "/api/open-source";
export const GRAPH_LOADING_HTML =
  '<div style="padding:20px; max-width:560px; margin:0 auto;"><div id="progress-steps"></div></div>';

export interface GraphController {
  update(resources: readonly GraphResource[] | null): GraphController | null;
  destroy(): void;
}

export type GraphMount = (
  host: unknown,
  props: RadiusGraphProps
) => MountedRadiusGraph;

export function asGraphController(value: unknown): GraphController | null {
  if (
    !isRecord(value) ||
    !isCallable(value.update) ||
    !isCallable(value.destroy)
  )
    return null;
  const update = value.update;
  const destroy = value.destroy;
  return {
    update: (resources) => asGraphController(update(resources)),
    destroy: () => {
      destroy();
    }
  };
}

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
  mounted: MountedRadiusGraph;
  host: DomElement;
}

/** Canvas owns roots and host I/O; graph-react owns all graph behavior and rendering. */
export function createGraphSurface(
  context: BrowserContext,
  resolveMount: () => GraphMount | null
): GraphSurface {
  const active = new Map<string, ActiveRender>();

  function openExternal(url: string): void {
    const safe = safeExternalUrl(url);
    if (safe) context.external.open(safe);
  }

  function openLocalSource(
    path: string,
    line: number,
    fallbackUrl: string,
    isActive: () => boolean = () => true
  ): void {
    if (!isActive()) return;
    if (!path) {
      openExternal(fallbackUrl);
      return;
    }
    context.net
      .fetch(OPEN_SOURCE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, line: line || 0 })
      })
      .then(
        (response) => {
          if (!response.ok && isActive()) openExternal(fallbackUrl);
        },
        () => {
          if (isActive()) openExternal(fallbackUrl);
        }
      );
  }

  function teardown(id: string, owner?: ActiveRender): void {
    const current = active.get(id);
    if (!current || (owner && owner !== current)) return;
    active.delete(id);
    try {
      current.mounted.unmount();
    } finally {
      current.host.remove();
    }
  }

  function showError(
    container: DomElement,
    message: string,
    retry: boolean
  ): void {
    container.innerHTML = "";
    const status = context.dom.createElement("div");
    status.className = "status error";
    status.setAttribute("role", "alert");
    status.textContent = message;
    container.appendChild(status);
    if (retry) {
      const button = context.dom.createElement("button");
      button.setAttribute("type", "button");
      button.className = "rad-btn rad-btn--secondary";
      button.textContent = "Reload graph";
      button.addEventListener("click", () => context.nav.reload());
      container.appendChild(button);
    }
  }

  return {
    render(id, resources, options = {}) {
      const container = context.dom.byId(id);
      if (!container) return null;
      let host: DomElement | null = null;
      try {
        teardown(id);
        const mount = resolveMount();
        if (!mount) {
          showError(container, GRAPH_LIBRARY_ERROR, true);
          return null;
        }
        container.innerHTML = "";
        container.style.position = "relative";
        container.style.minHeight = "450px";
        host = context.dom.createElement("div");
        host.className = "rad-flow-host";
        container.appendChild(host);
        const isActive = () => active.get(id)?.host === host;
        const callbacks: NonNullable<RadiusGraphProps["callbacks"]> = {
          onOpenExternal: (url) => {
            if (isActive()) openExternal(url);
          },
          onOpenSource: ({ path, line, fallbackUrl }) =>
            openLocalSource(path, line, fallbackUrl, isActive),
          onRetry: () => {
            if (isActive()) context.nav.reload();
          }
        };
        const propsFor = (
          next: readonly GraphResource[]
        ): RadiusGraphProps => ({
          graph: {
            kind:
              options.diffMode ? "diff"
              : options.deployMode ? "deployed-projection"
              : options.plannedMode ? "planned"
              : "modeled",
            resources: next
          },
          options,
          callbacks
        });
        const record: ActiveRender = {
          mounted: mount(host, propsFor(resources ?? [])),
          host
        };
        active.set(id, record);
        const controller: GraphController = {
          update(next) {
            if (active.get(id) === record && next)
              record.mounted.update(propsFor(next));
            return controller;
          },
          destroy() {
            teardown(id, record);
          }
        };
        return controller;
      } catch (error) {
        host?.remove();
        context.logger.error("Rendering the application graph failed.", error);
        showError(container, GRAPH_RENDER_ERROR, true);
        return null;
      }
    },
    setLoading(id) {
      const container = context.dom.byId(id);
      if (!container) return;
      teardown(id);
      container.innerHTML = GRAPH_LOADING_HTML;
    },
    setError(id, message) {
      const container = context.dom.byId(id);
      if (!container) return;
      teardown(id);
      showError(container, message, false);
    },
    openExternal,
    openLocalSource,
    destroyAll() {
      const errors: unknown[] = [];
      for (const id of [...active.keys()]) {
        try {
          teardown(id);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          "Graph roots could not all be unmounted."
        );
    }
  };
}
