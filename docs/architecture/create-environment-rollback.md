# Create Environment rollback

Create Environment rollback removes the durable artifacts an environment-creation attempt left behind when it never verified its credentials. Radius deletes only the artifacts the operation record proves it created, checks repository artifacts before it changes them, and stops short of destructive work when it cannot prove what it made. Deleting an established environment is a wider job with different rules.

```mermaid
graph TD
    Attempt["Create Environment operation"] --> Ledger["Durable artifact ledger"]
    Ledger --> Eligibility["Rollback eligibility"]
    Eligibility -->|verified environment| DeleteFlow["Normal Delete Environment flow"]
    Eligibility -->|unverified + proven artifacts| Preview["Rollback preview"]
    Eligibility -->|incomplete provenance| Manual["Manual action guidance"]
    Preview --> Confirm["Customer confirms rollback"]
    Confirm --> Workflow["Verify and revert workflow artifacts"]
    Workflow -->|blocked| Manual
    Workflow -->|safe| GitHubEnv["Delete created GitHub environment"]
    GitHubEnv --> Roles["Delete created role assignments"]
    Roles --> Fic["Delete created federated credentials"]
    Fic --> Sp["Delete created Service Principal"]
    Sp --> App["Delete created App Registration"]
    App --> Complete["Rollback complete"]
```

## Key components

- [`operations.ts`](../../packages/adapter-canvas/src/operations.ts) defines the artifact ledger, stable artifact identity, rollback target selection, eligibility, browser-safe preview, cleanup results, and retry state.
- [`operations-control.ts`](../../packages/adapter-canvas/src/server/routes/operations-control.ts) accepts rollback and rollback-retry commands, persists the command before execution, and enforces one active operation per repository.
- [`cleanup-commands.ts`](../../packages/adapter-canvas/src/server/services/cleanup-commands.ts) selects the deletion set for first rollback, rollback retry, and Exit setup.
- [`workflow-provenance.ts`](../../packages/adapter-canvas/src/server/services/workflow-provenance.ts) proves that committed workflow files and setup branches are still exactly what Radius wrote.
- [`workflow-rollback.ts`](../../packages/adapter-canvas/src/server/services/workflow-rollback.ts) safely removes an unmerged setup branch or creates file-revert commits for workflows that reached a repository branch.
- [`server.ts`](../../packages/adapter-canvas/src/server.ts) executes the ordered cleanup pass, persists each result, invalidates the environment-list cache, and closes the operation.

## Rollback compared with Delete Environment

Rollback and Delete Environment have different starting assumptions.

| Concern             | Create Environment rollback                          | Delete Environment in PR #398                                      |
|---------------------|------------------------------------------------------|--------------------------------------------------------------------|
| Starting state      | Environment creation is incomplete or stopped        | Environment was created and appears in the environment list        |
| Completion boundary | Credential verification has not succeeded            | Environment is an established resource                             |
| Source of truth     | Creation operation's artifact ledger                 | Current deployed environment and deletion operation                |
| Ownership rule      | Delete only artifacts this attempt proves it created | Delete the selected environment; review shared identity separately |
| Workflows           | Revert creation-time workflow changes when safe      | Dispatch the committed environment-deletion workflow               |
| App Registration    | Delete only when this attempt created it             | Prompt before deleting an unused registration                      |
| Service Principal   | Delete only when this attempt created it             | Governed by the established-environment deletion design            |
| Missing resources   | Record `not_found` and converge                      | Treat missing resources as warnings and converge                   |

The two flows can share progress conventions and deletion primitives. They must not share an eligibility shortcut. Rollback leans on saved creation provenance, which an older established environment never recorded. Delete Environment discovers the current state and asks the customer to confirm, two steps rollback avoids by design.

## Completion boundary

Successful credential verification is the product boundary between rollback and deletion.

- Until verification succeeds, the attempt is an unfinished setup, and Radius can roll it back.
- A failed OIDC or Azure Login verification stays rollback-eligible as long as provenance is complete.
- Once verification succeeds, the environment is established, and Delete Environment takes over.
- Committing the workflow does not finish the setup. Radius can still roll back after the commit when it proves the committed artifacts are unchanged and reverts them first.

