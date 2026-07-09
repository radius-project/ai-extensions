---
name: radius-app-graph
description: Build and visualize the Radius application graph for a repository. Use when the user asks to see, build, refresh, or compare the application graph (single branch or PR diff mode), or when they want to understand the resources in their Radius app.
---

# Radius — App Graph

Build and display the Radius application graph for a repo. The graph is assembled from `app.bicep` with the same `rad app graph <app.bicep>` path used by the Radius CLI, then rendered in the `radius` canvas using Cytoscape.

## When to use this skill

- "Show me the app graph"
- "What resources are in my Radius app?"
- "Compare the graph for PR #N"
- "Refresh the graph after my latest deploy"
- "What changed in the graph between branches?"

## Data flow

1. The canvas looks for `.radius/app.bicep` first, then `app.bicep`, on the selected branch. If neither file exists, it generates a Radius-native app model from the repo structure using only `Radius.*` resource namespaces.
2. The shared graph runner invokes offline `rad app graph <app.bicep>` and writes `app-graph.json` locally. It locates `rad` from `RADIUS_RAD_BINARY`, then `PATH`, then `~/.rad/bin`; if missing, it downloads and caches the release binary in `~/.rad/bin`.
3. `radius-core` converts the `rad` application graph output into the canvas `ApplicationGraphResource` shape and re-adds inbound connections so all views use the same resource model.
4. The graph, planned graph, auto-open graph diff, `radius_render_graph_diff`, and `radius_generate_pr_diff_markdown` all use the same graph build and `computeGraphDiff` flow. PR diff mode compares base and head branch app models and tags resources `added | removed | modified | unchanged`.
5. After deployment, the workflow captures the live deployed graph with `rad app graph -a "$APP_NAME" -o json` for deployed-resource status views.

## Rendering features

The renderer ports the production improvements from `radius-project/github-extension@brooke-hamilton/graph-dev`:

- **Diff coloring** — `added` (green), `removed` (red), `modified` (yellow), `unchanged` (grey). Node border + subtle bg fill.
- **Deployment-state styling** — `provisioningState` overrides diff color so a live deploy is visible:
  - `Queued` → dashed grey border, 55% opacity
  - `InProgress` → bold yellow border + yellow fill
  - `Failed` → bold red border + red fill
  - `Succeeded` → falls back to diff coloring
- **Cross-edge classification** — edges that point to a same-rank or backward-rank node (cycles, lateral links) render as **dashed red** instead of the default grey arrow; helps spot non-DAG structure at a glance.
- **Configurable line type** — `radiusRenderGraph(..., { lineType })` accepts Cytoscape curve styles (`taxi`, `straight`, `unbundled-bezier`, `segments`, etc.). Defaults to `taxi`.

## How to invoke

When the user asks to see, build, refresh, or compare the application graph, **open the canvas straight to the graph view**:

```
open_canvas({
  canvasId: "radius",
  instanceId: "radius-panel",
  input: { page: "graph", repo: "<owner/repo>" }
})
```

For PR diff mode:

```
open_canvas({
  canvasId: "radius",
  instanceId: "radius-panel",
  input: { page: "graph-diff", repo: "<owner/repo>", baseBranch: "main", headBranch: "<pr-branch>" }
})
```

The canvas will:
- Build the graph from committed `.radius/app.bicep` or `app.bicep` on the selected branch.
- Generate an app model from repository structure when no app definition exists, using only `Radius.*` namespaces.
- Use `rad app graph <app.bicep>` as the graph assembly source of truth, matching the CLI model instead of maintaining a separate parser.
- Show "no graph available" only if no app definition exists and generation cannot infer one from the repo; in that case, prompt the user to create a bicep file (`radius-app-bicep` skill) or run a deploy (`radius-deploy` skill).

## Prerequisites

- For the **modeled graph**: `.radius/app.bicep` or `app.bicep` on the selected branch, or a repo structure the generator can model.
- For the **deployed graph**: at least one successful Radius deploy run so the workflow can capture `rad app graph -a "$APP_NAME" -o json`.
- The first graph build may download `rad` into `~/.rad/bin`. Set `RADIUS_RAD_BINARY` to force a specific binary, or `RADIUS_RAD_SHA256` to pin the downloaded binary checksum.

## Troubleshooting

- **Empty graph**: no committed app definition and repo modeling could not infer one. Generate or commit `.radius/app.bicep`, then refresh.
- **Graph build fails**: verify `rad app graph <app.bicep>` succeeds locally, or check that the cached/downloaded `rad` binary is executable. On Windows, the runner starts `rad` detached so the embedded Bicep child process does not hang in Node's default job object.
- **Stale graph**: Click Refresh to rebuild from the selected branch's current app definition.
- **PR diff doesn't appear**: verify both base and head branch app definitions can be fetched or generated. The diff no longer requires both branches to have deployed first.

## Related files

- `.github/radius/extension.mjs` — Cytoscape rendering + styling (`radiusRenderGraph`)
- `.github/radius/extension.mjs` — provisioning/diff styling applied during render (`diffMode`, `provisioningState`)
- `adapters/shared/src/rad.mjs` — modeled graph build via the real `rad app graph <app.bicep>` CLI (`buildGraphViaRad`, downloads/caches the `rad` binary on first use). Exported from the shared adapter package `@radius-project/shared`.
- `radius-core/src/graph/appgraph.ts` — converts `rad` application graph output into canvas resources (`applicationGraphToResources`)
- `.github/radius/extension.mjs` — graph diff computation + API handler (`/api/diff-branches`)
- `.github/radius/extension.mjs` — repo file fetch helpers (`fetchFileFromRepo`) for `.radius/app.bicep` and `app.bicep`
- `.github/radius/extension.mjs` — graph + diff pages (`graphPage`, `graphDiffPage`) and shared repo/branch dropdown logic
