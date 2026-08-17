import { beginEntry, NOOP_TEARDOWN } from "../lifecycle.js";
import { readBoolean, readString } from "../json.js";
import { readPageState } from "./state.js";
import { DEPLOY_RESULT_STATE_ID } from "../../pages/browser-state-ids.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type { BrowserContext } from "../ports.js";

export const DEPLOY_RESULT_ENTRY_KEY = "deploy-result-page";
export const DEPLOY_RESET_PATH = "/api/deploy-reset";
export { DEPLOY_RESULT_STATE_ID };

export function initializeDeployResultPage(
  context: BrowserContext
): BrowserTeardown {
  const button = context.dom.inputById("back-btn");
  if (!button || !context.dom.byId(DEPLOY_RESULT_STATE_ID)) {
    return NOOP_TEARDOWN;
  }
  // Parsed before the binding is claimed: a throw here would otherwise leave
  // the entry key claimed forever and escape the compiled entry's IIFE.
  const state = readPageState(context, DEPLOY_RESULT_STATE_ID);
  const attemptId = readString(state, "attemptId");
  const scope = beginEntry(context, DEPLOY_RESULT_ENTRY_KEY);
  if (!scope) return NOOP_TEARDOWN;

  const status = context.dom.byId("deploy-reset-status");
  let pending = false;
  let abort = context.net.createAbort();

  scope.on(button, "click", () => {
    if (pending) return;
    pending = true;
    button.disabled = true;
    button.textContent = "Resetting…";
    if (status) status.style.display = "none";
    void context.net
      .fetch(DEPLOY_RESET_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptId }),
        ...(abort ? { signal: abort.signal } : {})
      })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !readBoolean(payload, "ok")) {
          throw new Error("The deployment view could not be reset.");
        }
      })
      .then(
        () => {
          if (!scope.active) return;
          context.nav.reload();
        },
        (error: unknown) => {
          if (!scope.active) return;
          pending = false;
          button.disabled = false;
          button.textContent = "← Back to Deploy";
          if (status) {
            status.textContent =
              error instanceof Error ?
                error.message
              : "The deployment view could not be reset.";
            status.style.display = "block";
          }
        }
      );
  });

  return () => {
    abort?.abort();
    abort = null;
    scope.teardown();
  };
}