## The artifact ledger

The operation ledger records what the attempt created, reused, committed, removed, or could not prove. Radius saves it with the operation and restores it when the extension restarts.

### Azure App Registration

Fields:

- `state`: `not_started`, `created`, `reused`, or `deleted`
- `appId`
- `displayName`
- `serviceManagementReference`

Rollback rule:

- `created`: Radius deletes it after removing everything that depends on it.
- `reused`: rollback never deletes it.
- `deleted`: nothing left to do.
- Missing identity: Radius does not target it.

### Service Principal

Fields:

- `state`
- `appId`
- `objectId`

Rollback rule:

- `created`: Radius deletes it.
- `reused`: rollback never deletes it.
- Without a target ID Radius cannot delete precisely, so it records a warning or a manual action.

### Federated credentials

Each entry records:

- Credential `name`
- OIDC `subject`

Rollback rule:

- Every recorded entry is a credential the attempt created, so Radius deletes it.
- Radius deletes these credentials before the Service Principal and the App Registration.
- The stable identity is `name@subject`, not the display label.

### Azure role assignments

Each entry records:

- Role name
- Scope
- Service Principal object ID

Rollback rule:

- Every recorded assignment is one the attempt created.
- Radius deletes assignments before the identity they name.
- Without a principal object ID Radius cannot delete precisely.
- Azure CLI `not found` results count as complete.

### GitHub environment

Fields:

- `state`: includes `created`, `reused`, `created_candidate`, and `deleted`
- Repository
- Environment name

Rollback rule:

- `created`: Radius deletes it.
- `reused`: rollback never deletes it.
- `created_candidate`: Radius cannot prove whether its idempotent request created the environment, so rollback leaves it in place and reports a manual action.
- After a successful deletion, Radius invalidates the server environment-list cache and the browser reloads the list.

### Workflow files

For each committed workflow file, Radius records:

- Repository-relative path
- Branch
- Commit mode: default branch or setup pull request
- State: `committed` or `removed`
- Commit SHA
- Blob SHA
- SHA-256 digest of the exact content Radius wrote
- Previous blob SHA, or `null` when Radius created the path

Radius also records the overall commit state:

- Commit mode
- Setup branch
- Base branch
- Pull request URL
- Last setup-branch head SHA

Rollback rule:

- Radius reverts a committed workflow only while it can prove the file's current state in the repository.
- A removed workflow stays in the ledger as history, and Radius does not target it again.
- Records written before workflow provenance existed fail closed, and Radius refuses post-commit rollback.

### Cleanup results

For every cleanup result, Radius records:

- Cleanup attempt number
- Artifact type
- Human-readable target
- Stable identity when available
- Outcome: `deleted`, `not_found`, `warning`, or `skipped`
- Safe detail

Radius keeps results across cleanup attempts. A retry targets only unresolved warnings on proven-owned artifacts, and it repeats no deletion that already succeeded or already found nothing.

## Stable artifact identity

Radius never matches a resource by display text. `cleanupArtifactIdentity` derives stable identities:

| Artifact             | Stable identity                   |
|----------------------|-----------------------------------|
| App Registration     | App ID                            |
| Service Principal    | App ID, falling back to object ID |
| Federated credential | Name and subject                  |
| Role assignment      | Role and scope                    |
| GitHub environment   | Repository and environment name   |
| Workflow file        | Branch and path                   |

The stable identity ties the ledger artifact, the cleanup target, and the cleanup result together. Display labels carry friendly names and annotations, which makes them unsafe as matching keys.

## When rollback is offered

`canStartRollback` offers rollback when:

- The operation is terminal.
- The environment has not reached `succeeded` or `succeeded_with_warnings`.
- The state is stopped, failed, partially failed, or action required.
- No completed cleanup attempt has already claimed the first rollback.
- At least one proven-owned artifact remains.
- If workflow files were committed, their saved provenance is complete.

