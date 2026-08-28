---
"@radius-project/adapter-canvas": patch
---

Pause Create Environment after a Canvas provider restart and ask whether to continue or stop. Continuing a recovered verification resumes monitoring its exact saved workflow run without redispatching it.

After Stop, offer cancellation only for the exact active GitHub Actions run recorded by setup. Keep destructive rollback unavailable until Radius proves the run is inactive, while always offering Abandon setup so the user can leave remaining resources in place, release the repository lock, and start Create Environment again.
