---
name: radius-code-review
description: 'Review a pull request or branch diff in ai-extensions for bugs, security issues, idiomatic TypeScript/ESM, and repository conventions. Use when asked to perform a code review or review the current branch.'
argument-hint: 'PR number or URL; omit to review the current branch against its base'
user-invocable: true
---

# Review a Pull Request

Review the pull request identified by the number or URL in the user's message in the `ai-extensions` repository and produce actionable, well-structured feedback. If no PR is given, review the current branch's diff against its base.

This skill is the source of truth for the review workflow. In local/manual sessions, return findings in chat by default. Do not post comments, submit a review, or approve a PR unless the user explicitly requests that action. A recommended review disposition is not authorization to submit it. A hosted Copilot review requested through GitHub uses the service's review response; this does not authorize a local agent to submit one.

## Invocation

In a repository session in Copilot CLI or the Copilot app, use:

```text
Use the /radius-code-review skill to review PR 123.
Use the /radius-code-review skill to review the current branch.
```

In Copilot CLI, run `/skills reload` if the skill was added during the session, and use `/skills info radius-code-review` to check discovery. The Copilot app makes repository skills available in repository sessions.

The [code-review prompt](../../prompts/code-review.prompt.md) remains an entry point in clients that support prompt files. It forwards its resolved PR input to this skill; skill users supply that input in their message rather than through prompt-file variable syntax.

## Repository Context

This repo is a pnpm-workspace monorepo: UI-agnostic product logic lives in `packages/core` (TypeScript) and the Copilot-canvas SDK wiring + webview host lives in `packages/adapter-canvas` (TypeScript/ESM). The canvas adapter is bundled by esbuild into a single generated extension bundle, `.artifacts/radius/com.github.copilot/extensions/radius/extension.mjs`, with Copilot SDK imports externalized. The source release-unit manifest is `extensions/radius/package.json`; release branches publish the assembled plugin at `plugins/radius/`, where the bundle is `plugins/radius/com.github.copilot/extensions/radius/extension.mjs`.

Use the [radius-code-quality skill](../radius-code-quality/SKILL.md) when reviewing TypeScript or JavaScript code and the [monorepo-changeset skill](../monorepo-changeset/SKILL.md) when assessing release impact. Invoke them when available; otherwise read and follow their files. They are the sources of truth for current architecture, testing, coverage, and release policies; the review criteria below supplement rather than replace them.

**Error handling:**

- If files are too large to analyze completely, focus on the most critical changes and say so in the review.
- If you cannot access certain files, note the limitation in the review.
- Report the validation actually performed and its results. Do not imply that an unrun build, typecheck, or test passed.

## Code Review Principles

- **Be concise and direct**: Prefer short, imperative statements over long paragraphs.
- **Focus on actionable feedback**: Avoid vague directives like "be more accurate" or "identify all issues".
- **Be specific**: Provide exact file paths, line numbers, and clear issue descriptions.
- **Structure matters**: Organize feedback by file with clear headings and bullet points.
- **Show examples**: Demonstrate the fix with sample code when it clarifies the point.
- **Avoid generic praise**: Remove purely complimentary comments; focus on what needs to change.

## Before Starting a Review

1. Establish the review target. For an explicit PR, use its metadata (`gh pr view`, `gh api`) to understand the purpose, base, head, and scope. Without a PR input, use the current branch and its configured base or session base context to establish the merge-base comparison. Consult an associated PR's base if available, but do not require a PR for a branch review. If the intended base cannot be established, ask rather than assuming `main`.
2. Read [README.md](../../../README.md) and [packages/core/README.md](../../../packages/core/README.md) for the architecture and core/adapter boundary.
3. For PR reviews, check related issues, review summaries, and all prior review threads, including resolved and outdated threads. Retrieve remaining pages rather than assuming the first page is complete. Apply the convergence rules below. Skip PR-only steps when reviewing a branch without a PR.
4. Note which packages are touched and whether the change is user-facing.

### Content-review scope

Inventory every changed path, but skip line-by-line content findings in generated `.artifacts/**`, `pnpm-lock.yaml` files, and visual baseline images. Review the owning source, manifests, build provenance, and applicable dependency/visual evidence instead. A skipped content review is not a statement that the artifact is safe.

Outside release branches, also skip generated payloads under `plugins/**`; determine whether a file is generated from the packaging rules rather than from its directory alone. Continue reviewing hand-written plugin manifests, READMEs, and catalog metadata there. On release branches, assess assembled plugin contents against their source and packaging contract. Never hand-edit generated output to resolve a finding.

These are content-review exclusions only. They never remove paths from the changed-file inventory, risk or approval eligibility, dependency scanning, artifact verification, or required visual checks. Do not classify a PR as low risk merely because its content was skipped.

### Review convergence

