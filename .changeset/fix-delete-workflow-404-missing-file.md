---
"radius": patch
---

Fix delete dispatches using missing or stale workflow files from the target repo's default branch. The pre-dispatch workflow sync now authors a missing workflow on the branch it will run from, and application deletion fails closed if either the dispatcher or its reusable provider cannot be updated. Because self-healing authors the workflow where it will run, deleting a deployment may now write a commit containing the delete workflow files to the default branch; if that branch is protected or the token lacks write access, the delete surfaces a message naming the failed file and branch. Authoring remains guarded so an unpushed working branch is never committed to.
