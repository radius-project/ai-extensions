---
"@radius-project/canvas": patch
---

Auto-update committed Radius workflow files when the upstream templates change.

The extension commits the verify, deploy and delete GitHub Actions workflows
into a user repo at environment-creation time, snapshotting the templates from
`radius-project/radius/.github/extension/`. Those copies previously went stale
whenever the upstream templates were revised.

The Environments listing now runs a throttled, background drift check: it
regenerates the expected workflow content for each managed environment and
re-commits any file whose committed copy no longer matches upstream. Files are
synced on the repo's default branch (where the Actions run) AND on the session
worktree branch (when it matches the repo), so a worktree-consistent deploy runs
the up-to-date workflows rather than a stale copy on the branch it checks out. A
file is considered in sync when it matches the generated content for any managed
environment, so repos with multiple environments never churn the cosmetic
per-environment dispatch default; only a genuine upstream change triggers an
update. Missing files (including those on an unpushed working branch) are left to
environment creation to author, and commit failures (e.g. a protected branch) are
logged and skipped rather than aborting the pass.

Also stop the shared extension from tearing down running sessions on rebuild.
The dev self-reload (which restarts the process when the installed
`extension.mjs` changes) used to be armed automatically by a persistent
`.dev-reload` sentinel that `build --install` dropped. Because the installed
extension is user-scoped and shared by every session on the machine, any install
— from any session — restarted the extension in ALL sessions, tearing down their
tools and canvas mid-turn and surfacing as sessions "constantly stopping" or the
app appearing unresponsive. Self-reload is now strictly opt-in per process via
`RADIUS_CANVAS_DEV=1` and is never armed by an on-disk sentinel; `build --install`
no longer drops one and removes any legacy sentinel it finds, and installs the
file exactly once. New code is picked up the normal, non-disruptive way — when a
session next starts a fresh process — instead of by killing running sessions.
When explicitly opted in, the reload still quiesces (defers while a deploy is
monitored or a canvas panel is actively serving) before restarting.
