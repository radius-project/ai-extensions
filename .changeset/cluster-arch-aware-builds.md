---
"radius": patch
---

Thread target-cluster architecture template variables into the generated deploy
workflows so upstream Radius workflow templates can select single-arch vs
multi-arch container image builds based on the deployment target cluster.
`generateDeployWorkflow` now always fills `TARGET_CLUSTER_ARCH_MODE` and
`TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS` with runtime GitHub Actions variable
defaults (`RADIUS_BUILD_ARCH_MODE` / `RADIUS_BUILD_PLATFORMS`), and accepts
optional `templateVars` overrides while still protecting the reserved
`ENV` / `APP_FILE` / `RADIUS_REF` placeholders.
