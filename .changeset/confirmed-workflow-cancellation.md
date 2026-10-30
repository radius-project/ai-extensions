---
"radius": patch
---

**Fixed:** Keep workflow cancellation bound to the confirmed GitHub account and exact run, refusing a new cancellation if setup changes or the runtime shuts down while it waits. Preserve the original run's result when an already-issued cancellation settles, and report results that cannot be saved without overwriting a replacement setup.

Keep a recorded Stop separate from a delayed workflow-status read: refuse stale results without changing a replacement run or announcing its completion, and report a failed status save without discarding the known result. Cancel remains available while the stopped setup task settles; an unissued cancellation restores only its own unchanged command and workflow status.
