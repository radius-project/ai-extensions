---
"radius": patch
---

Land the Radius canvas on the application graph instead of the environment page when a caller opens it without naming one. The default is owned by `hooks.mjs` alongside `GRAPH_PAGES`, so the canvas `open` handler, the HTTP page router, and the app.bicep pre-tool-use hook all resolve a page-less open the same way — a bare `open_canvas` is now gated and handed off for app.bicep authoring exactly like an explicit `page: "graph"`. Explicit pages, the in-flight deployment redirect, and the `page: "environment"` skill entry points are unchanged.
