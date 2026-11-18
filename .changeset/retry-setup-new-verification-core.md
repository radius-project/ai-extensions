---
"@radius-project/core": patch
---

**Fixed:** `configureSetupEnvironment` accepts `setupRetryAttempt`, which gives a retried setup its own verification marker and dispatch journal key, so a retry dispatches a new run. A verify workflow that the same operation already committed to the default branch no longer disables setup-branch verification on a continuation.
