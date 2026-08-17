---
"@radius-project/adapter-canvas": patch
---

Fix the Create Environment dialog reporting the acting GitHub account as missing the `workflow` scope (and Re-check never clearing) when a host-injected `GH_TOKEN` shadows a same-login gh keyring credential that was minted with more scopes. `getGitHubIdentity()` now resolves `hasWorkflow` keyring-first, matching how `hasPackages` already resolved, so the scope check reads the credential `gh auth refresh` actually mutates instead of the unmodifiable injected token.
