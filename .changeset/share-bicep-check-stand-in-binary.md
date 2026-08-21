---
"radius": patch
---

The Bicep checker tests now install their stand-in Bicep executable once into a shared temporary home directory instead of copying the ~78 MB Node binary into a fresh directory for each of the 66 cases. That removes roughly 5 GB of disk writes and 5 GB of deletions per run, along with the intermittent test and hook timeouts that copy volume caused.
