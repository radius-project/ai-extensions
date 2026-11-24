---
"radius": patch
---

**Fixed:** Radius validates new and refreshed application models before updating your worktree and refuses to start publication for that request if the saved source has changed. Reloading the graph no longer interrupts a refresh. If a refresh stops because Node.js is missing, install Node.js and reopen the graph to retry without changing the source.
