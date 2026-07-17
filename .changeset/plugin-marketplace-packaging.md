---
"@radius-project/core": minor
"@radius-project/canvas": minor
---

Package the repo as a GitHub Copilot CLI plugin marketplace. Add
`.github/plugin/marketplace.json` and a single `radius` plugin under
`plugins/radius/` that bundles the four Radius skills and the canvas extension.
Skills are now located under `plugins/radius/skills/`, and the canvas
build output is now written to `plugins/radius/extension.mjs`.