`canStartRollback` refuses rollback when:

- The environment verified successfully.
- The operation is still active.
- No proven-owned artifacts remain.
- Rollback already ran and only retry or manual work remains.
- A post-commit record lacks file branch, commit, blob, content digest, or setup-branch head provenance.

The server re-evaluates eligibility when the command arrives. The browser preview explains what will happen, and the server decides what runs.

## What rollback will remove

Radius removes the proven-owned set in this order:

1. Workflow files or the setup branch.
2. GitHub environment.
3. Azure role assignments.
4. Federated credentials.
5. Service Principal.
6. App Registration.

This order runs backward along the dependency chain. Radius removes workflow artifacts before the environment and the identity they use, and it removes assignments and credentials before the identity they name.

## What rollback will not remove

Rollback never removes:

- Reused App Registrations.
- Reused Service Principals.
- Reused GitHub environments.
- A `created_candidate` GitHub environment whose creation cannot be proven.
- A resource identified only by name or display label.
- Workflow files changed since Radius committed them.
- A setup branch whose head contains commits Radius did not write.
- Any dependent cloud resource when workflow rollback is blocked.
- An environment that completed credential verification.
- Application deployments. The customer starts a deployment, and its own deletion flow removes it.

Radius also never assumes a resource is safe to delete because it resembles the expected resource or carries a familiar name.

## Rollback preview

Before the customer confirms, the server projects three lists:

- `removes`: proven-owned targets selected for this rollback.
- `keeps`: reused or intentionally retained resources.
- `manualActionRequired`: ambiguous or unprovable resources with a specific reason.

```text
Roll back this environment setup?

Radius will remove
- Workflow file: .github/workflows/radius-verify-credentials.yml on main
- GitHub environment: owner/repo:dev
- Role assignment: Contributor @ /subscriptions/.../resourceGroups/rg
- Federated credential: radius-dev @ repo:owner/repo:environment:dev

Radius will keep
- App Registration: shared-deploy-app (00000000-...)
- Service Principal: shared-deploy-app (00000000-...)

Needs an action from you
- GitHub environment: owner/repo:old-dev — Radius cannot prove it created this environment.

[Keep resources] [Roll back setup]
```

The server builds the preview from the operation ledger and renders it as text. The browser never computes the deletion set.

## Rollback command acceptance

The route is:

```text
POST /api/operations/{operationId}/rollback
```

The server:

1. Loads the exact operation.
2. Checks for a duplicate cleanup command.
3. Re-evaluates rollback eligibility from the ledger.
4. Acquires the repository operation lock.
5. Snapshots the terminal state for recovery.
6. Increments the cleanup attempt.
7. Records a deterministic command identity based on operation, command kind, attempt, and artifact set.
8. Persists the reopened operation.
9. Schedules the instance-owned cleanup executor.
10. Returns `202`.

If persistence or scheduling fails, the route restores the preceding terminal state or closes the operation with an explicit scheduling failure. It never leaves an active record with no runner.

## Workflow rollback

Radius rolls back workflows before it deletes the GitHub environment or the cloud identity.

```mermaid
sequenceDiagram
    participant Runner as Cleanup executor
    participant Ledger as Operation ledger
    participant Proof as workflow-provenance.ts
    participant GitHub
    participant Cloud

    Runner->>Ledger: Read committed workflow provenance
    Runner->>Proof: Verify files and branch
    Proof->>GitHub: Read files, blobs, branch head, and PR
    alt Any artifact changed or unverifiable
        Proof-->>Runner: blocked + reasons
        Runner->>Ledger: Persist warnings
        Note over Runner,Cloud: No GitHub environment or cloud resource is deleted
    else All artifacts proven
        Proof-->>Runner: safe removal plan
        Runner->>GitHub: Delete setup branch or revert files
        Runner->>Ledger: Persist workflow results
        Runner->>GitHub: Delete created GitHub environment
        Runner->>Cloud: Delete assignments, credentials, SP, and app
        Runner->>Ledger: Persist each result
    end
```

