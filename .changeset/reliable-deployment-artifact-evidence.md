---
"radius": patch
---

**Fixed:** Reject conflicting deployment-artifact identities and retire stale evidence even when another application's graph is malformed. Allow later artifact reads to recover after an unexpected read failure. Keep malformed graph reads responsive with bounded scanning and decoding; a graph after output that exhausts those limits may be unavailable while valid progress remains readable.
