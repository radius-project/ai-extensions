import { createGraphSurface } from "../graph/surface.js";
import {
  createGraphNavigation,
  initializeGraphNavigation
} from "../graph/navigation.js";
import { resolveGraphVendor } from "../graph/vendor.js";
import { publishBrowserGlobals } from "../globals.js";
import { isRecord } from "../json.js";
import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { resolvePageRegistry, runBrowserEntry } from "../registry.js";
import type { GraphOptions } from "../graph/build.js";
import type { GraphResource } from "../graph/model.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type { BrowserContext } from "../ports.js";

export const GRAPH_ENTRY_GLOBALS = [
  "radiusRenderGraph",
  "radiusSetGraphLoading",
  "radiusSetGraphError"
] as const;
const ENTRY_KEY = "graph-api";

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asResources(value: unknown): GraphResource[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is GraphResource => isRecord(entry));
}

function asOptions(value: unknown): GraphOptions {
  if (!isRecord(value)) return {};
  const options: GraphOptions = {};
  for (const name of [
    "diffMode",
    "deployMode",
    "plannedMode",
    "localSource",
    "showLegend",
    "enablePopup"
  ] as const) {
    if (typeof value[name] === "boolean") options[name] = value[name];
  }
  for (const name of [
    "repoUrl",
    "branch",
    "baseBranch",
    "lineType",
    "curveStyle"
  ] as const) {
    if (typeof value[name] === "string") options[name] = value[name];
  }
  return options;
}

export function installGraphEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(
    scope,
    (context, globalScope) => initializeGraphEntry(context, globalScope),
    "document"
  );
}

function initializeGraphEntry(
  context: BrowserContext,
  scope: unknown
): BrowserTeardown {
  const entry = beginEntry(context, ENTRY_KEY);
  if (!entry) return NOOP_TEARDOWN;
  const surface = createGraphSurface(context, () => resolveGraphVendor(scope));
  const navigation = createGraphNavigation(context, resolvePageRegistry(scope));
  const navigationTeardown = initializeGraphNavigation(context, navigation);
  entry.onTeardown(navigationTeardown);
  entry.onTeardown(surface.destroyAll);

  publishBrowserGlobals(
    scope,
    {
      radiusRenderGraph: (
        containerId: unknown,
        resources: unknown,
        options: unknown
      ) =>
        surface.render(
          asText(containerId),
          asResources(resources),
          asOptions(options)
        ),
      radiusSetGraphLoading: (containerId: unknown) =>
        surface.setLoading(asText(containerId)),
      radiusSetGraphError: (containerId: unknown, message: unknown) =>
        surface.setError(asText(containerId), asText(message))
    },
    GRAPH_ENTRY_GLOBALS
  );

  return () => entry.teardown();
}