### Unmerged setup pull request

When every workflow sits on the setup branch and the pull request has not merged, Radius:

1. Checks that the branch head still equals the saved head SHA.
2. Closes the pull request, best effort.
3. Deletes the setup branch.
4. Records all workflows as removed.

If the branch head moved, Radius refuses to delete the branch because it contains work the operation did not create.

### Default-branch commit or merged pull request

When workflows already live on a repository branch, Radius:

1. Resolves the branch where each workflow currently lives.
2. Reads the current file.
3. Compares the current blob SHA and content digest with the saved provenance.
4. Commits a deletion if it created the file.
5. Reads the previous blob and commits a restore if it replaced a file.
6. Records each result.

One file that Radius cannot locate, cannot verify, or finds changed blocks the whole workflow pass before Radius modifies anything. The repository never ends up with half its workflows reverted.

## GitHub environment rollback

Radius deletes the GitHub environment only when its ledger state is `created`.

After a proven deletion or a `not found` response, Radius:

- Marks the environment deleted in the ledger.
- Invalidates the environment-list cache for the repository.
- Refreshes the environment table in the browser, where the rolled-back environment disappears from the list.

For `created_candidate`, Radius records a manual action and leaves the environment in place.

## Azure rollback

Azure cleanup touches only the selected stable keys.

### Role assignments

Radius deletes assignments with:

- Service Principal object ID
- Exact role
- Exact scope

Radius does not pass `--assignee-principal-type` to `az role assignment delete`; that flag belongs to create.

### Federated credentials

Radius deletes each recorded federated credential by App Registration ID and credential name.

### Service Principal

Radius deletes the Service Principal only when the ledger state is `created`.

### App Registration

Radius deletes the App Registration only when the ledger state is `created`, and only after assignments, credentials, and Service Principal cleanup.

Radius treats every `not found` result as convergence: the resource is already gone.

## Persistence during rollback

Radius persists the operation after each meaningful result:

- Workflow pass results.
- GitHub environment deletion.
- Each Azure deletion result.
- Final cleanup state.
- Command completion and terminal result.

If the extension stops mid-rollback, the restored ledger shows what is already gone. A later rollback recomputes the target set from the surviving artifacts and repeats no deletion the ledger proved complete.

## Rollback completion

Rollback completes when every selected target is `deleted` or `not_found`.

The operation moves to `cancelled` with terminal reason `rollback-complete`. The UI:

- Hides stale setup-failure banners.
- Stops the spinner.
- Hides resource inventory.
- Reloads the environment list.
- Shows one bottom **OK** button.

If warnings remain, the operation ends `failed_partial` with a rollback-specific failure, and the UI offers **Retry rollback** for unresolved warnings on proven-owned artifacts.

## Exit setup

Exit setup selects the same proven-owned artifacts as rollback and serves a different purpose: it closes an incomplete setup the customer no longer wants to finish.

The route is:

```text
POST /api/operations/{operationId}/exit
```

Exit runs the cleanup pass when proven-owned artifacts exist. When everything remaining was reused, Exit closes the operation and leaves those resources alone. Exit removes a created GitHub environment so the abandoned attempt does not linger in the environment list.

Exit never deletes reused identities. If cleanup cannot finish, the setup stays visible and actionable instead of claiming it closed.

## Rollback retry

Rollback retry uses:

```text
POST /api/operations/{operationId}/retry/cleanup
```

Retry selects only warning results from the latest cleanup attempt that still map to proven-owned ledger artifacts. It excludes:

- Successful deletions.
- Already-absent resources.
- Skipped ambiguous resources.
- Reused resources.

Results from earlier attempts stay in the ledger, so the final report separates what Radius removed earlier from what remains.

## Failure modes

