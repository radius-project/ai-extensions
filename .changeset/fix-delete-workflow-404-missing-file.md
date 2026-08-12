---
"radius": patch
---

Fix delete deployment failing with HTTP 404 when `delete-application.yml` is missing from the target repo's default branch. Two fixes: the delete workflow templates now default to `radius-project/radius` `main` (they previously pointed at a deleted branch, so the fetch 404'd), and the pre-dispatch workflow sync now **authors** a missing workflow on the branch it will run from — not just updates a drifted one — so any workflow routed through the pre-dispatch check is self-healing. Because self-healing authors the workflow where it will run, deleting a deployment may now write a commit (the delete workflow files) to your repo's default branch; if that branch is protected or the token lacks write access the commit is skipped and the delete surfaces a message naming the branch. Authoring is otherwise guarded so an unpushed working branch is never committed to.
