# Copilot re-review operations

This runbook implements the preparation for Stage 2 of the [AI-assisted review design](../design/2026-10-ai-assisted-review-plan.md#phase-2-copilot-code-review-on-every-push). It describes a separately authorized rollout, not settings that merging this document enables. Stage 1 hosted acceptance and live Stage 2 acceptance remain pending until an operator records the evidence below.

The [canonical review skill](../../.github/skills/radius-code-review/SKILL.md#review-convergence) owns review criteria and convergence rules. This runbook owns the human actions around those rules. It does not add a workflow, a hard review-round cap, an approval gate, or permission to spend on reviews.

## Roles and activation gates

The implementation lead is @nellshamrell. The primary repository admin is @nicolejms; the backup is @nellshamrell. Before activation, confirm their availability and record the acting operator, monitoring owner, authorized billing owner, and an approved location for the evidence ledger. A role assignment is not acknowledgment or spending authorization.

Keep activation blocked until the lead records all of the following:

- Stage 1 guidance is merged and present in the selected sample PR heads. GitHub [reads instructions and skills from the head branch](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#agent-skills), so inspect the actual sample revision.
- An authorized hosted sample has review URLs and reviewed SHAs demonstrating the relevant criteria. A local review or a claim that the skill loaded is not hosted evidence. The user must explicitly resolve the unsupported summary-format criterion with an observable alternative or leave activation blocked; see [hosted-review acceptance](../../.github/skills/radius-code-review/SKILL.md#hosted-review-acceptance).
- The runbook has been reviewed. The user has authorized the exact settings delta, controlled hosted-review experiment, pause/stop actions for all fix/push producers, and emergency rollback of this rollout's fields. Emergency rollback must be pre-authorized; re-enablement needs a fresh decision.
- The billing owner confirms the effective payer and access policy, a spending guardrail, who can observe it, and who can pause the experiment. Do not invent a budget or enable paid usage. Missing billing visibility or ownership blocks activation.
- Sample PRs and participants are explicitly authorized. Inventory their personal and organization review triggers and their automatic fix/push producers. Do not use the preparation PR or another contributor's PR as an experiment without consent.

An authorized isolated repository with representative rules and Stage 1 instructions can establish preliminary mechanics. Do not copy secrets or private integration configuration, and do not treat that result as acceptance for this repository. Real-repository acceptance still requires its own authorization and evidence.

Copilot approval submission and approval credit must remain effectively off. Preserve all human-review and check requirements. The agreed policy is one qualifying human approval from `radius-project/approvers-ai-extensions`, with a manually requested Max review for high-risk changes; Stage 2 does not implement team-membership enforcement. That remains later-stage work. A Copilot overview assessment is not a qualifying human approval.

## Requesting a review and choosing effort

Use the PR's **Reviewers** controls to choose Copilot's effort before requesting a review. For a high-risk change, the author or supervising human explicitly chooses **Max**. Confirm that the completed review's overview records Max and the intended commit. A request event alone does not establish that the review ran or used the requested effort.

GitHub's [effort precedence](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#review-effort-level) is: explicit request, prior effort on that PR, requester preference, repository setting, organization setting, then built-in default. A repository default of Balanced therefore does not force every review to use Balanced. Max can carry over to later automatic reviews. To request a lower effort, explicitly choose Balanced for a subsequent request and verify the observed result; do not assume changing the repository default resets an existing PR. Effective organization/enterprise limits still apply. Max is currently a preview feature; verify availability and terms before activation.

For an author who cannot request Copilot, an eligible maintainer opens the same PR, selects the intended effort, and requests the review. The maintainer verifies the resulting run, or records why the control is unavailable or the request failed. Maintainer status alone does not guarantee access. If no eligible requester is available, escalate to the lead and continue with human review; do not relax required checks or approval rules.

Access depends on the effective policies:

| Author or requester                         | What to verify                                                                                                                                                         |
|---------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Licensed person                             | Code-review access, applicable external-license restrictions, available credits, and effective billing source.                                                         |
| Organization member without a license       | Both paid usage and the organization's unlicensed-member review policy must already permit access; qualifying automatic reviews can run without an individual license. |
| Outside contributor without eligible access | Do not assume the organization-member exception applies. Use an authorized eligible maintainer request, or record the unavailable review.                              |
| Bot or Copilot cloud agent                  | Verify the documented actor-specific billing and eligibility; do not infer them from a human author's behavior.                                                        |

Do not alter licensing, external-license restrictions, or organization paid-usage policies to make a test pass.

## Billing and monitoring

[Current billing documentation](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#code-review-usage-and-billing) distinguishes AI credits from Actions usage for agentic capabilities. Automatic review normally attributes credits to the author; a manual request normally attributes them to the requester. Organization billing choices, unlicensed-member policies, and bot/cloud-agent attribution can change the payer. Check the effective source before requesting a review.

Link the [current consumption estimates](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#estimated-consumption) when discussing cost; they are neither fixed prices nor spending caps and exclude Actions usage. Do not extrapolate a guaranteed charge from the effort label. Exhausted budgets can prevent reviews; a missing review is not an approval.

The monitoring owner maintains a manual ledger in the approved location. A session artifact is sufficient for preparation; publishing a shared issue or comment needs separate authorization. Record one entry per review attempt:

| Field       | Evidence                                                                                                                         |
|-------------|----------------------------------------------------------------------------------------------------------------------------------|
| Target      | PR URL, pushed SHA, reviewed SHA, and whether Stage 1 guidance is present.                                                       |
| Trigger     | Personal, repository, organization, or manual source; mark unknown sources for investigation.                                    |
| Run         | Review ID/URL, requested effort, observed effort, trigger/completion timestamps, and completed/failed/pending outcome.           |
| Convergence | Completed round number including prior rounds, duplicate finding links and adjudication, unresolved work, and handoff owner.     |
| Consumption | Observed credits/Actions usage and payer category where available; explicitly mark delayed, aggregate-only, or unavailable data. |
| Decision    | Continue, pause, failed acceptance, or user-approved exception, with the supporting evidence and responsible operator.           |

Track latency, round count, repeated findings, failures, effort, and available usage. Do not infer per-PR spending from aggregate billing reports or count failed/incomplete attempts as completed review rounds. Those attempts still matter for reliability and spending. Agree an observation cutoff for an experiment before relying on the absence of a run.

Keep personal budgets, account details, tokens, and raw billing exports out of shared evidence. Redact settings screenshots and ledger entries before sharing; use payer categories rather than exposing private user spending. No monitoring service is required.

## Pausing the fix and push loop

Before the experiment, inventory every actor that can apply fixes, request reviews, or push to the PR. Include assigned cloud agents, local/app sessions, agent-merge check-ins, review-triggered fix automations, and any other configured source. For each, record its owner, supported pause/stop action, permission required, and how the operator will confirm it has stopped. Unknown or unpausable producers block the experiment. Pausing one chat does not stop other agents.

At the canonical skill's third-round handoff, the author or supervising human:

1. Pauses automatic fix applications, review requests, and agent pushes using that inventory, and confirms each producer stopped.
2. Records unresolved findings and duplicates, links the completed rounds, and identifies who will address the remaining work.
3. Decides the next action. Any later push or review needs a deliberate human decision rather than another unattended fix/review cycle.

This is an author-controlled pause, not a hard service cap. There is no documented per-PR switch that allows continued pushes while reliably suppressing ruleset reviews. GitHub evaluates [personal and ruleset triggers independently](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#automatic-pull-request-reviews); one source can still request reviews when another is off. A repository's non-draft policy does not stop a personal or organization draft-review trigger.

Do not claim that resolving a conversation, replying to Copilot, removing it as reviewer, turning off personal reviews, or converting to draft guarantees a stop. GitHub documents that [replies are not visible to Copilot and resolved findings can recur](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review#requesting-a-re-review-from-copilot). Drafting a PR is only a conditional aid after checking all applicable triggers.

Pause the rollout and notify the primary admin, or immediately the backup if unavailable, when findings repeat, the reviewed commit cannot be identified, spending exceeds authorization, monitoring ownership is lost, settings verification fails, or the fix/push loop cannot be controlled. Preserve human review and required checks while resolving the incident. A hard-stop automation proposal is separate work, not an implicit extension of this runbook.

## Applying the authorized settings delta

This section is an operator procedure, not authorization to execute it. Use [GitHub's supported settings controls](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review); do not introduce a settings-write script for this one-off operation.

1. Capture a fresh ruleset and settings snapshot. Include inherited rules, branch targeting, enforcement, bypass actors, required checks and their App IDs, all pull-request protections, approval controls, effective effort restrictions, and other automatic-review sources. Confirm Max's availability and current terms. Compare the snapshot with the authorized baseline and reconcile unexpected drift before editing.
2. In this repository's **Settings > Copilot > Code review**, select explicit **Balanced** review effort and **Max** maximum effort if supported and permitted by effective policy. If a stricter organization/enterprise limit prevents the intended result, stop for a decision rather than changing that policy.
3. In **Settings > Rules > Rulesets > main**, enable **Review new pushes** in the existing Copilot review rule. Keep **Review draft pull requests** off. Do not recreate the ruleset or replace it with a stale exported copy.
4. Leave Copilot approval submission and approval credit effectively off, including the organization restriction. Do not unlock approvals just to inspect hidden controls. Preserve required approving reviews, latest-push approval, stale dismissal, code-owner review, thread resolution, and every unrelated protection.
5. Re-read persisted settings and the complete ruleset. Confirm `review_on_push: true`, `review_draft_pull_requests: false`, explicit Balanced/Max, and no unrelated delta. Preserve the [required check contexts](../../CONTRIBUTING.md#required-merge-checks) and their source bindings. Save redacted before/after evidence and the operator identity.

If a save is partially applied or verification fails, stop the experiment and revert only the fields changed by this rollout using the procedure below. A stricter approval restriction is not a reason to enable approvals. Missing or inaccessible controls are a blocker, not evidence that the desired setting exists.

## Emergency rollback

Rollback concerns re-review and effort settings, not the later-stage suspension of Copilot approval credit. The separate rollout authorization must already cover the following emergency action by the primary or backup admin:

1. Stop the inventoried automatic fix/push producers. Capture the latest live ruleset/settings and compare each rollout-owned field with its recorded applied value.
2. Revert `review_on_push` and any effort fields this rollout changed to their recorded pre-rollout values. If an owned field changed concurrently, reconcile with its owner before overwriting it; do not restore an entire snapshot. Preserve unrelated concurrent changes and all human/check protections.
3. Re-read the result, record partial failures or unresolved drift, and confirm the repository-wide effect. Escalate immediately if the authorized rollback cannot be completed; do not label it successful.
4. Investigate continuing reviews against personal/organization triggers and in-flight work. Contact the relevant owner; additional changes need appropriate authorization. Repository rollback neither cancels queued/running reviews nor disables independent sources.

Never turn off merge protections to stop a review. Re-enablement requires a fresh approved delta, current evidence, and a resolved incident; it is not an automatic final step of rollback.

## Live acceptance record

Run these cases only after the activation gates and experiment authorization. Use safe controlled changes and sequential pushes; do not merge seeded defects. Record pass, fail, or blocked with review URLs, SHAs, settings evidence, and the operator's disposition. A local model review or a tabletop exercise does not satisfy live cases.

| Case                | Required evidence                                                                                                                                                                                                                                                                       |
|---------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| New push            | A ready eligible sample with Stage 1 guidance receives a completed review of the newly pushed SHA without a manual review request.                                                                                                                                                      |
| Non-draft scope     | Other draft-review sources are known to be off for the sample. A draft push has no triggered/pending/running review within the agreed observation cutoff; making it ready and pushing behaves as configured. This is bounded evidence, not a universal claim.                           |
| Resolved finding    | An actually fixed harmless finding remains resolved without an equivalent duplicate in the later review. Distinguish a newly introduced regression. A duplicate fails the case and needs remediation or explicit user acceptance of the platform limitation; never report it as a pass. |
| Effort              | An explicit Max request records Max, the following automatic run's effort is observed, and an authorized explicit Balanced request records its actual result. Unavailable or capped effort is blocked, not silently substituted.                                                        |
| Maintainer request  | An eligible maintainer successfully requests a review for an authorized sample author lacking access. Missing participants or permissions leave the case blocked; do not change access policies to manufacture it.                                                                      |
| Third-round handoff | Link completed rounds and demonstrate all automatic fix/push producers stopped at the human handoff. Prefer existing consented history; additional paid rounds need authorization. A tabletop walkthrough alone leaves the live case blocked.                                           |
| Rollback            | Revert rollout-owned fields against fresh live state, preserve concurrent unrelated changes and merge protections, and identify any continuing independent or in-flight reviews. Record the final state; re-enablement requires fresh approval.                                         |

The monitoring owner gives the lead the ledger and unresolved limitations. Preparation can be complete while live rollout is blocked. Declare Stage 2 accepted only when the cases pass or the user explicitly disposes of a documented platform limitation, and the operator confirms the final intended settings. Do not silently relax the Stage 1 acceptance gate, claim duplicate suppression is guaranteed, or treat an untested path as successful.

## Preparation verification

For documentation-only changes, run the [Markdown workflow](../../.github/skills/radius-markdown-lint/SKILL.md), verify affected links/anchors, inspect prose wrapping, and run `git diff --check`. Follow the [pre-PR workflow](../../.github/skills/radius-pre-pr-review/SKILL.md) for independent review and evidence. Product suites and visual comparisons are not required solely for this runbook.

A preparation walkthrough must cover licensed/unlicensed/external authors, default and previous-Max effort, resolved duplicates, the third completed round, overlapping triggers, unavailable usage data, and concurrent rollback drift. Every case must end in a named human action or explicit blocked state. Keep those walkthrough results separate from the live acceptance ledger.
