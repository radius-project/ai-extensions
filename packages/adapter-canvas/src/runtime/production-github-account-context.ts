import { randomUUID } from "node:crypto";
import {
  createSelectedGhExecutor,
  getActiveKeyringLogin,
  resetGhIdentityCache,
  switchGhKeyringAccount
} from "../gh.js";
import { resolveGhCommandPresentation } from "../gh-command-resolution.js";
import { createGitHubAccountCoordinator } from "../server/services/github-account-coordinator.js";
import { createEnvironmentAccountContext } from "./environment-account-context.js";

export function createProductionGitHubAccountContext() {
  return createEnvironmentAccountContext(
    randomUUID(),
    createGitHubAccountCoordinator(
      {
        createExecutor: (login) => createSelectedGhExecutor(login),
        getActiveKeyringLogin,
        switchKeyringAccount: switchGhKeyringAccount,
        resetIdentityCache: resetGhIdentityCache
      },
      { ghCommandPresentation: resolveGhCommandPresentation() }
    )
  );
}
