---
"radius": patch
---

**Fixed:** Stop blocking pull request creation in worktrees that contain a Radius application model. Radius no longer requires an application graph diff before every pull request, no longer opens the graph-diff canvas after a pull request is created, and no longer tells the agent to generate a graph diff for unrelated pull requests. Ask for a graph diff explicitly when you want one.
