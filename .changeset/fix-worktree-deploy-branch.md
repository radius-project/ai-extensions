---
"radius": patch
---

Fix Copilot worktree sessions deploying the wrong branch. The Deployments page no longer hard-codes the deploy branch to `main` when the active session branch is an unpushed worktree checkout — it now dispatches the workflow against the active session branch (`contextBranch`), which is the same branch the planned graph and deploy parameters are computed from. The unpushed-branch guard is unchanged, so a branch that hasn't been pushed to GitHub still surfaces a clear "push this branch" message instead of silently falling back to `main`.

The deploy branch is also now exposed as a visible **Branch** selector on the Deployments page (populated from the repo's branches and defaulting to the session/worktree branch), so the user can see and override the branch a deploy is dispatched against. The dispatched `gh workflow run --ref` always matches the selected branch.
