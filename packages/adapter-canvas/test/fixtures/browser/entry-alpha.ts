import { publishBrowserGlobals } from "../../../src/browser/globals.js";

export function installAlpha(scope: unknown): void {
  publishBrowserGlobals(scope, { radiusAlpha: "alpha" }, ["radiusAlpha"]);
}
