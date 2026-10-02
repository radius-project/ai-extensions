---
"radius": patch
---

**Fixed:** Reject conflicting deployment-artifact identities and unsafe status files, retire stale evidence even when another application's graph is malformed, and report malformed artifact listings as unavailable evidence rather than a missing deployment. Allow later reads to recover after an unexpected failure; bound malformed graph scanning and decoding while keeping valid progress readable even when a later graph cannot be recovered.
