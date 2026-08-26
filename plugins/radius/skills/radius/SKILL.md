---
name: radius
description: Deterministic entry point for the Radius plugin. Use when the user invokes /radius or asks generally to model, visualize, configure, deploy, or delete an application with Radius.
---

# Radius

Route the user's request to the focused Radius skill that owns it:

- Author or update `.radius/app.bicep`: `radius-app-bicep`
- Show, refresh, or compare an application graph: `radius-app-graph`
- Create or verify a deploy environment or cloud credentials: `radius-environment`
- Deploy an application: `radius-deploy`
- Delete a deployment or deploy environment: `radius-delete`
- Repair a missing Radius side panel: `radius-fix-canvas-installation`

Do not duplicate the focused skill's procedure. Invoke it and follow its instructions.

## Session preflight

Before invoking a focused skill that needs repository contents, confirm that a repository is attached to the current session. If none is attached, stop before changing any state and ask: "Which configured repository should I show the app graph for?" Substitute the requested Radius operation for "show the app graph" when the user asked for a different operation.

Repository clone, checkout, and worktree failures belong to the Copilot app. Surface that failure without creating Radius state, then retry the focused skill after the repository is available.

## Canvas preflight

When a focused skill calls `open_canvas`, treat an unavailable `radius` canvas or a canvas load error as an incomplete plugin load. Do not continue as if the side panel opened.

Run `radius-fix-canvas-installation` first because it can repair the known plugin-discovery problem without reinstalling. After a successful repair, tell the user to reload extensions or restart the Copilot app, then retry the original focused skill. If the repair cannot run because the installed plugin files are missing or corrupt, respond:

> The Radius plugin didn't load completely, so I can't show its view in the sidebar. Reinstalling usually fixes this: remove the Radius plugin from the Plugins settings page, add it again, then restart the Copilot app.

Retries start the focused skill again from preflight. Do not reuse partial state from the failed attempt.
