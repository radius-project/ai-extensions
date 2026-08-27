---
"radius": patch
---

Fix "View source code" doing nothing on the application graph diff page when the worktree is on an unpushed branch:

- The diff page built a `github.com` URL for every node, so on a branch that exists only locally the link led nowhere. The other graph pages already answered "is this source local?" once at the page level, but a diff renders two branches at the same time and a worktree can only have one of them checked out.
- Locality is now decided per node against the branch that node's source actually lives on, so head-branch nodes open in the workspace while a removed resource — whose file lives on the base branch — keeps its remote link. When the worktree is on neither compared branch, every node stays remote.
- A diff node with no source reference now renders the disabled "No source reference found" row instead of an enabled-looking link that resolved nowhere.
