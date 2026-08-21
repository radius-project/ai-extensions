---
"@radius-project/core": patch
"@radius-project/adapter-canvas": patch
---

Regenerate an app model that has no origin record instead of asking the user.

Every `.radius/app.bicep` written before origin records existed has no record, so opening a graph asked the user whether to regenerate before showing anything. A missing record says nothing about whether a person edited the file, so there was no decision to put to them. It is now refreshed like any other stale model. Only a model that was changed after it was generated still asks, because that is the case where an overwrite loses work.
