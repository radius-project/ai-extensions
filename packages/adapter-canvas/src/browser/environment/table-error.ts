import { escapeBrowserHtml } from "../html.js";
import { ServerResponseError } from "../http.js";

export function tableErrorRowMarkup(
  error: unknown,
  colspan: number,
  fallbackMessage: string
): string {
  const message =
    error instanceof ServerResponseError ? error.message : fallbackMessage;
  return `<tr><td colspan="${colspan}" style="color:var(--rad-text-tertiary);">${escapeBrowserHtml(message)}</td></tr>`;
}
