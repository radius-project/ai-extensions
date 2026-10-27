# Adopting layered, AI-assisted code review in ai-extensions

This document explores what practices we can adopt for AI assisted code review in ai-extensions. These practices are inspired by [Solving code review at Anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/).

The goal is to speed up our code review process with automation where ever practical, while continuing to require human code review for high risk changes. When human code review is required, AI automation will direct the reviewer's attention to the parts of pull requests that require their input.

## Summary

Human code review is currently our biggest bottleneck on the ai-extensions repo. It will remain necessary for some changes, but it isn't necessary for all changes *from trusted contributors*. Smaller, docs only pull requests or verifiably low risk changes which pass all automated checks should not require human approval.

Pull requests that do require human review should automatically surface high risk portions of the pull request so that the reviewer can immediately focus their attention on those areas.

## Current Status

We already have several AI assisted code review checks in our repo:

- [`radius-code-quality`](https://github.com/radius-project/ai-extensions/blob/main/.github/skills/radius-code-quality/SKILL.md)- which is run manually be a human or agent (and invoked by [`code-quality.instructions.md`](https://github.com/radius-project/ai-extensions/blob/main/.github/instructions/code-quality.instructions.md))
- [`code-review.prompt.md`](https://github.com/radius-project/ai-extensions/blob/main/.github/prompts/code-review.prompt.md)- which is run manually by a human
- [`code-quality.instructions.md`](https://github.com/radius-project/ai-extensions/blob/main/.github/instructions/code-quality.instructions.md) - which the [main ruleset](https://github.com/radius-project/ai-extensions/rules/18178381) requests automatically on every non-draft pull request when it opens (and which can be requested manually on drafts and later pushes).  
- [`build-gate`](https://github.com/radius-project/ai-extensions/blob/main/.github/workflows/build.yml#L268)- which runs in CI (but does not block merge)
- [`dependency-review.yml`](https://github.com/radius-project/ai-extensions/blob/main/.github/workflows/dependency-review.yml)- which runs in CI (but does not block merge)

While useful individually, these checks are not wired together. The code review prompt is only run manually on demand, it's not run automatically. The code quality instructions are only automatically run when the pull request is opened. If changes are made to the pull request, re-review must be requested manually.

Additionally, all changes currently face the same approval bar. A one word docs fix requires the same review and manual approval as more in depth, risky changes.

## How do we improve our process?

In order to improve the review bottleneck to allow us to move both with more speed but also with care (recklessness is not an option), we must:

- \*\*Build confidence in our automated tools\*\* to catch regressions, security issues, and more when scanning our code. This will include testing before a PR is opened, after a PR is opened, and after every change pushed to a PR (rather than just the initial set of changes when the PR is opened)
- \*\*Create standards for automatically assessing the risk of changes\*\* based on the size and area of the changes (for example, a one line doc update or a 100 line test addition would be low risk, a large scale change to the core shared libraries would be higher risk)
- \*\*Build skills to automatically flag high risk areas of change to human reviewers\*\* - human reviewers should immediately be able to tell what parts of a PR need their focus and what does not
- \*\*Establish a list of trusted contributors\*\* whom are eligible for automated approvals of low risk changes (we already somewhat do this with teams in our GitHub organization). PRs from untrusted contributors always require human review.

## Phase 1: Building confidence in our automated tools

### Step 1.Add `.github/copilot-instructions.md`

Write a file of about 60 lines that tells Copilot what the project is: a pnpm monorepo in which `packages/core` stays free of UI concerns and `packages/adapter-canvas` owns the Copilot and webview wiring; `.artifacts/` is generated and never edited by hand; and `pnpm typecheck`, `pnpm test`, and `pnpm build` verify a change. Link to `CONTRIBUTING.md`, the skills, and `docs/architecture/` for everything else.

### Step 1.2: Turn the review prompt into review instructions

Create `.github/instructions/code-review.instructions.md`. Copy the content of `code-review.prompt.md` into this new file. Add some additional content based on Anthropic's best practices.

- Cap nits at three style comments per pull request, forbid style comments on anything that Prettier or ESLint already checks
- List paths to skip: `.artifacts/**`, `pnpm-lock.yaml`, `plugins/**` outside release branches, and visual baseline images.
- Add a summary pull request comment with a count of findings and say plainly when there is nothing to fix.

Keep `code-review.prompt.md` for deep local reviews, and point it at the new file so the two cannot drift apart.

### Step 1.3: Add a pre-PR self-review skill

Write a `radius-pre-pr-review` skill that an agent runs before it opens a pull request.

This skill should make the agent run:
the commands in the [radius-code-quality skill's verification section](https://github.com/radius-project/ai-extensions/blob/main/.github/skills/radius-code-quality/SKILL.md#verification) and paste their output.

A `code-review` subagent with fresh context then reviews the diff against `code-review.instructions.md`. A second pass strips dead code, needless helpers, and edits outside the task. If the change touches the canvas, the agent also runs the visual baseline check.
Anthropic now does most review before a pull request exists, and it names a runnable check as the practice that improves agent output most. `radius-code-quality` already demands test evidence. It lacks a second reader: an agent reviewing its own work in the same context tends to agree with itself, while a subagent that sees only the diff and the rules does not. A bug caught here costs no CI run and no reviewer's time.
Put the skill at `.github/skills/radius-pre-pr-review/SKILL.md` and reference it from the "Before you open a pull request" section of `CONTRIBUTING.md` and from `copilot-instructions.md`. Copilot CLI's built-in `code-review` agent and `/review` command can act as the reviewer.

### Step 1.4: Consider agent hooks for formatting

Copilot CLI and the Copilot coding agent can run commands at fixed points in a session. A hook could run Prettier and ESLint with `--fix` on every file an agent edits.
Formatting comments add nothing to a review, and Anthropic drops style-only findings entirely. Fixing format as the agent writes removes those comments and the review rounds they cause. The step is optional, because CI lint already catches the same problems.

## The ideas worth borrowing

Anthropic's tools are specific to Claude Code, but the ideas behind them carry over.

Anthropic asks of each change what could go wrong and which check is best placed to catch it, instead of asking whether a human read every line. That question decides where our effort goes, and it matters more than any tool.

Review runs while the code is written. An agent has reviewed and fixed most changes before a person sees them, so the human reviewer gets a clean diff and can think about design.

Human time is the scarce resource, and reverts keep the accounting honest. A change that saves an hour of review and costs two hours of incident response has saved nothing. We will judge every step here by both numbers.

When the reviewer flags the same problem again and again, Anthropic fixes it in an instruction file, a skill, or a lint rule, so the problem stops appearing at all.

Review has to converge. An agent author and an agent reviewer will happily trade commits all night. An agent fixes every nit a reviewer raises, so each nit costs another commit and another round.

A person owns every change. When an agent opens a pull request, the person who directed it counts as a reviewer, and a bot's approval never stands in for a human's.

## Where we are today

| Layer from the article | What ai-extensions already has | Gap |
| --- | --- | --- |
| Project context (`CLAUDE.md`) | `CONTRIBUTING.md`, path-scoped `.github/instructions/*.instructions.md`, five repo skills | No `.github/copilot-instructions.md` or `AGENTS.md` to give every session a short summary of the stack |
| Review rules (`REVIEW.md`) | `.github/prompts/code-review.prompt.md`, detailed and specific to this repo | Runs only when someone invokes it locally; Copilot code review on GitHub never reads it |
| 1. Verify before the pull request | `radius-code-quality` requires test evidence and coverage; `CONTRIBUTING.md` lists the pre-PR checks | No fresh-context self-review, and no hooks that format code as it is written |
| 2. AI review on every pull request | The `main` ruleset requests Copilot code review when a non-draft pull request opens; unresolved threads block merge | Copilot does not re-review new pushes, and it never sees our review rules |
| 3. Blocking security review | `dependency-review.yml`; zizmor annotations in workflows | No code scanning of our TypeScript |
| 4. Blocking automated checks | `build.yml` with `build-gate`, typecheck, tests, coverage, Changesets status | The PR template asks how to test but not how risky the change is or how to undo it |
| 5. Risk-scaled human approval | `CODEOWNERS` covers workflows and dependency files, synced from `radius-project/.github`; the ruleset requires one code-owner approval, dismisses stale approvals, and requires approval of the latest push | Every change faces the same one-approval bar |
| 6. Merge queue and staged release | Changesets release PR, `publish.yml` | No merge queue and no staged release channel |
| 7. Detection and rollback | Canvas, Cloud E2E, and Headlamp workflows open and close their own failure issues; runbooks in `docs/eng/` | Incident notes do not ask which layer should have caught the problem |
| Improving the reviewer | `issue-metrics.yml` reports on issues | No pull request metrics, no measure of review quality, no eval set |

## Constraints that shape this plan

We use Copilot, not Claude Code, and the equivalents differ in places. Copilot reads `.github/copilot-instructions.md` and `AGENTS.md` where Claude Code reads `CLAUDE.md`, and a path-scoped `.instructions.md` file takes the place of `REVIEW.md`. Copilot code review offers no Quick, Standard, or Deep setting and does not have several agents vote on each finding. Where we need those, we build them with the Copilot CLI in Actions.

The org overwrites some of our files. `CODEOWNERS`, `pr-author.yml`, and `markdown.instructions.md` arrive from `radius-project/.github` with a "DO NOT EDIT MANUALLY" header. Changes to them belong upstream, where they reach every Radius repository, so the early steps leave them alone.

Strangers send us pull requests from forks. No workflow may run an agent with secrets on fork code. The comments in `cloud-e2e.yml` explain why it avoids `pull_request_target`, and every new agent workflow must follow the same rule.

## Phase 0: Measure a baseline

Pull these numbers for the last 90 days of merged pull requests: median and 95th-percentile time to first human review, human approvals per pull request, human review comments per pull request, and the count of reverts and fix-forward pull requests.

Anthropic counts a change as a success only if it saves human time without raising the revert rate. Without a baseline we cannot tell whether a later step helped, and we have no grounds to relax an approval rule. The work takes an afternoon, and every later decision rests on it.

`issue-metrics.yml` already runs `github/issue-metrics`, which reports time to first response and time to close. A second job with the query `is:pr is:merged` gives us the pull request numbers. `git log --grep '^Revert'` on `main` counts the reverts. Save the first report as the baseline.

## Phase 1: Give Copilot the context it lacks

### Step 1.1: Add `.github/copilot-instructions.md`

Write a file of about 60 lines that tells Copilot what the project is: a pnpm monorepo in which `packages/core` stays free of UI concerns and `packages/adapter-canvas` owns the Copilot and webview wiring; `.artifacts/` is generated and never edited by hand; and `pnpm typecheck`, `pnpm test`, and `pnpm build` verify a change. Link to `CONTRIBUTING.md`, the skills, and `docs/architecture/` for everything else.

Anthropic loads this file into every review and every agent session. A Copilot agent working here today learns our architecture only if it happens to open `CONTRIBUTING.md` or trigger the right skill. A short file that links outward stays accurate. A long one buries its rules and goes stale. The reviewer should also flag any change that makes a line in the file wrong, which keeps it current.

Distill the file from three sections of `CONTRIBUTING.md`: "Repository layout," "The dependency rule," and "Before you open a pull request." Link to the full text instead of copying it.

### Step 1.2: Turn the review prompt into review-only instructions

Create `.github/instructions/code-review.instructions.md` with `applyTo: '**'` and `excludeAgent: 'coding-agent'`, so that only Copilot code review loads it. Move the repo-specific criteria out of `code-review.prompt.md` and rewrite them in the shape Anthropic found works.

Our best review knowledge sits in a prompt that runs only when someone remembers to invoke it. Copilot code review already runs on every non-draft pull request and already loads `code-quality.instructions.md` for TypeScript files, so an instructions file is the proven way to put our rules in front of it. Anthropic's most effective review files share six traits:

- They describe what failure looks like in this repo: a generated workflow reads `secrets.X` when the value lives in `vars`; core imports from the adapter; a webview string goes out unescaped; someone hand-edits `.artifacts/`.
- They cap nits, for example at three style comments per pull request, and forbid style comments on anything Prettier or ESLint already checks.
- They list paths to skip: `.artifacts/**`, `pnpm-lock.yaml`, `plugins/**` outside release branches, and visual baseline images.
- They demand evidence. Every finding cites a file and line in the diff instead of guessing from a function name. Our prompt's section on line-number accuracy already does this well and should come along.
- They open the summary with a count of findings and say plainly when there is nothing to fix.
- They label pre-existing bugs as such, so a bug the pull request did not introduce does not read as the author's fault.

Keep `code-review.prompt.md` for deep local reviews, and point it at the new file so the two cannot drift apart.

### Step 1.3: Add a pre-PR self-review skill

Write a `radius-pre-pr-review` skill that an agent runs before it opens a pull request.

**What the skill does, in order:**

1. Runs the verification commands and pastes their output.
2. Asks a `code-review` subagent with fresh context to review the diff against `code-review.instructions.md`.
3. Makes a second pass that strips dead code, needless helpers, and edits outside the task.
4. If the change touches the canvas, runs the visual baseline check.

**Why:**

- Anthropic now does most review before a pull request exists.
- Anthropic names a runnable check as the practice that improves agent output most.
- `radius-code-quality` already demands test evidence, but it lacks a second reader.
- An agent reviewing its own work in the same context tends to agree with itself. A subagent that sees only the diff and the rules does not.
- A bug caught here costs no CI run and no reviewer's time.

**Where it lives:**

- Put the skill at `.github/skills/radius-pre-pr-review/SKILL.md`.
- Reference it from the "Before you open a pull request" section of `CONTRIBUTING.md` and from `copilot-instructions.md`.
- Copilot CLI's built-in `code-review` agent and `/review` command can act as the reviewer.

### Step 1.4: Consider agent hooks for formatting

Copilot CLI and the Copilot coding agent can run commands at fixed points in a session. A hook could run Prettier and ESLint with `--fix` on every file an agent edits.

Formatting comments add nothing to a review, and Anthropic drops style-only findings entirely. Fixing format as the agent writes removes those comments and the review rounds they cause. The step is optional, because CI lint already catches the same problems.

## Phase 2: Copilot code review on every push

### Step 2.1: Have Copilot re-review new pushes

The `main` ruleset already requests Copilot code review when a non-draft pull request opens. In the same rule, turn on "Review new pushes."

When Anthropic put an AI reviewer on every pull request, the share of pull requests with substantive comments rose from 16% to 54%. We already have that first review. What we lack is a review of the commits that follow it. An author or an agent who pushes a fix after the first review can introduce a new bug that no machine reads, and the ruleset's "approval of the most recent push" rule then asks a human to catch it alone. Copilot code review always submits a comment, never an approval, so it cannot fill a required approval slot, which matches Anthropic's rule.

Re-reviewing every push also invites the endless review loop described in Step 2.3, so turn this on together with the convergence rules, not before them. Run it as a trial for two to four weeks, as Anthropic advises, and watch the number of review rounds per pull request.

### Step 2.2: Keep every finding answered

The `main` ruleset already requires every review thread to be resolved before merge. Keep it.

Anthropic makes authors fix each finding or close the thread with a reason. Without that rule, people skim past findings, and the reviewer is only as good as the attention paid to it. With it, a false positive costs a click and a sentence, and that sentence becomes data for Phase 5. The rule applies to human threads too, which is a good norm on its own.

### Step 2.3: Add review-convergence rules

Add three rules to `code-review.instructions.md`. Name the class of a bug and list every instance, not just the first line found. Never repeat a finding already posted. After three rounds of review, stop commenting on details and ask the author to reconsider the approach.

One of Anthropic's pull requests went through more than fifty rounds of review and fixes overnight. When they traced what the reviewer kept flagging, 59% of it was code that had been present at the first pass: the reviewer was handing out old findings a few at a time, not catching new bugs. Our agents answer review comments too, so the same loop can happen here. The rules cost a few lines now and are hard to impose once the habit sets in.

## Phase 3: Blocking security review

Enable CodeQL code scanning for JavaScript and TypeScript and for GitHub Actions, turn on Copilot Autofix, and add a ruleset rule that blocks merge on any new high or critical alert.

Anthropic gives security its own reviewer, and that reviewer can block merge. A general reviewer weighs many concerns at once, and a missed security bug costs more than any other kind. Our review prompt already lists the risks that matter here: shell strings built from interpolated values, unescaped webview HTML, unpinned actions, and secrets passed as inputs. CodeQL catches several of these every time, and its Actions queries cover much of what our zizmor annotations guard against. Autofix hands the author a proposed patch, so a finding costs little to clear. Dismissing an alert with a reason does the job of Anthropic's "close the thread with a short reason."

`dependency-review.yml` already blocks vulnerable dependencies. This phase holds our own code to the same standard.

## Phase 4: Scale human approval to risk

This phase changes who must approve what. It should wait until Phases 0 through 3 have produced at least a month of data.

### Step 4.1: Write down risk tiers

Write a short `docs/eng/REVIEW_POLICY.md` that assigns each change a tier by what it touches, not by who wrote it.

| Tier | Examples in this repo | Human approvals |
| --- | --- | --- |
| Low | Docs, copy, tests only, changesets, visual baseline updates | One, after automated checks pass |
| Medium | Ordinary changes to `packages/core` and `packages/adapter-canvas` | One |
| High | `.github/workflows/**`, `.github/extension/**`, workflow-YAML generators in `packages/core/src/platforms` and `src/workflows`, release and publish paths | Two, including a maintainer |

Today a docs fix and a change to the code that writes our users' deployment workflows get the same review. The workflow generators belong in the top tier because the YAML they emit runs in other people's repositories with those people's cloud credentials, so a bug there becomes a security hole in someone else's account. Low-tier changes still need one human approval. Anthropic advises starting strict and loosening only with evidence, and we have no evidence yet.

### Step 4.2: Label pull requests by tier automatically

Add a workflow that uses `actions/labeler` to apply `risk:low`, `risk:medium`, or `risk:high` from the changed paths and posts how many approvals the pull request needs.

Anthropic uses a classifier to pick each change's tier. A path-based labeler needs no model, gives the same answer every time, and can be audited by reading one file. If it misses cases, a later version can add a Copilot CLI step that reads the diff and may raise a tier but never lower one.

### Step 4.3: Enforce the high tier through CODEOWNERS

Propose a section of sensitive paths in the synced `CODEOWNERS` template in `radius-project/.github`, and require two approvals for the high tier.

Anthropic ties each approval to one commit. Our `main` ruleset already does this: it dismisses stale approvals and requires approval of the most recent push. What it cannot do is ask for more approvals on riskier paths, because the ruleset sets one approval count for every change. `CODEOWNERS` can route high-tier paths to maintainers, and a second ruleset or a required status check driven by the Step 4.2 label can demand the second approval. The `CODEOWNERS` change has to go upstream because the org syncs the file, and other Radius repositories gain from it too.

### Step 4.4: Make the directing human accountable

Add a "Directing human" field to the pull request template for agent-written pull requests, and state in `REVIEW_POLICY.md` that this person fills one of the required reviewer slots.

At Anthropic, whoever prompted a change answers for it. When an agent opens a pull request, it is easy for every human to assume someone else owns it. A name in the template settles the question and tells on-call whom to ask.

### Step 4.5: Update the pull request template

Add three sections to `.github/pull_request_template.md`: Risk (the tier and why), How to revert (revert the commit, roll back a release, or something harder), and Directing human (for agent-authored pull requests).

Anthropic's template asks how a change was tested and how to undo it. Ours already asks good questions about testing. Asking how to revert makes the author notice when a change is hard to undo, which tells the reviewer to look harder. An agent may fill in these sections, but the directing human signs off on them.

## Phase 5: Close the loop on reviewer quality

### Step 5.1: Turn reverts into an eval set

Collect the pull requests that were later reverted or fixed forward. Have the engineers who know that code confirm where each bug lived, and store each case as the pre-fix diff plus the finding a good reviewer should have made. A scheduled workflow then has the Copilot CLI review every case with the current `code-review.instructions.md` and reports how many known bugs it caught.

Anthropic runs its reviewer daily against every past incident. Without such a set, we tune instructions by anecdote and cannot tell whether a change helped. The set grows with each incident, so it tests the reviewer on exactly the mistakes this codebase produces.

Keep the cases in a directory such as `tools/review-eval/cases/`. The workflow runs on a schedule and whenever the instructions file changes, calls `copilot -p` non-interactively, and never runs on fork pull requests, since it holds a Copilot token. Our scheduled workflows already show how to open an issue when a run fails.

### Step 5.2: Measure noise from how people respond

Write a scheduled script that sorts each resolved Copilot review thread by what happened next: a later commit changed the flagged lines, the author called the finding wrong, the author called the behavior intentional, or the author judged it not worth fixing. Report the proportions alongside the Phase 0 numbers.

A reviewer can catch more bugs simply by flagging more non-bugs. Anthropic treats noise as a cost, and a higher one when the author is an agent. Watching what people do with comments measures noise without asking anyone to fill in a form. Phase 2's resolution rule produces the data.

### Step 5.3: Fix recurring findings at the source

Read the noise report once a month. Give every recurring finding a permanent home: an ESLint rule, a line in `code-review.instructions.md`, or an edit to a skill. If the finding is noise, delete the rule that produces it.

A comment repeated across fifty pull requests costs fifty readings. A lint rule enforces the same point once, before anyone reviews anything. This is the loop at the center of Anthropic's process.

### Step 5.4: Consider a nightly sweep of existing code

Run a scheduled agent each night against one area of the codebase, using the review rules, and have it open issues for the bugs it confirms.

Anthropic sweeps old code nightly because pull-request review kept tripping over pre-existing bugs. A sweep moves those findings out of unrelated pull requests, which helps review converge. It should wait until Step 5.1 shows the reviewer is precise enough that the issues it opens are worth reading.

## Phase 6: Merge, release, and rollback

Three smaller changes, each worth weighing on its own:

- Add `merge_group` to `build.yml` and turn on a merge queue for `main`. Keep the scheduled cloud workflows out of it, as they are today.
- Evaluate a prerelease channel in the plugin marketplace, so maintainers run each new version before users get it.
- Add the question "Which layer should have caught this, and what will we change there?" to the runbooks in `docs/eng/` and to the issues our scheduled workflows open on failure.

Two pull requests can each pass CI and still break `main` together. A merge queue prevents that, and the risk grows as agents raise our pull request volume. A prerelease channel gives us Anthropic's "employees first" signal. The incident question turns each miss into a fix at a specific layer instead of a vague vow to be careful.

## Sharing context without line-by-line reading

Make the `radius-architecture-documenter` skill the standard way to learn an unfamiliar area before changing it. Consider adding the `approver-review` skill to the repository, so every approver gets the same structured assessment of a pull request.

When machines do most of the reading, people lose review's second benefit: learning how the codebase fits together. Anthropic's engineers instead ask the model to explain exactly the slice they are about to change, and our documenter skill already does that. An approver's summary serves Anthropic's other rule as well: an approver who cannot say what the automated checks would miss should ask for a full review instead of approving.

## What we are not adopting yet

We will not let any change merge without a human approval. Anthropic lets trusted authors merge low-risk changes on automated checks alone, but we accept outside contributions and have no baseline yet. Every tier keeps at least one human approval until the data from Phases 0 and 5 justifies relaxing it.

We will not build multi-agent voting on findings. Anthropic has several agents confirm each finding before it posts. Copilot code review does not do this, and building it ourselves is substantial work. We will revisit it only if Step 5.2 reveals noise that better instructions cannot fix.

We will not add circuit breakers that tighten approval when reverts rise. Anthropic itself lists them as future work. They become a goal once the Phase 0 numbers are stable.

## Success measures

We will hold this plan to Anthropic's test: less human time per pull request and no more reverts.

| Measure | Source | Direction we want |
| --- | --- | --- |
| Time to first human review (median, p95) | `issue-metrics.yml` PR job | Down |
| Human review comments per pull request | GitHub API | Down for low-tier |
| Review rounds before merge | GitHub API | Down |
| Copilot findings fixed versus dismissed | Step 5.2 script | Fixed share up |
| Known bugs caught in eval set | Step 5.1 workflow | Up |
| Reverts and fix-forward pull requests per 100 merges | `git log` on `main` | Flat or down (guardrail) |

## Open questions

1. Which org-synced changes, such as sensitive `CODEOWNERS` paths and ruleset settings, should go upstream to every Radius repository, and which should stay local to ai-extensions?
2. Who owns `code-review.instructions.md`? At Anthropic the code owners write their own review rules; here that is likely the maintainers team.
3. Do we have Copilot seats that can run the CLI in Actions for the eval workflow, and under which account?
4. Besides workflows and the workflow generators, which paths should always be high risk? The installer update workflow and the publish path are candidates.

## Suggested first week

These steps take little effort, touch no org-synced files, and produce the data the later phases need.

1. Run the Phase 0 baseline query and save the numbers.
2. Add `.github/copilot-instructions.md` (Step 1.1).
3. Add `.github/instructions/code-review.instructions.md` with the convergence rules (Steps 1.2 and 2.3).
4. Turn on "Review new pushes" in the `main` ruleset's Copilot code review rule (Step 2.1).
5. Add Risk, How to revert, and Directing human to the pull request template (Step 4.5).
