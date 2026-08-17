// Canvas adapter — page renderer compatibility facade.
//
// The server-side view layer lives in ./pages/: the shared document shell, the
// graph pages (modeled, planned, diff, deployed), the environment and
// credential pages, and the deployments page. This module re-exports that
// surface unchanged so `./pages.js` importers keep working; it holds no
// behaviour of its own.

export { serializeBrowserFunction } from "./pages/browser-function.js";
export { pageShell } from "./pages/shell.js";
export { oidcPage } from "./pages/oidc-page.js";
export { graphHeader, graphHeaderClose } from "./pages/graph-header.js";
export { graphPage } from "./pages/graph-page.js";
export { plannedGraphPage } from "./pages/planned-graph-page.js";
export { graphDiffPage } from "./pages/graph-diff-page.js";
export { deployedGraphPage } from "./pages/deployed-graph-page.js";
export { environmentPage } from "./pages/environment-page.js";
export { deployingPage } from "./pages/deploying-page.js";
