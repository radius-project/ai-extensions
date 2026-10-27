---
"radius": patch
---

**Fixed:** Keep workflow cancellation bound to the confirmed GitHub account and exact run, refusing a new cancellation if setup changes or the runtime shuts down while it waits. Preserve the original run's result when an already-issued cancellation settles, and report results that cannot be saved without overwriting a replacement setup.
