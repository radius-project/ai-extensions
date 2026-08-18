---
"radius": patch
---

Fix the generated deploy workflow producing invalid YAML for the target-cluster architecture variables. The upstream template wraps the `TARGET_CLUSTER_ARCH_MODE` / `TARGET_CLUSTER_ARCH_FALLBACK_PLATFORMS` placeholders in single quotes, but their values are GitHub Actions expressions whose fallback is itself a single-quoted string literal (`${{ vars.RADIUS_BUILD_ARCH_MODE || 'detect' }}`), so the committed `run-rad-commands-azure.yml` had nested single quotes and failed to parse ("workflow file issue"). Expression-valued placeholders are now emitted as bare YAML plain scalars, which GitHub Actions evaluates identically.
