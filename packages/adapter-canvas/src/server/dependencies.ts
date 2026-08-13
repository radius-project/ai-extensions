import { createServer } from "node:http";
import { primeGhIdentity, setPreferredGhLogin } from "../gh.js";
import { getPreferredGitHubLogin } from "../shared.js";
import type { CanvasServerDependencies } from "./ports.js";

export type CanvasServerDependencyOverrides = Partial<CanvasServerDependencies>;

export function composeCanvasServerDependencies(
  defaults: CanvasServerDependencies,
  overrides: CanvasServerDependencyOverrides = {}
): CanvasServerDependencies {
  return { ...defaults, ...overrides };
}

export function createProductionCanvasServerDependencies(
  seams: Pick<
    CanvasServerDependencies,
    "createRequestHandler" | "defaultPage" | "preferredPort"
  >,
  overrides: CanvasServerDependencyOverrides = {}
): CanvasServerDependencies {
  return composeCanvasServerDependencies(
    {
      createHttpServer: (handler) => createServer(handler),
      createRequestHandler: seams.createRequestHandler,
      createState: () => ({}),
      defaultPage: seams.defaultPage,
      now: () => Date.now(),
      preferredPort: seams.preferredPort,
      prepareIdentity: () => {
        const persistedLogin = getPreferredGitHubLogin();
        if (persistedLogin) setPreferredGhLogin(persistedLogin);
        primeGhIdentity().catch(() => {});
      }
    },
    overrides
  );
}
