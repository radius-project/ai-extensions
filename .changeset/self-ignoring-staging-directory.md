---
"radius": patch
---

Hide a modeling run's staging directory from git from the moment it is created, so an interrupted run cannot have its half-written files committed. The `.radius/.gitignore` rule is only written when a run publishes, so on a repository where no run had ever finished, an interrupted run left `.radius/.staging-<runId>/` untracked and un-ignored, where a bulk `git add -A` would commit it. The staging directory now carries its own ignore file excluding everything in it, which needs no undo on any failure path because it is deleted along with the directory.
