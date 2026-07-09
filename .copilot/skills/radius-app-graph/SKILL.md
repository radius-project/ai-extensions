---
name: radius-app-graph
description: Build and visualize the Radius application graph for a repository. Use when the user asks to see, build, refresh, or compare the application graph (single branch or PR diff mode), or when they want to understand the resources in their Radius app.
---

# Radius — App Graph

Build and display the Radius application graph for a repo. The graph is built in the `radius` canvas directly from the app's `.radius/app.bicep` (via `buildGraphFromBicep`) and rendered with Cytoscape.

## When to use this skill

- "Show me the app graph"
- "What resources are in my Radius app?"
- "Compare the graph for PR #N"
- "Refresh the graph after my latest deploy"
- "What changed in the graph between branches?"

## Data flow

1. The canvas reads the app's `.radius/app.bicep` from the repo via the GitHub Contents API (generating one from the repo source if none exists).
2. `buildGraphFromBicep(content)` compiles/parses the bicep into a resource array (bicep CLI when available, with a CLI-free regex fallback).
3. The canvas renders that resource array with Cytoscape + dagre, discovering source-code references for resources that lack them.
4. PR diff mode builds graphs for the PR head and base branches (`buildGraphFromBicep` on each branch's app.bicep) and compares them; resources are tagged `added | removed | modified | unchanged`.

## Rendering features

The renderer ports the production improvements from `radius-project/github-extension@brooke-hamilton/graph-dev`:

- **Diff coloring** — `added` (green), `removed` (red), `modified` (yellow), `unchanged` (grey). Node border + subtle bg fill.
- **Deployment-state styling** — `provisioningState` overrides diff color so a live deploy is visible:
  - `Queued` → dashed grey border, 55% opacity
  - `InProgress` → bold yellow border + yellow fill
  - `Failed` → bold red border + red fill
  - `Succeeded` → falls back to diff coloring
- **Cross-edge classification** — edges that point to a same-rank or backward-rank node (cycles, lateral links) render as **dashed red** instead of the default grey arrow; helps spot non-DAG structure at a glance.
- **Configurable edge curve** — `renderGraph({ curveStyle })` accepts any Cytoscape curve type (`bezier`, `straight`, `taxi`, `segments`, etc.). Defaults to `bezier`. Exported as `CURVE_STYLES` for UI pickers.

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
- Build the graph from `.radius/app.bicep` on the selected branch (generating a bicep from the repo source if none exists), so the graph is visible without any deploy.
- Show "no graph available" only if there's no bicep and none can be generated — in that case, prompt the user to create a bicep file (`radius-app-bicep` skill).

## Prerequisites

- `.radius/app.bicep` on the selected branch (use the `radius-app-bicep` skill if missing). If it's absent, the canvas attempts to generate one from the repo source.
- The popup's "Refresh" button re-reads `.radius/app.bicep` and rebuilds the graph — useful after editing the bicep.

## Troubleshooting

- **Empty graph**: no `.radius/app.bicep` on the selected branch and none could be generated from the repo source. Create one with the `radius-app-bicep` skill.
- **Stale graph**: Click Refresh to re-read `app.bicep` and rebuild.
- **PR diff doesn't appear**: both the PR head and base branches need a readable `.radius/app.bicep`; the diff compares the two branches' bicep-built graphs.

## Related files

- `.github/radius/extension.mjs` — Cytoscape rendering + styling (`radiusRenderGraph`)
- `.github/radius/extension.mjs` — provisioning/diff styling applied during render (`diffMode`, `provisioningState`)
- `adapters/shared/src/rad.mjs` — modeled graph build via the real `rad app graph <app.bicep>` CLI (`buildGraphViaRad`, downloads/caches the `rad` binary on first use). Exported from the shared adapter package `@radius-project/shared`.
- `.github/radius/extension.mjs` — graph diff computation + API handler (`/api/diff-branches`)
- `.github/radius/extension.mjs` — repo file fetch helpers (`fetchFileFromRepo`) for `.radius/app.bicep`
- `.github/radius/extension.mjs` — graph + diff pages (`graphPage`, `graphDiffPage`) and shared repo/branch dropdown logic
