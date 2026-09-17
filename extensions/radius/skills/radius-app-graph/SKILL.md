---
name: radius-app-graph
description: Build and visualize the Radius application graph for a repository. Use when the user asks to see, build, refresh, or compare the application graph (single branch or PR diff mode), or when they want to understand the resources in their Radius app.
---

# Radius — App Graph

Build and display the Radius application graph for a repo. The graph is assembled from `app.bicep` with the same `rad app graph <app.bicep> --include-icons` path used by the Radius CLI, then rendered in the `radius` canvas using React Flow.

## Execution boundary

- Never invoke `rad` or `rad.exe` directly from PowerShell, a shell, a subprocess, or a delegated agent. Do not ask another agent to run or troubleshoot the CLI.
- Perform every Radius graph operation through the Radius canvas and its tools. Open `canvasId: "radius"` with `instanceId: "radius-panel"`, pass the current session repository as `repo` in `owner/repo` form, and treat the current Copilot worktree branch as the graph branch. The Radius extension is the only component allowed to run `rad` internally.
- After opening the canvas, do not inspect the workspace for `app.bicep`, poll `get_graph_resources` to detect a missing model, invoke the `radius-app-bicep` skill or `radius_generate_app`, or delegate model generation. Graph reads are read-only. You may call `get_graph_resources` once to inspect an already-ready graph for missing source references; if it returns `ready: false`, report the unavailable result and end the current turn instead of retrying. Missing or stale models never authorize an automatic authoring handoff.
- The extension honors `RADIUS_RAD_BINARY` when it names an existing binary. Otherwise it uses its managed binary at `%USERPROFILE%\.radius\ai-extensions\bin\rad.exe` on Windows or `$HOME/.radius/ai-extensions/bin/rad` on macOS/Linux. On extension load it attempts a best-effort latest-release check (offline/API failures keep the installed binary), downloads the managed binary when absent, and upgrades it when its installed version is older unless `RADIUS_RAD_SKIP_VERSION_CHECK` is set. It never resolves `rad` from `PATH` or the separate user CLI installation under `.rad/bin`.
- Diagnose graph failures only through the Radius extension log (use extension inspection to locate and read it). Do not reproduce a failure by running `rad` directly.

## When to use this skill

- "Show me the app graph"
- "What resources are in my Radius app?"
- "Compare the graph for PR #N"
- "Refresh the graph after my latest deploy"
- "What changed in the graph between branches?"

## Data flow

