---
"@radius-project/canvas": patch
---

Fix Radius canvas deploy and environment-page issues:

- Stop the environments page from repeatedly reloading: derive each canvas
  server's port from the Copilot session id (not just the shared `radius-panel`
  instanceId), so concurrent sessions no longer collide on one global port and
  the client heartbeat stops flapping.
- Make deploys worktree-consistent: dispatch `run-rad-commands.yml` with
  `--ref <selected branch>` and publish the deploy workflow files onto that
  branch when missing, so the deploy runs the same branch's `app.bicep` the
  parameters are computed from (instead of always deploying the default branch).
- Ensure required deploy parameters are always provisioned: the deploy step now
  sets the `RADIUS_DEPLOY_PARAMS` secret (e.g. an `@secure()` password) from the
  branch's `app.bicep` when the environment lacks it, and environment creation
  falls back to the default branch (with a clear warning) instead of silently
  writing nothing.
