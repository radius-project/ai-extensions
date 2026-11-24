---
"radius": patch
---

**Fixed:** Validate new and refreshed models before updating the worktree from a Radius graph. Reloading the graph no longer interrupts a refresh, and publication stops if the saved source changes while the publisher starts. If a refresh stops because Node.js is missing, install Node.js and reopen the graph to retry without changing the source. Comparison and remote graph views no longer start model authoring; open the modeled graph for the checked-out branch to create a missing model.