1. The canvas reads the selected application definition from captured source: the current workspace for graph/planned views, or explicit committed source for another branch and every diff side. Missing definitions or required evidence produce explicit unavailable results, not authoring. See [Rendering a branch that has no model yet](#rendering-a-branch-that-has-no-model-yet).
2. The shared graph runner inside the Radius extension invokes offline `rad app graph <app.bicep> --include-icons` and writes `app-graph.json` locally. The modeled Bicep path must not use `--preview`: that flag switches the CLI to the deployed-application API and does not write `app-graph.json`. The required `--include-icons` flag embeds the resource icon metadata used by the canvas. The runner honors an existing `RADIUS_RAD_BINARY`; otherwise it uses the managed binary under `~/.radius/ai-extensions/bin`, downloading it when absent and upgrading it when older than the latest release. It never resolves `rad` from `PATH` or `~/.rad/bin`.
3. `packages/core` converts the `rad` application graph output into the canvas `ApplicationGraphResource` shape and re-adds inbound connections so all views use the same resource model.
4. Graph views and `radius_generate_pr_diff_markdown` use canonical graph operations. PR diff mode uses explicit committed base and head refs, never uncommitted worktree content, and tags resources `added | removed | modified | unchanged`.
5. Each non-application node can carry a **source-code reference** (`codeReference` → node `codeRef`) that deep-links the node to where the resource is defined or initialized in the repo. The `radius-app-bicep` skill owns discovering and authoring this metadata; this skill consumes it from `app.bicep`.
6. After deployment, the workflow captures the live deployed graph with `rad app graph -a "$APP_NAME" -o json --preview --include-icons` for deployed-resource status views. The deployed path requires both `--preview` and `--include-icons`.

## Rendering features

The renderer ports the production improvements from `radius-project/github-extension@brooke-hamilton/graph-dev`:

- **Diff coloring** — `added` (green), `removed` (red), `modified` (yellow), `unchanged` (grey). Node border + subtle bg fill.
- **Deployment-state styling** — `provisioningState` overrides diff color so a live deploy is visible:
  - `Queued` → dashed grey border, 55% opacity
  - `InProgress` → bold yellow border + yellow fill
  - `Failed` → bold red border + red fill
  - `Succeeded` → falls back to diff coloring
- **Configurable line type** — `radiusRenderGraph(..., { lineType })` accepts React Flow edge types (`default` bezier, `straight`, `step`, `smoothstep`). Legacy aliases (`taxi`, `segments`) map to `smoothstep`. Defaults to `default` (bezier).
- **Source-code links** — a node with a `codeReference` renders a clickable deep link to where the resource is defined/initialized in the repo (path + optional `#L<line>`). See [Source-code references](#source-code-references).

## Source-code references

The `codeReference` on each non-application resource is what makes a graph node link back to its definition/initialization site in the source (e.g. the file that opens the MySQL connection). Generated models store it durably in `app.bicep` as either a current-worktree-relative path or an exact GitHub branch/file URL; the graph consumes that authored metadata.

- The `radius-app-bicep` skill discovers and authors `codeReference` into `.radius/app.bicep` before publishing the model.
- If a generated graph lacks a reference, report it. Repair requires a separate explicit modeling request through the selected authoring mode, not a graph-read side effect. Do not treat the instance-scoped `update_source_refs` compatibility action as completion because its changes do not survive rebuilding the graph.

### Missing-reference repair workflow

After the graph canvas is opened and the graph has been built, inspect whether a generated model is missing source-code references:

1. **Get resources needing references** — call the `get_graph_resources` canvas action to retrieve resources missing `codeReference`:

```javascript
invoke_canvas_action({
  instanceId: "radius-panel",
  actionName: "get_graph_resources",
  input: { missingOnly: true }
})
```

If `ready` is `false`, end the current turn without waiting or retrying, and do not infer that the model is missing. Report the actual pending or unavailable state; the graph does not queue authoring. Inspect missing references only in a later turn after the graph is ready. A ready response includes the exact graph context (`repo`, branch fields, `view`, and `contextToken`) plus resources (each with `name`, `type`, `id`). Keep the returned `contextToken`; it prevents references discovered for one repo, branch, or graph view from being applied to another.

1. If the action returns any resources, report the missing references and request a separately authorized repair. Current SDK hosts retain legacy modeling through `radius_generate_app`; canonical authoring remains unavailable without trusted approval and authenticated assignment. Never use legacy as a fallback for an accepted canonical operation.
2. After observed promotion through the selected mode, rebuild the graph and call `get_graph_resources` again. An empty missing-resource list confirms the graph references, not the complete model's validation or deployment.

## How to invoke

When the user asks to see, build, refresh, or compare the application graph, **open the canvas straight to the graph view**:

```javascript
open_canvas({
  canvasId: "radius",
  instanceId: "radius-panel",
  input: { page: "graph", repo: "<owner/repo>" }
})
```

For PR diff mode:

```javascript
open_canvas({
  canvasId: "radius",
  instanceId: "radius-panel",
  input: { page: "graph-diff", repo: "<owner/repo>", baseBranch: "main", headBranch: "<pr-branch>" }
})
```

> **Canvas not opening?** If the Radius panel does not appear even though this skill and the Radius plugin are installed, reload extensions (or restart the app) and try again.

After `open_canvas` succeeds, do not poll the graph, search for `app.bicep`, or start model generation yourself. Call `get_graph_resources` at most once if the ready graph needs a missing-reference check. If the response is not ready, report the result and end the turn. The canvas reads existing model evidence or reports why the graph is unavailable.

The canvas will:

- Build the graph from the selected captured definition, using workspace content only for current-workspace graph/planned views.
- Use `rad app graph <app.bicep> --include-icons` as the modeled graph assembly source of truth, matching the CLI model instead of maintaining a separate parser. Do not pass `--preview` with a Bicep file.
- Report an explicit unavailable result when the selected source has no application definition. It does not infer or generate one from the repository.

## Rendering a branch that has no model yet

When the selected source has no application definition, report the missing model. Do not start authoring from a graph read. A separate explicit modeling request uses `radius_generate_app`, which follows the selected writer: the retained legacy bootstrap on the current SDK, or the guarded coordinator after a supported cutover. Direct canonical `definition.author` returns `CAPABILITY_UNAVAILABLE` without trusted host capabilities.

- **Current workspace graph/planned view:** captured on-disk model content can be read without a commit or push.
- **Another branch or any diff side:** only the selected committed source is read. Do not author, commit, or push merely to make a comparison available.

After a separately authorized source change, refresh the relevant graph view. A graph rendering successfully does not establish that an authoring action was approved, validated, or promoted.

## Prerequisites

- For the **modeled graph**: an application definition and required evidence in the selected captured source. Missing evidence is unavailable, not permission to author.
- For the **deployed graph**: at least one successful Radius deploy run so the workflow can capture `rad app graph -a "$APP_NAME" -o json --preview --include-icons`.
- `RADIUS_RAD_BINARY` may override the binary path. Without that override, extension startup downloads `rad` into `~/.radius/ai-extensions/bin` when absent or upgrades it when older than the latest release. `RADIUS_RAD_SHA256` may pin the checksum of the managed download.

## Troubleshooting

- **Empty graph**: report the actual missing-model or unavailable-evidence reason. Do not start authoring from this skill.
- **Graph build fails**: inspect the Radius extension log and report the failure without modifying the selected Radius CLI. Never download, install, upgrade, downgrade, copy, move, rename, back up, delete, or replace a `rad` binary; never change or unset `RADIUS_RAD_BINARY` or `RADIUS_RAD_SKIP_VERSION_CHECK`; and never search `PATH`, `.rad/bin`, or another location for a fallback. The extension alone owns its managed binary lifecycle. Never run `rad app graph` locally to reproduce the failure. Do not add `--preview` to this modeled command. On Windows, the extension keeps its managed `rad.exe` attached and hidden, then terminates the process tree after a valid graph artifact or timeout.
- **Stale graph**: Click Refresh to rebuild from the selected branch's current app definition.
- **PR diff doesn't appear**: verify both base and head branches have a committed `app.bicep` that can be fetched. Branches without one are reported as missing — the diff no longer generates a model for an empty branch, and it no longer requires both branches to have deployed first.

## Related files

- `extension.mjs` — React Flow rendering + styling (`radiusRenderGraph`)
- `extension.mjs` — provisioning/diff styling applied during render (`diffMode`, `provisioningState`)
- `packages/adapter-shared/src/rad.ts` — modeled graph build via the real `rad app graph <app.bicep> --include-icons` CLI (`buildGraphViaRad`, downloads/caches the `rad` binary on first use). Exported from the shared adapter package `@radius-project/adapter-shared`.
- `packages/core/src/graph/appgraph.ts` — converts `rad` application graph output into canvas resources (`applicationGraphToResources`), carrying `codeReference`/`definitionFile`/`definitionLine` through to the node
- `packages/core/src/modeling/repo.ts` — fetches the `app.bicep` generated by the `radius-app-bicep` skill from the repo (`fetchBicepFromRepo`)
- `extension.mjs` — graph diff computation + API handler (`/api/diff-branches`)
- `extension.mjs` — repo file fetch helpers (`fetchFileFromRepo`) for `.radius/app.bicep` and `app.bicep`
- `extension.mjs` — graph + diff pages (`graphPage`, `graphDiffPage`) and shared repo/branch dropdown logic