- When you identify a bug, name its class and search the relevant changed scope and callers for every instance. Report all confirmed instances in the same round, with precise locations; do not turn that search into unrelated repository cleanup.
- Before posting a finding, compare it with prior findings and their resolution. Do not repeat an already-posted or resolved finding. Point to an existing unresolved thread instead of opening a duplicate. If new code reintroduces a resolved defect, explain the new evidence and location rather than repeating the old comment.
- Count completed automated review rounds on the PR, not individual comments or replies. Finish the third round with an explicit request for the author to take over unresolved findings and decide the next review step. Do not initiate a fourth automated round yourself. If invoked again after three rounds, summarize outstanding findings and request human direction instead of starting another autonomous fix/re-review loop.
- If review history or round count cannot be established, state the limitation and request the author's direction; do not invent a count or claim duplicate detection was complete.
- This is reviewer guidance, not a GitHub scheduling control or merge gate. An author must intervene if hosted automatic reviews keep running; this skill cannot disable a ruleset or waive a required check.

## Step 1: Analyze the Changes

Conduct a file-by-file analysis of the PR or branch diff:

- **PR or branch summary**: The overall purpose and scope of the changes.
- **File-by-file analysis**: For each changed file, document its role in the codebase, the specific changes made, and their impact.

Consider both the PR author's description, when available, and the actual diff.

## Step 2: Provide Review Feedback

Review the analyzed changes and provide constructive, actionable feedback. Organize feedback by file with specific line references. Look for bugs, security issues, and non-idiomatic usage; avoid purely complimentary comments or unnecessary summaries.

### PR Title Review

- When reviewing a PR, ensure the title clearly and concisely describes the change.
- If it is vague, overly broad, or inaccurate, suggest an improved title.
- Skip title review for a branch without a PR.

### General Code Quality Criteria

- **Idiomatic usage**: Does TypeScript/ESM follow language best practices (types over `any`, `const`, async/await, no floating promises)?
- **Code quality**: Is the code maintainable and well-structured?
- **Readability**: Is the code clear and easy to understand?
- **Simplicity**: Is it as simple as possible? Avoid unnecessary complexity, helpers, or abstractions for one-off operations.
- **Performance**: Are there avoidable performance issues?
- **Bugs and edge cases**: Are error paths and edge cases (empty input, missing config, network failure) handled?

### Security Criteria

- **Command execution**: Flag building shell strings from interpolated values or running `execFile`/`spawn` with `{ shell: true }` on user-controlled input. CLI calls (`gh`, `az`, `aws`) must pass arguments as a separate argv array, never concatenated into a single string.
- **Webview / HTML**: Any value rendered into webview HTML must be escaped; flag unescaped interpolation in browser and page-rendering code.
- **Supply chain**: Flag piping remote scripts into a shell (`curl ... | bash`). Prefer pinned, released binaries (or pin + verify a checksum). GitHub Actions should be pinned to commit SHAs and tools to explicit versions.
- **Secrets**: Never store, log, or pass tokens/PATs as workflow inputs. Treat only true secrets as GitHub Actions secrets; non-secret identifiers (subscription/tenant/client/account IDs, regions, resource groups) belong in `vars`.

### Repo-Specific Criteria

- **Generated artifact**: `.artifacts/radius/` is produced by `packages/adapter-canvas/build.mjs` and must never be hand-edited. For adapter/core source changes, check applicable build evidence and bundle consistency according to the current code-quality policy; do not require generated output to be committed.
- **Core/adapter boundary**: Use the architecture rules in `radius-code-quality` to assess package ownership and dependency direction. Flag leakage of UI/process concerns into core, or duplicated product logic in an adapter.
- **Workflow-YAML generators** (`packages/core/src/platforms/*`, `packages/core/src/workflows/*`): Ensure `secrets.*` vs `vars.*` references match where the values are actually set, prefer OIDC/workload-identity (`azure wi`, `aws irsa`) over static credentials, and guard against unknown providers (`getPlatform` may return `undefined`).
- **Changesets**: Use `monorepo-changeset` to discover affected release units and determine whether notable user-facing changes need a Changeset, or contributor-only changes warrant proposing `pr:no-changeset`. Do not infer the release package from an implementation directory.
- **Typecheck and tests**: Assess `pnpm run typecheck` and the applicable build, test, boundary, and coverage evidence required by `radius-code-quality`. Distinguish observed failures from checks not performed.

### Unit Test Review Criteria

When tests are present, look for: clear and concise test cases, adequate assertions, proper setup/teardown, descriptive names, good helper reuse to avoid duplication, parameterized cases instead of copy/paste, and coverage of edge cases and error paths. Use `radius-code-quality` for mandatory test levels and coverage requirements.

For every request to add a test, identify the concrete missing regression scenario or required boundary contract. Prefer extending the existing suite at the lowest level that faithfully exercises it. Do not request duplicate heavyweight coverage, a new E2E suite for every change, or assertions whose only purpose is to execute a line. Higher-level tests must protect a distinct integration risk rather than repeat unit-test scenarios.

