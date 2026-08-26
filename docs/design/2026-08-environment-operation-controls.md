# Durable Create Environment operation controls

- **Author**: Ryan Waite (@ryanwaite)
- **Date**: 2026-08
- **Status**: In review

## Overview

Create Environment changes Azure identity, GitHub environment settings, repository workflows, and credential verification over several minutes. A user may close the Canvas, lose a response, encounter a permission delay, or stop after Radius has created only part of the environment. The durable operation record introduced by issues [#304](https://github.com/radius-project/ai-extensions/issues/304) and [#305](https://github.com/radius-project/ai-extensions/issues/305) lets the server survive those events, but durability alone does not tell Radius how to stop, continue, retry, or remove partial work.

This design adds durable commands and provider-mutation journals to the server-owned operation. Stop waits for the current external mutation to finish and takes effect at the next safe boundary. Continue and Retry resume from saved state. Rollback removes only resources selected from the artifact ledger and rechecks their provider identities before deletion. Exit closes an incomplete setup and uses the same cleanup machinery when disposable resources remain. The server projects the actions the browser may show, so the Canvas never guesses whether a destructive command is safe.

Successful credential verification is the completion boundary. Before that point, the operation remains an unfinished setup and may be retried or rolled back. After that point, the established environment uses the existing Delete Environment flow, which discovers current state rather than relying on creation-time provenance. No separate Delete Environment design exists in this repository, and no control in this design starts an application deployment.

This note builds on [Progress UX for credential and environment creation](./2026-08-progress-ux-credentials-environments.md). The accompanying architecture references describe the resulting [progress UX](../architecture/create-environment-progress-ux.md) and [rollback behavior](../architecture/create-environment-rollback.md) in operational detail.

## Terms and definitions

| Term                       | Definition                                                                                                                                          |
|----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| **Operation**              | One durable attempt to create and verify a Radius environment for a repository.                                                                     |
| **Command**                | A persisted user decision such as Stop, Continue, Retry, Rollback, or Exit.                                                                         |
| **Safe boundary**          | A point before or after an external mutation where Radius may stop without interrupting that mutation or losing its provenance.                     |
| **Artifact ledger**        | The server-only record of Azure, GitHub, and workflow artifacts created, reused, removed, or left ambiguous by the operation.                       |
| **Proven-owned**           | An artifact whose saved identity and origin prove that the current operation created it and may delete it.                                          |
| **Created candidate**      | An artifact that appeared during the operation but whose API semantics or failed create response do not prove ownership. Radius leaves it in place. |
| **Completion boundary**    | Successful credential verification. Before it, setup controls apply. After it, Delete Environment applies.                                          |
| **Attempt**                | A numbered setup, verification, or cleanup pass within the same operation.                                                                          |
| **Command identity**       | The deterministic key for one accepted user command, derived from the operation, command kind, attempt, and logical target.                         |
| **Mutation journal**       | A durable record written before an external provider request and settled only after an acknowledged result or exact provider-state reconciliation.  |
| **Pinned GitHub executor** | A GitHub command runner bound to the account and credential selected for the operation.                                                             |
| **Terminal latching**      | The rule that the first terminal outcome remains authoritative and later errors cannot replace it.                                                  |
| **Action projection**      | The server-built list of controls, guidance, previews, and next transitions that the browser renders.                                               |

## Objectives

> **Issue Reference:** [#306: Environment Creation Hardening: Add cancellation, resume, and retry controls](https://github.com/radius-project/ai-extensions/issues/306). Native stack 517 ordered the replacement implementation as [PR #508](https://github.com/radius-project/ai-extensions/pull/508), [PR #511](https://github.com/radius-project/ai-extensions/pull/511), [PR #515](https://github.com/radius-project/ai-extensions/pull/515), and [PR #516](https://github.com/radius-project/ai-extensions/pull/516). All four implementation pull requests are merged.

### Goals

1. Let a user stop Create Environment without killing an Azure CLI, GitHub CLI, or HTTP mutation in flight.
2. Let a user stop immediately while Radius is waiting for input, because no mutation is active at that point.
3. Resume input and setup against the same durable operation and artifact ledger.
4. Retry only the failed class of work: setup, verification, or unresolved cleanup.
5. Give every non-terminal state either an automatic transition or a user action.
6. Preserve one active operation per repository within a hydrated Copilot App session across Stop, Continue, Retry, Rollback, Exit, reload, and restart.
7. Latch terminal outcomes and preserve the latest 20 commands plus bounded attempt outcomes across later attempts.
8. Report created, reused, removed, retained, and manually actionable resources truthfully.
9. Remove only artifacts whose saved provenance authorizes cleanup and whose current immutable provider identity still matches.
10. Revert workflow changes before deleting the GitHub environment or cloud identity those workflows use.
11. Bind GitHub setup and rollback to the account the user selected.
12. Make duplicate clicks converge on saved command identities, and make lost provider responses converge through durable mutation journals and exact reconciliation rather than blind replay.
13. Keep deployment user-initiated after environment creation and verification.
14. Present progress and recovery controls in an accessible inline panel that survives navigation and reload.

The design succeeds when a user can stop at any safe point, return after a reload or extension restart, choose a valid forward or cleanup path, and reach a terminal result without waiting for stale-record expiry. It also succeeds when Radius refuses destructive work whenever identity, ownership, repository access, workflow provenance, or provider mutation outcome is uncertain. This durability guarantee currently depends on a writable operation store; [issue #506](https://github.com/radius-project/ai-extensions/issues/506) tracks the unresolved no-op store fallback.

### Non-goals

- **Killing an external command midway.** Stop is cooperative. Radius finishes the active mutation and stops before the next one.
- **The complete external-integration fault matrix from issue #307.** This design handles the failures required by the control paths but does not classify every GitHub, Azure, GHCR, network, or host fault.
- **Release-readiness work from issue #308.** Packaging, qualification, and release policy remain separate.
- **Automatic application deployment.** Create Environment controls never dispatch a deployment.
- **Deleting an established environment.** A verified environment follows the existing Delete Environment flow, which starts from current state rather than creation provenance.
- **Deleting reused or ambiguous resources.** Radius preserves them and explains why.
- **A general workflow engine for every Radius operation.** This design establishes patterns that later operations may reuse, but it changes only Create Environment.
- **New providers or cloud resource types.** The control model remains provider-neutral, but this work does not add a provider.
- **Percentage-complete estimates.** Create Environment has conditional stages and no fixed denominator.

### User scenarios

#### User story 1: Stop and continue

A developer starts Create Environment, sees that Radius has created the App Registration, and clicks **Stop setup**. Radius finishes the current mutation, persists its result, and stops before the next mutation. The server projects **Continue setup** only when the saved request and ledger support a safe forward step, **Roll back created resources** only when at least one proven-owned target is removable and no provider outcome remains unresolved, and **Exit setup** for any unfinished terminal attempt that the user has not already exited. Continue starts from the first incomplete step and reuses the recorded App Registration.

#### User story 2: Stop while Radius waits for input

Radius finds more than one eligible App Registration and asks the developer to choose one. The operation enters `input_required`, persists the prompt and resume request, and releases its executor. The developer may answer the prompt or stop immediately. If nobody answers for 60 minutes, stale reconciliation terminalizes the prompt as `failed_partial` with `operation-input-expired`, which releases the active lock while preserving any cleanup authority. A late answer cannot revive a terminal operation.

#### User story 3: Retry verification after an external condition changes

Radius commits workflows to a setup branch and asks the developer to merge a pull request. After the merge, the developer returns and clicks **Retry verification**. Radius reacquires the saved GitHub account within a persisted 45-minute acquisition window, proves the merge with that executor, establishes a workflow-run baseline, and dispatches the saved workflow, ref, environment, event, and operation marker. It adopts only the run whose exact identity matches. A similar retry covers positively identified Azure access propagation. OIDC configuration failures keep their own explanation rather than being mislabeled as propagation.

#### User story 4: Roll back partial setup

Setup fails after Radius creates Azure identity resources and a GitHub environment. The developer reviews the rollback preview and confirms. Radius removes workflow changes first when they exist, then deletes the GitHub environment, role assignments, federated credentials, Service Principal, and App Registration in reverse dependency order. Reused resources remain.

#### User story 5: Leave an incomplete setup

The developer no longer wants to finish the environment. **Exit setup** appears below **Show details**. Exit is a product decision to close the incomplete interaction; Rollback is the explicit destructive recovery choice to undo setup. Exit invokes the same cleanup executor only when proven-owned disposable resources remain. If nothing owned remains, it closes without destructive work. If cleanup cannot finish, the operation stays visible with Retry rollback or manual guidance and is not marked exited.

#### User story 6: Recover from reload, restart, or duplicate input

The developer reloads the Canvas, the extension restarts, or a command response is lost. The browser reloads the same operation. The registry restores persisted state, reopens unresolved provider or cleanup journals for reconciliation, keeps proven cleanup results, and terminalizes only after it can state what happened or hand the ambiguity to the user. A repeated command resolves to the saved command rather than scheduling a second mutation.

## User experience

Create Environment uses the inline progress panel defined by [Progress UX for credential and environment creation](./2026-08-progress-ux-credentials-environments.md). The panel separates its headline from the stage summary and the detailed event history. Recovery actions sit above **Show details**. **Exit setup** and terminal **OK** sit below it.

**Sample input:**

```text
Create Environment

Profile: azure-prod
Environment: dev
Repository: contoso/store
Branch: feature/cart
Resource group: rg-prod
AKS cluster: aks-prod

[Create Environment]
```

**Sample output while Stop is pending:**

```text
Creating environment "dev"                                  0:42
Creating GitHub environment...

✓ Authorize deploy identity - succeeded
● Configure environment - running
○ Verify credentials - pending

[Stopping after the current step...]

▸ Show details
```

**Sample output after Stop:**

```text
Environment setup stopped                                   0:45
Radius stopped before the next setup step.

✓ Authorize deploy identity - succeeded
✓ Configure environment - stopped safely
- Verify credentials - skipped

[Continue setup] [Roll back created resources]

▸ Show details

[Exit setup]
```

**Sample rollback confirmation:**

```text
Roll back this environment setup?

Radius will remove
- Workflow file: .github/workflows/radius-verify-credentials.yml on main
- GitHub environment: contoso/store:dev
- Role assignment: Contributor @ /subscriptions/.../resourceGroups/rg-prod
- Federated credential: radius-dev @ repo:contoso/store:environment:dev

Radius will keep
- App Registration: shared-deploy-app (00000000-...)

Needs an action from you
- Service Principal: Radius cannot prove this attempt created it.

[Keep resources] [Roll back setup]
```

The server supplies every action and preview. The browser submits the projected route, shows accepted-command status in a polite live region, and disables controls while the command is in flight. Polling preserves focus on an unchanged command. If the command disappears, focus moves to a visible heading or panel. Confirmation traps focus; cancellation returns to the trigger; successful Exit moves focus to **New environment** before the panel closes.

## Design

### High-level design

The durable operation record is the source of truth for setup progress and control. It stores lifecycle state, attempts, the latest 20 commands, input prompts, verification identity, provider-mutation journals, resource provenance, cleanup results, and bounded terminal history. The registry treats a non-terminal record as active admission and also retains admission for a terminal record that can still execute cleanup against a proven-owned artifact.

A control route loads the record, checks eligibility, records a deterministic command, changes the operation state, persists the record, and then schedules an instance-owned executor. The executor performs one setup, verification, reconciliation, or cleanup pass. Before each external mutation it persists a journal entry containing the operation-scoped mutation identity, logical target, intended provider state, and provider idempotency key when supported. It settles the entry only after an acknowledged result or exact provider-state reconciliation. The browser polls the record and renders the server's action projection.

Rollback reads the artifact ledger and selects only proven-owned artifacts. Workflow rollback gates all later deletion. The GitHub rollback runner uses the account saved on the operation, proves repository access, verifies workflow blobs and content, and rechecks access after a 404 before it treats an artifact as absent. Each provider deletion verifies the current immutable identity, journals one delete, and reconciles an uncertain response without replaying the delete. Azure cleanup runs only after the workflow gate passes.

#### Durability precondition and unresolved store gap

The safety model requires a writable operation store. The normal store writes under the verified Copilot session directory with a temporary-file-and-rename update. When the extension cannot resolve that directory or initialize the file store, it currently installs `disabledOperationStore()`. That fallback returns success from `save()` without writing anything, so Create, Stop, Retry, Rollback, Exit, provider journals, and cleanup journals can appear durable even though no record will survive restart.

This is an unresolved safety defect, not a supported durability mode. [Issue #506](https://github.com/radius-project/ai-extensions/issues/506) tracks a capability contract and fail-closed route behavior. Until it is fixed, the extension logs `operation-store-unavailable`, but mutating routes do not reliably reject the operation. Read-only Canvas features may continue, while durable environment mutation should eventually return a precise unavailable response before contacting a provider.

### Architecture diagram

```mermaid
flowchart TD
    User["Developer"] --> Browser["Environment progress controller"]
    Browser -->|"POST command + mutation nonce"| Routes["Operation control routes"]
    Routes --> Eligibility["State and provenance eligibility"]
    Eligibility --> Commands["Durable command history"]
    Commands --> Store["Operation store"]
    Store --> Scheduler["Instance-owned scheduler"]
    Scheduler --> Setup["Setup executor"]
    Scheduler --> Verify["Verification executor"]
    Scheduler --> Cleanup["Cleanup executor"]
    Setup --> Ledger["Artifact ledger"]
    Verify --> Ledger
    Cleanup --> WorkflowGate["Workflow provenance and rollback"]
    WorkflowGate -->|"safe"| GitHubCleanup["Pinned GitHub cleanup"]
    WorkflowGate -->|"blocked"| Manual["Manual guidance"]
    GitHubCleanup --> AzureCleanup["Azure cleanup"]
    AzureCleanup --> Ledger
    Ledger --> Projection["Browser-safe action and status projection"]
    Projection --> Browser
```

### Detailed design

#### Option 1: Browser-owned cancellation and retry

The browser would keep the active request, abort it when the user clicks Stop, and resend the Create Environment request for Retry.

##### Advantages

- Small change to the existing page code.
- No new command routes or persisted command model.
- Familiar request and response flow.

##### Disadvantages

- Aborting the browser request does not prove whether an external mutation succeeded.
- Navigation, reload, or host restart loses the control state.
- Resending the full request can duplicate cloud resources or overwrite repository files.
- The browser cannot safely decide what to delete.
- A lost response can leave the repository locked until stale timeout.

#### Option 2: Durable operation with coarse terminal retry

The server would keep the durable operation and expose a general Retry button that restarts setup from the beginning. Stop would mark the record terminal after the current request returns. Cleanup would remain a separate best-effort failure path.

##### Advantages

- Preserves operation identity across reload and restart.
- Keeps external work on the server.
- Requires fewer routes than separate commands.

##### Disadvantages

- A general Retry cannot distinguish setup, verification, and cleanup.
- Restarting from the beginning can repeat mutations whose outcomes are already known.
- A terminal flag does not record the user's command or make duplicate input idempotent.
- Cleanup cannot remove resources safely without an artifact ledger and stable identity.
- Verification handoff and input-required pauses remain special cases.

#### Proposed option: Durable commands over a provenance ledger

Radius records each user decision as a command on the existing operation. The command kind, attempt number, and logical target determine a stable command ID. The control route persists the reopened operation before it schedules work. The executor reads the retained artifact ledger and performs only the selected work.

This option costs more code because it models the real states instead of hiding them behind one Retry button. It gives every state an owner, makes duplicate input converge, and lets destructive work fail closed. It also preserves the server-owned execution and operation durability established by issues #304 and #305.

#### Operation record and schema

[`packages/adapter-canvas/src/operations.ts`](../../packages/adapter-canvas/src/operations.ts) owns the schema. Schema version 5 stores:

- Setup, verification, and cleanup attempt counters.
- Stop request and honored boundary.
- The latest 20 commands with accepted, running, and finished states.
- Input-required prompt and safe resume request.
- Verification workflow, ref, environment, event, operation marker, baseline run ID, exact run ID, run URL, acquisition deadline, and tracking deadline.
- Provider-mutation journal entries with deterministic mutation ID, kind, target, status, intent, provider idempotency key when supported, immutable provider ID, reconciliation attempts, and safe evidence.
- Artifact ledger and cleanup results.
- Workflow commit, blob, content digest, previous blob, and proof that the previous path state was observed.
- Terminal outcomes and prior attempt history.

Versions 1 through 4 load into the version 5 shape. Missing provenance remains missing. A legacy null previous blob does not become permission to delete a workflow merely because a later retry writes the file again. A non-null prior blob still proves that the path existed. A pre-version-5 non-terminal record interrupted without a mutation journal cannot prove what external request was in flight, so restart recovery quarantines it as `unrecoverable_legacy` and disables automatic forward or destructive work.

#### Command acceptance and idempotency

[`packages/adapter-canvas/src/server/routes/operations-control.ts`](../../packages/adapter-canvas/src/server/routes/operations-control.ts) follows one acceptance sequence:

1. Load the operation and parse the command target.
2. Return the saved command for a duplicate submission.
3. Re-evaluate eligibility from the durable record.
4. Acquire the repository through the non-terminal operation state.
5. Save a snapshot of the preceding terminal state.
6. Increment the appropriate attempt counter.
7. Record the deterministic command.
8. Position the operation at the correct stage or cleanup state.
9. Persist.
10. Schedule the executor.

If persistence fails, the route restores the snapshot. If scheduling fails, it restores the terminal record or closes the promised retry with an explicit failure. The route never returns success while leaving a non-terminal record with no executor.

The command ID has this logical shape:

```text
{operationId}:{commandKind}:{attempt}:{target}
```

Cleanup commands include a digest of the exact artifact keys selected for deletion. A duplicate click or reload while that attempt remains current therefore resolves to the same command. A later deliberate retry increments the attempt and creates a new command; external-mutation safety comes from the separate provider journal.

#### Provider mutation identity and reconciliation

[`packages/adapter-canvas/src/server/services/provider-mutation-recovery.ts`](../../packages/adapter-canvas/src/server/services/provider-mutation-recovery.ts) persists each external mutation as `prepared` before the request. An acknowledged result settles it as `confirmed` or `not_applied`. A timeout, killed process, network loss, or response that cannot be trusted settles it as `outcome_unknown` and triggers exact provider-state reconciliation. Radius does not issue the mutation again while the outcome remains unresolved.

Reconciliation compares the saved intent and immutable provider identity with current provider state. It adopts only an exact match, records conclusive absence as not applied or not found according to the operation, and marks ambiguity as `manual_required`. Unreadable provider state retries at most 12 times; the final handoff names the resource and forbids automatic replay or deletion.

Cleanup deletion uses the same journal through [`cleanup-deletion-journal.ts`](../../packages/adapter-canvas/src/server/services/cleanup-deletion-journal.ts). The journal keys a delete by exact immutable identity, verifies that a reusable name still resolves to that identity before sending one delete, and reconciles an uncertain response by reading the exact target. A present or unreadable target after an uncertain delete requires manual action rather than a second delete.

#### Cooperative Stop

The Stop route never kills a child process. It returns `200` when it can cancel an idle input prompt immediately or the operation is already stopped, `202` when active setup or verification must reach a safe boundary, `409 operation-cleanup-not-stoppable` while Rollback, Retry rollback, or Exit cleanup is active, `409 operation-already-terminal` after another terminal result, and `500 operation-stop-persist-failed` when the request cannot be saved.

Setup checks Stop before every external mutation and after the checkpoint that records the preceding mutation. Azure identity setup, GitHub environment creation and configuration, GHCR bootstrap, workflow writes, pull-request creation, and initial or retried verification dispatch use these boundaries. When an executor is active, Stop remains pending until the executor reaches one, and the operation records which boundary honored the request. If a provider response is already uncertain, read-only reconciliation finishes or hands the ambiguity to the user before Stop becomes terminal; the operation reports `provider-reconciliation-pending` rather than stranding an open journal entry.

Rollback, Retry rollback, and Exit cleanup are different. Each runs as one durable cleanup pass with no Stop boundary between deletions. The UI therefore offers no Stop action while cleanup runs, and the Stop route returns `409 operation-cleanup-not-stoppable` without recording a request. The customer waits for cleanup to finish; warnings then offer Retry rollback or manual guidance.

#### Input resume

An input-required operation persists the prompt code, checkpoint, candidates, default selection, request time, and safe resume request. The browser submits the answer to the prompt-specific resume route with the operation ID, repository, environment, provider, and checkpoint. The server rejects stale prompts and answers for terminal operations.

The operation does not hold the host process alive while waiting for a person. It retains active admission because a second setup would race the paused artifacts. After 60 minutes without an answer, stale reconciliation ends the operation as `failed_partial` with `operation-input-expired`, releases active admission, and retains cleanup admission only when removable proven-owned artifacts remain.

#### Targeted retries

Setup retry resumes from `nextIncompleteSetupStep`. It reuses ledger-confirmed resources and routes first to any outstanding mutation owner. It refuses unrelated forward writes while provider reconciliation or rollback is pending.

Verification retry uses the saved workflow, ref, environment, event, operation marker, and GitHub login. Before contacting GitHub, the route persists a 45-minute selected-executor acquisition deadline. The selected account is retained through pull-request merge proof, workflow-run baseline, dispatch, exact-run discovery, and monitoring; missing or unavailable identity fails closed with account-specific guidance. The retry covers a merged setup pull request, positive Azure access propagation evidence, expired tracking, and a failed dispatch. A failed OIDC claim, workflow syntax problem, or runner fault keeps its own classification and copy.

Cleanup retry selects warning results from the latest cleanup attempt that still map to proven-owned ledger artifacts. It excludes successful deletion, restoration, `not_found`, skipped ambiguity, and reused resources.

#### One active operation and terminal latching

Within one hydrated Copilot App session and process, the registry uses a repository's non-terminal operation as active admission. Continue and Retry reopen the same operation. A terminal operation also retains cleanup admission while its ledger contains an executable first-Rollback or Retry-rollback target. A new setup receives `409 previous-cleanup-required` with the earlier operation ID until those targets are deleted, restored, or proved absent. Independent Copilot sessions do not share this registry or operation file and can still race on the same repository.

The first terminal result latches. Later errors cannot overwrite it. A terminal transition closes any accepted or running command so a stale command cannot absorb the next user action.

Restart reconciliation handles each saved state:

- A saved Stop finishes at the restart boundary.
- An unexpired input prompt returns to `input_required`.
- A complete verification identity returns to verification tracking.
- An interrupted cleanup or provider mutation reopens for journal reconciliation before any new mutation.
- A settled interrupted cleanup remains available for Rollback or Retry rollback against surviving ledger targets.
- Other interrupted work becomes `failed_partial` with a safe retry or cleanup path.

Stale-record reconciliation never terminalizes an in-memory operation while its executor is active.

#### Artifact ledger and ownership

The ledger distinguishes presence from origin. `state` answers whether this operation may remove the artifact. `origin` explains where the artifact came from.

| Artifact             | Saved cleanup identity                             | Ownership and deletion rule                                                                                                                 |
|----------------------|----------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|
| App Registration     | App ID                                             | Delete only when this operation created it and the current App ID still matches.                                                            |
| Service Principal    | Provider object ID with App ID context             | Delete only when creation succeeded, was journaled, and the current provider object still matches. A create race remains a candidate.       |
| Federated credential | Provider object ID with App ID, name, and subject  | Delete only a journaled creation whose current provider ID still matches.                                                                   |
| Role assignment      | Assignment resource ID, role, scope, principal     | Delete only a journaled creation whose exact assignment resource ID still matches.                                                          |
| GitHub environment   | GitHub environment ID, repository, and name        | Promote after bounded creation inference; delete only when the current environment ID still matches and the selected account proves access. |
| Workflow file        | Branch, path, blob, content digest, and prior blob | Revert only with complete commit and previous-state provenance and an unchanged current file.                                               |

Provenance is monotonic for the same identity. A later lookup that finds a created resource does not downgrade it to reused. A different identity does not inherit ownership.

GitHub environment creation needs special handling because the PUT API is idempotent. Radius records a candidate, requires a preflight absence result, compares the returned creation time with the request, captures GitHub's environment ID, promotes a matching candidate, and persists that promotion in the mutation checkpoint before it honors Stop. This is bounded inference rather than perfect ownership proof: another actor can create the same environment name between the lookup and PUT and still fall inside the timestamp tolerance. The design accepts this low-likelihood residual race, while cleanup independently refuses deletion if the current environment ID differs or repository access cannot be proved.

#### Workflow provenance

For each workflow write, Radius saves the target branch, commit SHA, blob SHA, content SHA-256, previous blob SHA, whether the pre-write lookup proved the prior path state, and a journal entry for the provider mutation. A retry reconciles any unresolved write before it considers another mutation, then updates the current commit, blob, and digest.

Radius preserves the original pre-setup blob only when the new write proves it replaced the blob from Radius's preceding write. If another actor edits the workflow between Radius writes, the next record saves that intervening blob as the version rollback must restore. If the prior state was never observed, rollback refuses the file.

#### Rollback

Rollback is available only before successful credential verification. The server builds the preview and selection from stable ledger keys. The browser displays the preview but never derives the target set.

Pre-commit rollback removes:

1. GitHub environment.
2. Azure role assignments.
3. Federated credentials.
4. Service Principal.
5. App Registration.

Post-commit rollback first removes workflow changes:

1. Create a pinned executor for the GitHub account saved on the operation.
2. Prove that account can read the repository.
3. Read the setup pull request, branch head, and every workflow.
4. Recheck repository access after any file, branch, or deletion 404 before treating it as absence.
5. Refuse the whole workflow pass if one file changed or cannot be verified.
6. Delete an unchanged unmerged setup branch, or commit per-file deletes and restores.
7. Before every provider deletion, prove that the current immutable identity still matches the ledger and persist one cleanup-journal entry.
8. Record `deleted`, `restored`, `not_found`, `warning`, or `skipped`.
9. Delete the GitHub environment and Azure identity only after the workflow pass succeeds.

This order prevents an installed workflow from losing the credentials and environment it references.

#### Exit setup

Exit and Rollback use the same proven-owned cleanup selection but are separate commands. Rollback is an explicit destructive recovery choice to undo an unfinished setup and leaves the terminal operation available for acknowledgement. Exit expresses that the user is done with the incomplete interaction; it runs cleanup as a consequence only when disposable targets remain, and it marks the setup exited only after that cleanup succeeds.

Exit appears at the bottom of the panel. It confirms destructive cleanup when needed. An operation that owns nothing closes without deletion. An incomplete cleanup remains visible and actionable.

#### GitHub identity and credential selection

Create Environment pins one [`SelectedGhExecutor`](../../packages/adapter-canvas/src/gh.ts) to the selected login and credential source. The executor verifies the acting login before it runs commands. Setup, workflow publication, GHCR credential reporting, verification retry and monitoring, workflow rollback, and GitHub environment deletion use that identity.

The credential resolver distinguishes `GH_TOKEN` and `GITHUB_TOKEN` from stored `oauth_token` and keyring entries by exact source. It reads scopes from the credential it selected, even when the same login appears twice. A whitespace-only `GH_TOKEN` does not hide a valid `GITHUB_TOKEN`. Account-qualified keyring lookup uses GitHub CLI multi-account support and a bounded timeout. The GitHub CLI 2.40 prerequisite is checked when Radius first needs account-specific token resolution, not at extension startup, so an older client can begin setup and encounter the version error only when that lookup becomes necessary.

Workflow-scope fallback runs only after a positive missing-scope response and never after a timeout with unknown outcome. User guidance names the credential that actually failed. Radius does not tell a user to refresh an injected session token that GitHub CLI cannot change.

#### Action projection and browser behavior

`toClientView` projects:

- Headline and supporting text.
- Current and terminal state.
- Safe stage and step labels.
- Cleanup inventory and manual actions.
- Valid controls and their placement.
- Confirmation copy and rollback preview.
- Guidance for unavailable paths.
- The next automatic transition.

[`packages/adapter-canvas/src/browser/environment/operations.ts`](../../packages/adapter-canvas/src/browser/environment/operations.ts) parses this narrow contract. It does not receive tokens, secret values, raw CLI output, workflow logs, or private failure evidence.

The browser keeps the high-level headline separate from detailed steps. It rebuilds projected controls as state changes while preserving keyboard focus when the same action remains. Live-region status changes only when the message changes. Every terminal path releases the page's Create Environment latch, including verification fallback and timeout paths.

#### Environment-list consistency

Rollback and Exit invalidate the repository-scoped environment-list cache before the operation becomes terminal. The browser reloads the table after GitHub environment removal. A cache generation counter prevents an older in-flight listing from repopulating stale data after invalidation.

### API design

These routes are loopback Canvas APIs. Mutation routes require `X-Radius-Mutation-Nonce`. The retry handler is registered as one template route, `/api/operations/{operationId}/retry/{retryKind}`, where `retryKind` is `setup`, `verification`, or `cleanup`.

| Method | Path                                              | Purpose                                                      |
|--------|---------------------------------------------------|--------------------------------------------------------------|
| `POST` | `/api/operations`                                 | Start and persist a server-owned environment operation.      |
| `GET`  | `/api/operations?repo={repo}`                     | Read the current operation for a repository.                 |
| `GET`  | `/api/operations/{operationId}`                   | Read one operation.                                          |
| `POST` | `/api/operations/{operationId}/stop`              | Persist a cooperative Stop request.                          |
| `POST` | `/api/operations/{operationId}/continue`          | Continue an intentionally stopped setup.                     |
| `POST` | `/api/operations/{operationId}/resume/{code}`     | Supply input for a persisted prompt.                         |
| `POST` | `/api/operations/{operationId}/retry/{retryKind}` | Retry setup, verification, or cleanup.                       |
| `POST` | `/api/operations/{operationId}/rollback`          | Start proven-owned cleanup.                                  |
| `POST` | `/api/operations/{operationId}/exit`              | Close incomplete setup and clean disposable owned artifacts. |

Example accepted command response:

```json
{
  "operationId": "op_123",
  "commandId": "op_123:rollback:1:cleanup#7ed8b4d1326b3c90",
  "attempt": 1,
  "statusUrl": "/api/operations/op_123",
  "operation": {
    "operationId": "op_123",
    "state": "running"
  }
}
```

The accepted response has no top-level command `state`; command state is part of the browser-safe `operation` projection. The operation read response contains the same narrow projection rather than the private ledger. The exact action list changes with state.

### Implementation details

#### Core package: packages/core

N/A. The controls govern Canvas orchestration and external adapter mutations. No UI-agnostic core API changes.

#### Canvas adapter: packages/adapter-canvas

- [`src/operations.ts`](../../packages/adapter-canvas/src/operations.ts) owns schema version 5, commands, attempts, lifecycle rules, provider-recovery state, artifact provenance, rollback selection, action projection, persistence normalization, restart reconciliation, and session-scoped repository admission.
- [`src/operation-store.ts`](../../packages/adapter-canvas/src/operation-store.ts) persists operation envelopes.
- [`src/server/routes/operations-control.ts`](../../packages/adapter-canvas/src/server/routes/operations-control.ts) owns Stop, Continue, Rollback, Exit, and Retry routes.
- [`src/server/routes/create-environment.ts`](../../packages/adapter-canvas/src/server/routes/create-environment.ts) orchestrates GitHub setup, provider journals, provenance checkpoints, reconciliation routing, and safe boundaries.
- [`src/server/routes/azure-auto-setup-application.ts`](../../packages/adapter-canvas/src/server/routes/azure-auto-setup-application.ts) and [`azure-auto-setup-credentials.ts`](../../packages/adapter-canvas/src/server/routes/azure-auto-setup-credentials.ts) record identity origin and stop between Azure mutations.
- [`src/server/routes/create-environment-workflow-committer.ts`](../../packages/adapter-canvas/src/server/routes/create-environment-workflow-committer.ts) records commit and previous-path provenance.
- [`src/server/services/cleanup-commands.ts`](../../packages/adapter-canvas/src/server/services/cleanup-commands.ts) defines cleanup command selections.
- [`src/server/services/provider-mutation-recovery.ts`](../../packages/adapter-canvas/src/server/services/provider-mutation-recovery.ts) journals external writes and reconciles lost or uncertain responses.
- [`src/server/services/cleanup-deletion-journal.ts`](../../packages/adapter-canvas/src/server/services/cleanup-deletion-journal.ts) journals one exact-identity provider deletion and prevents destructive replay.
- [`src/server/services/verification-retry.ts`](../../packages/adapter-canvas/src/server/services/verification-retry.ts) owns selected-account acquisition and tracking deadlines.
- [`src/server/services/verification-retry-runner.ts`](../../packages/adapter-canvas/src/server/services/verification-retry-runner.ts) keeps the selected executor through merge proof, dispatch, exact run discovery, and monitoring.
- [`src/server/services/workflow-provenance.ts`](../../packages/adapter-canvas/src/server/services/workflow-provenance.ts) verifies workflow and branch identity.
- [`src/server/services/workflow-rollback.ts`](../../packages/adapter-canvas/src/server/services/workflow-rollback.ts) chooses branch deletion or per-file reversion.
- [`src/server/services/workflow-rollback-ports.ts`](../../packages/adapter-canvas/src/server/services/workflow-rollback-ports.ts) maps pinned GitHub commands into fail-closed reads and mutations.
- [`src/server/services/github-environment.ts`](../../packages/adapter-canvas/src/server/services/github-environment.ts) classifies GitHub environment creation evidence and captures the provider ID.
- [`src/server/services/environment-absence.ts`](../../packages/adapter-canvas/src/server/services/environment-absence.ts) distinguishes proved absence from an access-hidden GitHub 404.
- [`src/server/services/environment-listing-cache.ts`](../../packages/adapter-canvas/src/server/services/environment-listing-cache.ts) prevents stale listings after cleanup.
- [`src/gh.ts`](../../packages/adapter-canvas/src/gh.ts) selects, verifies, pins, and describes the effective GitHub credential.
- [`src/server.ts`](../../packages/adapter-canvas/src/server.ts) composes per-instance executors and runs ordered cleanup.
- [`src/server/services/operation-stop-boundary.ts`](../../packages/adapter-canvas/src/server/services/operation-stop-boundary.ts) centralizes persist-and-honor Stop behavior between provider mutations.
- [`src/pages/environment/environments-pane.ts`](../../packages/adapter-canvas/src/pages/environment/environments-pane.ts) renders progress and confirmation markup.
- [`src/browser/environment/operations.ts`](../../packages/adapter-canvas/src/browser/environment/operations.ts) renders the operation, sends controls, polls, manages focus, and applies terminal results.
- [`src/browser/environment/page.ts`](../../packages/adapter-canvas/src/browser/environment/page.ts) owns the Create Environment latch and supplies the terminal reset.

#### Shared adapter: packages/adapter-shared

N/A. The design does not change managed Radius or Bicep execution.

#### Plugin: plugins/radius

The plugin manifest, Canvas ID, action surface, and tool surface do not change. The generated `plugins/radius/dist/extension.mjs` includes the Canvas adapter changes after the normal build.

#### Build and packaging

The build continues to emit one loadable extension bundle with the Copilot SDK externalized. Changesets describe operation controls, GitHub credential selection, post-commit rollback, selected-account verification recovery, provider journals, and Stop hardening. No runtime dependency or lockfile change is required.

### Error handling

| Failure                                                  | Result                                                                                                                                                                              |
|----------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Durable store is disabled                                | The current fallback can report successful saves that do not survive restart; issue #506 tracks fail-closed route behavior.                                                         |
| Operation persistence fails before mutation              | Return failure and change no external resource.                                                                                                                                     |
| Command persistence fails                                | Restore the preceding terminal snapshot.                                                                                                                                            |
| Provider journal persistence fails before mutation       | Do not contact the provider.                                                                                                                                                        |
| Provider journal persistence fails after mutation        | Stop further provider work; keep the operation reserved and report the unresolved recovery record.                                                                                  |
| Command scheduling fails                                 | Restore or terminalize explicitly; leave no active record without a runner.                                                                                                         |
| Stop arrives during mutation                             | Persist Stop, finish and journal the mutation, then honor Stop at the next boundary.                                                                                                |
| Stop arrives with provider outcome unresolved            | Keep reconciliation non-terminal; do not cancel or replay until exact provider state is known or handed off.                                                                        |
| Stop arrives during cleanup                              | Return `409 operation-cleanup-not-stoppable`; record no Stop request.                                                                                                               |
| Input prompt receives no answer for 60 minutes           | Terminalize as `failed_partial` with `operation-input-expired`; release active admission and retain cleanup admission when required.                                                |
| Input answer is stale                                    | Reject it; do not revive or change the operation.                                                                                                                                   |
| Setup ownership is ambiguous                             | Refuse setup retry or automatic deletion.                                                                                                                                           |
| Verification pull request has not merged                 | Keep `action_required`; retry only after merge.                                                                                                                                     |
| Selected GitHub account cannot be acquired               | Fail closed with account-specific guidance; a rate-limited acquisition retries within its persisted 45-minute deadline.                                                             |
| Azure access may not be effective                        | Offer classified verification retry with accurate guidance.                                                                                                                         |
| OIDC, syntax, or runner verification failure             | Keep the actual failure classification and exact run URL.                                                                                                                           |
| Workflow provenance is incomplete                        | Refuse post-commit rollback.                                                                                                                                                        |
| Workflow file changed                                    | Block the whole workflow pass and dependent deletion.                                                                                                                               |
| Saved repository is renamed, deleted, or inaccessible    | Continue addressing the saved repository slug; do not adopt another repository identity. Treat unreadable results and access-hidden 404s as unresolved and provide manual guidance. |
| Setup branch head moved                                  | Refuse branch deletion.                                                                                                                                                             |
| GitHub environment ownership is unproven                 | Leave it and report manual action.                                                                                                                                                  |
| Provider proves the exact deletion target is absent      | Record convergence as `not_found`.                                                                                                                                                  |
| GitHub returns a bare 404 without readable absence proof | Treat it as unreadable or unresolved because 404 can also mean missing permission.                                                                                                  |
| Cleanup journal persistence fails                        | Abort the cleanup pass before another deletion; record a warning if that result itself can be saved.                                                                                |
| Independent provider deletion is conclusively rejected   | Record warning and continue only deletions that are independent and still safe.                                                                                                     |
| Cleanup is interrupted by restart                        | Reopen journal reconciliation, preserve proven results, and recompute survivors before any further delete.                                                                          |
| Browser poll fails                                       | Keep the current panel and retry polling.                                                                                                                                           |
| Verification tracking expires                            | Stop local tracking, preserve truthful expiry evidence and exact run identity when known, and release or retain admission according to cleanup state.                               |

## Test plan

Every external system sits behind a controlled port or fake. Pull-request tests use no personal credential, live cloud resource, mutable repository, or public network dependency.

### Unit tests

- Operation state transitions, terminal latching, session-scoped admission, retained-cleanup blocking, command identity, 20-command retention, migration, restart, stale input expiry, and action projection.
- Provider-mutation journal transitions, provider-specific idempotency keys, strict failure classification, bounded reconciliation, immutable provider-ID matching, legacy quarantine, and fail-closed persistence.
- Artifact provenance for Azure identity, Service Principals, GitHub environments, workflows, cleanup journals, and cleanup results.
- Workflow commit chains, intervening customer edits, legacy unknown previous state, branch identity, atomic fallback writes, file digest verification, and restore versus delete.
- Pinned GitHub credential selection, duplicate login entries, injected-token precedence, keyring lookup, scope reporting, bounded selected-executor acquisition, exact verification-run identity, timeout handling, restart recovery, and error redaction.
- Browser parsing, command submission, focus preservation, live-region stability, terminal reset, confirmation, preview rendering, and environment-list refresh.
- Route template matching and shadow rejection in either declaration order.

### HTTP integration

- Start, every Stop response class, Continue, input resume, setup retry, selected-account verification retry, Rollback, rollback retry, and Exit through a real loopback server.
- Mutation nonce enforcement, malformed input, duplicate commands, store and journal persistence failure, scheduling failure, active-operation conflict, and retained-cleanup conflict.
- GitHub environment creation inference, provider-ID checks, proved absence, access-hidden 404 handling, and cache invalidation.
- Provider response loss, restart reconciliation, reconciliation exhaustion, cleanup replay refusal, and post-commit rollback acceptance or refusal.

### Runtime and artifact integration

- Real Canvas runtime composition with a fake SDK session.
- Production bundle load, registration, startup, and shutdown.

### Browser tests

- Importable browser modules retain full statement, function, and line coverage.
- Browser component tests run the extracted browser behavior in Chromium.
- Canvas Chromium tests cover server-owned setup across navigation, GitHub identity selection, keyboard focus, destructive confirmation, branch selection, and heartbeat recovery.

### Validation gates

The implementation stack runs frozen install, typecheck, lint, formatting, Markdown lint, full Vitest coverage, build, runtime integration, HTTP integration, artifact integration, browser component tests, and Canvas Chromium. Merged PR #516 reported 7,225 Vitest tests passed with 19 skipped, 129 runtime integration tests, 248 HTTP integration tests, 6 artifact integration tests, 9 browser component tests, and 25 Canvas Chromium tests with no retries.

## Security

### Destructive cleanup

**Threat:** Radius deletes a customer-owned or shared resource.

**Mitigation:** Cleanup selects only artifacts marked `created`, then verifies the current immutable provider identity and journals one deletion before sending it. Reused and candidate resources remain. Missing identity, changed identity, unresolved provider outcome, or incomplete provenance blocks deletion. The browser cannot add targets because the server rebuilds the selection when the command arrives.

### Workflow and credential dependency

**Threat:** Radius leaves a workflow installed but deletes the environment or identity it needs.

**Mitigation:** Workflow proof and reversion gate all dependent deletion. One changed or unreadable workflow blocks the pass. Radius rechecks repository access after each 404.

### Wrong GitHub account

**Threat:** Ambient GitHub CLI state causes setup or rollback to act as another user.

**Mitigation:** The operation saves the selected login. A pinned executor obtains an account-qualified credential, verifies the acting login, and remains in use through setup, verification retry, monitoring, workflow rollback, and GitHub environment deletion. Exact source parsing keeps stored `oauth_token` entries distinct from injected tokens.

### Duplicate mutation

**Threat:** Double click, lost response, timeout, or restart repeats a cloud or repository mutation.

**Mitigation:** Commands use deterministic identities, while external mutations use a separate durable journal keyed by operation, kind, and target. The journal persists before the request. A lost or uncertain response triggers exact reconciliation, and destructive cleanup never replays an uncertain delete. A timeout with unknown GitHub outcome does not authorize credential fallback.

### Cross-site local mutation

**Threat:** Another page posts a destructive command to the loopback server.

**Mitigation:** Every control route requires the Canvas mutation nonce and validates its operation and path parameters.

### Secret exposure

**Threat:** The Canvas displays or persists credentials, workflow logs, or raw CLI errors.

**Mitigation:** The browser receives a narrow projection. The ledger stores identifiers and safe outcomes, not tokens or secret values. GitHub command errors redact injected and credential-shaped tokens.

### Repository races

**Threat:** Another actor changes a workflow or setup branch between Radius writes and rollback.

**Mitigation:** Radius saves commit, blob, content, and previous-state provenance. A recommit preserves the original customer blob only when the blob chain proves uninterrupted Radius ownership. Otherwise it restores the intervening customer edit or refuses if prior state is unknown.

### Cross-session concurrency

**Threat:** Two Copilot App sessions create or clean the same repository at the same time.

**Mitigation:** Each hydrated session prevents conflicts within its own registry and retains cleanup admission until removable targets are resolved. There is no distributed repository lock across independent sessions. Exact provider identities and workflow provenance reduce destructive risk, but they do not prevent concurrent setup. This remains a documented residual risk.

## Compatibility

- Operation schema version 5 reads versions 1 through 4 and fills missing fields with safe defaults.
- Older records without workflow or previous-state proof remain visible but refuse unsafe post-commit rollback.
- A pre-version-5 record interrupted without provider journal evidence is quarantined as `unrecoverable_legacy`; Radius does not infer the missing mutation outcome.
- The control routes add loopback API paths without changing public Canvas actions, tools, or plugin metadata.
- The browser accepts missing optional projection fields and falls back to safe empty values.
- GitHub CLI 2.40 or later is required for account-qualified multi-account token lookup. The version check happens when selected-account token resolution is first needed, not at extension startup. Older clients receive a specific error rather than falling through to the active account.
- Existing final states and stage names remain available to the progress design.
- The extension still builds as one `plugins/radius/dist/extension.mjs`.

## Known limitations and residual risks

- **Disabled operation store:** `disabledOperationStore().save()` is a successful no-op. A mutation can therefore proceed without restart-safe state when the verified session directory is unavailable. Issue #506 must make mutating routes fail closed; documentation cannot make this fallback safe.
- **Concurrent GitHub environment creator:** the GET-absent, idempotent PUT, creation-time tolerance, and returned provider ID cannot distinguish another actor who creates the same name in the narrow interval before Radius's PUT. This race is accepted as low likelihood. Cleanup still requires the current provider ID to match.
- **Session-scoped admission:** one-active-operation and retained-cleanup admission apply within one hydrated Copilot App session and process. Independent sessions do not coordinate.
- **Repository rename or deletion:** the operation persists the repository slug it started with and does not adopt a renamed repository automatically. Reads and mutations continue against the saved slug. If GitHub does not resolve it under the selected account, Radius treats the resource as unreadable or unresolved and provides manual guidance rather than interpreting a bare 404 as absence.
- **Bounded command history:** the operation keeps the latest 20 command records. Attempt outcomes and artifact or provider journals retain the safety facts needed for recovery, but the operation is not an unbounded audit log.
- **Delayed GitHub CLI prerequisite:** the 2.40 version check occurs during account-specific token resolution. A user can begin setup on an older client and encounter the prerequisite after earlier durable work has completed.

## Monitoring and logging

The operation record is the primary diagnostic. It carries timestamps, stage and step history, attempts, the latest 20 commands, input prompt identity, verification acquisition and tracking deadlines, safe resource identifiers, provider journals, cleanup results, terminal outcome, and recovery state.

The server reports operation-store diagnostics and best-effort announcement or recovery-snapshot failures through the existing diagnostic reporter. Provider and cleanup journal writes are required safety gates: failure before a request prevents the mutation, and failure after a request stops further mutations while preserving an unresolved recovery state when possible. Cleanup persists each meaningful result before the next deletion. The browser shows safe summaries and links to exact GitHub runs but never raw logs or private evidence.

The shared session timeline may announce operation completion. It does not drive state or repair. Troubleshooting starts with the operation ID, command ID, failure code, current stage, and artifact ledger.

No new telemetry service, metric backend, or trace exporter is part of this design.

## Delivery status

The work was split into native stack 517 so each safety layer could be reviewed and merged independently:

1. **[PR #508](https://github.com/radius-project/ai-extensions/pull/508), merged.** Durable commands, action projection, artifact provenance, workflow-first rollback, selected credential fixes, cleanup Stop rejection, retained-cleanup admission, and browser recovery UX.
2. **[PR #511](https://github.com/radius-project/ai-extensions/pull/511), merged.** Schema version 5, provider and cleanup journals, exact immutable identity and absence proof, bounded reconciliation, fail-closed journal persistence, and restart recovery.
3. **[PR #515](https://github.com/radius-project/ai-extensions/pull/515), merged.** Selected-account verification recovery, persisted acquisition and tracking deadlines, exact run identity, and restart-safe monitoring.
4. **[PR #516](https://github.com/radius-project/ai-extensions/pull/516), merged.** Cooperative per-mutation Stop boundaries, direct recovery routing, `provider-reconciliation-pending`, bounded prerequisite failures, and atomic workflow fallback behavior.

The original [PR #358](https://github.com/radius-project/ai-extensions/pull/358) is closed and superseded. Issue #306 is closed. Issue #506 is a separate required follow-up for unavailable durable storage.

## Open questions

### Should other long-running Radius operations reuse this command model?

The command history, action projection, cleanup result vocabulary, and focus conventions fit Delete Environment and deployment repair. Reuse should preserve each operation's own completion and ownership rules rather than turn `operations.ts` into an untyped general workflow engine.

### How much operation history should the store retain?

The current store retains the latest 20 commands per operation and a bounded set of ordinary terminal operations. Admission-blocking cleanup records bypass terminal age and count pruning until their executable cleanup authority is resolved. Support and audit needs may justify longer retention or an export, but that choice changes privacy, storage, and lifecycle policy.

### Should the Canvas add a dedicated critical journey for Stop, Continue, Rollback, and Exit?

Unit and HTTP tests cover the state machine and destructive boundaries, and the current Chromium gate covers related environment behavior. A dedicated browser-and-server journey would test the full visible recovery sequence and focus movement in one scenario.

### Should created candidates support later ownership proof?

The current design leaves an ambiguous Service Principal or GitHub environment in place. A later proof protocol could adopt a candidate, but it must rely on authoritative immutable evidence rather than timing or naming.

### Should verification retry expose more failure classes?

The design recognizes the production cases required by issue #306. Issue #307 may add a wider fault vocabulary. New classes should remain closed and evidence-based.

## Alternatives considered

### Kill the active process

Rejected because a terminated CLI or HTTP request has unknown external outcome. Radius could retry a mutation that already succeeded or lose the provenance needed to clean it up.

### Roll back automatically after every failure

Rejected because users may want to fix a permission or merge a setup pull request, and because automatic deletion is unsafe for reused or ambiguous resources.

### Treat workflow commit as successful environment creation

Rejected because committed workflows can still fail credential verification. Successful verification marks the environment ready.

### Delete resources by expected name

Rejected because names are not ownership proof. Shared and pre-existing resources may match Radius naming conventions.

### Let the browser decide which actions are valid

Rejected because browser state can be stale and cannot see the private ledger. The server must re-evaluate every command.

### Use the ambient GitHub CLI account for rollback

Rejected because setup may have used another selected account. GitHub also returns 404 when a credential cannot see a private repository, which can look like absence.

### Rely on stale timeout to release the repository

Rejected because a quiet record can retain created resources and block the user with no visible recovery. Every non-terminal state needs an action or automatic transition.

### Restore the first pre-setup workflow blob after every recommit

Rejected when the blob chain breaks. Another actor may have edited the file between Radius writes. Rollback restores the immediately overwritten customer edit in that case.

## Design review notes

Draft for review. Native stack 517 supersedes the closed PR #358, and PRs #508, #511, #515, and #516 are merged. The design accepts the narrow concurrent GitHub environment creator race and records the session-scoped admission limit. Issue #506 remains a difficult unresolved safety gap because the disabled operation store can acknowledge writes that will not survive restart.
