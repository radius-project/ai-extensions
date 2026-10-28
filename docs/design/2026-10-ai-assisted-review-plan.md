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
- [Copilot code review](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review) - which the [main ruleset](https://github.com/radius-project/ai-extensions/rules/18178381) requests automatically on every non-draft pull request when it opens (and which can be requested manually on drafts and later pushes). It reads [`code-quality.instructions.md`](https://github.com/radius-project/ai-extensions/blob/main/.github/instructions/code-quality.instructions.md) for TypeScript files, runs at the Balanced effort level unless someone picks another, and ends each review with an approval assessment. Copilot approvals are off, so that assessment does not count toward merge.
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
- **Understand that this is a constantly evolving proce**ss and that we will not get it completely right at first.The models and tools available to us are also rapidly evolving- we will need to update our processes as they change.

## Phase 1: Building confidence in our automated tools

### 1. Add `.github/copilot-instructions.md`

Write a file of about 60 lines that tells Copilot what the project is: a pnpm monorepo in which `packages/core` stays free of UI concerns and `packages/adapter-canvas` owns the Copilot and webview wiring; `.artifacts/` is generated and never edited by hand; and the commands in the [radius-code-quality skill's verification section](https://github.com/radius-project/ai-extensions/blob/main/.github/skills/radius-code-quality/SKILL.md#verification) verify a change. Link to `CONTRIBUTING.md`, the skills, and `docs/architecture/` for everything else.

Copilot code review reads this file automatically, as do the cloud agent and Copilot CLI. Linking to the verification section, not copying the commands, keeps the two from drifting apart.

### Step 1.2: Turn the review prompt into review instructions

Create `.github/instructions/code-review.instructions.md`. Copy the content of `code-review.prompt.md` into this new file. Add some additional content based on Anthropic's best practices.

- Cap nits at three style comments per pull request, forbid style comments on anything that Prettier or ESLint already checks
- List paths to skip: `.artifacts/**`, `pnpm-lock.yaml`, `plugins/**` outside release branches, and visual baseline images.
- Add a summary pull request comment with a count of findings and say plainly when there is nothing to fix.

Keep `code-review.prompt.md` for deep local reviews, and point it at the new file so the two cannot drift apart.

Copilot code review now also loads repository [agent skills](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#mcp-servers-and-agent-skills-for-code-review) when they are relevant, and it favors skills whose directory names say they are for review. Split the content by how it is used:

- Always-on rules (the nit cap, paths to skip, the summary comment) go in `code-review.instructions.md`.
- The deeper checklist from `code-review.prompt.md` becomes a `.github/skills/radius-code-review/SKILL.md` skill. Pull-request review, Copilot CLI's `/review`, the pre-PR skill (Step 1.3), and the eval set (Step 5.1) then all draw on one source.

Copilot reads instructions and skills from the pull request's head branch, so a pull request can test changes to them before merge. The same behavior lets a fork rewrite them, which Step 4.7 addresses.

### Step 1.3: Add a pre-PR self-review skill

Write a `radius-pre-pr-review` skill that an agent runs before it opens a pull request.

This skill should make the agent run:
the commands in the [radius-code-quality skill's verification section](https://github.com/radius-project/ai-extensions/blob/main/.github/skills/radius-code-quality/SKILL.md#verification) and paste their output.

A `code-review` subagent with fresh context then reviews the diff against `code-review.instructions.md`. A second pass strips dead code, needless helpers, and edits outside the task. If the change touches the canvas, the agent also runs the visual baseline check.
Anthropic now does most review before a pull request exists, and it names a runnable check as the practice that improves agent output most. `radius-code-quality` already demands test evidence. It lacks a second reader: an agent reviewing its own work in the same context tends to agree with itself, while a subagent that sees only the diff and the rules does not. A bug caught here costs no CI run and no reviewer's time.
Put the skill at `.github/skills/radius-pre-pr-review/SKILL.md` and reference it from the "Before you open a pull request" section of `CONTRIBUTING.md` and from `copilot-instructions.md`. Copilot CLI's built-in `code-review` agent and `/review` command can act as the reviewer. Authors who want a second opinion from other models can run the reviewer on [Copilot Fusion](https://docs.github.com/en/copilot/concepts/models/copilot-fusion) High or Max, whose critique pattern has several models review a draft in parallel.

### Step 1.4: Consider agent hooks for formatting

Copilot CLI and the Copilot coding agent can run commands at fixed points in a session. A hook could run Prettier and ESLint with `--fix` on every file an agent edits.
Formatting comments add nothing to a review, and Anthropic drops style-only findings entirely. Fixing format as the agent writes removes those comments and the review rounds they cause. The step is optional, because CI lint already catches the same problems.

### Step 1.5: Check Copilot Memory for the repository

Confirm whether [Copilot Memory](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#copilot-memory) is on for ai-extensions. When it is, Copilot code review stores repository-level facts, such as "`.artifacts/` is generated," and uses them in later reviews, so the instructions file need not grow to hold every one. Before relying on it, find out who can see and correct the stored facts.

## The ideas worth borrowing

Anthropic's tools are specific to Claude Code, but the ideas behind them carry over.

Anthropic asks of each change what could go wrong and which check is best placed to catch it, instead of asking whether a human read every line. That question decides where our effort goes, and it matters more than any tool.

Review runs while the code is written. An agent has reviewed and fixed most changes before a person sees them, so the human reviewer gets a clean diff and can think about design.

Human time is the scarce resource, and reverts keep the accounting honest. A change that saves an hour of review and costs two hours of incident response has saved nothing. We will judge every step here by both numbers.

When the reviewer flags the same problem again and again, Anthropic fixes it in an instruction file, a skill, or a lint rule, so the problem stops appearing at all.

Review has to converge. An agent author and an agent reviewer will happily trade commits all night. An agent fixes every nit a reviewer raises, so each nit costs another commit and another round.

A person owns every change. When an agent opens a pull request, the person who directed it counts as a reviewer. Where a change needs a human approval, a bot's approval never stands in for it. Anthropic lets bots carry only the low-risk changes from trusted authors.

## Where we are today

| Layer from the article | What ai-extensions already has | Gap |
| --- | --- | --- |
| Project context (`CLAUDE.md`) | `CONTRIBUTING.md`, path-scoped `.github/instructions/*.instructions.md`, five repo skills | No `.github/copilot-instructions.md` or `AGENTS.md` to give every session a short summary of the stack |
| Review rules (`REVIEW.md`) | `.github/prompts/code-review.prompt.md`, detailed and specific to this repo | Runs only when someone invokes it locally; Copilot code review on GitHub never reads it |
| 1. Verify before the pull request | `radius-code-quality` requires test evidence and coverage; `CONTRIBUTING.md` lists the pre-PR checks | No fresh-context self-review, and no hooks that format code as it is written |
| 2. AI review on every pull request | The `main` ruleset requests Copilot code review when a non-draft pull request opens; unresolved threads block merge | Copilot does not re-review new pushes, and it never sees our review rules |
| 3. Blocking security review | `dependency-review.yml`; zizmor annotations in workflows | No code scanning of our TypeScript, and Dependency Review is not a required check, so it does not block merge |
| 4. Blocking automated checks | `build.yml` with `build-gate`, typecheck, tests, Changesets status; `vitest.config.ts` fails `pnpm coverage` below 100% | Only `DCO` and `Visual comparisons` are required checks, so neither `build-gate` nor the coverage thresholds block merge; `build-gate` is skipped, not failed, when a job before it fails, and it does not wait for the plugin builds; the PR template asks how to test but not how risky the change is or how to undo it |
| 5. Risk-scaled human approval | `CODEOWNERS`, synced from `radius-project/.github`, assigns every path (`*`) to the maintainers and approvers teams; the ruleset requires one code-owner approval, dismisses stale approvals, and requires approval of the latest push | Every change faces the same one-approval bar; Copilot approvals are off |
| 6. Merge queue and staged release | Changesets release PR, `publish.yml` | No merge queue and no staged release channel |
| 7. Detection and rollback | Canvas, Cloud E2E, and Headlamp workflows open and close their own failure issues; runbooks in `docs/eng/` | Incident notes do not ask which layer should have caught the problem |
| Improving the reviewer | `issue-metrics.yml` reports on issues | No pull request metrics, no measure of review quality, no eval set |

## Constraints that shape this plan

We use Copilot, not Claude Code, and the equivalents differ in places. Copilot reads `.github/copilot-instructions.md` and `AGENTS.md` where Claude Code reads `CLAUDE.md`, and a path-scoped `.instructions.md` file or a review skill takes the place of `REVIEW.md`. Copilot code review's Lite, Balanced, and Max [effort levels](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#review-effort-level) correspond to Anthropic's Quick, Standard, and Deep. Max runs several review agents on models from different providers, and an aggregation agent reconciles their findings. Average cost per review is about $0.25 for Lite, $1.50 for Balanced, and $10 for Max. Copilot can also [approve pull requests](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#copilot-approvals) when an admin allows it.

ai-extensions is a public repository, and [Copilot automations](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-automations) are not available in public repositories. Scheduled and event-driven agent work in this plan uses [GitHub Agentic Workflows](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/about-github-agentic-workflows) instead. Those are Markdown files compiled to Actions workflows and kept in Git. They are read-only by default and can write only through declared safe outputs.

The org overwrites some of our files. `CODEOWNERS`, `pr-author.yml`, and `markdown.instructions.md` arrive from `radius-project/.github` with a "DO NOT EDIT MANUALLY" header. Changes to them belong upstream, where they reach every Radius repository, so the early steps leave them alone.

Strangers send us pull requests from forks. No workflow may run an agent with secrets on fork code. The comments in `cloud-e2e.yml` explain why it avoids `pull_request_target`, and every new agent workflow must follow the same rule.

## Phase 0: Measure a baseline

Pull these numbers for the last 90 days of merged pull requests: median and 95th-percentile time to first human review, human approvals per pull request, human review comments per pull request, pushes per pull request, and the count of reverts and fix-forward pull requests.

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

When Anthropic put an AI reviewer on every pull request, the share of pull requests with substantive comments rose from 16% to 54%. We already have that first review. What we lack is a review of the commits that follow it. An author or an agent who pushes a fix after the first review can introduce a new bug that no machine reads, and the ruleset's "approval of the most recent push" rule then asks a human to catch it alone. Copilot code review submits only comments until an admin enables Copilot approvals; Phase 4 decides whether to do that.

Set the repository's default effort level to Balanced and its maximum to Max, so authors can ask for a Max review of a risky change by hand. Copilot code review is billed in AI credits, to the pull request author by default, at about $1.50 per Balanced review, so re-reviewing every push multiplies that cost by the number of pushes. Re-reviews also keep the effort level last chosen on the pull request, so once someone asks for Max, every later push costs about $10. Phase 0's count of pushes per pull request gives the estimate, and the trial should log effort levels and actual spend.

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

Make the Dependency Review job and `build-gate` (shown as "Shared release gate") required status checks in the `main` ruleset. Today both report failures but neither blocks merge, so a pull request that adds a vulnerable package or breaks the build can still merge.

Fix `build-gate` before requiring it. When a job it depends on fails, GitHub skips `build-gate` instead of failing it, and a skipped required check counts as passed. Give the gate `if: always()`, have it fail unless every job it needs succeeded, and add the plugin build and artifact jobs to its `needs`. Once the gate is required, the 100% coverage thresholds already in `vitest.config.ts` block merge too.

Consider [GitHub Code Quality](https://docs.github.com/en/code-security/code-quality/get-started/quickstart) as well. It comments on maintainability, which overlaps with Copilot code review, so watch Step 5.2's noise numbers after enabling it. Its coverage view would need a `cobertura` report from Vitest and an upload step in `build.yml`, but our own thresholds already enforce coverage.

## Phase 4: Scale human approval to risk

This phase changes who must approve what. It should wait until Phases 0 through 3 have produced at least a month of data.

### Step 4.1: Write down risk tiers

Write a short `docs/eng/REVIEW_POLICY.md` that assigns each change a tier by what it touches, not by who wrote it.

| Tier | Examples in this repo | Human approvals |
| --- | --- | --- |
| Low | Docs, copy, tests only, changesets, visual baseline updates | One during the trial (Step 4.6); afterward, a Copilot approval for trusted authors |
| Medium | Ordinary changes to `packages/core` and `packages/adapter-canvas` | One |
| High | `.github/workflows/**`, `.github/extension/**`, workflow-YAML generators in `packages/core/src/platforms` and `src/workflows`, release and publish paths | Two, including a maintainer |

Today a docs fix and a change to the code that writes our users' deployment workflows get the same review. The workflow generators belong in the top tier because the YAML they emit runs in other people's repositories with those people's cloud credentials, so a bug there becomes a security hole in someone else's account. Low-tier changes keep one human approval until Step 4.6's trial shows that Copilot's approval assessments match the humans' decisions. Anthropic advises starting strict and loosening only with evidence, and we have no evidence yet.

The high tier also calls for a Max review. Copilot picks the effort level per repository, not per path, so the author or the directing human requests Max on a high-tier pull request by hand.

### Step 4.2: Label pull requests by tier automatically

Add a workflow that uses `actions/labeler` to apply `risk:low`, `risk:medium`, or `risk:high` from the changed paths and posts how many approvals the pull request needs.

Anthropic uses a classifier to pick each change's tier. A path-based labeler needs no model, gives the same answer every time, and can be audited by reading one file. If it misses cases, a later version can add a GitHub Agentic Workflow that reads the diff and may raise a tier but never lower one.

### Step 4.3: Enforce the high tier through CODEOWNERS

Propose a section of sensitive paths in the synced `CODEOWNERS` template in `radius-project/.github`, and require two approvals for the high tier.

Anthropic ties each approval to one commit. Our `main` ruleset already does this: it dismisses stale approvals and requires approval of the most recent push. What it cannot do is ask for more approvals on riskier paths, because the ruleset sets one approval count for every change. `CODEOWNERS` can route high-tier paths to maintainers. For the second approval, add a required status check that works out the highest tier from every changed path, not from the Step 4.2 label, and confirms two distinct human approvals of the current commit, one from a maintainer. The check must not count Copilot's approval. The `CODEOWNERS` change has to go upstream because the org syncs the file, and other Radius repositories gain from it too.

### Step 4.4: Make the directing human accountable

Add a "Directing human" field to the pull request template for agent-written pull requests, and state in `REVIEW_POLICY.md` that this person fills one of the required reviewer slots.

At Anthropic, whoever prompted a change answers for it. When an agent opens a pull request, it is easy for every human to assume someone else owns it. A name in the template settles the question and tells on-call whom to ask.

### Step 4.5: Update the pull request template

Add three sections to `.github/pull_request_template.md`: Risk (the tier and why), How to revert (revert the commit, roll back a release, or something harder), and Directing human (for agent-authored pull requests).

Anthropic's template asks how a change was tested and how to undo it. Ours already asks good questions about testing. Asking how to revert makes the author notice when a change is hard to undo, which tells the reviewer to look harder. An agent may fill in these sections, but the directing human signs off on them.

### Step 4.6: Let Copilot approve low-tier changes, after a trial

[Copilot approvals](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#copilot-approvals) became generally available on October 28, 2026. An admin lists up to 15 path globs, and Copilot may approve a pull request only when every changed file matches one of them and its review finds nothing blocking. The approval counts toward required approvals. This gives us Anthropic's low-risk lane without building one.

Roll it out in four steps:

- **Trial.** For at least four weeks and at least 30 low-tier pull requests, leave approvals off and record each pull request's approval assessment next to the human decision on the same commit. Count a false approval (Copilot would approve; the human asked for a real fix) separately from Copilot being stricter than the human. Turn approvals on only if there are no false approvals, the Phase 4 prerequisites are met, and Step 4.7 is in place.
- **Allow-list.** Use the low tier's paths as the globs. Never include `.github/**`, any `AGENTS.md` or `copilot-instructions.md`, or any glob that overlaps a high-tier path.
- **Code owners.** The synced `CODEOWNERS` assigns every path (`*`) to our teams, and the ruleset requires a code-owner review. GitHub does not document whether a Copilot approval satisfies that rule. Test it on a scratch repository first. If it does not, propose upstream `CODEOWNERS` entries with no owners for the low-tier paths.
- **Trusted authors.** Copilot approvals do not check who wrote the change. Add a required status check that passes when the pull request has a human approval of the current commit, or when its author is a member of the maintainers or approvers teams. An agent's pull request counts as trusted only when the check can confirm from GitHub's own records, not the template, that a team member started the agent. Outside contributions therefore still need a human, and the check fails closed when it cannot tell.

### Step 4.7: Guard review instructions against fork pull requests

Copilot code review reads instructions and skills from the pull request's head branch, including `AGENTS.md` files anywhere in the tree. A fork can therefore rewrite `code-review.instructions.md` in the same pull request it wants approved. These steps keep such a pull request from earning a Copilot approval:

- Keep `.github/**` and every `AGENTS.md` out of the approval globs (Step 4.6).
- Propose upstream `CODEOWNERS` entries for `.github/instructions/**`, `.github/skills/**`, `.github/prompts/**`, `.github/copilot-instructions.md`, and `**/AGENTS.md`, so changes to the reviewer's rules need a maintainer.
- Turn on "Only allow Copilot code review to be triggered by authorized users." This limits who can start a review; it does not make a pull request's instructions trustworthy.

## Phase 5: Close the loop on reviewer quality

### Step 5.1: Turn reverts into an eval set

Collect the pull requests that were later reverted or fixed forward. Have the engineers who know that code confirm where each bug lived, and store each case as the pre-fix diff plus the finding a good reviewer should have made. A scheduled GitHub Agentic Workflow then reviews every case with the current review instructions and skill and reports how many known bugs it caught.

Anthropic runs its reviewer daily against every past incident. Without such a set, we tune instructions by anecdote and cannot tell whether a change helped. The set grows with each incident, so it tests the reviewer on exactly the mistakes this codebase produces.

Keep the cases in a directory such as `tools/review-eval/cases/`. The workflow runs on a schedule and whenever the review instructions or skill change, and never on fork pull requests. It authenticates with the workflow's `GITHUB_TOKEN` and the `copilot-requests: write` permission, so it needs no personal token. It writes only through a `create-issue` safe output, and a `max-ai-credits` limit caps what each run can spend.

### Step 5.2: Measure noise from how people respond

Write a scheduled GitHub Agentic Workflow that sorts each resolved Copilot review thread by what happened next: a later commit changed the flagged lines, the author called the finding wrong, the author called the behavior intentional, or the author judged it not worth fixing. Report the proportions alongside the Phase 0 numbers.

A reviewer can catch more bugs simply by flagging more non-bugs. Anthropic treats noise as a cost, and a higher one when the author is an agent. Watching what people do with comments measures noise without asking anyone to fill in a form. Phase 2's resolution rule produces the data.

### Step 5.3: Fix recurring findings at the source

Read the noise report once a month. Give every recurring finding a permanent home: an ESLint rule, a line in `code-review.instructions.md`, or an edit to a skill. If the finding is noise, delete the rule that produces it.

A comment repeated across fifty pull requests costs fifty readings. A lint rule enforces the same point once, before anyone reviews anything. This is the loop at the center of Anthropic's process.

### Step 5.4: Consider a nightly sweep of existing code

Run a scheduled GitHub Agentic Workflow each night against one area of the codebase, using the review skill, and have it open issues through a safe output for the bugs it confirms.

Anthropic sweeps old code nightly because pull-request review kept tripping over pre-existing bugs. A sweep moves those findings out of unrelated pull requests, which helps review converge. It should wait until Step 5.1 shows the reviewer is precise enough that the issues it opens are worth reading.

## Phase 6: Merge, release, and rollback

Three smaller changes, each worth weighing on its own:

- Add `merge_group` to `build.yml` and turn on a merge queue for `main`. Every required check, including `DCO`, `Visual comparisons`, and Dependency Review, must also report on merge-group commits, or the queue stalls. Keep the scheduled cloud workflows out of it, as they are today.
- Evaluate a prerelease channel in the plugin marketplace, so maintainers run each new version before users get it.
- Add the question "Which layer should have caught this, and what will we change there?" to the runbooks in `docs/eng/` and to the issues our scheduled workflows open on failure.

Two pull requests can each pass CI and still break `main` together. A merge queue prevents that, and the risk grows as agents raise our pull request volume. A prerelease channel gives us Anthropic's "employees first" signal. The incident question turns each miss into a fix at a specific layer instead of a vague vow to be careful.

## Sharing context without line-by-line reading

Make the `radius-architecture-documenter` skill the standard way to learn an unfamiliar area before changing it. Consider adding the `approver-review` skill to the repository, so every approver gets the same structured assessment of a pull request.

When machines do most of the reading, people lose review's second benefit: learning how the codebase fits together. Anthropic's engineers instead ask the model to explain exactly the slice they are about to change, and our documenter skill already does that. An approver's summary serves Anthropic's other rule as well: an approver who cannot say what the automated checks would miss should ask for a full review instead of approving.

## What we are not adopting yet

We will not let any change merge without a human approval until Step 4.6's trial and its other conditions are met. Copilot can now approve pull requests, so the limit is our evidence, not the platform. Anthropic lets trusted authors merge low-risk changes on automated checks alone, but we accept outside contributions and have no baseline yet. After the trial, only low-tier changes from trusted authors may merge on a Copilot approval.

We will not build multi-agent voting on findings. Anthropic has several agents confirm each finding before it posts. Copilot's Max effort level already runs several review agents and reconciles their findings, so we will try Max on high-tier changes before building anything of our own.

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
| Copilot approval assessment agrees with the human decision (low tier) | Step 4.6 trial log | Up |
| AI credits spent on review per merged pull request | Copilot usage reports | Flat or down |

## Open questions

1. Which org-synced changes, such as sensitive `CODEOWNERS` paths and ruleset settings, should go upstream to every Radius repository, and which should stay local to ai-extensions?
2. Who owns `code-review.instructions.md`? At Anthropic the code owners write their own review rules; here that is likely the maintainers team.
3. Which Copilot plan and org settings cover ai-extensions? Agentic Workflows need the `copilot-requests` permission, and Max reviews and Copilot approvals need admin opt-in.
4. Besides workflows and the workflow generators, which paths should always be high risk? The installer update workflow and the publish path are candidates.
5. Does a Copilot approval satisfy the ruleset's code-owner review requirement? The Step 4.6 scratch-repository test answers this.
6. Should Copilot review fork pull requests automatically, given that the review is billed to the author?
7. How is GitHub Code Quality billed for a public repository?
8. Will the org accept `CODEOWNERS` entries with no owners for low-tier paths in the synced template?

## Suggested first week

These steps take little effort, touch no org-synced files, and produce the data the later phases need.

1. Run the Phase 0 baseline query and save the numbers.
2. Add `.github/copilot-instructions.md` (Step 1.1).
3. Add `.github/instructions/code-review.instructions.md` with the convergence rules (Steps 1.2 and 2.3).
4. Turn on "Review new pushes" in the `main` ruleset's Copilot code review rule, and set the default effort to Balanced and the maximum to Max, with Copilot approvals off (Step 2.1).
5. Add Risk, How to revert, and Directing human to the pull request template (Step 4.5).
6. Start logging each low-tier pull request's approval assessment next to the human decision, and run the `CODEOWNERS` test on a scratch repository (Step 4.6).