Preserve all applicable rows of the [test-evidence matrix](../radius-code-quality/SKILL.md#required-pull-request-test-evidence) and its coverage floors. Avoiding redundant tests does not justify omitting required unit, boundary, success, failure, or edge-case coverage. Credentialed cloud E2E stays off PRs; scheduled/release qualification neither becomes a PR requirement nor replaces required pre-merge coverage. Prose-only changes do not need product tests unless they alter executable examples, generated inputs, test configuration, or product behavior.

## Step 3: Validate Your Review

Act as a critic of your own review before returning findings or, when explicitly requested, posting:

- **Accuracy**: File names, paths, and line numbers are correct.
- **Clarity**: Comments are clear, concise, and actionable.
- **Value**: Remove comments that are purely complimentary.
- **Correctness**: Findings align with the actual diff. For inline PR comments, the cited line is on the `RIGHT`/added side of the PR diff.

### Line-number accuracy (mandatory)

GitHub silently attaches a comment to whatever line you name, so a wrong number is never reported as an error. To prevent this:

- **Never type a line number from memory.** Find the exact line by searching the reviewed version of the file for a unique substring on it. Use a line-numbered search tool, or `rg -n` with the path syntax appropriate to the host.
- Record the **anchor** (the unique snippet you searched for) next to each comment; the anchor, not the integer, is the source of truth.
- Verify before returning or posting by printing the actual content at each cited line and confirming it matches the anchor. For a remote PR, use the reviewed head version, not a different local checkout.

## Review Output Format

Structure review comments as:

```text
path/to/file.ext
    Line X (anchor: `unique snippet from line X`): Specific issue description
    Line Y (anchor: `unique snippet from line Y`): Suggestion for improvement
```

### Closing summary

For local/manual reviews, close with the following information in chat. When posting a review is explicitly authorized, include it once in the review summary rather than repeating it on every inline finding:

- **Findings:** count new actionable findings, with blocking and non-blocking counts. Group instances of the same bug class as one finding with all affected locations. Report outstanding prior findings separately so they are not counted as new.
- **No findings:** when there are none, say "No new actionable findings." Say whether prior findings remain unresolved. This does not mean unrun checks passed or excluded content was reviewed.
- **Read first:** identify up to two or three changed locations a human should read first and explain the concrete risk at each (for example, changed permissions, a shell command, or a public API contract). These are reading recommendations, not additional findings. Name fewer or none when the change does not warrant them.
- **Evidence and limits:** state the reviewed scope/revision, checks actually observed or run with results, excluded content, and any missing history or verification.
- **Disposition or handoff:** give a clear recommendation; at the convergence limit, explicitly hand unresolved work to the author instead of prompting another automated round.

Choose the recommended review disposition based on severity; submit it only if explicitly requested:

- **Comment** for informational/non-blocking feedback.
- **Request changes** when blocking bugs, security issues, or broken builds exist.
- **Approve** only when explicitly asked.

### Verify guidance in GitHub Copilot PR reviews

GitHub Copilot code review runs on GitHub when Copilot reviews a pull request. This is distinct from an agent reviewing code in the Copilot CLI or desktop app. GitHub controls the PR review interface and overview comment. Its [customization guidance](https://docs.github.com/en/copilot/tutorials/customize-code-review) lists overview-comment and formatting changes as unsupported, and notes that Copilot may not follow every instruction consistently. This skill cannot guarantee that GitHub's reviewer loads it, uses the closing-summary format, or stops after three rounds. Local/manual reviewers still follow the summary contract above.

Before relying on this guidance in GitHub Copilot PR reviews, check its effect on a separately authorized sample PR containing the instruction changes. Record the head SHA and review URL. Inspect whether Copilot applies the canonical criteria, avoids repeated findings, reports a findings/no-findings result, and identifies genuinely risky changes for the human. Record each observed behavior and any missing output; a reviewer's claim that it loaded the skill is not sufficient. GitHub reads instructions and skills from the PR head, so changed guidance itself needs independent human scrutiny.

This check determines which parts of the guidance can be relied on in GitHub-run reviews; it is not a new required merge check. Mark unsupported summary or convergence behavior as unsupported, and behavior not yet observed as unverified. Do not silently duplicate the rule set into instruction files, claim successful verification without evidence, post extra GitHub comments without authorization, or add enforcement automation as part of this guidance-only change.

## Best Practices

1. Prefer specific over general: "Pass args as argv on line 14 instead of joining into a bash string" beats "improve the shell handling".
2. Provide rationale: explain *why* a change is needed, not just *what* to change.
3. Show correct vs incorrect patterns when clarifying a non-trivial issue.
4. Keep feedback consistent with existing codebase patterns and the core/adapter boundary.
5. Prioritize correctness, security, and readability over style nits.
