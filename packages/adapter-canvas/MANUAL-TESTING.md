# Radius operation persistence manual testing

The automated functional suite covers restart recovery for input-required operations, exact verification references, post-mutation interruption, return context, terminal outcomes, active-operation conflicts, corrupt stores, and forbidden persisted data.

Manual testing remains required only where local fakes cannot prove the behavior of external systems:

1. Verify a real Azure App Registration, Service Principal, federated credential, and role assignment are not duplicated when the extension restarts after the remote mutation.
2. Verify GitHub's live Environment `GET`/`PUT` race still produces `created_candidate` and is never automatically deleted.
3. Verify a real GitHub Actions dispatch is resolved to the expected run when other verification runs exist in the repository.
4. Verify the Copilot host restarts the installed extension and restored Canvas panel with the expected session ID, repository, and worktree branch.
5. Inspect the installed extension's session operation file during a live setup to confirm no provider-specific CLI version emits an unexpected sensitive value into an allowlisted field.

Use disposable Azure and GitHub resources for these checks. Automated tests remain authoritative for deterministic state transitions and persistence behavior.
