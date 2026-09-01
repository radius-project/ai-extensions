# Environment creation readiness

This record tracks issue [#308](https://github.com/radius-project/ai-extensions/issues/308). It is both the opt-in live-validation runbook and the durable evidence index. It does not declare production readiness.

## Candidate identity

| Field                               | Value                                                   |
|-------------------------------------|---------------------------------------------------------|
| Diagnostic and recovery baseline    | `7d1c6a69c6c6fddec819d6ad8d8b75e6b001f2c6` (#617 merge) |
| #308 implementation commit          | `a1751ab9e5dbbba4c21066125b1c79bec84336b4`              |
| Release-candidate version           | `NOT RUN` - no immutable candidate is designated        |
| Installation source and attestation | `NOT RUN`                                               |
| Record last refreshed               | 2026-08-30                                              |

Before final qualification, record the final #308 commit and identify one immutable plugin version, ref, artifact digest, and attestation. `main`, `edge`, or an arbitrary commit is not implicitly the release candidate.

## Status rules

Every gate uses exactly one status:

- `PASS`: required evidence exists and is tied to the candidate.
- `FAIL`: the observed result did not meet the expected result or cleanup is incomplete.
- `BLOCKED`: a named prerequisite, authority, environment, or decision is missing.
- `NOT RUN`: the approved procedure has not been executed.

Mocks, an empty checklist, inferred approval, prior prototype work, and work performed for another version cannot produce `PASS`.

## Scope and unresolved decisions

| Decision                | Current state                                                                                                                                                                                                                                                                                                                                                           |
|-------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Implemented provider    | Azure only. AWS remains unsupported and does not gate Azure validation.                                                                                                                                                                                                                                                                                                 |
| Diagnostic collection   | Approved: explicit customer-initiated local JSON download from a closed schema. The default profile excludes identifiers; an optional profile requires preview and confirmation before adding bounded repository, branch, environment, and GitHub login values. A fingerprint binds download to the reviewed values. No automatic upload or additional retained record. |
| Remote telemetry        | `BLOCKED`: no destination, consent, opt-out, retention, privacy owner, operating owner, or incident path is approved. No telemetry sink or speculative framework is implemented.                                                                                                                                                                                        |
| Live environment        | `BLOCKED`: approved tenant, subscription, disposable repository, Entra and GitHub identities, package scope, and credential-handling method are not recorded.                                                                                                                                                                                                           |
| Cost and cleanup limits | `BLOCKED`: budget, maximum resources and runs, timeout, cleanup deadline, retained-resource escalation, and manual-cleanup owner are not recorded.                                                                                                                                                                                                                      |
| Signoff authorities     | `BLOCKED`: accessibility, usability, support, privacy, destructive-drill, and release authorities are not recorded.                                                                                                                                                                                                                                                     |
| Evidence location       | This file is proposed as the index. Redacted run artifacts may be linked but must follow the retention and access policy chosen by the release authority.                                                                                                                                                                                                               |
| Restart interpretation  | Proposed: deterministic evidence for every meaningful mutation boundary plus selected live Azure, GitHub, verification, and cleanup restart drills, not a Cartesian product of every live scenario and boundary. Approval remains `BLOCKED`.                                                                                                                            |

## Existing automated evidence

The following is supporting evidence for the merged #544 baseline, not a #308 release-candidate `PASS`:

| Check                                | Status                             | Evidence                                                                                                                                                           |
|--------------------------------------|------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| PR #544 Publish/Build                | `NOT RUN` for the future candidate | [Run 33215077408](https://github.com/radius-project/ai-extensions/actions/runs/33215077408) passed for merge commit `ebe35941589a30cce99e4be919f1a95f2d4864d8`.    |
| PR #544 live upstream templates      | `NOT RUN` for the future candidate | [Run 33215077239](https://github.com/radius-project/ai-extensions/actions/runs/33215077239) passed for the merge commit without cloud mutation.                    |
| PR #599 Publish/Build                | `NOT RUN` for the future candidate | [Run 33217025737](https://github.com/radius-project/ai-extensions/actions/runs/33217025737) passed for baseline commit `fd7ce62fc95877d57bfea256eed516be65465bd3`. |
| PR #599 live upstream templates      | `NOT RUN` for the future candidate | [Run 33217025617](https://github.com/radius-project/ai-extensions/actions/runs/33217025617) passed for the baseline without cloud mutation.                        |
| PR #617 Publish/Build                | `NOT RUN` for the future candidate | [Run 33219627587](https://github.com/radius-project/ai-extensions/actions/runs/33219627587) passed for baseline commit `7d1c6a69c6c6fddec819d6ad8d8b75e6b001f2c6`. |
| PR #617 live upstream templates      | `NOT RUN` for the future candidate | [Run 33219627363](https://github.com/radius-project/ai-extensions/actions/runs/33219627363) passed for the baseline without cloud mutation.                        |
| #308 diagnostics and support changes | `NOT RUN`                          | Record the final CI run URL and exact test identifiers after this change is committed.                                                                             |

## Mutation-boundary traceability

This section maps deterministic coverage to the merged #544 implementation, the restart controls added by #599, and #617's identifier-rich verification-dispatch steps. The map was refreshed against merge commit `7d1c6a69c6c6fddec819d6ad8d8b75e6b001f2c6`. The safe diagnostic profile continues to exclude free-form step labels; contextual identifiers come only from four structured operation fields after explicit review. Add a new test only if a production mutation owner lacks evidence for prepared intent, conclusive rejection or unknown outcome, reconciliation, duplicate prevention, and safe cleanup disposition. Generic recovery behavior is proven once in `provider-mutation-recovery.test.ts`; call-site tests prove each owner uses that contract.

| Boundary                                        | Production owner                                                                                                    | Existing deterministic evidence                                                                                                                                                                                                                                                                                                                                 |
|-------------------------------------------------|---------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Azure App Registration and Service Principal    | `server/routes/azure-auto-setup-application.ts`                                                                     | `azure-auto-setup-application.test.ts`: "reconciles a restarted application before reuse and transfers directly to rollback", "adopts a restarted application by the provider id settled with the acknowledgement", "reconciles timed-out owner and provenance mutations before continuing", and "creates, owns, tags, and verifies a new application in order" |
| Azure federated credential                      | `server/routes/azure-auto-setup-credentials.ts`                                                                     | `azure-auto-setup-credentials.test.ts`: "adopts a timed-out federated credential only when operation provenance matches", "reconciles a pending credential before the existing-subject skip on restart", malformed-list, Retry-After, authorization-failure, Stop, and cleanup cases                                                                            |
| Azure role assignment                           | `server/routes/azure-auto-setup-credentials.ts`                                                                     | `azure-auto-setup-credentials.test.ts`: "adopts a timed-out deterministic role assignment after exact reconciliation", "lets the role stage reconcile its own unresolved mutation after restart", replication-lag retry, AKS warning, and Stop-during-backoff cases                                                                                             |
| GitHub environment create                       | `server/services/github-environment.ts` and `server/services/environment-operation.ts`                              | `github-environment.test.ts`: existing reuse, missing create, pre-create Stop, and journal reconciliation; `environment-operation.test.ts`: orchestration, failure, and recovery ownership                                                                                                                                                                      |
| GitHub environment variables                    | `server/routes/create-environment-gh-runner.ts`                                                                     | `create-environment-gh-runner.test.ts`: exact target identity, replacement refusal, immediate identity recheck, conclusive rejection, timed-out write reconciliation, malformed reads, Retry-After, and authorization failure                                                                                                                                   |
| GitHub environment-variable cleanup             | `server/services/github-environment-variable-rollback.ts`                                                           | `github-environment-variable-rollback.test.ts`: delete, restore, customer-change refusal, lost-response adoption, failed-restore retry refusal, and cleanup journal behavior                                                                                                                                                                                    |
| Workflow files and setup branch                 | `server/routes/create-environment-workflow-committer.ts`                                                            | `create-environment-workflow-committer.test.ts`: timed-out write adoption, lost response and restart, fail-closed provenance, atomic pull-request branch fallback, recovered branch delete, refused delete, and unresolved delete                                                                                                                               |
| Setup pull request                              | `server/routes/create-environment.ts`                                                                               | `create-environment.test.ts`: protected-branch success, unresolved create reconciliation before Stop, multiple-match manual handoff, conclusive API refusal, and pre-create Stop; generic process-restart semantics are supplied by `provider-mutation-recovery.test.ts` for the same journal contract                                                          |
| Verification dispatch and retry                 | `server/routes/create-environment.ts` and `server/services/verification-retry-runner.ts`                            | `provider-mutation-recovery.test.ts`, `recovered-verification-run.test.ts`, and `verification-retry-runner.test.ts`: operation-marked identity, selected-account acquisition, exact run adoption, duplicate prevention, timeout, authorization, rate limit, and restart recovery                                                                                |
| Restart decision and verification cancellation  | `operations.ts`, `server/routes/operations-control.ts`, and `server/services/verification-workflow-cancellation.ts` | #599 unit, HTTP integration, and Chromium tests: restored operations pause for Continue or Stop; the exact saved run is monitored or cancelled once through the saved account; uncertain state blocks destructive cleanup; Abandon closes without cleanup and releases the repository lock                                                                      |
| GitHub environment and generic cleanup deletion | `server/services/cleanup-deletion-journal.ts`                                                                       | `cleanup-deletion-journal.test.ts` and `server.test.ts`: journal persistence before delete, exact identity, reused-resource refusal, created-candidate retention, lost response, unknown outcome, and cleanup disposition                                                                                                                                       |
| GHCR bootstrap                                  | `ghcr.ts` and `server/routes/create-environment.ts`                                                                 | `ghcr.test.ts`: bounded timeout, authentication, 429 and Retry-After, 5xx, malformed responses, concurrent publication, repository linkage, visibility, and exact package identity. GHCR bootstrap is bounded and reconciled by package state rather than the operation mutation journal.                                                                       |

The #544 fault matrix is concentrated in `provider-mutation-recovery.test.ts` for timeout, signal, 5xx, malformed response, transport failure, conflict, and authentication classification; `ghcr.test.ts` for timeout budget, authentication, 429, 5xx, malformed and concurrent mutation; `azure-auto-setup-credentials.test.ts` for malformed inventory, Retry-After, authorization and replication lag; `github-environment.test.ts` for Retry-After and authorization; and `github-environment-variable-rollback.test.ts` for stale reads, lost responses and retry-stop cleanup behavior.

No additional restart suite is required by this review. The setup pull-request boundary uses layered evidence: its call-site tests prove reconciliation and safe outcomes, while the shared journal suite proves process restoration for arbitrary mutation kinds. The approved live protocol still requires a representative protected-branch restart drill.

## Live Azure and GitHub matrix

All cases require the approved candidate, environment, operator, limits, and cleanup owner.

| Case                                              | Status    | Required observation                                                                                                                                                      | Evidence          |
|---------------------------------------------------|-----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------|
| New Entra application                             | `BLOCKED` | New identity is created, verified, attributed to this operation, and cleaned or retained as planned.                                                                      | None              |
| Reused application owned by signed-in user        | `BLOCKED` | Existing owned identity is reused and never enters this operation's deletion authority.                                                                                   | None              |
| Matching application not owned by signed-in user  | `BLOCKED` | Radius refuses unauthorized adoption and deletes nothing.                                                                                                                 | None              |
| Radius-tagged orphan                              | `BLOCKED` | Radius does not reclaim or delete the orphan without current ownership proof.                                                                                             | None              |
| Protected default branch and pull-request handoff | `BLOCKED` | Setup reaches `action_required`; merge, return, and verification retry complete against the same operation.                                                               | None              |
| Verification workflow already present             | `BLOCKED` | Setup updates or reuses the workflow without duplication and preserves rollback provenance.                                                                               | None              |
| Missing GitHub Packages authorization             | `BLOCKED` | Preflight fails clearly, leaks no credential material, and succeeds only after authorized recovery.                                                                       | None              |
| Microsoft Graph propagation delay                 | `BLOCKED` | Bounded retry reaches the expected terminal or manual outcome.                                                                                                            | None              |
| Azure RBAC propagation delay                      | `BLOCKED` | Bounded retry and verification reach the expected terminal or manual outcome.                                                                                             | None              |
| Azure login failure                               | `BLOCKED` | Failure is actionable and no cloud mutation begins under an unverified identity.                                                                                          | None              |
| AKS warning                                       | `BLOCKED` | Environment reaches `succeeded_with_warnings`; warning is visible and semantically distinct from failure.                                                                 | None              |
| Cleanup success                                   | `BLOCKED` | Proven-owned resources are removed in dependency order and reused resources remain.                                                                                       | None              |
| Cleanup failure                                   | `BLOCKED` | Original setup failure remains visible; cleanup failure is separate; retained resources and manual actions are recorded.                                                  | None              |
| Representative Azure restart                      | `BLOCKED` | Restart pauses for an explicit decision; Continue creates no duplicate and Stop deletes no unowned resource.                                                              | None              |
| Representative GitHub restart                     | `BLOCKED` | Restart at an approved GitHub mutation boundary reconciles exact provider identity without blind replay.                                                                  | None              |
| Verification restart                              | `BLOCKED` | The exact operation-marked run is recovered without ambient-account fallback or duplicate dispatch; cancel/check never targets another run or submits cancellation twice. | None              |
| Cleanup restart                                   | `BLOCKED` | The saved cleanup command resumes or requires manual action without repeating a confirmed deletion.                                                                       | None              |
| AWS environment creation                          | `NOT RUN` | Unsupported by the product; no AWS validation or fixture is claimed.                                                                                                      | Scope record only |

## Live execution protocol

1. Obtain written authorization naming the candidate, Azure tenant and subscription, disposable GitHub repository, Entra and GitHub identities, allowed package scope, operator, budget, timeout, cleanup deadline, and manual-cleanup owner.
2. Confirm the repository and subscription contain no production resources and record the expected starting state.
3. Install the immutable candidate and verify its attestation.
4. Execute one matrix case at a time. Do not run cases concurrently against shared identity, workflow, environment, or package resources.
5. Capture only redacted evidence. Never attach tokens, secrets, environment variables, command lines, stdout, stderr, workflow logs, raw provider responses, or free-form attacker-influenced evidence.
6. Complete cleanup before starting the next destructive case. If cleanup is incomplete, mark the case `FAIL`, stop the run, and hand retained resources to the named cleanup owner.
7. Update the matrix only after the evidence record is complete.

Each live result must record date, operator, candidate version and digest, approved environment, case, expected result, observed result, cleanup disposition, retained resources, defects, and redacted evidence links.

## Restart and rollback drills

For each selected drill, record the mutation boundary, expected recovery, observed recovery, duplicate check, retained and removed resources, and cleanup disposition. Kill only the extension process at the approved injection point; do not kill an in-flight cloud command or mutate provider state from a second session.

A restart drill passes only when the same durable operation pauses for an explicit Continue or Stop decision, reconciles provider state, creates no duplicate resource, deletes no resource it did not create, and reaches a truthful terminal or input-required state. A verification restart must monitor or cancel only the exact saved run through the saved GitHub account, and status checks must never submit a second cancellation. A rollback drill passes only when workflow changes are handled before dependent credentials, reused and ambiguous resources remain, cleanup failures are separate from the original setup failure, and every retained resource has an owner and disposition. When external state cannot be established, Abandon may release the lock only while retaining resources and recording that no cleanup occurred.

## Accessibility and usability

Automated axe and keyboard evidence does not replace human signoff. Review the exact candidate with the approved browser, host, screen-reader, motion, and color protocol.

| Check                                 | Status    | Required evidence                                                                         |
|---------------------------------------|-----------|-------------------------------------------------------------------------------------------|
| Stage granularity with users          | `BLOCKED` | Reviewer, participants, protocol, candidate, findings, and disposition                    |
| `action_required` meaning             | `BLOCKED` | Users understand it as successful work requiring a next step, not failure                 |
| Setup versus cleanup failure          | `BLOCKED` | Visual and semantic findings for both material states                                     |
| Keyboard and focus                    | `BLOCKED` | Complete keyboard path, focus order, focus restoration, and disabled/loading states       |
| Screen reader and live regions        | `BLOCKED` | Reviewer, assistive technology and browser versions, announcements, findings, and signoff |
| Reduced motion and color independence | `BLOCKED` | Protocol, candidate, findings, and signoff                                                |

## Dogfood, support, and approval

| Gate                      | Status    | Required evidence                                                                                    |
|---------------------------|-----------|------------------------------------------------------------------------------------------------------|
| Release-candidate dogfood | `BLOCKED` | Candidate identifier, participants, scenarios, defects, and disposition                              |
| Support owner acceptance  | `BLOCKED` | Named owner, accepted responsibilities, escalation path, and durable acceptance record               |
| Support documentation     | `NOT RUN` | Review and acceptance of [Environment creation support](./ENVIRONMENT_CREATION_SUPPORT.md)           |
| Telemetry decision        | `BLOCKED` | Approved remote policy or explicit acceptance that local diagnostics satisfy the release requirement |
| Accessibility signoff     | `BLOCKED` | Named authority, protocol, candidate, findings, and approval                                         |
| Usability signoff         | `BLOCKED` | Named authority, protocol, candidate, findings, and approval                                         |
| Nicole's approval         | `BLOCKED` | Explicit approval tied to the completed candidate evidence set                                       |

## Production gate

**Status: `BLOCKED`.** No release candidate is designated, live scenarios and drills have not run, remote telemetry remains undecided, and the required human owners and approvals are not recorded. Do not close #308 or claim production readiness from this file in its current state.
