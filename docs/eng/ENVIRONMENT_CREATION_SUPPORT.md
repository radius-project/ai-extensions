# Environment creation support

Use this guide when Azure environment creation stops, requires an external action, leaves resources behind, or resumes after the Radius extension restarts. It covers the supported Azure provider only.

## Start with the operation panel

Open **Environments** and read the inline operation panel before changing Azure or GitHub resources. The panel is the authoritative view of the operation's current state, allowed recovery actions, and resource ownership.

| State            | Meaning                                                                                          | Normal response                                                                                                      |
|------------------|--------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------|
| Running          | Radius still owns active work or reconciliation.                                                 | Wait for the next durable state. A Stop request takes effect only at a safe boundary.                                |
| Needs input      | Radius cannot continue without a customer choice.                                                | Answer the prompt or choose **Stop setup**.                                                                          |
| Action required  | Radius completed its part but an external action, usually merging a setup pull request, remains. | Complete the named action, return to Radius, and choose **Retry verification**.                                      |
| Failed           | Setup did not complete and Radius has no safe automatic continuation.                            | Follow the panel guidance and inspect **Show details**.                                                              |
| Failed partway   | Setup stopped after creating or reusing resources.                                               | Choose an offered Retry, Rollback, or Exit action based on the panel's ownership summary.                            |
| Restart decision | Radius restored an unfinished operation after the extension restarted.                           | Choose **Continue setup** or **Stop setup**. Radius does not resume cloud changes until you decide.                  |
| Stopped          | Radius stopped at a safe boundary.                                                               | Cancel or check the exact verification workflow when offered, then continue, roll back, exit, or abandon as allowed. |
| Ready            | Credential verification succeeded.                                                               | Acknowledge with **OK**. Future removal uses Delete Environment, not setup rollback.                                 |

**Action required** is a successful handoff, not a failed setup. Do not start a second setup while the existing operation is waiting for its pull request or verification retry.

## Recovery actions

Radius projects only actions that are valid for the saved operation.

| Action                      | Use it when                                                               | What it does                                                                                                   |
|-----------------------------|---------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| Continue setup              | A stopped operation can resume from its saved boundary.                   | Reopens the same operation and reuses its durable artifact ledger.                                             |
| Cancel workflow             | A stopped setup still has an active, exactly identified verification run. | Cancels only the saved GitHub Actions run through the GitHub account that started setup.                       |
| Check workflow status       | Workflow cancellation or status is uncertain.                             | Rechecks the exact saved run without submitting another cancellation.                                          |
| Retry setup                 | A retryable setup attempt failed.                                         | Repeats only the allowed setup work under the same operation identity.                                         |
| Retry verification          | The setup pull request was merged or verification failed transiently.     | Dispatches or resumes verification for the saved repository, branch, environment, and selected GitHub account. |
| Roll back environment setup | The unfinished operation created resources that Radius can prove it owns. | Removes only proven-owned resources in dependency order.                                                       |
| Retry rollback              | A previous rollback left retryable cleanup warnings.                      | Rechecks unresolved targets and retries only deletions that remain safe.                                       |
| Exit setup                  | The customer wants to leave an incomplete setup.                          | Closes the operation and removes proven-owned disposable resources when safe.                                  |
| Abandon setup               | External workflow or provider state cannot be proven safe for cleanup.    | Closes the operation without cleanup, retains the ledger for diagnosis, and releases the repository lock.      |

Radius never interrupts an in-flight provider mutation. If a response was lost, Radius reconciles provider state before continuing, stopping, or deleting.

After an extension restart, Radius pauses the restored operation instead of resuming cloud mutations automatically. **Continue setup** resumes the saved operation. **Stop setup** closes forward execution; if the exact saved verification workflow may still be active, cancel it or wait until **Check workflow status** reports it inactive before attempting destructive cleanup. **Abandon setup** is the non-destructive escape hatch when Radius cannot establish that cleanup is safe; retained resources remain the customer's responsibility.

## Download diagnostics

Expand **Show details**, then activate **Download diagnostics**. Radius creates a local JSON file named `radius-environment-operation-diagnostics.json`. The browser does not upload it, and Radius does not create a second retained diagnostic record.

The export contains the installed plugin version, generated operation ID, schema version, lifecycle and stage states, timestamps and duration, attempt and command counts, failure classification, cleanup outcome counts, provider-recovery status counts, whether verification was dispatched, and the allowlisted state of its saved verification workflow.

The export excludes repository and environment names, Azure tenant, subscription, application, principal, role-assignment, and resource identifiers, GitHub account, branch, workflow, run, package, and resource identifiers, persisted request and resume inputs, resource labels and targets, URLs, command lines, environment variables, idempotency keys, stdout, stderr, logs, evidence, free-form error messages, and step text. Unknown future states appear only as `unknown`, with `unrecognizedValueCount` showing how many values were omitted.

Treat the file as customer-controlled support data. Inspect it before sharing it and use the organization's approved support channel.

## Retained resources

Under **What exists right now**, Radius separates resources into created, available to roll back, reused, removed or absent, and requiring manual action.

- **Created by Radius and available to roll back** means the operation has enough provenance to offer a safe deletion.
- **Reused** means the resource existed before this operation. Radius will not delete it.
- **Needs an action from you** means identity, ownership, or current state could not be proven. Radius leaves the resource in place.
- A `created_candidate` is not proof of ownership. Never treat a likely Radius creation as safe to delete without an independent identity and ownership check.

Do not bypass a `previous-cleanup-required` conflict by starting setup from another session. Finish or reconcile the earlier operation first.

## Manual cleanup

Use manual cleanup only when the panel provides a specific manual action or an authorized operator has independently verified the exact resource identity and ownership. Save the diagnostic export and the panel's resource summary before changing anything.

Remove only resources confirmed to belong to the failed attempt, in this dependency order:

1. Setup workflow files or the setup branch.
2. GitHub environment variables written by the attempt.
3. The GitHub environment.
4. Azure role assignments.
5. Federated credentials.
6. The Service Principal.
7. The App Registration.

Do not remove reused resources, ambiguous candidates, a resource identified only by display name, or workflow files that changed after Radius wrote them. After authorized manual cleanup, choose **Retry rollback** when available so Radius can verify absence and release the repository cleanup block.

Record every retained and removed resource, the evidence used to identify it, the operator, date, result, and final cleanup disposition. A failed or incomplete cleanup remains a support incident; it is not a successful rollback.

## Escalation

Escalate when diagnostics report unknown values, reconciliation becomes manual-required, the panel offers no transition for a non-terminal operation, a cleanup target cannot be identified precisely, Retry rollback cannot verify absence, an operation remains stuck beyond its documented tracking window, or the installed host cannot download diagnostics.

Include the diagnostic export, installed release-candidate identifier, operation state, expected and observed result, actions already attempted, and retained-resource disposition. Do not include raw command output, tokens, secrets, or copied environment variables.

Release qualification and evidence requirements are tracked in [Environment creation readiness](./ENVIRONMENT_CREATION_READINESS.md).
