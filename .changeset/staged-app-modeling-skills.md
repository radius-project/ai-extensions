---
"radius": minor
---

**Changed:** Replace the `radius-app-bicep` skill with three staged skills. `radius-app-model` writes a platform-neutral application graph, `radius-app-plan` checks it against a cloud provider's Recipe pack and writes Recipes for custom resource types, and `radius-app-complete` adds the settings, secrets, and credentials that make it deployable. Each stage writes into `.radius/.staging-*` and publishes only when its check passes. The canvas runs `radius-app-model` for the graph, and runs the plan and complete stages when Deploy finds a model that is not ready.

**Changed:** The canvas starts each graph modeling run itself, with `"publish": false` in the run's `run.json`. The stage's check then validates the run without publishing it, and `radius_complete_app_authoring` checks it again and publishes it.

**Removed:** The `radius_publish_custom_type_extension` tool, because `radius-app-model` builds the custom-types extension itself.
