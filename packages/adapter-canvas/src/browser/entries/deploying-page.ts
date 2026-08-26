import {
  DEPLOYING_PAGE_STATE_ID,
  initializeDeployingPage
} from "../deploying/page.js";
import { readString } from "../json.js";
import { NOOP_TEARDOWN } from "../lifecycle.js";
import { readPageState } from "../pages/state.js";
import { runBrowserEntry } from "../registry.js";
import type { BrowserTeardown } from "../lifecycle.js";
import type { BrowserContext } from "../ports.js";

function initialize(context: BrowserContext): BrowserTeardown {
  if (!context.dom.byId(DEPLOYING_PAGE_STATE_ID)) return NOOP_TEARDOWN;
  const state = readPageState(context, DEPLOYING_PAGE_STATE_ID);
  return initializeDeployingPage(context, {
    repo: readString(state, "repo"),
    branch: readString(state, "branch"),
    mutationNonce: readString(state, "mutationNonce")
  });
}

export function installDeployingPageEntry(scope: unknown): BrowserTeardown {
  return runBrowserEntry(scope, (context) => initialize(context));
}
