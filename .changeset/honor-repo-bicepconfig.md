---
"@radius-project/shared": patch
---

Canvas compilation now honors the repository's applicable `bicepconfig.json` in full. `writeBicepCompileConfig` uses the applicable `.radius/bicepconfig.json` verbatim as the temporary compile config instead of reconstructing a minimal `extensions` + `experimentalFeaturesEnabled` subset, so a pinned `extensions.radius` reference, every additional extension alias, and unrelated Bicep settings (analyzers, formatting, moduleAliases, cloud, ...) are all preserved when `rad app graph` runs. `extensibility` is still force-enabled and a `radius` alias is backfilled from the base config only when the repository config omits it; the base `RADIUS_BICEP_CONFIG` is used solely as a fallback when no applicable repository config exists or it is unreadable. This applies to both working-tree and staged remote-branch graph compilation, so canvas validation runs against the same Radius extension contract the generated application targets.
