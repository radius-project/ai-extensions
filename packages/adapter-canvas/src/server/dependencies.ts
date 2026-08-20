import { createServer } from "node:http";
import { primeGhIdentity } from "../gh.js";
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
    | "createRequestHandler"
    | "defaultPage"
    | "onStarted"
    | "onStopped"
    | "preferredPort"
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
      onStarted: seams.onStarted,
      onStopped: seams.onStopped,
      preferredPort: seams.preferredPort,
      prepareIdentity: () => {
        primeGhIdentity().catch(() => {});
      }
    },
    overrides
  );
}
