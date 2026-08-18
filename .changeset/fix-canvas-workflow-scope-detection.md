---
"@radius-project/adapter-canvas": patch
---

Fix the Create Environment dialog reporting the acting GitHub account as missing the `workflow` scope (and Re-check never clearing) when a host-injected `GH_TOKEN` shadows a same-login gh keyring credential with a different scope set. `getGitHubIdentity()` now reports the `workflow` scope from the credential that will actually act as each login — the one `decideGhTokenStrategy` selects — instead of always reading the first (injected-token) entry or blanket keyring-first. This clears the warning when the keyring credential has the scope and the injected token does not (issue #213), and avoids the mirror false positive of warning that `workflow` is missing when the injected token already has it. The `write:packages` scope stays keyring-first, matching the credential GHCR pushes authenticate with.
