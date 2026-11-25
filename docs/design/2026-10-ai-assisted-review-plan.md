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
- [`build.yml`](https://github.com/radius-project/ai-extensions/blob/main/.github/workflows/build.yml): the required `CI gate` waits for builds, tests, coverage, Windows, Chromium, and every discovered plugin build to succeed.
- [`dependency-review.yml`](https://github.com/radius-project/ai-extensions/blob/main/.github/workflows/dependency-review.yml): `dependency-review / dependency-review` is required. The workflow is synced from `radius-project/.github`, so policy changes belong upstream.

The majority of these checks don't work together:

- Copilot reviews only the first version of a pull request. A later push gets a review only if someone asks for one.
- Copilot never sees `code-review.prompt.md`, our most detailed list of what to look for.
- Build and Dependency Review failures already block normal merges, alongside the other checks listed in [CONTRIBUTING.md](../../CONTRIBUTING.md#required-merge-checks). CodeQL scanning and its separate severity rule still need the Phase 3 rollout and acceptance evidence below.

Every change also faces the same approval bar. A one-word docs fix needs the same human review as a risky change to shared code.

## Proposal

The next enforcement stage, **Stage 5**, requires a human approval from `radius-project/approvers-ai-extensions` for every pull request targeting the protected default branch. Use GitHub's native required-team reviewer rule first, subject to the qualification and activation gates in [Step 4.3](#step-43-require-native-approvers-team-human-approval). Repository preparation does not activate that rule.

Allowing low-risk changes from trusted contributors to merge on Copilot approval remains a later proposal, not a Stage 5 exception. Defer its App/evaluator, trusted-author and agent-origin checks, approval globs, and Copilot approval credit. Automation should point human reviewers to the riskiest parts of each diff without deciding who may approve.

We can do this work in four phases:

1. [Phase 1: Building confidence in our automated tools](#phase-1-building-confidence-in-our-automated-tools)
2. [Phase 2: Copilot code review on every push](#phase-2-copilot-code-review-on-every-push)
3. [Phase 3: Blocking security and build checks](#phase-3-blocking-security-and-build-checks)
4. [Phase 4: Scaling human approval to risk](#phase-4-scale-human-approval-to-risk)

## Objectives

### Goals

We want reviews to move faster without getting careless. To get there, we must:

- **Build trust in our automated checks.** They should catch regressions, security bugs, and broken builds at three points: before a pull request opens, when it opens, and on every later push.
- **Classify each change's risk automatically.** The paths a change touches set its tier. A docs fix or a new unit test is low risk; a change to `packages/core` or to the workflow generators is higher.
- **Show human reviewers where to look.** When a pull request needs a human, automation should flag its riskiest parts so the reviewer starts there.
- **Keep approval authority explicit.** Stage 5 requires an approvers-team human regardless of author, tier, or labels. Any later trusted-author exception needs a separate design and rollout.
- **Expect to revise this.** We won't get it right the first time and will need to revise as the tools and models available to us change.

### Non-goals

Stage 5 does not enable Copilot approval credit or implement a custom approval service, App-owned check, workflow relay, or observation publisher. Steps 4.5–4.7 describe deferred work: their trial and enforcement conditions, plus separate authorization, must be satisfied before any change may merge without a human approval. A later design must resolve how a Low exception interacts with the blanket team requirement; do not weaken that requirement now for a hypothetical exception.

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

Merging this proposal changes no settings or approval rules. Before enabling reviews on every push, we must verify Stage 1 in GitHub, agree what to check instead of the unsupported summary format, and obtain separate approval for the rollout.

#### Step 2.1: Have Copilot re-review new pushes

We need Copilot to review every push to a pull request that is ready for review, not just its first version. A fix pushed after the first review can bring a new bug, and today only a human reviewer stands between that bug and `main` unless someone manually asks Copilot to look again.

We should change two sets of settings:

- In the `main` ruleset, turn on "Review new pushes."
- In the repository's Copilot code review settings, set the default effort level to Balanced and the maximum to Max, so authors can request a Max review of a risky change by hand. Leave Copilot approvals off for now; Step 4.5 sets the conditions for turning them on.

Leave draft reviews off in the repository rule. Personal or organization settings can still trigger them. Keep all existing merge requirements, including human approvals, required checks, and thread resolution.

Reviews use AI credits and may also incur Actions charges. GitHub's [published costs](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#estimated-consumption) are estimates, not fixed prices or spending caps.

GitHub chooses effort in this order: an explicit request, the previous review's effort, the requester's preference, the repository default, then the organization default. After a Max review, later automatic reviews can therefore use Max despite the repository's Balanced default. Max is in preview. Check that it is available under our policies and confirm the effort each completed review reports.

Automatic reviews usually charge the author; manual reviews usually charge the requester. Organization policies and bot billing rules can change who pays. Organization members without individual licenses [may qualify](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#copilot-code-review-without-a-copilot-license) when the required policies are enabled; outside contributors do not necessarily qualify. If the author lacks access, a maintainer with access can request the review once spending is authorized. If nobody can request it, continue with human review and leave merge requirements unchanged.

#### Step 2.2: Keep every finding answered

Our `main` ruleset already requires every review thread to be resolved before merge. We should keep that rule.

#### Step 2.3: Add review-convergence rules

We need reviews to converge instead of looping forever. One of Anthropic's pull requests went through more than fifty rounds of review and fixes overnight. When the team traced what the reviewer kept flagging, 59% of it was code present at the first review: the reviewer was handing out old findings a few at a time instead of catching new bugs.

Keep these rules in `radius-code-review`; `code-review.instructions.md` links to the skill:

- When you find a bug, name its class and list every instance, not just the first.
- Read prior findings and avoid duplicates. GitHub warns that resolved findings can still recur.
- After three completed automated review rounds, hand unresolved findings to the author. The author stops every agent or automation that applies fixes or pushes commits, then decides what to do next. The skill cannot make GitHub stop reviewing.

If reviews keep running unexpectedly, an admin authorized to roll back can restore the push-review and effort settings changed by this rollout. Keep merge protections intact. Personal or organization triggers can still start reviews, and queued or running reviews may continue. This stage adds no automation to enforce a round limit.

### Phase 3: Blocking security and build checks

Add CodeQL scanning, then require successful analysis and block new high/critical findings. Keep the existing build, dependency, release, and human-review protections.

**Adding the workflow does not change merge rules.** Scanning, merge enforcement, and Autofix each need their own evidence and authorization.

#### Step 3.1: Turn on CodeQL and Copilot Autofix

##### Run both language analyses

The [advanced CodeQL workflow](../../.github/workflows/codeql.yml) runs `security-extended` for `javascript-typescript` and `actions`. Each language gets its own matrix job. `fail-fast: false` lets both finish even if one fails.

It runs on every pull request, including stacks and documentation-only changes, pushes to `main`, a weekly schedule, and authorized manual recovery runs. No path, author, or draft filters skip PR analysis.

The workflow keeps execution narrow:

- Pin actions to reviewed full commit SHAs. `tools: linked` uses the CodeQL bundle tied to that action release.
- Check out the normal PR merge ref with `persist-credentials: false`.
- Start with root `permissions: {}`. Grant the analysis job only `contents: read` and `security-events: write`.
- Do not install application dependencies, run application builds, or use cloud credentials, PATs, OIDC, or `pull_request_target`.

Uploads use separate categories, `/language:javascript-typescript` and `/language:actions`, so one language cannot replace the other's results. Initialization, extraction, analysis, and upload errors must fail the job.

##### Separate completion from findings

**A successful scan can still find a vulnerability.** We need two controls:

| Control                                                                                                               | What it establishes                                                                                                                                      |
|-----------------------------------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
| Required status: `CodeQL analysis gate`, bound to GitHub Actions                                                      | Both language analyses completed successfully. The gate runs with `always()` and rejects failed, cancelled, skipped, empty, missing, or unknown results. |
| Native `code_scanning` rule: tool `CodeQL`, security alerts **High or higher**, ordinary non-security alerts **None** | Relevant high/critical findings block merge, independently of scanner completion.                                                                        |

Add these requirements only after healthy default-branch and PR scans and an authorized rehearsal of enforcement and rollback in an isolated repository. Keep advanced setup as the only CodeQL configuration; do not also enable default setup.

Check the effective `main` ruleset and Code security settings to establish what is active. Source files describe the intended configuration, not proof of activation. The [acceptance sequence](#phase-3-acceptance-evidence) records the evidence.

##### Know what scanning does not cover

CodeQL recognizes supported query patterns, not every shell interpolation, HTML sink, secret flow, or workflow risk. Human review and existing tests still matter.

The selected action release, v4.39.3, links CodeQL bundle 2.27.4. Its [Actions extractor](https://github.com/github/codeql/blob/codeql-cli/v2.27.4/actions/extractor/tools/autobuild.sh) includes these paths by default:

- `.github/workflows/*.yml` and `.github/workflows/*.yaml`
- `.github/reusable_workflows/**/*.yml` and `.github/reusable_workflows/**/*.yaml`
- `**/action.yml`, `**/action.yaml`, and `**/actions.lock`

Composite action manifests under `.github/extension` can therefore be included. Arbitrarily named workflow templates there, and YAML embedded in TypeScript, are not automatically analyzed as executable workflows. Confirm actual extraction coverage from hosted results; zero alerts alone do not prove coverage.

Do not exclude source just to silence findings. Any proposed exclusion needs a reason, review, and evidence showing what it removes. Trigger filters decide when a scan runs; extraction filters decide what it reads. This workflow adds neither.

Three limits affect enforcement:

- **PR-diff scope.** GitHub's [native merge protection](https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection) applies only when all relevant alert locations are in the PR diff. It is not a ban on every existing vulnerability. Triage baseline alerts rather than silently dismissing them to enable the rule.
- **Action pinning.** `security-extended` includes [`actions/unpinned-tag`](https://codeql.github.com/codeql-query-help/actions/actions-unpinned-tag/) with security severity 5.0 and warning severity. The high/critical rule will not make it blocking. Keep the scoped pinning tests for shipped assets and specific workflows; a universal pinning gate remains deferred.
- **Contributor and queue behavior.** Native protection excludes merge-queue groups and Dependabot PRs analyzed by default setup. Advanced setup avoids the latter exception, but fork and Dependabot behavior still needs hosted evidence. We have no merge queue; adopting one needs a separate trigger and enforcement design.

##### Verify Autofix and authorize hosted work separately

Copilot Autofix can suggest fixes for supported queries, but it may be unavailable or produce no suggestion. Humans review and test any proposed fix. Autofix neither approves nor automatically applies changes, and a missing suggestion never clears an alert.

Verify its effective availability before any separately authorized setting change.

Publishing a PR with this workflow can immediately start CodeQL. Repository preparation alone does not authorize publication, hosted Actions usage, dispatches, live settings changes, or deliberate-failure experiments. Obtain the applicable authorization before each.

#### Step 3.2: Preserve Dependency Review, CI, and release gates

**The plugin-build gap is already closed.** The required `CI gate` runs with `always()` and passes only when every Build dependency succeeds: plugin discovery, static checks, Windows, both Chromium shards, tests/coverage/library candidates, the shared release gate, and every plugin build. The ruleset does not need a fixed list of plugins or shards.

Keep the required checks listed in [CONTRIBUTING.md](../../CONTRIBUTING.md#required-merge-checks), including Dependency Review, with their existing source bindings. GitHub Actions is integration `15368`; DCO is `974774`. Recheck those identities before an authorized rule edit. Dependency Review is synced upstream; do not edit its workflow locally.

Coverage thresholds come from [`vitest.config.ts`](../../vitest.config.ts) and [`coverage-baseline.json`](../../coverage-baseline.json), not a universal 100% rule. Required CI enforces those floors. The code-quality skill separately targets 100% meaningful coverage of changed production paths.

Leave `Shared release gate` and its `build-gate` artifact unchanged. Publish and release workflows consume that artifact. The PR completion gate does not replace it or couple independent plugin releases.

Preserve strict up-to-date checks, signatures, squash-only merges, human/code-owner/latest-push approvals, thread resolution, and bypasses. Stage 3 adds security requirements; it does not relax these protections.

##### Keep PR analyses current

Before requiring CodeQL, find open PRs without current analyses. Authors should update their branches normally so they contain the workflow and receive a `pull_request` run against the intended base and head.

Retargeting alone may not trigger a scan. A default-branch dispatch does not establish analysis of a PR's current revision.

##### Keep required checks connected to their producers

Never delete or rename a required check's producer first:

- **Withdraw scanning:** obtain authorization, remove the new status and native requirement, then delete the workflow.
- **Rename the completion check:** report both names, verify the new identity and successful runs, switch the required context, then remove the old name. Keep the native CodeQL rule if analysis continues unchanged.
- **Roll back:** compare current settings with the recorded prior values and restore only Stage 3-owned fields. Do not replace the whole ruleset or relax unrelated protections.

### Phase 4: Scale human approval to risk

#### Step 4.1: Write down risk tiers

Stage 4 repository preparation uses one executable path table in [`scripts/review-risk.mjs`](../../scripts/review-risk.mjs). Highest tier wins across the complete current-base diff, including deletions and both rename names. Low requires an explicit recognized documentation/image/test match; unknown and ordinary production paths are Medium. High overrides include instruction/policy controls, shipped skills, credentialed generation/publication boundaries, cloud suites, release/build entry points and imported inputs, dependency manifests, and executable verification configuration.

High overrides cover the shared-adapter deployment implementation family, including repository access, command bindings, and production/runtime composition, not only its Canvas wrappers. They also cover core credential redaction, cloud identity verification, authenticated discovery, credential-cache persistence, Canvas deployment routes/services and runtime/tool wiring, and the collocated tests for these boundaries. Cloud-loaded helpers outside `test/e2e-cloud` include the shared Canvas harness, discovery contract, and production/deployment runtime test factories.

**All tiers require one qualifying approvers-team human approval under the selected policy.** Step 4.3 prepares native enforcement; it is not yet activated. High additionally calls for a manually requested Max review, not a second human. The existing extra-approval rule for unattributed Copilot PRs remains a separate exception that can require two humans. Labels/comments are advisory and do not verify approval or membership. The eventual Low exception below remains deferred.

Each high-tier path is there for a specific reason:

- **Our workflows** in `.github/workflows/**` run in CI with write tokens and secrets, and they enforce our merge rules. One change can weaken a required check, pull in an unpinned action, or let a pull request title inject a shell command.
- **The workflows we ship to users** in `.github/extension/**` run in users' repositories. Several request `id-token: write` to get cloud credentials through OIDC, and some delete real AWS or Azure resources.
- **The generators** in `packages/core/src/platforms` and `packages/core/src/workflows` write that workflow YAML and build the OIDC subject that a user's cloud account checks before it hands out credentials. A subject that's too broad lets more workflows get those credentials. Reviewers read the generator, not the YAML it produces, so a risky change is easy to miss.
- **The cloud test suite** in `packages/adapter-canvas/test/e2e-cloud/**` runs from `cloud-e2e.yml` with an Azure identity and a GitHub App token, and it creates and deletes real Azure resources. That workflow runs only nightly and on manual dispatch, never on a pull request, to keep fork code away from those credentials. So a change to these tests or their `support/` helpers first runs with credentials after it merges, and no pull request check exercises it beforehand. Ordinary credential-free tests qualify only through the explicit Low rules and after High overrides; live tests do not inherit that exception.
- **The release scripts**, called by the plugin and library release workflows, decide what reaches users. Their imported discovery, artifact, build, vendor-style, and verified Git helpers are also High. A compromise there is a supply-chain attack, and a published version can't be cleanly taken back.

For all five examples above, passing tests don't show a change is safe. Tests check that the code does what we intended; the danger in these paths is what the code could also be made to do. A workflow that grants `contents: write` where `read` would do passes every test. So does a generator that writes a wider OIDC subject, if we update the expected output along with it. A shell step that interpolates a pull request title works fine until someone opens a pull request with a malicious title. And our pull request CI can't run the real thing: it has no cloud credentials and doesn't publish, so the deploy, delete, and release steps first run for real after merge. Only a reviewer who reads for least privilege, scope, and untrusted input can catch these.

The high tier also calls for a Max code review from Copilot, which the author or the human directing the agent must request by hand. Copilot sets the default effort level per repository, not per path, and we should keep that default at Balanced.

#### Step 4.2: Label pull requests by tier automatically

The [default-off advisory workflow](../../.github/workflows/review-risk.yml) uses one built-in-fetch classifier/reconciler, not `actions/labeler` plus duplicated rules. It incrementally maintains exactly one tier label, the independent instruction warning, and one bot-owned advisory comment. Unrelated `pr:*` signals remain untouched. Errors fail visibly and attempt safe unavailable-advisory cleanup rather than leaving a stale Low result unnoticed.

Repository preparation does not activate labels/comments or complete Phase 4. Activation and rollback remain separately gated: authorize publication/Actions usage and isolated testing first, inspect event-policy allowance, prove immutable protected default-branch execution for forks/stacks, verify endpoint permissions and coexistence, and separately authorize real-repository activation/read-back. `pull_request_target` has used default-branch workflow/ref semantics since December 8, 2025; the documented public-repository default event-policy block becomes enforced December 2, 2026 for affected repositories. Neither policy changes nor exceptions are authorized here.

The enabled variable is a startup snapshot. On rollback, disable the flag/workflow, cancel or drain admitted writers, verify termination and read back state, then clean up only owned advisory state. Do not rely on queue FIFO, bot-write follow-up events, or mid-run flag revocation.

Base-only pushes do not trigger reconciliation. If a base update changes an open PR's diff, an authorized operator must manually reconcile that PR from the default workflow ref. Preparation failures attempt unavailable-advisory cleanup only against a verified stable PR; mutation failures and changed snapshots instead report attempted writes and residual state, which may still contain stale labels or comments. Inspect that evidence and the current PR before an authorized stable rerun.

Failure of the final pre-write snapshot read still permits preparation cleanup if a subsequent read verifies the original snapshot. A successfully read but changed snapshot does not. Recovery evidence remains readable JSON in an indented code block; invisible controls are encoded as JSON Unicode escapes rather than HTML entities. Pagination accepts the repository's verified numeric-ID links as well as its owner/name links, while rejecting foreign repositories, endpoints, origins, and malformed page queries.

#### Step 4.3: Require native approvers-team human approval

Stage 5 uses [GitHub's native required reviewers](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#required-reviewers), separately from CODEOWNERS and risk labels. Human authority means active membership in `radius-project/approvers-ai-extensions`, not trusted authorship or generic repository access. Maintainers-only, on-call-only, and temporary-write-access approval cannot satisfy this policy alone, including for dependency PRs.

Read-only inspection on November 13, 2026 found repository ruleset `18178381` active on `~DEFAULT_BRANCH`, with `required_reviewers: []`. Team `18223393` (`approvers-ai-extensions`) has repository write permission, which GitHub requires for team approvals. Prepare one required-reviewer entry with one approval from that team and candidate file pattern `**`, with no exclusions. The [REST schema](https://docs.github.com/en/rest/repos/rules#update-a-repository-ruleset) defines `file_patterns`, `minimum_approvals`, and `reviewer` (`id` and `type: Team`). This is a proposed configuration, not evidence that the pattern covers every changed path or that native authorization meets all cases below.

The current synced CODEOWNERS already lists the approvers team on the catch-all and every exception. Do not edit it downstream or propose an upstream rewrite for this human-only stage. One ordinary, non-author approvers-team review should satisfy the team requirement, native approval count, and CODEOWNERS together, subject to the retained latest-push rules. Prove this in isolation rather than adding another human requirement for High.

Preserve all existing protections: one ordinary approval, code-owner review, stale-review dismissal, latest-push approval, resolved threads, squash-only merges, signatures, deletion/non-fast-forward/linear-history rules, and the seven strict status contexts with their integration IDs. Keep `require_extra_approval_for_unattributed_changes` enabled: an unattributed Copilot PR can still need two human approvals, at least one from the approvers team. Existing organization-admin (`always`) and repository-admin (`pull_request`) bypasses remain exceptions; admin success cannot prove ordinary-user enforcement.

Native review validity is diff/push-based, **not exact-head-SHA matching**. A diff-changing push or merge-base update can invalidate an approval; a head change GitHub considers non-invalidating may retain it. Qualify stale-diff dismissal and approval by someone other than the latest reviewable pusher, including when an approver pushed the change.

##### Qualify before activation

Obtain separate authorization naming the isolated organization repository, team mapping, non-bypass identities, allowed settings changes, reviews/merge attempts, cleanup, and evidence storage. A personal repository cannot qualify an organization-team rule. Use actual GitHub rule evaluation and expressly authorized controlled merge attempts, not a local matcher, green workflow, or screenshot alone. Record each case's immutable ID, PR/head/base, rules snapshot, team state, actor/bypass status, expected result, and observed evidence.

- **Ordinary authority:** one qualifying human suffices for representative Low, Medium, and High PRs with other requirements satisfied. No approval, author self-review, bot/Copilot-only review, trusted authorship, maintainer-only or on-call-only review, labels, review text, and `author_association` cannot substitute.
- **Blanket path coverage:** prove root/nested files, dotfiles, `.github/**`, agent instructions, ordinary/credentialed tests, unknown paths, deletions, and renames into and out of sensitive paths. Do not equate `**` with the advisory regex classifier or assume documentation proves coverage.
- **Review lifecycle:** exercise diff-changing pushes, update-branch/merge-base changes, dismissed approvals, later changes requested, valid reapproval, and no-diff head changes. Record when native approval remains valid and prove the ordinary one-human latest-push case.
- **Revoked authority:** remove an approving member while leaving their review intact; prove authority no longer counts at merge time. Re-add them and observe reapproval requirements. Also test team write-access removal, team rename/deletion, organization-membership removal, pending invitations, and inherited/nested membership where supported. Permission failure must not silently disable the rule.
- **PR isolation:** PRs sharing a head SHA cannot borrow approval, including a new PR opened after another was approved and different/retargeted bases. GitHub's generic same-head pending/rejected-review guard is not sufficient proof of approval-authority isolation.
- **PR variants and exceptions:** cover same-repository/fork PRs, drafts, reopened PRs, stacked-base retargets, the retained unattributed-Copilot extra approval, and configured bypass actors. Only matching protected branch targets are covered, not every feature branch.
- **Failure and rollback:** prove rule read-back and permission/unavailability failures do not relax authority, and rehearse rollback. There is no custom publisher to fail, but native merge-time authorization still needs proof.

Membership revocation, stale/latest-push behavior, path coverage, and same-commit PR isolation remain unproven. Do not accept a polling-delay window for revoked authority, invalidated reviews, or borrowed approval. If native behavior or available evidence cannot establish the contract, **stop before activation** and obtain a new design decision; do not automatically resurrect an App.

##### Authorize, activate, and roll back narrowly

Repository preparation, isolated authorization, qualification, production authorization, activation/read-back, and rollback rehearsal are separate milestones. Merging this document completes none of the operational milestones. Operational owners are @nicolejms (primary admin) and @nellshamrell (backup admin and implementation/tracker lead); verify current ownership and access before acting.

After isolated qualification passes, obtain explicit authorization for the exact production entry. Immediately re-read current rules, inherited protections, team identity/write permission, CODEOWNERS, and native Copilot approval settings. Keep approval credit off; a mismatch is a blocker, not permission to change another setting. Preserve concurrent changes and obtain approval for unexpected scope rather than overwriting an old snapshot. Change only the required-reviewer entry, then compare effective read-back with the pre-write snapshot and record the activation SHA/time, rules evidence, responsible admin, and approved production positive/negative cases using non-bypass identities. Never merge a failing production fixture.

Rehearse removal of only the new entry in isolation. Removing it restores the **weaker baseline**, where maintainers/on-call may satisfy existing review rules alone; it does not preserve approvers-only authority. A production rollback needs explicit admin authorization. If authority must remain enforced, separately authorize and verify a technical merge pause before removal; a requested human pause is not a technical block. Preserve other protections/bypasses, leave Copilot credit off, and record residual risks without broadening bypasses.

This stage adds no App, evaluator/check, relay, service, secrets, workflow dispatch, cloud resource, or upstream CODEOWNERS change. It does not establish Stage 2 push-review activation, Stage 3 CodeQL enforcement, Stage 4 advisory activation, or Copilot credit behavior. The inspected rules still have `review_on_push: false` and no native CodeQL rule or required CodeQL completion context; the other operational states have not been verified.

#### Step 4.4: Point human reviewers at the riskiest changes

We need human reviewers on medium- and high-tier pull requests to start with the parts most likely to hide a bug. A reviewer who reads a large diff top to bottom spends the same attention on a renamed variable as on a changed workflow permission. Automation already knows which paths are sensitive and which changes Copilot found risky, so it should tell the reviewer where to look.

We should:

- Extend the labeling workflow from Step 4.2 so its comment also lists every changed file that matches a high-tier path. The list comes from the paths alone, so it's the same every time.
- Rely on Copilot's summary comment (Step 1.2) for the judgment calls: the changes it thinks are riskiest, and why.

#### Step 4.5: Let Copilot approve low-tier changes, after a trial

**Deferred beyond Stage 5.** The following describes later Copilot-credit work, not permission to enable it. The blanket required-team rule remains in place unless a separately approved design proves a safe native exception.

[Copilot approvals](https://docs.github.com/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#copilot-approvals) became generally available on October 28, 2026. A repository admin can turn them on under [Settings > Copilot > Code review](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review#customizing-copilot-code-review-1), which has three Auto-approval settings:

- **Allow Copilot to approve pull requests** lets Copilot submit an approving review.
- **Allow Copilot approvals to count toward merge requirements** lets that approval satisfy the ruleset's required approval, the same way a teammate's would.
- **File paths** optionally limits which pull requests that applies to. The admin enters up to 15 file globs, one per line, such as `docs/**` or `.changeset/**`. Copilot's approval counts toward merge only when every changed file in the pull request matches at least one glob. If the list is blank, it counts for every file. A glob can only add paths, not exclude them, so each one must avoid matching any high-tier path.

For example, the globs `docs/**` and `**/*.md` would match `docs/setup.md` and `README.md`, but not `packages/core/src/index.ts`. Matching globs alone would not satisfy the blanket team requirement, CODEOWNERS, author eligibility, or the later rollout gates.

The globs don't change which pull requests Copilot reviews. The `main` ruleset still requests a review on every non-draft pull request, and every review still includes Copilot's approval assessment in its summary comment. A new push dismisses Copilot's approval.

We should roll this plan out in four parts:

- **Trial.** For at least four weeks and at least 30 low-tier pull requests, **leave approvals off and record Copilot's approval assessment for each pull request next to the human decision on the same commit**. Count any false approvals (where Copilot would approve, but a human asks for a real fix). Turn approvals on only if there are no false approvals in the trial period. If there are false approvals, update the review instructions and skills, then run a new trial.
- **Allow-list.** Use the low tier's paths as the globs. Never include `.github/**`, any `AGENTS.md` or `copilot-instructions.md`, or any glob that overlaps a high-tier path. That rules out broad test globs such as `**/*.test.ts`, which would match the `*.test.ts` files under `packages/adapter-canvas/test/e2e-cloud/`; list the low-tier test folders by name instead.
- **Native requirements.** A later design must qualify Copilot behavior against both CODEOWNERS and the blanket team requirement. No ownerless Low entries or upstream CODEOWNERS rewrite is authorized here.
- **Trusted authors.** Later eligibility must establish trusted authorship, agent origin from GitHub records, and review validity, and fail closed when unknown. Trusted authorship alone never satisfies Stage 5. Defer the App/evaluator and check architecture; it must address stale SHA-scoped success and per-PR authority isolation rather than assuming a required check solves them.

#### Step 4.6: Guard review instructions against fork pull requests

The advisory instruction warning is part of Stage 4 preparation. Approval-credit guards below are deferred with Step 4.5; they do not replace Stage 5 human authority.

Copilot code review reads instructions and skills from the pull request's head branch, including `AGENTS.md` files anywhere in the tree. A fork can therefore rewrite `code-review.instructions.md` in the same pull request it wants approved. These changes keep such a pull request from earning a Copilot approval:

- Keep `.github/**` and every `AGENTS.md` out of the approval globs (Step 4.5).
- Keep review-policy and instruction changes under approvers-team human authority. Existing CODEOWNERS already includes approvers; no upstream rewrite is needed for Stage 5.
- Turn on "Only allow Copilot code review to be triggered by authorized users." Without it, an outside contributor can edit the instructions on their fork and then request a review with their own Copilot license. With it on, only people with a Copilot license from our org can request reviews. [Automatic reviews from the `main` ruleset still run](https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/code-review#reviews-requested-with-an-external-copilot-license), so this doesn't affect Step 2.1, and it doesn't stop a ruleset review from reading a fork's edited instructions. The `CODEOWNERS` entries and the approval-glob exclusions are the main guard.

The later guards need qualification before Copilot receives approval credit. They cannot stop a tampered review from shaping what Copilot says. A fork that rewrites the instructions can still get a review that calls a risky change safe, and that comment can sway the human who reviews it. The Step 4.2 advisory preparation includes a `review-instructions-changed` label and warning for instruction changes; its operational activation remains separate.

#### Step 4.7: Suspend Copilot approvals when one goes wrong

**Deferred beyond Stage 5.** Approval credit stays off during human-only preparation and activation.

We need a way to stop merging on Copilot approvals if one lets a bad change through, and a clear bar for starting again.

We should suspend approvals when a change that merged on a Copilot approval:

- had to be reverted or hot-fixed for a defect a human reviewer would reasonably have caught,
- touched a path that belongs in the medium or high tier, which means a glob was too broad, or
- came from an author the trusted-author check should have rejected.

Any maintainer can suspend approvals immediately by turning off "Allow Copilot approvals to count toward merge requirements." Copilot will keep reviewing every push and writing its approval assessment, but PRs will not be able to merge without human approval.

The maintainer who suspends approvals should open a tracking issue that links the merged pull request, says what Copilot missed, and names the cause: a glob that was too broad, a gap in the review instructions or skills, a miss by Copilot itself, or a bug in the trusted-author check.

To turn approvals back on, we should:

1. Fix the cause, whether that means the globs, the instructions and skills, or the check.
2. Run a shorter trial: at least two weeks and at least 15 eligible low-tier pull requests with zero false approvals, recorded the same way as the Step 4.5 trial.
3. Have a maintainer record the result on the tracking issue, close it, and turn the setting back on.

### Error handling

Stage 5 adds no custom check. Its native failure and authority-revocation cases must pass before activation. In later Copilot-credit work, every new check must fail closed: a broken check must not grant an exception, and any human fallback must still satisfy approvers-team authority.

- **Copilot doesn't review.** The review can fail to run because the author has no Copilot license, has run out of AI credits, or GitHub has an outage. Then there's no Copilot approval, and the ruleset's required approval must come from a human.
- **The labeler fails or doesn't run.** Labels only inform reviewers. The approval globs and the Step 4.5 trusted-author check work from the changed files and the author, never from labels, so a missing or wrong label can't lower the bar.
- **A team-membership lookup fails.** If the GitHub API returns an error, rate-limits the check, or the token can't read the team, the trusted-author check must fail rather than pass, and its output must say why.
- **A required check is skipped.** GitHub counts a skipped required check as passed (Step 3.2). Each new required check must run on every pull request, with no job-level `if:` that could skip it, and make its decision inside its steps. The Stage 4 advisory job is never required: unrelated label events may skip it, and a disabled startup flag explicitly performs no API activity.

## Test plan

We need evidence for two separate questions. The Step 4.5 trial measures whether Copilot's reviews are right. It says nothing about whether our checks enforce the rules, so we also need acceptance tests for the checks themselves. Both must pass before Copilot approvals count toward merge.

Each phase gets one verification:

- **Phase 1.** Open a pull request after Step 1.2 and confirm that Copilot's review applied the `radius-code-review` skill and ended with the summary comment.
- **Phase 2.** Once the rollout is separately authorized, test it in GitHub. Confirm that Copilot reviews the new commit after a push, skips drafts under the tested settings, handles resolved findings, and uses the requested effort. Test a maintainer's review request, the author's pause after round three, and admin rollback. Record any blocked case or platform limitation. Local reviews cannot establish these results.
- **Phase 3.** Complete the separately authorized scan, enforcement, and rollback cases in [Phase 3 acceptance evidence](#phase-3-acceptance-evidence). Local workflow tests establish execution contracts, not GitHub merge blocking.
- **Phase 4 / Stage 5.** First complete the separately authorized native-human qualification in [Step 4.3](#qualify-before-activation). The Copilot-credit cases below remain deferred until a later design and separately authorized isolated rollout.

### Phase 3 acceptance evidence

**Local tests prove the workflow's behavior. Hosted tests must prove scanning and merge enforcement.** Keep those results separate.

#### Check the local contracts

Parse the workflow YAML and execute the actual CodeQL gate shell with successful, failed, cancelled, skipped, empty, missing, and unknown dependency results. Rerun the existing CI-gate tests, keeping their dynamic dependency coverage.

These checks do not need new product, UI, cloud, or deliberately vulnerable production fixtures.

#### Authorize and rehearse hosted tests

Before hosted work, confirm who will act as admin, who owns the evidence, which Actions usage is permitted, the isolated repository and participants, the exact settings changes, and who may roll them back. A named admin or admin access is not authorization.

Rehearse enforcement and rollback in an approved isolated repository **before changing live rules**. Use an identity without bypass rights. Copy only the needed safe workflows and protections, not secrets or publication/deployment jobs. Never merge seeded defects or execute intentionally unsafe steps.

For each case, record **pass, fail, or blocked**, the workflow/action/tool versions, event, language category, matching head/base/merge revisions, analysis URLs, and the specific rule or check that made the decision. Compare with a healthy control.

#### Cover the required cases

- **Healthy scans:** both languages succeed on the default branch and a healthy PR. Verify extraction scope; zero alerts do not prove that the intended files were read.
- **High and critical findings:** use harmless, non-executed samples in paths the extractor analyzes. First observe the expected query, severity, and PR-diff locations in the actual results. Then verify that the native rule blocks and that correcting the sample clears it on a new revision. If the expected alert is absent, mark the case blocked, even if another rule prevents merge.
- **Lower-severity control:** a medium-severity finding does not block through the new high/critical rule. Identify any independent blocking control.
- **Unsuccessful analysis:** either language failing, cancelled, skipped, missing, or incomplete cannot produce a passing completion gate.
- **Absent or stale results:** disabled analysis and a failed revision following a successful one cannot satisfy requirements with missing or older results.
- **Contributor variants:** fork, Dependabot, documentation-only, stacked, pre-existing, and retargeted PRs receive current analysis without secrets or privilege escalation. Mark unavailable identities as blocked evidence.
- **Dependabot pushes:** test PR uploads separately from scans after a Dependabot-authored squash merge. The latter can have read-only-token upload limits. Preserve squash-only policy and document an authorized recovery path.
- **Existing protections:** static checks, coverage/tests, Chromium, Windows, plugin discovery/build, the shared release artifact, Dependency Review, shell/uploader, registry, visual, and DCO protections still work. Reuse matching checked-in or hosted evidence. Inspect upstream Dependency Review policy before choosing a sample; never install or run a vulnerable package. Visual checks may legitimately skip nonvisual changes.
- **Autofix:** record effective availability and, where supported, a suggestion, human review, and verification of an accepted fix. No suggestion does not weaken protection.
- **Rollback:** restore only the new fields and demonstrate safe producer removal/rename ordering. Unresolved new-rule or rollback failures block activation. Other unavailable cases need an explicit decision before proceeding; do not count them as passes.

#### Activate, verify, and record

Once scans are healthy and rehearsal is complete:

1. Obtain separate activation authorization. Capture the full current ruleset and security configuration, and reconcile concurrent changes.
2. Add only the two Step 3.1 requirements. Read the persisted settings back and compare them with the snapshot.
3. Repeat safe, approved enforcement cases in the real repository, using current revisions and an identity without bypass rights.

Prove that the specific new rule or check blocks the matching revision. A red job, missing approval, draft restriction, admin's ability to merge, or isolated-repository result is not enough. Never attempt a potentially successful real-repository merge to prove a negative.

Keep a separate acceptance record for each milestone: **repository preparation**, **hosted scans**, **Autofix verified**, **live rules persisted**, and **enforcement accepted**. Each needs its own evidence and responsible operator; source edits do not establish later milestones.

Repository preparation alone leaves the later milestones pending authorization and evidence. Stage 3 is operationally complete only when scans are healthy, authorized settings are persisted, enforcement and rollback cases pass, and remaining platform limitations have explicit disposition.

### Phase 4 acceptance cases

These are deferred Copilot-credit cases, not the Stage 5 native-human qualification matrix. Reconcile them with the retained team requirement before any later rollout. In each case, "blocked" means GitHub won't allow the merge.

| #  | Scenario                   | Setup                                                                                                                                                | Expected result                                                                                                                    |
|----|----------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------|
| 1  | Mixed tiers                | A trusted author changes `docs/setup.md` and `.github/workflows/build.yml`, and Copilot approves.                                                    | Blocked until a human approves. Copilot's approval doesn't count, because the workflow file matches no glob.                       |
| 2  | Stale human approval       | A human approves, then the author pushes a diff-changing commit.                                                                                     | Blocked until a qualifying human reapproves under native stale-diff and latest-push rules; no exact-SHA review reducer is implied. |
| 3  | Dismissed Copilot approval | Copilot approves a low-tier change, then the author pushes again.                                                                                    | Blocked until Copilot approves the new commit or a human does.                                                                     |
| 4  | A push raises the tier     | A low-tier pull request gets a new commit that touches `packages/core/src/workflows/`.                                                               | Copilot's approval no longer counts, so the new commit needs a human approval.                                                     |
| 5  | Label tampering            | Someone removes `risk:high` or adds `risk:low` by hand.                                                                                              | No change. The checks ignore labels.                                                                                               |
| 6  | Untrusted author           | An outside contributor's docs-only pull request gets a Copilot approval.                                                                             | Blocked until a human approves.                                                                                                    |
| 7  | Instruction change         | A pull request edits `.github/instructions/code-review.instructions.md` along with a docs file.                                                      | Copilot's approval doesn't count, and the labeler adds `review-instructions-changed` and its comment.                              |
| 8  | Team lookup fails          | The trusted-author check runs with a token that can't read team membership.                                                                          | The check fails, so the pull request is blocked.                                                                                   |
| 9  | Agent of unknown origin    | An agent opens a low-tier pull request, and the check can't confirm which team member started it.                                                    | Treated as untrusted: blocked until a human approves.                                                                              |
| 10 | Approvals suspended        | A maintainer turns off "Allow Copilot approvals to count toward merge requirements," then Copilot approves a trusted author's low-tier pull request. | Blocked until a human approves (Step 4.7).                                                                                         |

We also need to confirm these facts before the step that depends on each:

- Does a Copilot approval satisfy the ruleset's code-owner review rule? (Step 4.5)
- Can an instruction make Copilot code review load a skill on every review? (Step 1.2)
- When a pull request has a file outside the globs, does Copilot still submit an approval that doesn't count, or none at all? (Step 4.5)
- If we adopt a merge queue, do the new required checks need a `merge_group` trigger? (Step 3.2)
- Who can see and correct what Copilot Memory stores? (Step 1.5)

## Security

Stage 5 keeps human approval mandatory; the later Copilot-credit proposal could let some changes merge without it. Both need evidence that a PR cannot earn authority it should not have.

- **Tampered review instructions.** Copilot reads instructions and skills from the pull request's head branch, so a fork can rewrite them. Stage 5 requires an approvers-team human; Step 4.6's later approval-glob exclusions and the advisory warning do not replace that authority.
- **The labeler's trigger.** On a fork pull request, the `pull_request` trigger gets a read-only token, so the labeler needs `pull_request_target`. That trigger runs with a write token in our repository, so the labeling job must never check out or run the pull request's code, and should request only `pull-requests: write`.
- **Team authority.** Stage 5 uses native team review, with hard qualification gates for revocation, effective membership, and per-PR isolation. It needs no App token. Later custom eligibility would need a separate credential and lifecycle design that runs no PR-controlled code; a membership lookup alone cannot prevent stale approval credit.
- **Wider merge rights.** Copilot approvals count only for low-tier paths, only for trusted authors, and only after the trial and the acceptance cases pass. Any maintainer can suspend them at once (Step 4.7). Every other change keeps a human approval.
- **Copilot Memory.** A wrong fact in memory would steer later reviews without anyone seeing it, so Step 1.5 asks who can audit what it stores.

## Open questions

**Q: Who pays for reviews on every push?**
Automatic reviews usually charge the author; manual reviews usually charge the requester. Organization policies and bot/cloud-agent billing rules can change who pays, and Actions charges are separate. Before enabling Phase 2, the billing owner must confirm who pays, what bounds spending, who can monitor it, and who can stop the experiment. Get separate authorization before changing organization billing or paid-usage policies.

**Q: Is the trial bar right?**
Step 4.5 asks for four weeks, 30 low-tier pull requests, and zero false approvals. Someone has to record Copilot's assessment next to the human decision for each of those pull requests. Proposed: keep the bar, and name an owner for the record before the trial starts.

**Q: Should an agent's pull request ever count as trusted?**
Stage 5 requires an approvers-team human for agent PRs as for every other author. Step 4.5's agent-origin exception is deferred; a later design must establish attribution from GitHub records and fail closed when it cannot.

**Q: What happens when a required check is flaky?**
Step 3.2 preserves `CI gate`, which requires the Canvas Chromium and Windows jobs to succeed. If one fails at random, it blocks merges that are otherwise ready. Diagnose it under the code-quality skill's retry and no-quarantine rules; never quarantine safety-critical coverage or drop the required check to clear a merge.

**Q: Is the plugin build gap still open?**
No. The required `CI gate` fails if plugin discovery or any plugin build fails. Step 3.2 preserves it and the separate release artifact.

**Q: Are the suspension window and audit size right?**
Step 4.7 sends us back to the full trial after a second suspension within 90 days, and has a maintainer sample up to five Copilot-approved merges each month. A longer window or a larger sample catches more but costs more maintainer time. Proposed: start with these numbers and revisit them after the first three months of approvals.

## Alternatives considered

### Require individual build jobs or reuse the release gate

Requiring individual jobs would make us update the ruleset whenever we reshard Chromium or add a plugin. Reusing the shared release gate for every plugin could couple independent releases or change the artifact contract that publish and release workflows consume.

Instead, `CI gate` handles PRs and `Shared release gate` supplies the `build-gate` publication artifact. The CI gate always runs and fails unless every Build dependency succeeds. Its contract test checks that the gate includes every dependency, including the plugin matrix.

CodeQL uses the same completion pattern, with a separate native rule for alert severity.

### Use default CodeQL setup

We chose checked-in advanced setup so reviewers can inspect the languages, suite, permissions, categories, and completion behavior. It also avoids the documented Dependabot default-setup merge-protection exception. Hosted fork and Dependabot behavior still needs verification.

A universal action-pinning gate remains deferred. High/critical CodeQL enforcement does not fill that gap.

## Design review notes

To be recorded before this doc merges.
