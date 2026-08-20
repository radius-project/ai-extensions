---
"radius": minor
---

Environment deletion now cleans up the cloud state it created, instead of only removing the GitHub environment and orphaning the rest.

Deleting an environment from the Radius Canvas is now a tracked async operation that runs through the same progress panel as environment creation:

- **Delete the Radius environment** on the cluster first, by dispatching the delete-environment workflow while the environment's federated credential still exists (the workflow authenticates to the cluster with it).
- **Remove the per-environment Azure federated credential** (`repo:<owner>/<repo>:environment:<env>`) from the app registration, so a later environment of the same name no longer fails with a stale-credential OIDC error.
- **Delete the GitHub environment.**
- **Leave the app registration in place:** Radius never deletes a Microsoft Entra app registration — removing one can break other environments or callers that still rely on it, and the registration can be shared. The panel records an informational step noting the app registration (`<client-id>`) was left behind, and on a successful azure deletion an acknowledgement dialog reminds you it was not deleted and tells you to remove it yourself in the Azure portal if you no longer need it.

If the environment still has one or more **deployed applications**, deletion stops before anything is torn down (fail-closed) and the panel tells you to delete the application(s) first, then delete the environment. When the deployed application is known, the error offers a link to its deployment rather than navigating you there automatically. This guard also runs live on the cluster (`rad application list`) inside a static, ai-extensions-owned `delete-environment` workflow, so it catches applications deployed outside the Canvas too.

Deleting an environment now confirms through an in-panel dialog rendered in the page rather than the browser's native `window.confirm`, which the Canvas host suppresses — so the confirm/cancel choice (and therefore the whole deletion) works reliably inside the sandboxed panel.

If the Radius environment delete itself cannot be confirmed — the workflow could not be dispatched, its run was never found, it timed out, or it finished with a non-guard failure (deterministically the case for an AWS provider, since the bundled env-delete workflow is Azure-only) — the deletion now **stops before any other cleanup** and is reported as a retryable partial failure. This is fail-closed: the per-environment federated credential and the GitHub environment the workflow needs to retry are left in place instead of being torn down out from under a still-present Radius environment. Credential cleanup is retry-safe too: if Radius cannot revalidate or delete a credential, it preserves the ownership evidence and keeps the GitHub environment so deletion can be retried. Confirmed missing credentials remain idempotent successes, while later GitHub cleanup remains best-effort.

Removing the per-environment federated credential is now **provenance-gated** (issue #331). Radius durably records both created and reused consumers using immutable Entra identity (tenant, application object, and federated-credential object IDs), stable GitHub repository identity, the subject configuration, issuer, audiences, and the setup operation. A cross-session lock serializes credential setup and reclamation so a new consumer cannot appear between the safety check and destructive action. Before deletion, Radius refreshes the evidence, retains credentials with another recorded consumer, and revalidates the exact live credential immediately before deleting it by object ID. Reused, shared, unproven, externally changed, or insufficiently scoped custom credentials are retained with manual-cleanup guidance. Failed cloud deletion preserves the evidence for retry, successful creation is recorded for rollback before live verification, and failed persistence stops setup rather than silently losing ownership evidence.

An in-flight deletion is recovered and resumed if the extension restarts: the minimum typed inputs needed to resume (including tenant and stable repository identity and the app-registration client id) are persisted, and a mid-stage deletion is rehydrated as resumable instead of being abandoned.

While a deletion is in progress the environment is now reported with a live `deleting` status that greys out the actions that could collide with it: its **Delete Env** button on the Environments tab is disabled, and it can no longer be selected or deployed to on the Deployments tab. The marker is applied fresh on every environment listing (never cached) from the one active delete operation, so it appears the instant deletion starts and clears the instant the operation reaches a terminal state — the row then disappears on success or reverts to its real status on failure.

The background workflow-template sync now authors the static `delete-environment-azure.yml` provider whenever the `delete-environment.yml` dispatcher is present, so a drift rewrite of the dispatcher can never leave a dangling `uses:` reference to an uncommitted reusable workflow.
