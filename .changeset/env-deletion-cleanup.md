---
"radius": minor
---

Environment deletion now cleans up the cloud state it created, instead of only removing the GitHub environment and orphaning the rest.

Deleting an environment from the Radius Canvas is now a tracked async operation that runs through the same progress panel as environment creation:

- **Delete the Radius environment** on the cluster first, by dispatching the delete-environment workflow while the environment's federated credential still exists (the workflow authenticates to the cluster with it).
- **Remove the per-environment Azure federated credential** (`repo:<owner>/<repo>:environment:<env>`) from the app registration, so a later environment of the same name no longer fails with a stale-credential OIDC error.
- **Delete the GitHub environment.**
- **Review the app registration:** if no federated credentials remain, the app registration is unused. Radius never deletes an app registration automatically — removing one can break other environments or callers that still rely on it — so the panel always prompts before deleting it, whether Radius created it (it carries the `radius-managed` tag) or you brought your own. When credentials still remain (it is shared with another environment) it is left in place, and an app registration that is already gone is treated as a clean success with no prompt.

If the environment still has one or more **deployed applications**, deletion stops before anything is torn down (fail-closed) and the panel tells you to delete the application(s) first, then delete the environment. When the deployed application is known, the error offers a link to its deployment rather than navigating you there automatically. This guard also runs live on the cluster (`rad application list`) inside a static, ai-extensions-owned `delete-environment` workflow, so it catches applications deployed outside the Canvas too.

Deleting an environment now confirms through an in-panel dialog rendered in the page rather than the browser's native `window.confirm`, which the Canvas host suppresses — so the confirm/cancel choice (and therefore the whole deletion) works reliably inside the sandboxed panel.

If the Radius environment delete itself cannot be confirmed — the workflow could not be dispatched, its run was never found, it timed out, or it finished with a non-guard failure (deterministically the case for an AWS provider, since the bundled env-delete workflow is Azure-only) — the deletion now **stops before any other cleanup** and is reported as a retryable partial failure. This is fail-closed: the per-environment federated credential and the GitHub environment the workflow needs to retry are left in place instead of being torn down out from under a still-present Radius environment. The later cleanup steps (credential, GitHub environment, app-registration review) remain best-effort and idempotent — a missing credential or app registration is treated as already-done.

Before deleting an unused app registration, the panel **re-lists its federated credentials at the moment you confirm**, so a credential added while the prompt was open (making the app shared again) is detected and the app is left in place rather than deleted along with it.

Removing the per-environment federated credential is now **provenance-gated** (issue #331). Radius records durable, per-credential provenance when it creates a federated credential (the client id, name, subject, issuer, and audiences it wrote), and on delete it only removes a live credential when it can prove from that provenance that Radius created it and the credential is unchanged. A credential Radius merely reused, one with no provenance, or one whose live subject has drifted from what Radius recorded is retained with manual-cleanup guidance instead of being deleted — so a shared, user-owned, or externally modified credential is never removed by mistake. The provenance store is fail-safe: a missing or partially written record makes Radius under-reclaim (retain and warn), never over-delete.

An in-flight deletion is recovered and resumed if the extension restarts: the minimum typed inputs needed to resume (including the app-registration client id and your pending delete decision) are persisted, and a mid-stage or awaiting-decision deletion is rehydrated as resumable instead of being abandoned.

While a deletion is in progress the environment is now reported with a live `deleting` status that greys out the actions that could collide with it: its **Delete Env** button on the Environments tab is disabled, and it can no longer be selected or deployed to on the Deployments tab. The marker is applied fresh on every environment listing (never cached) from the one active delete operation, so it appears the instant deletion starts and clears the instant the operation reaches a terminal state — the row then disappears on success or reverts to its real status on failure.

The background workflow-template sync now authors the static `delete-environment-azure.yml` provider whenever the `delete-environment.yml` dispatcher is present, so a drift rewrite of the dispatcher can never leave a dangling `uses:` reference to an uncommitted reusable workflow.