| Failure                                            | Behavior                                                                        |
|----------------------------------------------------|---------------------------------------------------------------------------------|
| Missing workflow provenance                        | Refuse post-commit rollback                                                     |
| Workflow file changed                              | Leave all workflow and dependent resources                                      |
| Setup branch moved                                 | Leave branch and dependent resources                                            |
| GitHub read failed                                 | Record retryable warning; remove nothing dependent                              |
| Workflow revert failed after another file reverted | Record warnings; stop cloud deletion                                            |
| GitHub environment delete failed                   | Preserve warning and continue safe Azure cleanup only when workflow gate passed |
| Azure delete failed                                | Record warning; continue independent deletions                                  |
| Missing precise identity                           | Skip deletion and report manual action                                          |
| Process restart                                    | Restore ledger; recompute surviving target set                                  |
| Duplicate command                                  | Return the existing command; do not schedule twice                              |

## Security and safety invariants

1. **Proven ownership:** Radius deletes only `created` ledger artifacts.
2. **Stable identity:** Radius matches on IDs, paths, branches, roles and scopes, and subjects, never on display text.
3. **Dependency order:** workflows and the environment go before the cloud identity.
4. **All-or-nothing workflow proof:** one unverified workflow blocks dependent cleanup.
5. **Persist-before-progress:** Radius makes accepted commands and deletion outcomes durable before it moves on.
6. **One active repository operation:** cleanup cannot race setup or another cleanup.
7. **No secret exposure:** the browser preview never receives tokens, secret values, CLI output, or diagnostic evidence.
8. **Idempotent convergence:** missing resources count as complete.
9. **No application deployment:** rollback never deploys or deletes deployed applications.

## Discussion points for PR #398

PR #398 adds deletion of an established environment. Aligning it with rollback raises these questions.

### Shared artifact model

- Should deletion reuse the same stable identities and cleanup-result vocabulary?
- Can deletion consume creation provenance when available, while still supporting older environments without it?
- Should the two flows share a common GitHub-environment deletion primitive and environment-list cache invalidation?

### Different identity policy

Rollback deletes an App Registration or Service Principal only when the attempt created it. PR #398 proposes reviewing an App Registration after removing an environment and prompting before deleting one nothing else uses. Keep that distinction explicit:

- Rollback has creation provenance.
- Deletion has current usage discovery and user confirmation.

### Sequencing

Rollback removes workflows before credentials because those workflows reference the identity. PR #398 must keep its own load-bearing order: the environment-deletion workflow needs the federated credential until the Radius environment deletion workflow finishes.

### Progress and recovery

Both flows can align on:

- Durable operation records.
- Stage and step reporting.
- Stop or retry semantics at safe boundaries.
- Idempotent `not_found` outcomes.
- Persisting each destructive result.
- Bottom **OK** on successful completion.
- Cache invalidation and environment-list refresh after GitHub environment removal.

### Scope boundary

Rollback handles an environment that never verified successfully. PR #398 handles an established environment. A shared service must preserve that product distinction and must keep rollback's provenance assumptions from becoming deletion's implicit assumptions.

## Source references

- [`packages/adapter-canvas/src/operations.ts`](../../packages/adapter-canvas/src/operations.ts)
- [`packages/adapter-canvas/src/server/routes/operations-control.ts`](../../packages/adapter-canvas/src/server/routes/operations-control.ts)
- [`packages/adapter-canvas/src/server/services/cleanup-commands.ts`](../../packages/adapter-canvas/src/server/services/cleanup-commands.ts)
- [`packages/adapter-canvas/src/server/services/workflow-provenance.ts`](../../packages/adapter-canvas/src/server/services/workflow-provenance.ts)
- [`packages/adapter-canvas/src/server/services/workflow-rollback.ts`](../../packages/adapter-canvas/src/server/services/workflow-rollback.ts)
- [`packages/adapter-canvas/src/server/services/workflow-rollback-ports.ts`](../../packages/adapter-canvas/src/server/services/workflow-rollback-ports.ts)
- [`packages/adapter-canvas/src/server.ts`](../../packages/adapter-canvas/src/server.ts)
- [PR #398: Clean up cloud state on environment deletion](https://github.com/radius-project/ai-extensions/pull/398)
