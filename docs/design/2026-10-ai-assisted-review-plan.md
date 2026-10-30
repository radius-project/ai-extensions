# Adopting layered, AI-assisted code review in ai-extensions

- **Author**: Nell Shamrell-Harrington (@nellshamrell)
- **Date**: 2026-10

This document proposes automated review practices for ai-extensions. They draw on [Solving code review at Anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/) and on the [Copilot features announced at GitHub Universe 2026](https://github.blog/news-insights/company-news/github-universe-2026-evolving-every-layer-of-the-stack/).

There is also an open issue to [explore AI Personas by Component in Radius](https://github.com/radius-project/radius/issues/13345). This document is not intended to supersede or conflict with that issue in any way. Instead, it is focused on using tools which already exist in our ai-extensions repository today and that are built into GitHub.

## Current state

We already run several review checks. Some use AI and some are through ordinary CI:

- [`code-review.prompt.md`](https://github.com/radius-project/ai-extensions/blob/main/.github/prompts/code-review.prompt.md): our most detailed review prompt. Today it runs only when someone invokes it by hand.
- [`radius-code-quality`](https://github.com/radius-project/ai-extensions/blob/main/.github/skills/radius-code-quality/SKILL.md): a skill that people or agents run while making a change. [`code-quality.instructions.md`](https://github.com/radius-project/ai-extensions/blob/main/.github/instructions/code-quality.instructions.md) points agents to it for TypeScript and JavaScript files. Copilot agents usually load it when they edit those files, and Copilot code review may load it, but the model decides each time.
- [Copilot code review](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review): the [main ruleset](https://github.com/radius-project/ai-extensions/rules/18178381) requests a review when someone opens a non-draft pull request. The review reads `code-quality.instructions.md` for TypeScript and JavaScript files.
- [`build.yml`](https://github.com/radius-project/ai-extensions/blob/main/.github/workflows/build.yml): the build, test, and coverage jobs run in CI but don't block merge.
- [`dependency-review.yml`](https://github.com/radius-project/ai-extensions/blob/main/.github/workflows/dependency-review.yml): runs in CI but doesn't block merge.

The majority of these checks don't work together:

- Copilot reviews only the first version of a pull request. A later push gets a review only if someone asks for one.
- Copilot never sees `code-review.prompt.md`, our most detailed list of what to look for.
- Only `DCO` and `Visual comparisons` block merge, so a broken build or a vulnerable dependency can still merge.

Every change also faces the same approval bar. A one-word docs fix needs the same human review as a risky change to shared code.

## Proposal

Not every change needs a human reviewer. A pull request from a trusted contributor (a member of the maintainers or approvers team) can merge without human approval when it passes every required check and *is plainly low risk*, such as a docs-only or tests-only change.

Every other pull request still needs a human. For those, automation should point to the riskiest parts of the diff, so the reviewer starts there instead of reading the whole change.

We can do this work in four phases:

1. [Phase 1: Building confidence in our automated tools](#phase-1-building-confidence-in-our-automated-tools)
2. [Phase 2: Copilot code review on every push](#phase-2-copilot-code-review-on-every-push)
3. [Phase 3: Blocking security and build checks](#phase-3-blocking-security-and-build-checks)
4. [Phase 4: Scaling human approval to risk](#phase-4-scale-human-approval-to-risk)

## Objectives

### Goals

We want reviews to move faster without getting careless. To get there, we must:

- **Build trust in our automated checks.** They should catch regressions, security bugs, and broken builds at three points: before a pull request opens, when it opens, and on every later push.
- **Classify each change's risk automatically.** The paths a change touches set its tier. A docs fix or a new test file is low risk; a change to `packages/core` or to the workflow generators is higher.
- **Show human reviewers where to look.** When a pull request needs a human, automation should flag its riskiest parts so the reviewer starts there.
- **Define trusted contributors.** Only members of the maintainers and approvers teams may merge low-risk changes on an automated approval. Everyone else's pull requests must get human review.
- **Expect to revise this.** We won't get it right the first time and will need to revise as the tools and models available to us change.

### Non-goals

We will not let any change merge without a human approval until Step 4.5's trial succeeds and its other conditions are met. After that, only low-risk changes from trusted authors may merge on a Copilot approval. As we continue to gather data and iterate on our process, we may consider whether we will allow Copilot approvals on medium risk changes from trusted contributors.

## Design

### Phase 1: Building confidence in our automated tools

#### Step 1.1: Add `.github/copilot-instructions.md`

We need to give Copilot facts about our repo that it loads in every session. In [Anthropic's process](https://claude.dev/blog/solving-code-review-at-anthropic/), a project context file (`CLAUDE.md`) is the base every other review layer builds on. Our version is `copilot-instructions.md`.

The file should cover:

- **Repo Layout:** it's a pnpm monorepo. `packages/core` stays free of UI code, and `packages/adapter-canvas` owns the Copilot and webview wiring.
- **Generated file rules:** `.artifacts/` is generated. Never edit it by hand.
- **Verification instructions:** link to the commands in the `radius-code-quality` [verification section](https://github.com/radius-project/ai-extensions/blob/main/.github/skills/radius-code-quality/SKILL.md#verification). Link rather than copy, so the two lists can't drift apart.
- **Links to more information:** `CONTRIBUTING.md`, the skills, and `docs/architecture/`.

#### Step 1.2: Give Copilot code review the same review rules that we use for manual review

Our most detailed review guidance lives in `code-review.prompt.md`, and the Copilot reviewer that runs on pull requests never reads it. We need to move that guidance where Copilot will find it on every review.

First, we should move the contents of `code-review.prompt.md` into a new skill at **`.github/skills/radius-code-review/SKILL.md`**. We will keep the prompt for local reviews (should someone wish to run it through VSCode) and have it point to the skill. Having a radius-code-review skill, rather than a saved prompt, will also allow us to run the same checks through GitHub Copilot CLI and the GitHub Copilot app.

Next, we should create **`.github/instructions/code-review.instructions.md`** to hold the rules for every review. The file should:

- Tell Copilot to apply the `radius-code-review` skill to every pull request. Copilot code review loads a skill only when it judges the skill relevant, but it reads this file on every review, so the pointer makes the skill far more likely to load. GitHub doesn't document whether an instruction can force a skill to load, so we will need to manually  check one pull request's review to confirm it did.
- Skip `.artifacts/**`, `pnpm-lock.yaml`, `plugins/**` outside release branches, and visual baseline images.
- End with a summary comment that counts findings and says plainly when there's nothing to fix.
- In that summary, name the two or three changes a human should read first and say why each is risky (for example, a new shell command, a changed security check, or a public API change).

#### Step 1.3: Add a pre-PR self-review skill

We need agents to review their own work before they open a pull request. `radius-code-quality` already asks agents for test evidence, but no one checks their work with fresh eyes. An agent reviewing its own work in the same session tends to agree with itself; a separate reviewer that sees only the diff and the rules doesn't.

We should add a `radius-pre-pr-review` skill at `.github/skills/radius-pre-pr-review/SKILL.md`. The skill should have the agent:

1. Run the commands in the `radius-code-quality` [verification section](https://github.com/radius-project/ai-extensions/blob/main/.github/skills/radius-code-quality/SKILL.md#verification) and paste their output.
2. Hand the diff to a `code-review` subagent with fresh context, which checks it against the rules and skill from Step 1.2.
3. Make a second pass to remove dead code, needless helpers, and edits outside the task.
4. Run the visual baseline check if the change touches the canvas.

We should link to the skill from the "Before you open a pull request" section of `CONTRIBUTING.md` and from `copilot-instructions.md`.

Copilot CLI's and the Copilot app's built-in `code-review` agent or `/review` command can serve as the fresh-context reviewer. For a second opinion from other models, authors can run it on [Copilot Fusion](https://docs.github.com/en/copilot/concepts/models/copilot-fusion) High or Max, where several models critique the draft in parallel.

#### Step 1.4 (optional): Format code as agents write it

We need formatting problems fixed before they reach review. Each formatting comment takes a reviewer's attention and usually costs another push and another review round. Anthropic doesn't post style-only findings at all.

Copilot CLI and the Copilot coding agent can run hooks at fixed points in a session. We can add a hook that runs Prettier and ESLint with `--fix` on every file an agent edits.

This step is optional because CI lint already catches the same problems. The hook catches them sooner.

#### Step 1.5 (optional): Check whether Copilot Memory is on

We need to know whether Copilot code review can remember facts about our repo. Some facts surface only during review, such as a file that looks hand-written but is generated. Without memory, someone corrects the same mistaken comment on pull request after pull request, or we keep growing the instructions file that every review loads.

[Copilot Memory](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#copilot-memory) lets Copilot code review learn repo facts, such as "`.artifacts/` is generated," and use them in later reviews. We will:

- Check whether Copilot Memory is on for ai-extensions.
- Find out who can see and correct what it stores. A wrong fact would quietly steer every later review, so someone must be able to audit it.

### Phase 2: Copilot code review on every push

#### Step 2.1: Have Copilot re-review new pushes

We need Copilot to review every push to a pull request that is ready for review, not just its first version. A fix pushed after the first review can bring a new bug, and today only a human reviewer stands between that bug and `main` unless someone manually asks Copilot to look again.

We should change two sets of settings:

- In the `main` ruleset, turn on "Review new pushes."
- In the repository's Copilot code review settings, set the default effort level to Balanced and the maximum to Max, so authors can request a Max review of a risky change by hand. Leave Copilot approvals off for now; Step 4.5 sets the conditions for turning them on.

Copilot code review is billed in AI credits, to the pull request author by default. A Balanced review costs about $1.50, so reviewing every push multiplies that by the number of pushes. A re-review also keeps the last effort level used, so once someone requests Max, every later push costs about $10.

The ruleset reviews only pull requests [created by people with access to Copilot](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#automatic-pull-request-reviews). An outside contributor without a Copilot license gets no automatic review, so a maintainer must request one by hand, and the maintainer will pay for it.

#### Step 2.2: Keep every finding answered

Our `main` ruleset already requires every review thread to be resolved before merge. We should keep that rule.

#### Step 2.3: Add review-convergence rules

We need reviews to converge instead of looping forever. One of Anthropic's pull requests went through more than fifty rounds of review and fixes overnight. When the team traced what the reviewer kept flagging, 59% of it was code present at the first review: the reviewer was handing out old findings a few at a time instead of catching new bugs.

We should add three rules to `code-review.instructions.md`:

- When you find a bug, name its class and list every instance, not just the first.
- Never repeat a finding already posted.
- After three rounds of automated review, stop and ask the pull request author to step in.

### Phase 3: Blocking security and build checks

#### Step 3.1: Turn on CodeQL and Copilot Autofix

We need a security reviewer that can block merge. Our review prompt already lists the risks that matter most here: shell strings built from interpolated values, unescaped webview HTML, unpinned actions, and secrets passed as inputs. Today nothing blocks merge on any of them.

CodeQL can detect several of these risks, including workflow injection, but its coverage depends on the selected query suite. The high/critical merge rule below will not block medium-severity findings such as unpinned actions. Copilot Autofix can propose patches for supported findings; it does not support every Actions query.

We should:

- Enable CodeQL code scanning for JavaScript and TypeScript, and for GitHub Actions.
- Turn on Copilot Autofix.
- Add a rule to the `main` ruleset that blocks merge on any new high or critical alert.

#### Step 3.2: Make Dependency Review and the build jobs required checks

We need failing builds and vulnerable dependencies to block merge. Today the Dependency Review job and the build jobs in [`build.yml`](https://github.com/radius-project/ai-extensions/blob/main/.github/workflows/build.yml) report failures, but none is required, so a pull request that adds a vulnerable package or breaks the build can still merge.

We should add these as required status checks in the `main` ruleset, using the check name each job reports:

- `dependency-review / dependency-review` (from [`dependency-review.yml`](https://github.com/radius-project/ai-extensions/blob/main/.github/workflows/dependency-review.yml))
- `Static checks`
- `Windows process integration`
- `Canvas Chromium (shard 1)` and `Canvas Chromium (shard 2)`
- `Tests, browser coverage and library candidates`

Once the tests job is required, violations of the 100% coverage thresholds already in `vitest.config.ts` block merge too.

We should require these jobs directly rather than `build-gate`. `build-gate` waits on the same jobs, but when one of them fails GitHub skips the gate instead of failing it, and a skipped required check counts as passed. Requiring the jobs directly avoids changing `build-gate`, which `publish.yml` and `release.yml` rely on. The cost is upkeep: when we rename, add, or reshard one of these jobs, we must update the ruleset to match. [Alternatives considered](#alternatives-considered) covers the other option.

This list leaves out the per-plugin `Build <plugin> dist` jobs. Their check names come from a matrix that grows as we add plugins, so a fixed ruleset can't list them. As it stands, a pull request that breaks one plugin's build can still merge.

### Phase 4: Scale human approval to risk

#### Step 4.1: Write down risk tiers

We should write a short `docs/eng/REVIEW_POLICY.md` that assigns each change a tier by what it touches.

| Tier | Examples in this repo | Human approvals | Why |
| --- | --- | --- | --- |
| Low | Docs, copy, tests only, changesets, visual baseline updates | Copilot approval for trusted authors, one human approval for all other authors | Nothing here runs with credentials or ships as code. A mistake is visible in the diff and cheap to revert. |
| Medium | Ordinary changes to `packages/core` and `packages/adapter-canvas` | One | This code ships to users, but CI, coverage, and Copilot review catch most mistakes, and a bad release can be fixed with the next one. |
| High | `.github/workflows/**`, `.github/extension/**`, `packages/core/src/platforms/**`, `packages/core/src/workflows/**`, and the release scripts (`scripts/plugins.mjs`, `scripts/version.mjs`, `scripts/release-version.mjs`, `scripts/release-plan.mjs`, `scripts/verified-git.mjs`, `scripts/validate-plugin-dist.mjs`) | One | These run with credentials, act outside this repo, and are hard to undo. Passing tests don't show they're safe (more info below). |

Each high-tier path is there for a specific reason:

- **Our workflows** in `.github/workflows/**` run in CI with write tokens and secrets, and they enforce our merge rules. One change can weaken a required check, pull in an unpinned action, or let a pull request title inject a shell command.
- **The workflows we ship to users** in `.github/extension/**` run in users' repositories. Several request `id-token: write` to get cloud credentials through OIDC, and some delete real AWS or Azure resources.
- **The generators** in `packages/core/src/platforms` and `packages/core/src/workflows` write that workflow YAML and build the OIDC subject that a user's cloud account checks before it hands out credentials. A subject that's too broad lets more workflows get those credentials. Reviewers read the generator, not the YAML it produces, so a risky change is easy to miss.
- **The release scripts**, called by `publish.yml` and `release.yml`, decide what reaches users. A compromise there is a supply-chain attack, and a published version can't be cleanly taken back.

For all four, passing tests don't show a change is safe. Tests check that the code does what we intended; the danger in these paths is what the code could also be made to do. A workflow that grants `contents: write` where `read` would do passes every test, and so does a generator that writes a wider OIDC subject, if we update the expected output along with it. A shell step that interpolates a pull request title works fine until someone opens a pull request with a malicious title. And our pull request CI can't run the real thing: it has no cloud credentials and doesn't publish, so the deploy, delete, and release steps first run for real after merge. Only a reviewer who reads for least privilege, scope, and untrusted input can catch these.

The high tier also calls for a Max code review from Copilot, which the author or the human directing the agent must request by hand. Copilot sets the default effort level per repository, not per path, and we should keep that default at Balanced.

#### Step 4.2: Label pull requests by tier automatically

We should add a workflow that uses `actions/labeler` to apply `risk:low`, `risk:medium`, or `risk:high` from the changed paths, and that posts how many approvals the pull request needs.

#### Step 4.3: Enforce the high tier

We should propose a section of sensitive paths in the synced `CODEOWNERS` template in `radius-project/.github`, so a code owner must approve any high-tier change.

A ruleset sets one approval count for the whole branch, and `CODEOWNERS` requires one code-owner approval. Since high-tier changes should require only one human approval, the code-owner requirement is sufficient; we do not need a separate approval-count check for high-tier pull requests.

#### Step 4.4: Point human reviewers at the riskiest changes

We need human reviewers on medium- and high-tier pull requests to start with the parts most likely to hide a bug. A reviewer who reads a large diff top to bottom spends the same attention on a renamed variable as on a changed workflow permission. Automation already knows which paths are sensitive and which changes Copilot found risky, so it should tell the reviewer where to look.

We should:

- Extend the labeling workflow from Step 4.2 so its comment also lists every changed file that matches a high-tier path. The list comes from the paths alone, so it's the same every time.
- Rely on Copilot's summary comment (Step 1.2) for the judgment calls: the changes it thinks are riskiest, and why.

#### Step 4.5: Let Copilot approve low-tier changes, after a trial

[Copilot approvals](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#copilot-approvals) became generally available on October 28, 2026. A repository admin turns them on under [Settings > Copilot > Code review](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review#customizing-copilot-code-review-1), which has three Auto-approval settings:

- **Allow Copilot to approve pull requests** lets Copilot submit an approving review.
- **Allow Copilot approvals to count toward merge requirements** lets that approval satisfy the ruleset's required approval, the same way a teammate's would.
- **File paths** optionally limits which pull requests that applies to. The admin enters up to 15 file globs, one per line, such as `docs/**` or `**/*.test.ts`. Copilot's approval counts toward merge only when every changed file in the pull request matches at least one glob. If the list is blank, it counts for every file.

For example, with the globs `docs/**` and `**/*.md`, a pull request that changes `docs/setup.md` and `README.md` can merge on Copilot's approval. If it also changes `packages/core/src/index.ts`, it still needs a human approval.

The globs don't change which pull requests Copilot reviews. The `main` ruleset still requests a review on every non-draft pull request, and every review still includes Copilot's approval assessment in its summary comment. A new push dismisses Copilot's approval.

We should roll it out in four parts:

- **Trial.** For at least four weeks and at least 30 low-tier pull requests, **leave approvals off and record Copilot's approval assessment for each pull request next to the human decision on the same commit**. Count any false approvals (where Copilot would approve, but a human asks for a real fix). Turn approvals on only if there are no false approvals in the trial period. If there are false approvals, update the review instructions and skills, then run a new trial.
- **Allow-list.** Use the low tier's paths as the globs. Never include `.github/**`, any `AGENTS.md` or `copilot-instructions.md`, or any glob that overlaps a high-tier path.
- **Code owners.** The synced `CODEOWNERS` assigns every path (`*`) to our teams, and the ruleset requires a code-owner review. GitHub doesn't document whether a Copilot approval satisfies that rule. We should test it on a scratch repository first. If it doesn't, we should propose upstream `CODEOWNERS` entries with no owners for the low-tier paths.
- **Trusted authors.** Copilot approvals don't check who wrote the change. We should add a required status check that passes when the pull request has a human approval of the current commit, or when its author is a member of the maintainers or approvers teams. An agent's pull request counts as trusted only when the check can confirm from GitHub's own records, not the pull request template, that a team member started the agent. Outside contributions therefore still need a human, and the check fails when it can't tell.

#### Step 4.6: Guard review instructions against fork pull requests

Copilot code review reads instructions and skills from the pull request's head branch, including `AGENTS.md` files anywhere in the tree. A fork can therefore rewrite `code-review.instructions.md` in the same pull request it wants approved. These changes keep such a pull request from earning a Copilot approval:

- Keep `.github/**` and every `AGENTS.md` out of the approval globs (Step 4.5).
- Propose upstream `CODEOWNERS` entries for `.github/instructions/**`, `.github/skills/**`, `.github/prompts/**`, `.github/copilot-instructions.md`, and `**/AGENTS.md`, so a change to the reviewer's rules needs a maintainer.
- Turn on "Only allow Copilot code review to be triggered by authorized users." Without it, an outside contributor can edit the instructions on their fork and then request a review with their own Copilot license. With it on, only people with a Copilot license from our org can request reviews. [Automatic reviews from the `main` ruleset still run](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#reviews-requested-with-an-external-copilot-license), so this doesn't affect Step 2.1, and it doesn't stop a ruleset review from reading a fork's edited instructions. The `CODEOWNERS` entries and the approval-glob exclusions are the main guard.

These guards stop a tampered review from approving a pull request, but not from shaping what Copilot says. A fork that rewrites the instructions can still get a review that calls a risky change safe, and that comment can sway the human who reviews it. We should have the Step 4.2 labeler add a `review-instructions-changed` label and a comment whenever a pull request touches the instruction, skill, prompt, or `AGENTS.md` paths, telling the human reviewer to set Copilot's review aside and read the change themselves.

## Alternatives considered

### Require a fixed `build-gate` instead of the individual build jobs

We could fix `build-gate` and require it instead of the individual jobs. The fix would add `if: ${{ !cancelled() }}` so the gate runs when a job it needs fails, plus a step, before the artifact upload, that fails the gate unless every needed job succeeded.

Advantages:

- The ruleset lists one check, so renaming, adding, or resharding a build job needs no ruleset change.
- Adding the plugin build jobs to the gate's `needs` would close the plugin build gap.

Disadvantages:

- It changes a job that `publish.yml` and `release.yml` depend on. A mistake in the new condition could let a release go out after a failed build, or quietly let broken pull requests merge.
- Adding the plugin build jobs to `needs` would let one broken plugin block every plugin's release. `publish.yml` deliberately keeps plugins independent of each other.

We chose to require the jobs directly because it leaves the release path untouched. If ruleset upkeep becomes a burden, we can add a separate `pr-gate` job for merges and leave `build-gate` for releases.
