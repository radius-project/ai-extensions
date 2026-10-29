# Adopting layered, AI-assisted code review in ai-extensions

This document explores what practices we can adopt for AI assisted code review in ai-extensions. These practices are inspired by [Solving code review at Anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/) and the latest

## Summary

Not every change needs a human reviewer. A pull request from a trusted contributor (a member of the maintainers or approvers team) can merge without human approval if it passes every required check and is clearly low risk, such as a docs-only or tests-only change.

Every other pull request still needs a human reviewer. For those, automation should point out the riskiest parts of the diff, so the reviewer can start there instead of reading the whole change.

## Current Status

We already run several review checks, some AI-assisted and some ordinary CI:

- [`code-review.prompt.md`](https://github.com/radius-project/ai-extensions/blob/main/.github/prompts/code-review.prompt.md): a detailed review prompt. It runs only when someone invokes it by hand.
- [`radius-code-quality`](https://github.com/radius-project/ai-extensions/blob/main/.github/skills/radius-code-quality/SKILL.md): a skill that people or agents run while making a change. [`code-quality.instructions.md`](https://github.com/radius-project/ai-extensions/blob/main/.github/instructions/code-quality.instructions.md) points agents to it for TypeScript and JavaScript files. Nothing runs the skill automatically. Copilot agents usually load it when they edit those files, and Copilot code review may load it, but the model decides each time.
- [Copilot code review](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review): the [main ruleset](https://github.com/radius-project/ai-extensions/rules/18178381) requests it when a non-draft pull request is opened on our GitHub repo. It reads `code-quality.instructions.md` for TypeScript files.
- [`build-gate`](https://github.com/radius-project/ai-extensions/blob/main/.github/workflows/build.yml#L268): runs in CI but doesn't block merge.
- [`dependency-review.yml`](https://github.com/radius-project/ai-extensions/blob/main/.github/workflows/dependency-review.yml): runs in CI but doesn't block merge.

These checks don't currently work together:

- Copilot code review reviewsonly the first version of a pull request. Later pushes get a review only if someone manually triggers a re-review.
- Copilot never sees the code-review prompt, which is our most detailed list of what to look for.
- Only `DCO` and `Visual comparisons` block merge, so a broken build or a vulnerable dependency can still merge.

Every change also faces the same approval bar. A one-word docs fix needs the same human review as a risky change to shared code.

## How do we improve our process?

We want reviews to move faster without getting careless. That means five changes:

- **Build trust in our automated checks.** They should catch regressions, security issues, and broken builds at three points: before a pull request opens, when it opens, and on every later push.
- **Classify each change's risk automatically.** Base the tier on which paths a change touches. A docs fix or a new test file is low risk; a change to `packages/core` or to the workflow generators is higher risk.
- **Show human reviewers where to look.** When a pull request needs a human, automation should flag its riskiest parts so the reviewer starts there.
- **Define trusted contributors.** Only members of the maintainers and approvers teams can merge low-risk changes on automated approval. Everyone else's pull requests always get human review.
- **Expect to revise this.** We won't get it right the first time, and the models and tools keep changing, so we'll keep adjusting the process.

## Phase 1: Building confidence in our automated tools

### Step 1.1: Add `.github/copilot-instructions.md`

We need to give Copilot context about our repo that it automatically loads with every session.
In [Anthropic's process](https://claude.dev/blog/solving-code-review-at-anthropic/), this kind of project context file (`CLAUDE.md`) is the base every other review layer builds on. Our version of this file is `copilot-instructions.md`.

The content of `copilot-instructions.md` should include:

- **Repo Layout:** it's a pnpm monorepo. `packages/core` stays free of UI code, and `packages/adapter-canvas` owns the Copilot and webview wiring.
- **Generated file rules:** `.artifacts/` is generated. Never edit it by hand.
- **Verification instructions:** link to the commands in the `radius-code-quality` [verification section](https://github.com/radius-project/ai-extensions/blob/main/.github/skills/radius-code-quality/SKILL.md#verification). Don't copy them, so the two lists can't drift apart.
- **Links to more information:** link to `CONTRIBUTING.md`, the skills, and `docs/architecture/`.

### Step 1.2: Give Copilot code review the same review rules that we use for manual review

Our most detailed review guidance lives in `code-review.prompt.md`. Currently, the Copilot reviewer (the one that runs on pull requests) never reads or runs it.  We need to move it where Copilot will find it and use it with every review.

First, we need to move the content within `code-review.prompt.md` to a new skill at **`.github/skills/radius-code-review/SKILL.md`**. We will keep `code-review.prompt.md` for local reviews, but have it point to the skill.

Next, we should create **`.github/instructions/code-review.instructions.md`** to hold the high-level rules for every review. The file should:

- Tell Copilot to apply the `radius-code-review` skill to every pull request. Copilot code review loads skills only when it judges them relevant, but it reads this file on every review, so the pointer makes the skill far more likely to be used. GitHub doesn't document whether an instruction can force a skill to load, so check one pull request's review to confirm it did.
- Skip `.artifacts/**`, `pnpm-lock.yaml`, `plugins/**` outside release branches, and visual baseline images.
- End with a summary comment that counts findings and says plainly when there's nothing to fix.
- In that summary, list the two or three changes a human reviewer should read first and say why each one is risky (for example, a new shell command, a changed security check, or a public API change).

### Step 1.3: Add a pre-PR self-review skill

We need agents to review their own work before they open a pull request. Anthropic now catches most problems at this stage, and it found that giving an agent a check it can run improves its output more than anything else. `radius-code-quality` already asks agents for test evidence, but nothing checks their work with fresh eyes. An agent reviewing its own work in the same session tends to agree with itself; a separate reviewer that sees only the diff and the rules doesn't.

We should add a `radius-pre-pr-review` skill at `.github/skills/radius-pre-pr-review/SKILL.md`. The skill should have the agent:

1. Run the commands in the `radius-code-quality` [verification section](https://github.com/radius-project/ai-extensions/blob/main/.github/skills/radius-code-quality/SKILL.md#verification) and paste their output.
2. Hand the diff to a `code-review` subagent with fresh context, which reviews it against the rules and skill from Step 1.2.
3. Make a second pass to remove dead code, unnecessary helpers, and edits outside the task.
4. Run the visual baseline check if the change touches the canvas.

We should link to the skill from the "Before you open a pull request" section of `CONTRIBUTING.md` and from `copilot-instructions.md`.

Copilot CLI's built-in `code-review` agent or `/review` command can act as the fresh-context reviewer. For a second opinion from other models, authors can run it on [Copilot Fusion](https://docs.github.com/en/copilot/concepts/models/copilot-fusion) High or Max, where several models critique the draft in parallel.

### Step 1.4 (optional): Format code as agents write it

We need formatting problems fixed before they reach review. Formatting comments take a reviewer's attention, and each one usually costs another push and another review round. Anthropic doesn't post style-only findings at all.

Copilot CLI and the Copilot coding agent can run hooks at fixed points in a session. We can add a hook that runs Prettier and ESLint with `--fix` on every file an agent edits.

This step is optional because CI lint already catches the same problems. The hook just catches them sooner.

### Step 1.5 (optional): Check whether Copilot Memory is on

We need to know whether Copilot code review can remember facts about our repo. Some facts only come up during review, such as a file that looks hand-written but is generated. Without memory, someone corrects the same mistaken comment on pull request after pull request, or we keep growing the instructions file that every review loads.

[Copilot Memory](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#copilot-memory) lets Copilot code review learn repo facts, such as "`.artifacts/` is generated," and use them in later reviews. We will:

- Check whether Copilot Memory is on for ai-extensions.
- Find out who can see and correct what it stores. A wrong fact would quietly steer every later review, so someone needs to be able to audit it.

## Phase 2: Copilot code review on every push

### Step 2.1: Have Copilot re-review new pushes

We need Copilot to review every push on a "ready for review" pull request, not just the first version of a pull request. An author or agent who pushes a fix after the first review can introduce a new bug. Unless we manually request a re-review from copilot, we are solely dependent on a human to catch the new bug in manualy review.

We should update the Copilot code review rule in the `main` ruleset:

- Turn on "Review new pushes."
- Set the default effort level to Balanced and the maximum to Max, so authors can request a Max review of a risky change by hand.
- Leave Copilot approvals off for now. Later we will set the rules on when to turn them on.

Copilot code review is billed in AI credits, to the pull request author by default. A Balanced review costs about $1.50, so reviewing every push multiplies that by the number of pushes. Re-reviews also keep the last effort level chosen, so once someone requests Max, every later push costs about $10.

The ruleset only reviews pull requests [created by people with access to Copilot](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#automatic-pull-request-reviews). An outside contributor without a Copilot license gets no automatic review, so a maintainer needs to request one by hand (billed to that maintainer). The org can extend automatic reviews to members without a license by turning on "Allow members without a Copilot license to use Copilot code review," with the cost billed to the org, but that setting doesn't cover non-members.

### Step 2.2: Keep every finding answered

Our `main` ruleset already requires every review thread to be resolved before merge. We should keep that rule.

### Step 2.3: Add review-convergence rules

We need reviews (and re-reviews) to converge, rather than continue in an endless loop. One of Anthropic's pull requests went through more than fifty rounds of review and fixes overnight. When they traced what the reviewer kept flagging, 59% of it was code present at the first review: the reviewer was handing out old findings a few at a time instead of catching new bugs.

We should add three rules to `code-review.instructions.md`:

- When you find a bug, name its class and list every instance, not just the first one.
- Never repeat a finding already posted.
- After three loops of automated review, stop and request attention from the pull request author.

## Phase 3: Blocking security review

### Step 3.1: Turn on CodeQL and Copilot Autofix

We need a security reviewer that can block merge. Our review prompt already lists the risks that matter most here: shell strings built from interpolated values, unescaped webview HTML, unpinned actions, and secrets passed as inputs. Today nothing blocks merge on them.

CodeQL catches several of these risks on every run, and its Actions queries flag the same workflow problems a linter like zizmor would (injection in `run:` steps, unpinned actions, risky triggers). Copilot Autofix can automatically propose patches for CodeQL findings.

We should:

- Enable CodeQL code scanning for JavaScript and TypeScript, and for GitHub Actions.
- Turn on Copilot Autofix.
- Add a rule to the `main` ruleset that blocks merge on any new high or critical alert.

### Step 3.2: Fix `build-gate` so it fails when a job fails

`build-gate` is the last shared job in [`build.yml`](../../.github/workflows/build.yml). It waits on `static-checks`, `windows-process-integration`, `canvas-chromium`, and `node-tests`. When all four pass, it uploads a small `build-gate` artifact. `publish.yml` and `release.yml` download that artifact before they publish a plugin, so a missing artifact stops a release.

We need `build-gate` to fail whenever a job it depends on fails. Today it doesn't. By default, a GitHub Actions job runs only if every job in its `needs` list succeeded. If one of them fails, GitHub marks the dependent job as skipped rather than failed. So when `node-tests` fails, `build-gate` shows up as skipped.

That's fine for releases, because a skipped `build-gate` never uploads its artifact and the release stops. It's a problem for merge, because GitHub treats a skipped required check as passing. If we required `build-gate` as it stands, a pull request with failing tests would show a skipped gate, and the ruleset would let it merge.

We should update `build-gate` in `build.yml`:

- Add `if: always()` so the gate always runs.
- Fail the gate unless every job in its `needs` succeeded.
- Add the plugin build and artifact jobs to its `needs`.

### Step 3.3: Make Dependency Review and `build-gate` required checks

We need failing builds and vulnerable dependencies to block merge. Today the Dependency Review job and `build-gate` both report failures, but neither is required, so a pull request that adds a vulnerable package or breaks the build can still merge.

After Step 3.2, we should add both as required status checks in the `main` ruleset. Once `build-gate` is required, the 100% coverage thresholds already in `vitest.config.ts` block merges too.

## Phase 4: Scale human approval to risk

### Step 4.1: Write down risk tiers

Write a short `docs/eng/REVIEW_POLICY.md` that assigns each change a tier by what it touches, not by who wrote it.

| Tier | Examples in this repo | Human approvals |
| --- | --- | --- |
| Low | Docs, copy, tests only, changesets, visual baseline updates | Copilot approval for trusted authors |
| Medium | Ordinary changes to `packages/core` and `packages/adapter-canvas` | One |
| High | `.github/workflows/**`, `.github/extension/**`, workflow-YAML generators in `packages/core/src/platforms` and `src/workflows`, release and publish paths | Two, including a maintainer |

The high tier also calls for a Max level code review from copilot - which the author or directing human would need to request by hand. (Copilot picks the effort level per repository, not per path, and we should keep the default effort set on Balanced).

### Step 4.2: Label pull requests by tier automatically

Add a workflow that uses `actions/labeler` to apply `risk:low`, `risk:medium`, or `risk:high` from the changed paths and posts how many approvals the pull request needs.

### Step 4.3: Enforce the high tier through CODEOWNERS

Propose a section of sensitive paths in the synced `CODEOWNERS` template in `radius-project/.github`, and require two approvals for the high tier on ai-extensions.

### Step 4.4: Point human reviewers at the riskiest changes

We need human reviewers on medium- and high-tier pull requests to start with the parts most likely to hide a bug. A reviewer who reads a large diff from top to bottom spends the same attention on a renamed variable as on a changed workflow permission. Automation already knows which paths are sensitive and which changes Copilot found risky, so it should tell the reviewer where to look.

We should:

- Extend the labeling workflow from Step 4.2 so that its comment also lists every changed file that matches a high-tier path. This list comes from the paths alone, so it's the same every time.
- Rely on Copilot's summary comment (Step 1.2) for the judgment calls: the changes it thinks are riskiest and why.

### Step 4.5: Let Copilot approve low-tier changes, after a trial

[Copilot approvals](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#copilot-approvals) became generally available on October 28, 2026. An admin can list up to 15 path globs, and Copilot may approve a pull request only when every changed file matches one of them and its review finds nothing blocking.

Roll it out in four steps:

- **Trial.** For at least four weeks and at least 30 low-tier pull requests, leave approvals off and record each pull request's approval assessment next to the human decision on the same commit. Count a false approval (Copilot would approve; the human asked for a real fix) separately from Copilot being stricter than the human. Turn approvals on only if there are no false approvals. If there are false approvals, update the code review instructions/skills, then run a new trial.
- **Allow-list.** Use the low tier's paths as the globs. Never include `.github/**`, any `AGENTS.md` or `copilot-instructions.md`, or any glob that overlaps a high-tier path.
- **Code owners.** The synced `CODEOWNERS` assigns every path (`*`) to our teams, and the ruleset requires a code-owner review. GitHub does not document whether a Copilot approval satisfies that rule. Test it on a scratch repository first. If it does not, propose upstream `CODEOWNERS` entries with no owners for the low-tier paths.
- **Trusted authors.** Copilot approvals do not check who wrote the change. Add a required status check that passes when the pull request has a human approval of the current commit, or when its author is a member of the maintainers or approvers teams. An agent's pull request counts as trusted only when the check can confirm from GitHub's own records, not the template, that a team member started the agent. Outside contributions therefore still need a human, and the check fails when it cannot tell.

### Step 4.6: Guard review instructions against fork pull requests

Copilot code review reads instructions and skills from the pull request's head branch, including `AGENTS.md` files anywhere in the tree. A fork can therefore rewrite `code-review.instructions.md` in the same pull request it wants approved. These steps keep such a pull request from earning a Copilot approval:

- Keep `.github/**` and every `AGENTS.md` out of the approval globs (Step 4.5).
- Propose upstream `CODEOWNERS` entries for `.github/instructions/**`, `.github/skills/**`, `.github/prompts/**`, `.github/copilot-instructions.md`, and `**/AGENTS.md`, so changes to the reviewer's rules need a maintainer.
- Turn on "Only allow Copilot code review to be triggered by authorized users." Without it, an outside contributor can edit the instructions on their fork and then request a review with their own Copilot license. With it on, only people with a Copilot license from our org can request reviews. [Automatic reviews from the `main` ruleset still run](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#reviews-requested-with-an-external-copilot-license), so this doesn't affect Step 2.1, and it doesn't stop a ruleset review from reading a fork's edited instructions. The `CODEOWNERS` entries and approval-glob exclusions above are the main guard.

## What we are not adopting yet

We will not let any change merge without a human approval until Step 4.5's trial and its other conditions are met. After the trial  (if it goes well), only low risk changes from trusted authors may merge on a Copilot approval.

We will not build multi-agent voting on findings. Anthropic has several agents confirm each finding before it posts. Copilot's Max effort level already runs several review agents and reconciles their findings, so we will try Max on high-tier changes before building anything of our own.

We will not add circuit breakers that tighten approval when reverts rise. Anthropic itself lists them as future work. They become a goal once we have stable baseline numbers for reverts.
