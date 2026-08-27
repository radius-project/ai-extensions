import { readBoolean, readString } from "../json.js";
import type { DomElement } from "../ports.js";

type GraphModelingFailureContext = {
  readonly dom: {
    byId(elementId: string): Pick<DomElement, "style" | "textContent"> | null;
  };
};

export type GraphErrorRenderer = (
  containerId: string,
  message: string
) => unknown;

export interface GraphModelingFailureElements {
  readonly statusIds: string | readonly string[];
  readonly staleContentIds?: readonly string[];
}

export const UNSUPPORTED_GRAPH_MODEL_MESSAGE =
  "The Radius app-bicep skill cannot model this repository.";

export function unsupportedGraphModelMessage(payload: unknown): string | null {
  if (!readBoolean(payload, "appBicepUnsupported")) return null;
  return readString(payload, "error") || UNSUPPORTED_GRAPH_MODEL_MESSAGE;
}

export function showGraphModelingFailure(
  context: GraphModelingFailureContext,
  renderError: GraphErrorRenderer,
  message: string,
  elements: GraphModelingFailureElements
): void {
  renderError("graph-container", message);
  const ids =
    typeof elements.statusIds === "string" ?
      [elements.statusIds]
    : elements.statusIds;
  const status = ids
    .map((statusId) => context.dom.byId(statusId))
    .find((element) => element !== null);
  if (status) {
    status.style.display = "none";
    status.textContent = "";
  }
  for (const contentId of elements.staleContentIds ?? []) {
    const content = context.dom.byId(contentId);
    if (content) content.style.display = "none";
  }
}
