---
"radius": patch
---

Detect a stale or unverified `.radius/app.bicep` instead of silently rendering it. The `radius-app-bicep` skill now writes a `.radius/app.origin.json` origin record capturing the source commit, generator version, and a fingerprint of the model that passed the Bicep checker. Opening a graph view compares that record against the branch. A model is regenerated before the graph renders when the application source actually changed (changes confined to `.radius/` do not count, so committing a generated model does not invalidate it) or a different generator is installed. A model that was hand-edited or predates the origin record is surfaced for the user to approve before anything is overwritten. A stale model on a branch the skill cannot rewrite is reported rather than refreshed.
