---
"radius": patch
---

Bind the deploy repair handoff's async callbacks and its scheduled retry to the deploy attempt that opened them. A canvas panel is reused across deploys, and the handoff's `delivered`/`failed` callbacks and retry timer all mutated whichever attempt was current when they settled rather than the one they belonged to. Starting a new deploy while a previous handoff was still in flight let the stale settle land on the new attempt: a late `delivered` marked it `deployRepairing`, which the trigger's own guard then read as "this loop is already owned", permanently suppressing that deploy's repair handoff. Each callback now checks that the attempt it was created for is still the current one before touching state or re-triggering, so an older handoff can no longer speak for a newer deploy.
