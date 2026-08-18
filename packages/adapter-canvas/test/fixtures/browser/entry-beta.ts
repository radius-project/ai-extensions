import { publishBrowserGlobals } from "../../../src/browser/globals.js";

export function installBeta(scope: unknown): void {
  publishBrowserGlobals(scope, { radiusBeta: "beta" }, ["radiusBeta"]);
}
