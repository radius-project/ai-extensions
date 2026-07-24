---
name: radius-app-graph
description: Build and visualize the Radius application graph for a repository. Use when the user asks to see, build, refresh, or compare the application graph (single branch or PR diff mode), or when they want to understand the resources in their Radius app.
---

# Radius — App Graph

Build and display the Radius application graph for a repo. The graph is assembled from `app.bicep` with the same `rad app graph <app.bicep> --include-icons` path used by the Radius CLI, then rendered in the `radius` canvas using React Flow.

## When to use this skill

- "Show me the app graph"
- "What resources are in my Radius app?"
- "Compare the graph for PR #N"
- "Refresh the graph after my latest deploy"
- "What changed in the graph between branches?"

## Data flow

1. The canvas looks for `.radius/app.bicep` first, then `app.bicep`, on the selected branch. If neither file exists, the canvas does **not** generate one directly — it returns `needsAppBicep` and automatically hands off to Copilot to run the `radius-app-bicep` skill and author the definition. App model generation is owned solely by that skill; the canvas only consumes an `app.bicep` from the selected branch — committed for a non-workspace branch, or present in the working tree when the selected branch is the current workspace branch. See [Rendering a branch that has no model yet](#rendering-a-branch-that-has-no-model-yet).
2. The shared graph runner invokes offline `rad app graph <app.bicep> --include-icons` and writes `app-graph.json` locally. The modeled Bicep path must not use `--preview`: that flag switches the CLI to the deployed-application API and does not write `app-graph.json`. The required `--include-icons` flag embeds the resource icon metadata used by the canvas. It locates `rad` from `RADIUS_RAD_BINARY`, then `PATH`, then `~/.rad/bin`; if missing, it downloads and caches the release binary in `~/.rad/bin`.
3. `radius-core` converts the `rad` application graph output into the canvas `ApplicationGraphResource` shape and re-adds inbound connections so all views use the same resource model.
4. The graph, planned graph, auto-open graph diff, `radius_render_graph_diff`, and `radius_generate_pr_diff_markdown` all use the same graph build and `computeGraphDiff` flow. PR diff mode compares base and head branch app models and tags resources `added | removed | modified | unchanged`.
5. Each non-application node can carry a **source-code reference** (`codeReference` → node `codeRef`) that deep-links the node to where the resource is defined/initialized in the repo. When authoring `app.bicep`, populate it; otherwise this skill can discover and attach it after the graph builds. See [source-code-references.md](references/source-code-references.md).
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

The optional `codeReference` on each resource is what makes a graph node link back to its definition/initialization site in the source (e.g. the file that opens the MySQL connection). It is normally hand-added metadata, but since the app model here is generated, this skill locates it automatically:

- Prefer authoring `codeReference` into `.radius/app.bicep` (the `radius-app-bicep` skill) so the link is durable and high quality.
- Any resource still missing one is discovered by this skill's AI agent at graph-build time, using the heuristics in [source-code-references.md](references/source-code-references.md).

For the per-resource discovery methodology — categorization, filename/initialization patterns, skip rules, line pinpointing, and output format — follow [source-code-references.md](references/source-code-references.md).

### Agent-driven discovery workflow

After the graph canvas is opened and the graph has been built, discover source-code references for resources that lack them:

1. **Get resources needing references** — call the `get_graph_resources` canvas action to retrieve resources missing `codeReference`:

```javascript
invoke_canvas_action({
  instanceId: "radius-panel",
  actionName: "get_graph_resources",
  input: { missingOnly: true }
})
```

If `ready` is `false`, the graph hasn't built yet — wait and retry. The response includes the exact graph context (`repo`, branch fields, `view`, and `contextToken`) plus resources (each with `name`, `type`, `id`). Keep the returned `contextToken`; it prevents references discovered for one repo, branch, or graph view from being applied to another.

1. **Categorize each resource** by its `type` using the category mapping in [source-code-references.md](references/source-code-references.md) (e.g. `mysql`, `postgres`, `redis`, `mongo`, `rabbitmq`, `neo4j`, `container`, `secret`).
2. **Search the repository** for each resource's definition/initialization site using `grep` and `glob` tools, following the file-name patterns and initialization/content patterns from [source-code-references.md](references/source-code-references.md). Skip test/spec/mock/vendor directories and files.
3. **Pinpoint the line** — when a candidate file is found, search within it for the initialization pattern and note the 1-based line number.
4. **Push discovered references** to the canvas via the `update_source_refs` action:

```javascript
invoke_canvas_action({
  instanceId: "radius-panel",
  actionName: "update_source_refs",
  input: {
    contextToken: "<contextToken returned by get_graph_resources>",
    refs: [
      { id: "<database resource id>", codeReference: "src/db.js#L14" },
      { id: "<cache resource id>", codeReference: "src/redis.js#L8" }
    ]
  }
})
```

Always use the stable `id` and `contextToken` returned by `get_graph_resources`; do not reconstruct them from resource names or types. The action refreshes the active graph URL after applying references. If it reports a stale context, fetch resources again and repeat the search against the newly returned repo/branch context.

Only attach a reference when confident it points to the real initialization/definition site. An empty reference is better than a wrong one.

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

The canvas will:

- Build the graph from the committed `.radius/app.bicep` or `app.bicep` on the selected branch.
- Use `rad app graph <app.bicep> --include-icons` as the modeled graph assembly source of truth, matching the CLI model instead of maintaining a separate parser. Do not pass `--preview` with a Bicep file.
- Show "no app.bicep found" (`needsAppBicep`) when no committed app definition exists on the branch. It does not infer one from the repo — it hands off to Copilot to generate one with the `radius-app-bicep` skill, then refresh the graph. See [Rendering a branch that has no model yet](#rendering-a-branch-that-has-no-model-yet) for where that generated model needs to land.

## Rendering a branch that has no model yet

When the selected branch has no committed `.radius/app.bicep` (or `app.bicep`), the canvas returns `needsAppBicep` and hands off to Copilot to author one with the `radius-app-bicep` skill (via the `radius_generate_app` tool). That skill models the working tree, so where the resulting file needs to be committed depends on which branch was selected:

- **Selected branch is the current workspace branch:** writing `.radius/app.bicep` to the working tree is enough — the graph, planned, and PR-diff-preview views render straight from the on-disk worktree checkout, so no commit or push is required to preview the graph.
- **Selected branch is a different branch:** the skill must model that branch's code (not the current worktree's), and the resulting `.radius/app.bicep` must be committed and pushed to that branch before the graph can render there. Prefer opening a pull request into the target branch rather than committing directly to it, and never push a generated model straight to a protected branch such as `main` without the user's explicit confirmation.

Once `.radius/app.bicep` is committed on the target branch, reopen the view — nodes then deep-link to `https://github.com/<owner>/<repo>/blob/<branch>/<file>` for that branch's source.

## Prerequisites

- For the **modeled graph**: a committed `.radius/app.bicep` or `app.bicep` on the selected branch. If none exists, author one with the `radius-app-bicep` skill first — the canvas will not generate it.
- For the **deployed graph**: at least one successful Radius deploy run so the workflow can capture `rad app graph -a "$APP_NAME" -o json --preview --include-icons`.
- The first graph build may download `rad` into `~/.radius/ai-extensions/bin`. Set `RADIUS_RAD_BINARY` to force a specific binary, or `RADIUS_RAD_SHA256` to pin the downloaded binary checksum.

## Troubleshooting

- **Empty graph**: no committed app definition on the branch. Author `.radius/app.bicep` with the `radius-app-bicep` skill and commit it, then refresh.
- **Graph build fails**: verify `rad app graph <app.bicep> --include-icons` succeeds locally, or check that the cached/downloaded `rad` binary is executable. Do not add `--preview` to this modeled command. On Windows, the extension runs `rad` detached to avoid a known `rad`/Bicep hang under Node’s default job object.
- **Stale graph**: Click Refresh to rebuild from the selected branch's current app definition.
- **PR diff doesn't appear**: verify both base and head branches have a committed `app.bicep` that can be fetched. Branches without one are reported as missing — the diff no longer generates a model for an empty branch, and it no longer requires both branches to have deployed first.

## Related files

- `plugins/radius/extension.mjs` — React Flow rendering + styling (`radiusRenderGraph`)
- `plugins/radius/extension.mjs` — provisioning/diff styling applied during render (`diffMode`, `provisioningState`)
- `adapters/shared/src/rad.mjs` — modeled graph build via the real `rad app graph <app.bicep> --include-icons` CLI (`buildGraphViaRad`, downloads/caches the `rad` binary on first use). Exported from the shared adapter package `@radius-project/shared`.
- `radius-core/src/graph/appgraph.ts` — converts `rad` application graph output into canvas resources (`applicationGraphToResources`), carrying `codeReference`/`definitionFile`/`definitionLine` through to the node
- `radius-core/src/modeling/repo.ts` — fetches the skill-generated `app.bicep` from the repo (`fetchBicepFromRepo`); source-code reference discovery is now handled by this skill's AI agent (see [source-code-references.md](references/source-code-references.md))
- `references/source-code-references.md` — how to locate and attach each resource's definition/initialization site so graph nodes deep-link to source
- `plugins/radius/extension.mjs` — graph diff computation + API handler (`/api/diff-branches`)
- `plugins/radius/extension.mjs` — repo file fetch helpers (`fetchFileFromRepo`) for `.radius/app.bicep` and `app.bicep`
- `plugins/radius/extension.mjs` — graph + diff pages (`graphPage`, `graphDiffPage`) and shared repo/branch dropdown logic
