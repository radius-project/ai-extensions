---
"radius": patch
---

**Fixed:** Keep a permanent modeling failure on reload and retry only after saved source files change or the branch gets a new commit. If the source revision cannot be read, keep the failure and establish a baseline when the read recovers, so later edits can enable retry.
