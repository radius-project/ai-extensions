---
"@radius-project/core": minor
---

**Changed:** The app origin record gains optional `stage` and `provider` fields, and `stagesBeforeDeploy` returns the modeling stages that a recorded model still needs before it deploys to a provider.

**Removed:** `serializeAppOrigin`, the generator-version freshness check, and the staged-run helpers that mirrored the old promote script. `REQUIRED_STAGED_FILES`, `STAGING_DIR_PREFIX`, and `isStagingDirName` remain.
