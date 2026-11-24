---
name: radius-pre-pr-review
description: 'Verify an implementation and get one fresh-context review before opening a pull request in ai-extensions. Use when preparing an implemented change for a PR, not when performing a read-only review.'
argument-hint: 'The implemented change and intended base branch'
user-invocable: true
---

# Pre-PR self-review

Use this workflow after implementing a change and before opening a PR. It prepares evidence and findings; it does not authorize creating a PR, submitting a GitHub review, approving a change, or changing settings. Read-only reviewers, including the reviewer invoked below, must not run this skill recursively.

## 1. Establish scope and verification

- Confirm the request, intended base, current head, and complete proposed diff, including staged, unstaged, and relevant untracked files. Use the configured/session base; ask if it is ambiguous. Do not discard unrelated user changes.
- Apply [radius-code-quality](../radius-code-quality/SKILL.md) to code changes. Map the change to every applicable row of its [test-evidence matrix](../radius-code-quality/SKILL.md#required-pull-request-test-evidence), then use the canonical [verification commands](../radius-code-quality/SKILL.md#verification). Do not maintain another baseline command list here.
- Start with targeted tests while iterating, then collect the applicable baseline evidence. Reuse existing suites and put scenarios at the lowest faithful layer. A higher-level case must protect a distinct boundary or cross-layer risk; do not duplicate business-logic scenarios or add assertions only to execute lines. This does not waive required matrix rows, success/error/boundary coverage, or coverage floors.
- Do not rerun runtime and HTTP integration separately when the coverage command already includes them. Do not add credentialed cloud E2E or scheduled reliability/real-host qualification to PR gates, or use those later runs to replace required pre-merge evidence.
- For documentation-only changes that do not alter executable examples, generated inputs, test configuration, or product behavior, run [radius-markdown-lint](../radius-markdown-lint/SKILL.md) and check affected links instead of product suites.
- Follow [contributor prerequisites](../../../CONTRIBUTING.md#prerequisites). Record exact commands, exit results, and concise relevant output, including failure diagnostics with secrets redacted. Mark unavailable environments or missing prerequisites as **not run**, not passed; require the applicable CI evidence before merge.
- If the change can affect Canvas UI, run the [canonical visual comparison](../../../CONTRIBUTING.md#canvas-visual-baselines) and inspect differences. Do not regenerate baselines to hide unexplained failures. If the canonical environment is unavailable, state the gap and require the owning CI comparison; unrelated adapter changes do not need new screenshots merely because of their directory.

## 2. Get one independent review

Invoke one fresh-context, read-only `code-review` subagent, or the client's equivalent isolated reviewer. Give it the user requirements, base/head identifiers, complete diff (including untracked additions), access to relevant source and tests, [radius-code-review](../radius-code-review/SKILL.md), applicable instructions, and the verification results. For an existing PR, include its review history so it can apply the canonical convergence rules. Do not give it the author's reasoning transcript or a request to rubber-stamp the implementation.

Ask it to follow the canonical review skill, return findings and its summary to the author, and make no edits or GitHub submissions. Do not ask it to open another reviewer or run this pre-PR skill. Use the client's configured reviewer model unless the user requested a particular model. If isolated review is unavailable, state that it was not performed and ask for an independent human or supported reviewer; a second pass in the same context does not count as fresh-context evidence.

## 3. Address findings and simplify

Evaluate each finding against the diff. Fix confirmed issues; explain why a finding is inapplicable or needs a user decision rather than silently dropping it. Do not change unrelated code to appease a reviewer. Stop for unresolved correctness or safety issues.

Make a separate simplification pass over the proposed changes: remove newly introduced dead code, unused helpers, unnecessary abstractions, and edits outside the task. Preserve user-owned changes. Rerun checks affected by fixes or simplification and identify any changes made after the independent review. Use the same reviewer for a bounded follow-up when needed, rather than repeatedly spawning reviewers until one approves.

## 4. Prepare the handoff

Use [monorepo-changeset](../monorepo-changeset/SKILL.md) to decide whether a Changeset is needed. When PR creation is authorized, fill the repository's [PR template](../../pull_request_template.md), preserving its sections. Put each applicable test-matrix row and its evidence under **Test evidence**; use "Documentation only" when no row applies. Keep reproducible steps and expected results under **How to test**, separate from commands already run.

Return the reviewed base/head or workspace scope, exact validation results with relevant output, independent review findings and their resolution, remaining limitations, and release-impact decision. Do not describe the change as fully verified when checks or independent review are missing, and do not claim a local review proves hosted Copilot behavior.
