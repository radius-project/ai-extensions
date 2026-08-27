import { requireBrowserFunction } from "../globals.js";
import { readBoolean, readString } from "../json.js";
import type { DomElement } from "../ports.js";

type GraphModelingFailureContext = {
  readonly dom: {
    byId(elementId: string): Pick<DomElement, "style" | "textContent"> | null;
  };
};

export const UNSUPPORTED_GRAPH_MODEL_MESSAGE =
  "The Radius app-bicep skill cannot model this repository.";

export function unsupportedGraphModelMessage(payload: unknown): string | null {
  if (!readBoolean(payload, "appBicepUnsupported")) return null;
  return readString(payload, "error") || UNSUPPORTED_GRAPH_MODEL_MESSAGE;
}

export function showGraphModelingFailure(
  context: GraphModelingFailureContext,
  globalScope: unknown,
  message: string,
  statusIds: string | readonly string[]
): void {
  requireBrowserFunction(globalScope, "radiusSetGraphError")(
    "graph-container",
    message
  );
  const ids = typeof statusIds === "string" ? [statusIds] : statusIds;
  const status = ids
    .map((statusId) => context.dom.byId(statusId))
    .find((element) => element !== null);
  if (status) {
    status.style.display = "none";
    status.textContent = "";
  }
}
