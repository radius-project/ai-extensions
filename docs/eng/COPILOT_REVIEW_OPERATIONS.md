# Copilot re-review operations

Use this runbook to roll out [Stage 2: reviews on every push](../design/2026-10-ai-assisted-review-plan.md#phase-2-copilot-code-review-on-every-push) after obtaining separate authorization. Merging this document changes no settings. Stage 1 and Stage 2 still need verification in GitHub, with the results recorded below.

The [review skill](../../.github/skills/radius-code-review/SKILL.md#review-convergence) defines what reviewers check and when they hand unresolved findings to the author. This runbook tells maintainers how to operate the rollout. It adds no workflow, enforced round limit, or merge requirement, and authorizes no spending.

## Roles and activation gates

The lead is @nellshamrell. The primary repository admin is @nicolejms; the backup is @nellshamrell. Before starting, confirm their availability. Record who will change settings, monitor reviews, and authorize spending, and agree where to keep the results. Naming someone here does not mean they have agreed or approved spending.

Do not enable the rollout until the lead records all of the following:

- Stage 1 guidance is merged and present in the selected sample PR heads. GitHub [reads instructions and skills from the head branch](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#agent-skills), so inspect the actual sample revision.
- An authorized sample demonstrates the Stage 1 criteria in GitHub, with review URLs and reviewed SHAs. A local review or a claim that the skill loaded is not enough. GitHub does not support the requested summary format, so the user must agree on an observable alternative before rollout; see [Stage 1 verification](../../.github/skills/radius-code-review/SKILL.md#hosted-review-acceptance).
- Someone has reviewed this runbook. The user has authorized the exact settings changes, the GitHub review experiment, how to stop every agent or automation that fixes or pushes code, and emergency rollback. Obtain rollback authorization before starting; restarting after rollback requires a new decision.
- The billing owner has confirmed who pays, which access policies apply, what bounds spending, who can monitor it, and who can stop the experiment. Do not set a budget or enable paid usage yourself. Without a billing owner or usage visibility, do not start.
- The sample PRs and participants have explicit authorization. List their personal and organization review triggers and every agent or automation that fixes or pushes code. Do not use this preparation PR or another contributor's PR without consent.

You can test the mechanics in an authorized isolated repository with representative rules and Stage 1 instructions. Do not copy secrets or private integration configuration. Those results do not replace separately authorized tests in this repository.

Keep Copilot approvals off, both submission and counting toward merge. Preserve all human-review requirements and required checks. The agreed policy calls for one qualifying human approval from `radius-project/approvers-ai-extensions` and a manually requested Max review for high-risk changes. Enforcing team membership is later-stage work, not part of Stage 2. Copilot's assessment does not count as a human approval.

## Requesting a review and choosing effort

Choose Copilot's effort in the PR's **Reviewers** controls before requesting a review. For a high-risk change, the author or supervising human chooses **Max**. Check the completed review's overview for Max and the intended commit. A request alone proves neither.

GitHub [chooses effort](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#review-effort-level) in this order: explicit request, previous effort on that PR, requester preference, repository setting, organization setting, then built-in default. After a Max review, automatic reviews can keep using Max despite a Balanced repository default. To lower effort, explicitly request Balanced and check the result; changing the repository default does not reset existing PRs. Organization and enterprise limits still apply. Max is in preview, so check availability and terms before rollout.

If the author cannot request Copilot, a maintainer with access opens the same PR, chooses the effort, and requests the review. Check that it ran, or record why the control is missing or the request failed. Maintainer status alone does not grant access. If nobody can request the review, notify the lead and continue with human review. Keep required checks and approval rules unchanged.

Check access for each participant:

| Author or requester                         | What to verify                                                                                                                                     |
|---------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| Licensed person                             | Check code-review access, external-license restrictions, available credits, and who pays.                                                          |
| Organization member without a license       | Paid usage and the unlicensed-member review policy must already permit access. Qualifying automatic reviews can run without an individual license. |
| Outside contributor without eligible access | Do not assume the member exception applies. Have an authorized maintainer with access request the review, or record that it is unavailable.        |
| Bot or Copilot cloud agent                  | Check the documented access and billing rules for that actor; human-author rules may not apply.                                                    |

Do not alter licensing, external-license restrictions, or organization paid-usage policies to make a test pass.

## Billing and monitoring

Reviews use [AI credits and may also incur Actions charges](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#code-review-usage-and-billing). Automatic reviews usually charge the author; manual reviews usually charge the requester. Organization policies, including those for unlicensed members, and bot/cloud-agent billing rules can change who pays. Confirm the payer before requesting a review.

Use GitHub's [current estimates](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#estimated-consumption) when discussing cost. They exclude Actions usage and are neither fixed prices nor spending caps. An effort label does not guarantee a charge. An exhausted budget can prevent a review; a missing review is not an approval.

The monitoring owner keeps a record in the agreed location, with one entry per review attempt. A session artifact is enough during preparation; publishing an issue or comment needs separate authorization.

| Field       | Evidence                                                                                                                                |
|-------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| Target      | PR URL, pushed SHA, reviewed SHA, and whether Stage 1 guidance is present.                                                              |
| Trigger     | Personal, repository, organization, or manual request. Flag unknown sources for investigation.                                          |
| Run         | Review ID/URL, requested and reported effort, trigger and completion times, and completed/failed/pending status.                        |
| Convergence | Completed round number, including earlier rounds; links to duplicates and the decision on each; unresolved work and who will handle it. |
| Consumption | Reported credits/Actions usage and payer category. Mark data that is delayed, aggregate-only, or unavailable.                           |
| Decision    | Continue, pause, failed test, or user-approved exception, with evidence and the responsible operator.                                   |

Track review time, round count, repeated findings, failures, effort, and available usage. Aggregate billing reports cannot establish per-PR spending. Failed or incomplete attempts do not count as completed rounds, but still matter for cost and reliability. Before testing, agree how long to wait before recording that no review ran.

Keep personal budgets, account details, tokens, and raw billing exports out of shared records. Redact screenshots and review records before sharing; record payer categories rather than private user spending. No monitoring service is needed.

## Pausing the fix and push loop

Before testing, list everything that can apply fixes, request reviews, or push to the PR: cloud agents, local/app sessions, agent-merge check-ins, review-triggered fix automations, and any other configured source. For each, record who owns it, how to pause or stop it, the permission needed, and how to confirm it stopped. Do not start if any source is unknown or cannot be paused. Pausing one chat does not stop other agents.

After the third completed automated review round, the author or supervising human:

1. Uses that list to pause automatic fixes, review requests, and pushes, then confirms each source stopped.
2. Records unresolved findings and duplicates, links the completed rounds, and assigns the remaining work.
3. Decides what happens next. Every later push or review needs a human decision.

The author stops the fix/push loop; GitHub does not enforce a three-round limit. There is no documented per-PR switch that reliably stops ruleset reviews while allowing more pushes. [Personal and ruleset triggers act independently](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#automatic-pull-request-reviews), so disabling one can leave another active. Personal or organization settings can trigger draft reviews even when the repository rule excludes drafts.

Resolving a conversation, replying to Copilot, removing it as reviewer, disabling personal reviews, or converting to draft does not guarantee a stop. [Copilot cannot see replies, and resolved findings can recur](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-code-review#requesting-a-re-review-from-copilot). Check every applicable trigger before relying on draft status to help.

Pause the rollout and notify the primary admin if findings repeat, the reviewed commit is unknown, spending exceeds authorization, nobody is monitoring, settings cannot be verified, or the fix/push loop cannot be stopped. Contact the backup immediately if the primary is unavailable. Keep human review and required checks in place. Automation to enforce a stop would be a separate proposal.

## Applying the authorized settings delta

Follow these steps only after authorization. Use [GitHub's settings controls](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review), not a new script for this one-off change.

1. Read and save the current ruleset and settings, including inherited rules, branch targets, enforcement, bypass actors, required checks and their App IDs, all PR protections, approval controls, effort limits, and other automatic-review sources. Check Max's availability and terms. Compare with the state used to approve the rollout; resolve unexpected differences before editing.
2. In this repository's **Settings > Copilot > Code review**, explicitly select **Balanced** review effort and **Max** maximum effort, if available and allowed. If an organization or enterprise limit prevents this, stop for a decision. Do not change that policy.
3. In **Settings > Rules > Rulesets > main**, enable **Review new pushes** in the existing Copilot review rule. Keep **Review draft pull requests** off. Do not recreate the ruleset or replace it with a stale exported copy.
4. Keep Copilot approval submission and counting toward merge off, including the organization restriction. Do not enable approvals to inspect hidden controls. Preserve required approvals, latest-push approval, stale dismissal, code-owner review, thread resolution, and every unrelated protection.
5. Reopen the settings and complete ruleset in GitHub to check what saved. Confirm `review_on_push: true`, `review_draft_pull_requests: false`, explicit Balanced/Max, and no unrelated changes. Preserve [required check names](../../CONTRIBUTING.md#required-merge-checks) and their source Apps. Save redacted before/after records and who made the change.

If only some changes save or verification fails, stop the experiment and roll back only the fields this rollout changed. Follow the procedure below. Do not loosen approval restrictions. If a required control is missing or inaccessible, stop rather than assuming it is set correctly.

## Emergency rollback

This rollback restores re-review and effort settings. It is separate from the later-stage procedure for suspending Copilot approval credit. Before rollout, obtain authorization for the primary or backup admin to take these emergency steps:

1. Stop every automatic fix/push source on the list. Read the current ruleset and settings, and compare the fields this rollout changed with the values recorded after rollout.
2. Restore `review_on_push` and any changed effort fields to their recorded pre-rollout values. If someone has since changed one of those fields, resolve the conflict with its owner before overwriting it. Do not restore an entire snapshot. Preserve unrelated changes, human-review requirements, and required checks.
3. Read the settings again and confirm their repository-wide effect. Record any failed restore or unresolved difference. Escalate immediately if rollback cannot be completed; do not report success.
4. If reviews continue, check personal/organization triggers and queued or running work. Contact the relevant owner; further changes need authorization. Repository rollback does not cancel queued or running reviews or disable other triggers.

Never disable merge protections to stop a review. Restart only after resolving the incident, checking the current state, and obtaining fresh approval for the settings changes.

## Live acceptance record

Run these cases only after meeting the prerequisites and obtaining authorization. Use safe, controlled changes and push one at a time. Do not merge deliberately introduced defects. Record pass, fail, or blocked, with review URLs, SHAs, settings records, and the operator's decision. Local reviews and walkthroughs do not count as tests in GitHub.

| Case                | Required evidence                                                                                                                                                                                                                                                                               |
|---------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| New push            | A ready PR with review access and Stage 1 guidance receives a completed review of the new SHA without a manual request.                                                                                                                                                                         |
| Non-draft scope     | Confirm other draft-review triggers are off for the sample. Push to the draft and observe no triggered, pending, or running review during the agreed wait. Mark it ready and push; confirm the configured review runs. This result applies only to the tested settings and interval.            |
| Resolved finding    | Fix a harmless finding and confirm the later review does not repeat it. Distinguish a new regression from a duplicate. A duplicate fails the test: fix the cause or obtain explicit user acceptance of the limitation, but do not record a pass.                                                |
| Effort              | Request Max and confirm the completed review reports Max. Record the next automatic review's effort. Make an authorized explicit Balanced request and record its actual result. If the requested effort is unavailable or capped, mark the case blocked rather than substituting another level. |
| Maintainer request  | A maintainer with access successfully requests a review for an authorized sample author without access. Missing participants or permissions block the test; do not change access policies to make it pass.                                                                                      |
| Third-round handoff | Link completed rounds and show that every automatic fix/push source stopped when the human took over. Prefer existing history whose use is authorized; extra paid rounds need authorization. A walkthrough alone leaves this test blocked.                                                      |
| Rollback            | Restore only this rollout's fields after checking current settings. Preserve unrelated concurrent changes and merge protections. Identify reviews that continue through other triggers or queued/running work. Record the final state; restarting requires fresh approval.                      |

The monitoring owner gives the lead the results and unresolved limitations. Preparation can finish while rollout remains blocked. Before accepting Stage 2, the operator must confirm the intended final settings. Each test must pass unless the user explicitly decides how to handle a documented platform limitation. Do not skip Stage 1 verification, promise that findings cannot recur, or mark untested cases as passed.

## Preparation verification

For documentation changes, run the [Markdown checks](../../.github/skills/radius-markdown-lint/SKILL.md), check links and anchors, inspect prose wrapping, and run `git diff --check`. Follow the [pre-PR workflow](../../.github/skills/radius-pre-pr-review/SKILL.md) for independent review and results. This runbook alone does not require product tests or visual comparisons.

Before rollout, walk through licensed, unlicensed, and external authors; default effort and a previous Max review; repeated resolved findings; the third completed round; overlapping triggers; missing usage data; and settings changed by someone else before rollback. For each case, name who acts and what they do, or state why it is blocked. Keep walkthrough results separate from tests run in GitHub.
