# Automated pull request review triage

- **Author**: Nell Shamrell-Harrington (@nellshamrell)
- **Date**: 2026-10

## Overview

Every pull request to this repository is reviewed by a maintainer or approver listed in [`.github/CODEOWNERS`](../../.github/CODEOWNERS). That reviewer answers the same four questions each time: is the code functional, is it safe, is it maintainable, and does it comply with our linters and style guides. Much of the evidence for those answers is already produced by CI. The reviewer still has to collect it from a dozen checks, decide which of it applies to this change, and sometimes pull the branch down and run it locally to fill a gap.

This proposal adds an automated **review triage** step that runs whenever a pull request is opened or updated. It gathers the evidence CI already produces, adds a context-aware AI review, applies a repository-owned policy, and publishes one result: the author has something to fix, a human needs to look at something specific, or the change carries enough evidence to need no further reviewer attention. When it escalates, it tells the reviewer exactly which question it could not answer and why.

The triage step decides where reviewer attention goes. It does not approve pull requests and does not replace any existing required check.

## Terms and definitions

| Term                   | Definition                                                                                                                                                                                                         |
|------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Evidence               | A machine-verifiable result attached to a specific commit: a check conclusion, a coverage figure, a scanner finding, a dependency diff, or an AI review finding with a file location.                              |
| Evidence gap           | A question the policy needs answered for this change that no evidence answers. For example, changed production code that no test exercises, or a check that applies to the change but did not run.               |
| Finding                | A concrete problem with a location, a failure scenario, and a source (scanner, test, linter, or AI review).                                                                                                        |
| Risk area              | A path or kind of change that the policy treats as needing human judgment regardless of evidence, such as workflow files or credential handling.                                                                  |
| Triage outcome         | One of `author-action`, `human-review`, or `no-reviewer-needed`. Defined in [Triage outcomes](#triage-outcomes).                                                                                                   |
| Shadow mode            | Triage runs and records its outcome but blocks nothing and requests no one. Used to measure accuracy before enforcement.                                                                                           |
| Review brief           | The single pull request comment triage writes when it escalates: what it checked, what it could not establish, and the specific decision it needs from a person.                                                  |
| Triage App             | A dedicated GitHub App whose installation token publishes the triage check run, so branch rules can require the check from that App alone.                                                                         |

## Objectives

> **Issue Reference:** N/A. No tracking issue exists yet; one should be opened when this design merges.

### Goals

1. On every pull request event that changes what would merge (`opened`, `synchronize`, `reopened`, `ready_for_review`), produce an assessment of the four review questions for the current head commit.
2. Separate what tools can verify from what needs human judgment. Deterministic results (tests, linters, scanners) are authoritative; AI review adds context but never overrides a deterministic failure.
3. Send reproducible, mechanical problems (lint failures, failing tests, missing formatting) back to the author without consuming reviewer time.
4. Escalate to a human with a focused review brief when a change touches a risk area, when the evidence is incomplete, or when a finding needs judgment.
5. Keep untrusted pull request content away from credentials and write tokens.
6. Measure accuracy in shadow mode before triage gates anything.

### Non-goals

1. **Automatic approval or merge.** Triage never submits an approving review. Whether a `no-reviewer-needed` outcome may ever substitute for a human approval is a governance decision for maintainers, captured in [Open questions](#open-questions), and this design works either way.
2. **Replacing existing checks.** The jobs in [`build.yml`](../../.github/workflows/build.yml), [`dependency-review.yml`](../../.github/workflows/dependency-review.yml), and the other pull request workflows keep running and keep their current required status. Triage reads their results.
3. **Running the cloud end-to-end tier on pull requests.** [`cloud-e2e.yml`](../../.github/workflows/cloud-e2e.yml) deliberately avoids `pull_request_target` so fork code never reaches the Azure identity. This design keeps that decision. Triage reports when a change touches code that only that tier exercises, and escalates instead.
4. **A general code-quality score.** A single number hides which question failed and invites tuning to the number. Triage reports per-question results and named gaps.
5. **Style opinions beyond configured rules.** If a whitespace or naming choice passes ESLint, Prettier, and markdownlint as configured in [`.github/linters/`](../../.github/linters/), triage does not comment on it.

### User scenarios

#### User story 1: a mechanical problem

A contributor opens a pull request that fails `pnpm run format:check`. Today a reviewer may notice the red check, open the log, and comment. With triage, the outcome is `author-action`, the check summary names the failing rule and file, and no reviewer is requested until the author pushes a fix.

#### User story 2: a change to a risk area

A maintainer changes `.github/extension/` templates that are shipped into user repositories and bind OIDC environments. All checks pass. Triage still returns `human-review` because the path is a risk area, and its review brief lists which live contract tests ran ([`live-tests.yml`](../../.github/workflows/live-tests.yml)), which consumers it found, and what it could not test.

#### User story 3: a new dependency

A pull request adds a package to [`packages/core/package.json`](../../packages/core/package.json). Dependency review passes with no known vulnerabilities. Triage escalates anyway because a new third-party dependency is a risk area, and the brief summarizes the package's install scripts, maintainers, license, and why the AI review thinks it was added.

#### User story 4: a well-evidenced change

A pull request fixes a bug in one function in `packages/core`, adds a test that fails before the fix and passes after, keeps coverage at or above the [`coverage-baseline.json`](../../coverage-baseline.json) ratchet, and touches no risk area. The AI review raises no finding above the reporting threshold. Triage returns `no-reviewer-needed`, and the check summary shows the evidence it relied on.

## User experience

Contributors and reviewers see triage in two places.

1. **A check run named `Review triage`** on the head commit. Its conclusion maps to the outcome: `failure` for `author-action`, `action_required` for `human-review` until a code owner approves the current head, and `success` for `no-reviewer-needed`. The check summary is the full assessment.
1. **One review brief comment**, created or updated in place, only when the outcome is `human-review`. It reuses the single-comment pattern that [`scripts/canvas-visual-baselines.mjs`](../../scripts/canvas-visual-baselines.mjs) already uses for visual baseline status, with its own HTML marker.

**Sample input:** a pull request that adds a dependency and changes a workflow file.

**Sample output** (review brief):

```markdown
<!-- review-triage -->
### Review triage: human review needed

Assessed head `4f2a9c1` against `main` at `b81d3e0` with policy v3.

| Question       | Result       | Evidence                                                     |
|----------------|--------------|--------------------------------------------------------------|
| Functional     | Passed       | Build, Node tests, Chromium shards 1–2, artifact smoke tests |
| Safe: security | Needs review | New dependency `left-pad@2.0.0` has an install script        |
| Safe: context  | Needs review | `.github/workflows/build.yml` changed (risk area: CI)        |
| Maintainable   | Passed       | No AI findings above threshold                               |
| Lint and style | Passed       | ESLint, Prettier, markdownlint                               |

**Decisions needed**

1. Is a new runtime dependency acceptable for this change? The package runs `postinstall`.
1. The `static-checks` job now runs after `node-tests`. Is the slower critical path intended?
```

## Design

### High-level design

Triage has three stages with a deliberate privilege boundary between them.

1. **Collect (unprivileged).** A `pull_request` workflow computes the facts that depend on the pull request's files: the changed paths, the affected packages, newly added dependencies, and which existing checks apply to this change. It runs with `contents: read` and no secrets, exactly like the jobs in `build.yml`. It uploads those facts as an artifact.
1. **Assess (privileged, trusted code only).** A `workflow_run` workflow, which always runs the workflow file from the default branch, waits for the pull request's checks to finish, downloads the facts artifact as untrusted data, reads check results and Copilot review comments through the API, and evaluates the base-branch policy.
1. **Publish (Triage App identity).** The assess job exchanges a Triage App credential for an installation token and writes the `Review triage` check run and, when needed, the review brief and reviewer request.

The AI review is GitHub's [Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review), enabled through a repository ruleset. It reviews the pull request on its own; triage reads its comments as findings. Triage does not run its own model.

### Architecture diagram

```mermaid
flowchart TD
  PR[Pull request event<br/>opened · synchronize · reopened · ready_for_review]

  subgraph unprivileged[pull_request: read-only token, no secrets]
    BUILD[Existing checks<br/>build.yml, dependency-review.yml,<br/>live-tests.yml, canvas-functional.yml, ...]
    COLLECT[review-triage-collect.yml<br/>changed paths, affected packages,<br/>new dependencies, applicable checks]
  end

  CCR[Copilot code review<br/>enabled by ruleset]

  subgraph privileged[workflow_run: default-branch code only]
    ASSESS[review-triage-assess.yml<br/>scripts/review-triage.mjs assess]
    POLICY[.github/review-triage.yml<br/>read from base branch]
  end

  APP[Triage App installation token]
  CHECK[Check run: Review triage]
  BRIEF[Review brief comment<br/>+ code owner request]

  PR --> BUILD
  PR --> COLLECT
  PR --> CCR
  COLLECT -- facts artifact, untrusted --> ASSESS
  BUILD -- check results via API --> ASSESS
  CCR -- review comments via API --> ASSESS
  POLICY --> ASSESS
  ASSESS --> APP
  APP --> CHECK
  APP --> BRIEF
```

### Detailed design

#### Assessing each question

The policy maps each question to the evidence that answers it in this repository. Every entry below names a check or script that exists today unless marked **new**.

| Question       | Evidence triage reads                                                                                                                                                                                                                                                                                                                                                  | Escalates when                                                                                                                                                                                                                                                         |
|----------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Functional     | `build.yml`: `Static checks` (typecheck), `Tests, browser coverage and library candidates` (`pnpm run coverage`), `Canvas Chromium` shards, `Windows process integration`, and the per-plugin artifact smoke tests. `extension-selftests.yml` for `.github/extension/` changes. `live-tests.yml` for workflow templates. **New:** changed-line coverage from `coverage/lcov.info`. | A check that applies to the changed paths did not run or did not finish. Changed production lines have no test coverage. The change touches code exercised only by scheduled tiers ([`canvas-reliability.yml`](../../.github/workflows/canvas-reliability.yml), `cloud-e2e.yml`). |
| Safe: security | `dependency-review.yml`. **New:** CodeQL code scanning for JavaScript/TypeScript and GitHub Actions. Secret scanning push protection. New dependencies from the lockfile diff, including install scripts. Copilot review findings tagged security.                                                                                                                       | Any new third-party dependency. Any code scanning alert at or above `medium`. Any change in a security risk area (below). Any Copilot security finding.                                                                                                                |
| Safe: context  | **New:** affected-package detection from the pnpm workspace graph, so a change to `packages/core` lists `adapter-shared`, `adapter-canvas`, and `graph-react` as consumers. Public contract paths. Copilot review findings about callers.                                                                                                                                    | A public contract changes (see risk areas). A shared package changes and a consumer's tests did not run. The change removes or renames an exported symbol.                                                                                                             |
| Maintainable   | Copilot review findings tagged maintainability, filtered by the reporting threshold. Coverage ratchet from [`coverage-baseline.json`](../../coverage-baseline.json) through [`vitest.config.ts`](../../vitest.config.ts).                                                                                                                                                  | A finding above the threshold is not resolved. Coverage regresses below the ratchet.                                                                                                                                                                                   |
| Lint and style | `Static checks`: `pnpm run lint`, `pnpm run format:check`, `pnpm run version:check`. `extension-selftests.yml`: shellcheck. **New:** `pnpm run lint:md` on changed Markdown.                                                                                                                                                                                             | Never escalates. Failures produce `author-action` with the rule and location.                                                                                                                                                                                          |

Tests are evidence of behavior, not proof that the behavior is the intended one. For a bug fix, the strongest evidence is a test that fails on the base commit and passes on the head. Computing that requires running tests twice, so it is deferred to [Option 3](#option-3-on-demand-execution-agent) and listed in [Open questions](#open-questions).

#### Risk areas

Risk areas are glob patterns in the policy file. A change matching one always produces `human-review`, regardless of evidence. The initial set is chosen from code in this repository that already carries security or compatibility comments explaining why it is sensitive.

| Risk area                     | Patterns                                                                                                    | Why                                                                                                                                                       |
|-------------------------------|-------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| CI and release                | `.github/workflows/**`, `.changeset/config.json`, `scripts/release-version.mjs`, `scripts/version.mjs`       | Workflows hold tokens and decide what is published. `CODEOWNERS` already adds `@radius-project/on-call` here.                                            |
| Templates shipped to users    | `.github/extension/**`                                                                                      | These run in user repositories with cloud OIDC credentials. `live-tests.yml` exists because a template change once broke generated deploys.               |
| Cloud identity and credentials | `packages/adapter-canvas/src/server/routes/azure-auto-setup-application.ts` and other credential handlers listed in the policy | Creates Entra applications and federated credentials in user tenants.                                                                                    |
| Dependencies                  | `**/package.json` dependency fields, `pnpm-lock.yaml`, `pnpm-workspace.yaml`                                 | Supply chain. `CODEOWNERS` already lists these for on-call.                                                                                              |
| Plugin surface                | `extensions/radius/**` manifests and skills                                                                  | Public contract with the Copilot app and users.                                                                                                          |
| Triage itself                 | `.github/review-triage.yml`, `scripts/review-triage.mjs`, the triage workflows                               | A change to the policy must not approve itself. The policy is always read from the base branch, so a pull request that edits it is assessed by the old one. |

#### Triage outcomes

Triage evaluates rules in a fixed order. The first rule that matches decides the outcome.

1. A deterministic check that applies to the change failed, or a linter reported a violation: `author-action`. The summary links to the failing job and quotes the first error.
1. The change matches a risk area: `human-review`.
1. A required evidence item is missing (a check did not run, coverage is absent for changed lines, Copilot review did not complete): `human-review`, with the gap named.
1. A scanner or Copilot finding at or above the reporting threshold is unresolved: `human-review`.
1. The change is in the `no-reviewer-needed` allowlist and none of the above matched: `no-reviewer-needed`.
1. Otherwise: `human-review`.

Rule 6 makes the default fail closed. The allowlist starts narrow, for example documentation-only changes under `docs/` that pass markdownlint, and grows only when shadow-mode data shows triage was right for that class of change. Pull request size is not a criterion: a one-line change to authorization is not low risk.

Copilot code review's own confidence does not decide eligibility. Its findings count toward rule 4. Whether its silence counts as evidence is decided by measured precision in shadow mode, not assumed.

#### Freshness

Every assessment records the head SHA, the base SHA, and the policy version. A new push or a base update triggers a new assessment, and the previous check run is superseded because check runs attach to a commit. A `human-review` outcome moves to `success` only when a code owner has approved the current head, which the assess job reads from the reviews API. This matches the existing branch-protection option to dismiss stale approvals.

#### Option 1: Turn on GitHub-native features only

Enable Copilot code review on all pull requests through a ruleset, enable CodeQL default setup and secret scanning, and mark the existing checks as required. Write no new code.

##### Advantages

- No code to maintain. All configuration is in repository settings.
- Contributors get AI and security feedback on every pull request within days.

##### Disadvantages

- Nothing decides which pull requests need a human. Every pull request still goes to a reviewer, who now has more comments to read.
- No record of which question failed or what evidence was missing, so there is nothing to measure.
- Copilot comments and check failures stay in separate places.

#### Option 2: Evidence aggregation in Actions with a Triage App identity

Implement the three-stage design above: an unprivileged collect workflow, a privileged assess workflow that runs only default-branch code, a policy file in the repository, and a dedicated GitHub App identity for the required check. Option 1's native features are inputs.

##### Advantages

- Uses infrastructure the repository already operates: pinned actions, `contents: read` defaults, artifact handoff, and the single-comment pattern from `canvas-visual-baselines.mjs`.
- The policy is versioned in the repository and reviewed like code, and is always evaluated from the base branch.
- Requiring the check from the Triage App means a pull request cannot satisfy it by adding a workflow job with the same name. Any job a pull request adds runs under the GitHub Actions identity, not the App.
- Deterministic and testable: the assessment is a pure function from facts, check results, and policy to an outcome, which fits the repository's Vitest-first testing rules.

##### Disadvantages

- `workflow_run` is a privileged trigger. GitHub's [secure use reference](https://docs.github.com/en/actions/reference/security/secure-use#mitigating-the-risks-of-untrusted-code-checkout) warns that it must never check out or execute pull request code, and that downloaded artifacts must be treated as untrusted. The design depends on following that rule exactly.
- Waiting for every applicable check adds latency. The assessment cannot finish before the slowest check.
- A GitHub App private key must be stored as a secret and rotated.

#### Option 3: On-demand execution agent

Add an agent that checks out the pull request in a disposable, network-restricted sandbox, builds it, and exercises a specific scenario: reproducing a reported bug, running the base-versus-head test comparison, or driving the Canvas through Playwright. This is the closest substitute for a reviewer pulling the branch locally.

##### Advantages

- Closes evidence gaps that static checks cannot, particularly "does this fix the reported bug" and behavior with no existing test.
- Its output is evidence (a trace, a failing-then-passing test, a screenshot) rather than opinion.

##### Disadvantages

- Executes untrusted code. It needs isolation equivalent to the unprivileged `pull_request` jobs, plus egress limits, and must never hold credentials.
- Slow and costly to run on every pull request.
- Its scenarios must be specified per change, which is itself a judgment call.

#### Option 4: Standalone GitHub App service

Run triage as a hosted service that receives webhooks, keeps state, and calls GitHub APIs, instead of running in Actions.

##### Advantages

- Can react to individual check completions without a polling or `workflow_run` fan-in.
- Natural home for cross-pull-request state such as precision metrics.

##### Disadvantages

- Requires hosting, uptime, and an on-call owner that this repository does not have today.
- Moves the policy evaluator out of the repository's normal review and test flow.

#### Proposed option

**Option 2, built on Option 1, with Option 3 deferred to a targeted follow-up.**

Option 1 is the first step regardless, because its features are inputs to everything else. Option 2 adds the missing part, a policy that decides who needs to look, with the least new infrastructure and a trust model the repository already uses. Its main risk, the privileged `workflow_run` trigger, is contained by running only default-branch code and treating the facts artifact as data. Option 3 is valuable but should be invoked only to close a named evidence gap, once shadow-mode data shows which gaps are common. Option 4 is unnecessary until Actions latency or state becomes a measured problem.

### API design

N/A. Triage adds no public API, canvas action, tool, or `packages/core` export. Its interfaces are a check run, a pull request comment, and the policy file below, all internal to this repository.

The policy file, `.github/review-triage.yml`, has this shape:

```yaml
version: 1
mode: shadow # shadow | advisory | enforce
riskAreas:
  - name: ci-and-release
    paths:
      - .github/workflows/**
      - .changeset/config.json
    reviewers: ["@radius-project/maintainers-ai-extensions"]
noReviewerNeeded:
  - name: docs-only
    paths:
      - docs/**
    requireChecks: ["Static checks"]
findings:
  reportingThreshold: medium
requiredEvidence:
  - when: "packages/**/src/**"
    checks:
      - "Tests, browser coverage and library candidates"
      - "Static checks"
    changedLineCoverage: true
```

### Implementation details

#### Core package — packages/core

N/A. Triage is repository automation, not product logic, and must not ship in the plugin bundle.

#### Canvas adapter — packages/adapter-canvas

N/A. No Canvas behavior changes.

#### Shared adapter — packages/adapter-shared

N/A.

#### Plugin — extensions/radius

N/A. No skill, manifest, or marketplace change. The plugin's paths are inputs to the risk-area policy only.

#### Build & packaging

All new code lives under `scripts/` and `.github/`, following the pattern of `scripts/canvas-visual-baselines.mjs`: a dependency-free Node script with subcommands, invoked from workflows, with collocated tests.

1. **`scripts/review-triage.mjs`** with subcommands:
   - `collect`: reads `git diff --name-only` from the merge commit like the `changes` job in [`canvas-functional.yml`](../../.github/workflows/canvas-functional.yml), resolves affected packages from the pnpm workspace, extracts added dependencies from the lockfile diff, and writes `facts.json`.
   - `assess`: validates `facts.json` against a strict schema (unknown keys, oversized fields, or path traversal rejected), reads check runs and Copilot review comments through the GitHub API, loads the base-branch policy, and returns an outcome plus summary. The decision logic is a pure function so it can be tested without network access.
   - `publish`: writes the check run and review brief using the Triage App token.
1. **`.github/workflows/review-triage-collect.yml`**: `on: pull_request` with types `opened`, `synchronize`, `reopened`, `ready_for_review`. `permissions: contents: read`, `persist-credentials: false`, no secrets. Uploads `facts.json`.
1. **`.github/workflows/review-triage-assess.yml`**: `on: workflow_run` for the collect workflow. Checks out the default branch only, never the pull request ref. Polls check suites for the head SHA until applicable checks complete or a timeout elapses, which produces an evidence gap. Uses `actions/create-github-app-token` with the Triage App secret in a protected environment.
1. **`.github/review-triage.yml`**: the policy.
1. **Repository settings**: Copilot code review ruleset, CodeQL default setup, secret scanning push protection, and, at the enforce stage, `Review triage` as a required check restricted to the Triage App.
1. **Changed-line coverage**: a small addition that intersects `coverage/lcov.info`, already uploaded by the `node-tests` job, with the diff hunks. It can live in `scripts/review-triage.mjs` or extend [`scripts/coverage-summary.mjs`](../../scripts/coverage-summary.mjs).

This is repository tooling with no released package, so no Changeset is needed; such pull requests use the `pr:no-changeset` label described in [`changesets.yml`](../../.github/workflows/changesets.yml).

### Error handling

Triage fails closed: any error produces `human-review`, never `no-reviewer-needed`.

| Scenario                                                        | Behavior                                                                                                                                       |
|-----------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| Facts artifact missing, malformed, or fails schema validation   | `human-review` with gap "triage could not read change facts". The artifact is never interpreted beyond the schema.                            |
| An applicable check does not finish before the assess timeout   | `human-review` with the check named as a gap. A later `check_suite` completion does not re-trigger in v1; the next push does.                  |
| Copilot code review unavailable or not completed                | Evidence gap. Copilot review is not treated as having found nothing.                                                                           |
| GitHub API rate limit or transient error                        | Retry with backoff inside the job. If retries are exhausted, publish `human-review` with the error.                                            |
| Triage App token cannot be created                              | The job fails visibly. Because the required check never reports, the pull request cannot merge, which is the fail-closed result.               |
| Policy file invalid                                             | The assess job fails before publishing. Policy changes are themselves a risk area and have a unit test that parses the committed file.         |
| Fork pull requests                                              | Collect runs with a read-only token as today. Assess runs from the default branch, so forks are handled identically without granting them anything. |

## Test plan

The repository's [code-quality rules](../../.github/instructions/code-quality.instructions.md) apply to `scripts/review-triage.mjs`: collocated Vitest tests and a goal of 100% line, branch, function, and statement coverage. The script would be added to the `coverage.include` list and per-file 100% thresholds in [`vitest.config.ts`](../../vitest.config.ts), like the existing skill scripts.

1. **Policy evaluation (unit).** Table-driven tests over the outcome rules: each rule in isolation, rule ordering, the fail-closed default, risk-area glob matching, allowlist matching, and freshness against a stale approval.
1. **Facts validation (unit).** Malformed JSON, unknown keys, oversized arrays, paths with `..` or absolute prefixes, and non-UTF-8 content are all rejected.
1. **Collect (unit).** Changed paths to affected packages using a fixture pnpm workspace. Lockfile diffs to added dependencies, including a dependency with an install script.
1. **Changed-line coverage (unit).** LCOV fixtures intersected with diff hunks, including renamed files and deleted lines.
1. **Publish (boundary).** API calls against a local fake GitHub server, as `canvas-visual-baselines.mjs` comment tests do: create versus update of the single comment, check run conclusion mapping, and idempotence on repeated runs for the same SHA.
1. **Policy file (configuration check).** A test parses the committed `.github/review-triage.yml` and asserts every referenced check name exists as a job name in a workflow under `.github/workflows/`, so renaming a job cannot silently create a permanent evidence gap.
1. **Workflow security (configuration check).** A test asserts the assess workflow never checks out `github.event.workflow_run.head_sha` or a pull request ref, and that the collect workflow has no `secrets` references and only `contents: read`.
1. **Shadow-mode evaluation (operational).** For at least four weeks, record every outcome alongside what human review actually found. Report misses (a human found a material defect on a `no-reviewer-needed` outcome), unnecessary escalations, and evidence-gap frequency. The enforce stage requires zero material misses in the allowlisted categories.

## Security

| Threat                                                                                      | Mitigation                                                                                                                                                                                                                       |
|---------------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Pull request code runs with privileged credentials ("pwn request")                          | Only the collect stage touches pull request files, and it runs under `pull_request` with `contents: read` and no secrets. The assess stage runs default-branch code from `workflow_run` and never checks out pull request content. |
| Crafted facts artifact manipulates the assessment                                           | The artifact is data, validated against a strict schema with size limits. Facts can only add evidence gaps or risk matches; they cannot assert that a check passed. Check results are read from the API, not the artifact.      |
| A pull request spoofs the `Review triage` check by adding a same-named job                  | The required check is restricted to the Triage App as its expected source, per GitHub's [required status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches#require-status-checks-before-merging). |
| A pull request weakens the policy and is assessed by the weakened policy                    | The policy is read from the base branch. Policy and triage code are a risk area, so changes to them always need human review.                                                                                                  |
| Prompt injection through pull request text or code steers the AI review                     | Copilot review findings can only escalate, never clear an escalation. A silent or manipulated AI review cannot produce `no-reviewer-needed` unless every deterministic rule also passes and the change is allowlisted.         |
| Script injection from pull request titles, branch names, or file names                       | No `${{ github.event.* }}` value is interpolated into `run:` blocks. Values pass through `env:` and are handled as data, as the existing workflows already do.                                                                |
| Triage App private key leak                                                                 | Stored as an environment secret on a protected environment used only by the assess job. The App has only `checks: write`, `pull-requests: write`, and read permissions. Rotated on a schedule.                                   |
| Third-party action compromise                                                               | All actions pinned by full commit SHA, matching existing workflows. Dependabot already updates them.                                                                                                                            |

## Compatibility

No product or plugin behavior changes. Contributor-visible changes:

1. A new `Review triage` check appears on every pull request. During shadow mode it is neutral and not required.
1. Copilot code review comments appear on pull requests once the ruleset is enabled.
1. At the enforce stage, `Review triage` becomes required. Because a `human-review` outcome only clears after a code owner approves, this does not change who can merge, only when reviewers are pulled in.
1. Renaming a job in an existing workflow can create an evidence gap. The configuration check in the test plan catches this in the same pull request.

## Monitoring and logging

1. **Check summary.** Every run writes the full assessment, including head SHA, base SHA, policy version, evidence read, gaps, and the matched rule, to the check run and to `$GITHUB_STEP_SUMMARY`.
1. **Assessment artifact.** The assess job uploads `assessment.json` with a 90-day retention so outcomes can be compared against later human review.
1. **Shadow-mode report.** A scheduled job aggregates the past week's `assessment.json` artifacts against merged pull request reviews and opens or updates a tracking issue, following the open-or-update pattern in `canvas-reliability.yml`'s `notify-scheduled-result` job.
1. **Troubleshooting.** A reviewer who disagrees with an outcome reads the matched rule in the check summary. A wrong rule is fixed in `.github/review-triage.yml`; a wrong fact is fixed in `scripts/review-triage.mjs`.

## Development plan

Each step is independently mergeable and leaves the repository in a working state.

1. **Native features.** Enable Copilot code review by ruleset, CodeQL default setup including Actions, and secret scanning push protection. Settings only.
1. **Collect and assess in shadow mode.** Add `scripts/review-triage.mjs` (`collect`, `assess`), its tests, the two workflows, and an initial policy with risk areas and an empty allowlist. Publish a neutral check using `GITHUB_TOKEN`; no App, no comment, no reviewer request.
1. **Changed-line coverage and affected-package detection.** Add the two new evidence sources and their tests.
1. **Triage App and review brief.** Create the App, move publishing to its token, add the review brief comment and code owner request. Outcomes become visible but remain non-blocking (`mode: advisory`).
1. **Shadow-mode evaluation.** Four or more weeks of measurement and policy tuning. Populate the allowlist from evidence.
1. **Enforce.** Make `Review triage` a required check restricted to the Triage App. Maintainers decide separately whether `no-reviewer-needed` relaxes any existing approval requirement.
1. **Targeted execution (Option 3).** Design separately, scoped to the evidence gaps step 5 shows are most common.

## Open questions

1. **Q: May a `no-reviewer-needed` outcome ever replace a required human approval?** This is a governance question for the maintainers, not a technical one. The design is useful without it: triage still filters mechanical problems out of reviewer queues and focuses escalations. A ruleset bypass for the Triage App would be needed and should be decided after shadow-mode data exists.
1. **Q: Should the base-versus-head test comparison for bug fixes run on every pull request?** It doubles test time. A lighter alternative is to run only the tests added in the pull request against the base commit.
1. **Q: How should triage treat Dependabot pull requests?** [`dependabot-manager.yml`](../../.github/workflows/dependabot-manager.yml) already manages them. They are always dependency risk-area changes, so they would always escalate unless the policy has a separate rule for patch updates with no new transitive packages.
1. **Q: Who owns the Triage App?** It needs an owner in the `radius-project` organization and a rotation schedule for its key. The [`radius-project/.github`](https://github.com/radius-project/.github) repository syncs shared workflows such as `dependency-review.yml`; triage could eventually live there for other Radius repositories.
1. **Q: Should the assess stage re-run when a slow check completes after the timeout?** Version 1 waits for the next push. A `check_suite: completed` trigger would remove that wait at the cost of more runs.
1. **Q: What reporting threshold should Copilot findings use?** Only measured precision in shadow mode can answer this.

## Alternatives considered

1. **A single `pull_request_target` workflow.** Simpler than a two-workflow split, and this repository already uses that trigger safely in `changesets.yml` and `pr-author.yml` because neither executes pull request code. Triage needs facts computed from pull request files, which is exactly the case GitHub warns against. Rejected.
1. **A self-hosted LLM reviewer instead of Copilot code review.** More control over prompts and output format, but it adds model hosting, credential handling, and a second AI review on top of the one the organization already licenses. Revisit only if Copilot review output cannot be consumed reliably.
1. **Labels to signal review need.** Labels are easy to read but any user with triage permission can remove them, and they are not enforceable. The check run is the authoritative signal; a label may be added for filtering.
1. **Path-based reviewer assignment through `CODEOWNERS` alone.** `CODEOWNERS` already requests the right teams by path, but it cannot tell an evidenced change from an unevidenced one, and this repository's `CODEOWNERS` is synced from `radius-project/.github` and must not be edited locally. Triage complements it rather than replacing it.
1. **A numeric risk score with a threshold.** Rejected for the reasons in [Non-goals](#non-goals): it obscures which question failed.

## Design review notes

<!--
Record the decisions made during design review. Update this before the design is
merged/approved.
-->
