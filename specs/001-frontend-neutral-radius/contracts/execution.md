# Execution Contract and Migration

This contract extends the existing GitHub Actions execution binding. It does not replace `rad`, move extension workflows to the Radius repository, or promise durable operation recovery. New field and artifact names below are proposed implementation contracts, not currently deployed inputs.

## Current Boundary to Preserve

- Dispatcher: `.github/extension/run-rad-commands.yml`; provider implementations: `run-rad-commands-azure.yml` and `run-rad-commands-aws.yml`.
- Existing dispatch inputs: `environment`, optional `image`, and optional `rad_commands`.
- Existing command-result artifact: `rad-commands-result`, containing a result with `schemaVersion: "1.0"`, command outcomes, exit codes, and environment.
- Existing progress: `deploy-progress.json` with `schemaVersion: 1`, application, environment, run ID, sequence, time, state, and resources; graph evidence is separate.
- Provider workflows currently serialize through a repository-wide concurrency group with `cancel-in-progress: false`. Do not narrow this while introducing the new contract.
- Restore-success gating protects state save. Radius state archives and cached graph artifacts have different purposes.

The shared service uses reviewed typed command builders. An internal compatibility adapter may produce the existing `rad_commands` string, but arbitrary caller shell text is not a lifecycle request. Preserve the existing command allowlist and pinned composite actions.

## Dispatch Extension

Add optional legacy-compatible workflow inputs for `lifecycle_version`, `lifecycle_operation`, `operation_id`, `attempt_id`, and `expected_commit`; forward them explicitly to provider workflows and actions. The new binding requires all five and validates their combination. Their absence selects the legacy contract; partial presence is invalid rather than silently treated as legacy.

The operation and attempt IDs are generated before dispatch. Include them in the dispatcher run name and all new execution evidence. Match candidate runs on exact identity and source; use the correlated run's jobs to obtain phase outcomes. A user-readable run title alone cannot authorize an operation or prove completion.

The typed operation determines whether the workflow may verify, configure, deploy, or delete. A new environment configuration path must not inherit a legacy verify-to-deploy continuation. Retain a legacy composite sequence only when the caller explicitly authorizes its complete scope, including deployment.

Before dispatch, verify repository access, environment approval requirements, supported execution contract, selected workflow availability, published source, and intended target. The workflow must verify its checked-out commit against `expected_commit` before application execution or state mutation. Pass untrusted values as data to validation/builders, never interpolate them into executable shell. Preserve pinned actions and least-privilege permissions; fork graph reads cannot dispatch privileged execution.

If dispatch is rejected, return its explicit error. If dispatch times out, mark dispatch `unconfirmed`, retain the operation ID, and reconcile exact matching evidence. A uniquely correlated run can establish progress later. Zero or multiple matches remain uncertain and must not cause another dispatch. This is bounded reconciliation, not an exactly-once service.

## New Execution Evidence

Keep old command/progress formats readable and add a separately versioned `lifecycle-result.json` final evidence document. Extend live progress with identity only under an explicitly supported schema; do not treat the old progress schema as proof that new identity fields exist.

The final document includes:

- `executionSchemaVersion`, `operationId`, `attemptId`, lifecycle operation.
- Repository, environment, application where applicable, expected commit, and actual checked-out commit.
- Workflow run ID and run-attempt number; these are not the lifecycle repair attempt ID.
- Sequence and observation time, scoped to that exact run and attempt.
- Restore, command, state-save, and cleanup outcomes with exit codes and skipped/unknown reasons.
- Primary failure, additional phase failures, and bounded redacted diagnostics.

Illustrative successful deployment evidence:

```json
{
  "executionSchemaVersion": 1,
  "operationId": "op-example",
  "attemptId": "attempt-example",
  "operation": "deployment.start",
  "repo": "example/shop",
  "environment": "dev",
  "application": "shop",
  "expectedCommit": "1111111111111111111111111111111111111111",
  "actualCommit": "1111111111111111111111111111111111111111",
  "runId": 123,
  "runAttempt": 1,
  "sequence": 12,
  "observedAt": "2026-09-15T20:00:00Z",
  "phases": {
    "restore": { "outcome": "succeeded", "exitCode": 0 },
    "commands": { "outcome": "succeeded", "exitCode": 0 },
    "stateSave": { "outcome": "succeeded", "exitCode": 0 },
    "cleanup": { "outcome": "succeeded", "exitCode": 0 }
  }
}
```

This payload is a fixture example, not evidence of an actual deployment. The observer still obtains the authoritative workflow conclusion from GitHub and checks it against the artifact. Never let an artifact claim to override access checks or its owning run.

## Restore, Save, and Finalization

Attempt restore before commands. When restore failed or never ran, do not execute deployment commands or save uninitialized state. When restore succeeded, attempt state save even if the deployment command failed, preserving the primary failure.

