import { readBoolean, readString } from "../json.js";
import type { BrowserContext } from "../ports.js";

export type GraphErrorRenderer = (
  containerId: string,
  message: string
) => unknown;

export interface GraphModelingFailureElements {
  readonly containerId: string;
  readonly statusIds: readonly string[];
  readonly staleContentIds?: readonly string[];
}

export const UNSUPPORTED_GRAPH_MODEL_MESSAGE =
  "The Radius app-bicep skill cannot model this repository.";

export function unsupportedGraphModelMessage(payload: unknown): string | null {
  if (!readBoolean(payload, "appBicepUnsupported")) return null;
  return readString(payload, "error") || UNSUPPORTED_GRAPH_MODEL_MESSAGE;
}

export function showGraphModelingFailure(
  context: BrowserContext,
  renderError: GraphErrorRenderer,
  message: string,
  elements: GraphModelingFailureElements
): void {
  renderError(elements.containerId, message);
  const status = elements.statusIds
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
