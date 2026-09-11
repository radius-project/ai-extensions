import { escapeHtml } from "../shared.js";
import type { PageStateById, PageStateId } from "./browser-state-ids.js";

export function renderPageState<Id extends PageStateId>(
  id: Id,
  state: PageStateById[NoInfer<Id>]
): string {
  const serialized = JSON.stringify(state);
  if (serialized === undefined) {
    throw new Error(`Radius page state "${id}" cannot be serialized.`);
  }
  // Keep JSON escapes through HTML parsing; the reader uses textContent and
  // JSON.parse, not executable JavaScript or HTML entities inside a script.
  const encoded = serialized.replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
  return `<div hidden id="${escapeHtml(id)}">${escapeHtml(encoded)}</div>`;
}