Capture the `rad shutdown` exit outcome independently from control-plane cleanup. The inspected Radius implementation reports backup/archive-commit failures through its command error and does not delete the cluster. Do not use a later cleanup command's exit status as a replacement for the save outcome.

Final lifecycle evidence must be published after required save/cleanup phases when the runner remains able to execute. Preserve command failures even if diagnostic collection or artifact upload fails. Cancellation or runner loss may prevent the final document; no document is preferable to a false success document. Existing earlier progress must not be mistaken for final completion.

Graph-only operations execute through the isolated local graph binding and never write deployment-state or graph archives. A graph artifact cannot substitute for a state archive during restore or recovery.

## Outcome Interpretation

| Evidence                                                           | Shared result                                                                                          |
|--------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| Dispatch explicitly rejected                                       | Start failed; explain rejection and do not claim a run exists                                          |
| Dispatch unconfirmed                                               | Accepted operation with unknown execution observation and `DISPATCH_UNCONFIRMED`; no automatic repeat  |
| Exact run queued or awaiting GitHub approval                       | Nonterminal observation; preserve the actual waiting reason                                            |
| Restore failed                                                     | Failed restore; commands/save skipped to protect existing state; cleanup reported separately           |
| Commands failed, save/cleanup succeeded                            | Failed operation with command failure primary; saved partial state disclosed                           |
| Commands succeeded, save failed                                    | Failed operation; resources may have changed without safely saved Radius state                         |
| Commands/save succeeded, cleanup or workflow failed                | Workflow/cleanup failure with successful deployment phases stated separately; no overall success claim |
| All required phases and workflow succeeded                         | Succeeded with current corroborated evidence                                                           |
| Workflow conclusively failed/cancelled but phase artifacts missing | Preserve workflow conclusion; phase/resource outcomes explicitly unavailable                           |
| Status retrieval failed and execution outcome is unknown           | Stale/unknown observation, not a new execution failure                                                 |
| Identity or version mismatched                                     | Reject artifact as evidence and report mismatch/unsupported version                                    |
| Correlated evidence conflicts                                      | Preserve the conflict and mark observation uncertain; never choose the successful-looking result       |

Operation-specific completion policies declare which phases are required before execution. A non-deployment configuration workflow must not fabricate deployment/save phases; it reports them as not applicable where appropriate. The shared result must distinguish not-applicable from required-but-skipped.

Retry transient reads with existing bounded backoff and rate-limit handling. Do not automatically request broader permissions, repeat dispatch, or run repair from the observation path.

## Lifecycle and Agent Continuations

Polling may refresh observations and caches only. An explicit authorized operation or an explicitly configured bounded policy initiates agent work independently of a polling call. Pure failure notices may be presented by the App, but must not mutate source or start repair.

Repair creates a distinct linked attempt with a declared finite budget and approved source. Reuse existing authoring/deploy attempt fences while keeping their identities distinct. Agent completion references staged outputs; publishing and redeploying require their own authorization and exact source validation.

Preserve the existing maximum of five repair cycles after the initial failure; an authoring run may compile initially and once per cycle, at most six times. A stricter caller policy is allowed. Starting a linked repair must not reset the original operation's consumed budget, and handoff delivery retries must not be counted as new repair cycles. The default new-contract policy is manual repair; automatic repair requires an explicit authorized policy.

Cancelling browser polling cancels the observation request, not the deployment. A cancellation control addresses the existing operation/run and reports requested versus confirmed cancellation. Preserve current setup stop/continue/rollback distinctions; do not map them all to cloud rollback or a terminal cancelled state.

## Cutover and Rollback

1. Inventory current declarations, exact handlers, schemas, setup controls, workflow inputs, and artifact formats. Preserve executable baseline fixtures rather than freezing the historical 40-route count.
2. Add shared services and explicit legacy translations. New service reads never bootstrap authoring; any existing automatic model handoff stays a separately declared, authorized App behavior, not a side effect of a graph read.
3. Introduce the execution version and evidence producer/reader together. Validate generated templates and committed uploader artifacts through existing workflow self-tests.
4. Switch one operation family at a time through composition-root routing. Use deterministic fixtures for before/after mutation comparison, not duplicate live execution.
5. Keep supported legacy readers and setup storage; report legacy evidence limitations rather than promising v1 completion guarantees. A requested v1 mutation with an incapable installed workflow returns a capability/precondition error and does not silently fall back.
6. Remove fallback code only after its explicit residual inventory is empty and the compatibility window has elapsed. Do not remove decoding needed by known in-flight operations.

Rollback changes routing only when the remaining binding can continue handling known operations. Otherwise hold the migration or keep the newer reader/control path until those operations finish. Never roll back by redispatching, discarding operation identity, or overwriting a user's workflow/source changes.
