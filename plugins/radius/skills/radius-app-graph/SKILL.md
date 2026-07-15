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

1. The canvas looks for `.radius/app.bicep` first, then `app.bicep`, on the selected branch. If neither file exists, the canvas does **not** generate one — it returns `needsAppBicep` and prompts the user to author the definition with the `radius-app-bicep` skill. App model generation is owned solely by that skill; the canvas only consumes a committed `app.bicep`.
2. The shared graph runner invokes offline `rad app graph <app.bicep>` and writes `app-graph.json` locally. It locates `rad` from `RADIUS_RAD_BINARY`, then `PATH`, then `~/.rad/bin`; if missing, it downloads and caches the release binary in `~/.rad/bin`.
3. `radius-core` converts the `rad` application graph output into the canvas `ApplicationGraphResource` shape and re-adds inbound connections so all views use the same resource model.
4. The graph, planned graph, auto-open graph diff, `radius_render_graph_diff`, and `radius_generate_pr_diff_markdown` all use the same graph build and `computeGraphDiff` flow. PR diff mode compares the committed base- and head-branch `app.bicep` models and tags resources `added | removed | modified | unchanged`. Both branches must have a committed `app.bicep`; a branch without one is reported as missing rather than generated.
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
- Build the graph from the committed `.radius/app.bicep` or `app.bicep` on the selected branch.
- Use `rad app graph <app.bicep>` as the graph assembly source of truth, matching the CLI model instead of maintaining a separate parser.
- Show "no app.bicep found" (`needsAppBicep`) when no committed app definition exists on the branch. It does not infer one from the repo — prompt the user to create the definition with the `radius-app-bicep` skill, then refresh the graph.

## Prerequisites

- For the **modeled graph**: a committed `.radius/app.bicep` or `app.bicep` on the selected branch. If none exists, author one with the `radius-app-bicep` skill first — the canvas will not generate it.
- For the **deployed graph**: at least one successful Radius deploy run so the workflow can capture `rad app graph -a "$APP_NAME" -o json`.
- The first graph build may download `rad` into `~/.rad/bin`. Set `RADIUS_RAD_BINARY` to force a specific binary, or `RADIUS_RAD_SHA256` to pin the downloaded binary checksum.

## Troubleshooting

- **Empty graph**: no committed app definition on the branch. Author `.radius/app.bicep` with the `radius-app-bicep` skill and commit it, then refresh.
- **Graph build fails**: verify `rad app graph <app.bicep>` succeeds locally, or check that the cached/downloaded `rad` binary is executable. On Windows, the runner starts `rad` detached so the embedded Bicep child process does not hang in Node's default job object.
- **Stale graph**: Click Refresh to rebuild from the selected branch's current app definition.
- **PR diff doesn't appear**: verify both base and head branches have a committed `app.bicep` that can be fetched. Branches without one are reported as missing — the diff no longer generates a model for an empty branch, and it no longer requires both branches to have deployed first.

## Related files

- `plugins/radius/extensions/radius/extension.mjs` — Cytoscape rendering + styling (`radiusRenderGraph`)
- `plugins/radius/extensions/radius/extension.mjs` — provisioning/diff styling applied during render (`diffMode`, `provisioningState`)
- `adapters/shared/src/rad.mjs` — modeled graph build via the real `rad app graph <app.bicep>` CLI (`buildGraphViaRad`, downloads/caches the `rad` binary on first use). Exported from the shared adapter package `@radius-project/shared`.
- `radius-core/src/graph/appgraph.ts` — converts `rad` application graph output into canvas resources (`applicationGraphToResources`)
- `radius-core/src/modeling/repo.ts` — fetches the committed app definition (`fetchBicepFromRepo`), trying `.radius/app.bicep` then `app.bicep`; returns null (→ `needsAppBicep`) when neither exists. There is no repo-structure generation fallback.
- `plugins/radius/extensions/radius/extension.mjs` — graph diff computation + API handler (`/api/diff-branches`)
- `plugins/radius/extensions/radius/extension.mjs` — repo file fetch helpers (`fetchFileFromRepo`) for `.radius/app.bicep` and `app.bicep`
- `plugins/radius/extensions/radius/extension.mjs` — graph + diff pages (`graphPage`, `graphDiffPage`) and shared repo/branch dropdown logic
