---
"radius": patch
---

Stop asking more than once for the same application model. Four code paths could each independently discover that `.radius/app.bicep` was missing or stale and raise its own authoring turn: a pre-tool-use hook on `open_canvas`, a second hook on `radius_generate_pr_diff_markdown`, a fallback when a canvas panel opened, and the graph HTTP routes. Opening the graph through a tool call ran three of them against the same repository and branch, so the agent could be handed the same instruction several times over.

The graph HTTP routes are now the only owner of that decision, because every render passes through them — a tool-driven open, a direct panel open, a programmatic reload after source refs are attached, the refresh button, plan-graph, and the diff — and they already narrate the wait through the graph progress stages.

- The `open_canvas` and pull-request-diff hooks no longer inspect the application model, and the canvas-open fallback is gone. `radius_generate_pr_diff_markdown` compares the models committed on two named refs, which authoring cannot satisfy by writing the working tree, so it now runs and reports its own outcome; the pull request guard turns a missing model on both branches into "create the pull request without a graph diff section" as it already does for every other unavailable diff.
- The classification itself moved into one module that resolves each branch's model status and sends at most one message: author it, refresh it, ask before overwriting a hand-edited model, or just note that a model on a branch modeling may not rewrite has drifted.
- Load-graph, plan-graph, and the branch diff now reconcile freshness even when a model is already present, so drift is noticed on the paths that previously only checked for a missing file.
- Deduplication is keyed on what is actually wrong with the model rather than on which branches were looked at, so a model that changes from stale to hand-edited between two renders is still reported the second time while an unchanged situation is reported once. The two former paths wrote that key in different formats and so never deduplicated against each other.

A repository with no Dockerfile is still refused rather than modeled, but the panel now opens and states the refusal on the page instead of the open being denied.
