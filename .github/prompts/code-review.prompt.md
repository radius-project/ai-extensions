---
mode: agent
description: "Review a pull request in the ai-extensions repo for bugs, security issues, idiomatic TypeScript/ESM, and repo-specific conventions (radius-core vs canvas adapter, generated extension.mjs, workflow-YAML generators, Changesets)."
---

# Review a Pull Request

Review the pull request `${input:pr:PR number or URL (leave blank for the current branch)}`
in the `ai-extensions` repository and produce actionable, well-structured feedback. If no PR
is given, review the current branch's diff against its base.

This repo is a pnpm-workspace monorepo: UI-agnostic product logic lives in
`radius-core` (TypeScript) and the Copilot-canvas SDK wiring + webview host lives
in `adapters/canvas` (ESM `.mjs`). The canvas adapter is bundled by esbuild into a
single generated artifact, `plugins/radius/extension.mjs`.

**Error handling:**
- If files are too large to analyze completely, focus on the most critical changes and say so in the review.
- If you cannot access certain files, note the limitation in the review.

## Code Review Principles

- **Be concise and direct**: Prefer short, imperative statements over long paragraphs.
- **Focus on actionable feedback**: Avoid vague directives like "be more accurate" or "identify all issues".
- **Be specific**: Provide exact file paths, line numbers, and clear issue descriptions.
- **Structure matters**: Organize feedback by file with clear headings and bullet points.
- **Show examples**: Demonstrate the fix with sample code when it clarifies the point.
- **Avoid generic praise**: Remove purely complimentary comments; focus on what needs to change.

## Before Starting a Review

1. Use the active pull request context (`gh pr view`, `gh api`) to understand the PR's purpose and scope.
2. Read [README.md](../../README.md) and [radius-core/README.md](../../radius-core/README.md) for the architecture and core/adapter boundary.
3. Check for related issues referenced in the PR description and any prior review discussion.
4. Note which packages are touched (`radius-core`, `adapters/canvas`) and whether the change is user-facing.

## Step 1: Analyze the Changes

Conduct a file-by-file analysis of the PR:

- **PR summary**: The overall purpose and scope of the changes.
- **File-by-file analysis**: For each changed file, document its role in the codebase, the specific changes made, and their impact.

Consider both the PR author's description and the actual diff.

## Step 2: Provide Review Feedback

Review the analyzed changes and provide constructive, actionable feedback. Organize
feedback by file with specific line references. Look for bugs, security issues, and
non-idiomatic usage; avoid purely complimentary comments or unnecessary summaries.

### PR Title Review

- Ensure the title clearly and concisely describes the change.
- If it is vague, overly broad, or inaccurate, suggest an improved title.

### General Code Quality Criteria

- **Idiomatic usage**: Does TypeScript/ESM follow language best practices (types over `any`, `const`, async/await, no floating promises)?
- **Code quality**: Is the code maintainable and well-structured?
- **Readability**: Is the code clear and easy to understand?
- **Simplicity**: Is it as simple as possible? Avoid unnecessary complexity, helpers, or abstractions for one-off operations.
- **Performance**: Are there avoidable performance issues?
- **Bugs and edge cases**: Are error paths and edge cases (empty input, missing config, network failure) handled?

### Security Criteria

- **Command execution**: Flag building shell strings from interpolated values or running `execFile`/`spawn` with `{ shell: true }` on user-controlled input. CLI calls (`gh`, `az`, `aws`) must pass arguments as a separate argv array, never concatenated into a single string.
- **Webview / HTML**: Any value rendered into webview HTML must be escaped; flag unescaped interpolation in `client.mjs` and related host code.
- **Supply chain**: Flag piping remote scripts into a shell (`curl ... | bash`). Prefer pinned, released binaries (or pin + verify a checksum). GitHub Actions should be pinned to commit SHAs and tools to explicit versions.
- **Secrets**: Never store, log, or pass tokens/PATs as workflow inputs. Treat only true secrets as GitHub Actions secrets; non-secret identifiers (subscription/tenant/client/account IDs, regions, resource groups) belong in `vars`.

### Repo-Specific Criteria

- **Generated artifact**: `plugins/radius/extension.mjs` is produced by `adapters/canvas/build.mjs` — never hand-edited. If adapter/core source changed, confirm the bundle was rebuilt (`pnpm run build`) and is in sync.
- **Core/adapter boundary**: Keep UI-agnostic logic in `radius-core` and Copilot/webview wiring in `adapters/canvas`. Flag leakage of UI/process concerns into core, or duplicated product logic in the adapter.
- **Workflow-YAML generators** (`radius-core/src/platforms/*`, `radius-core/src/workflows/*`): Ensure `secrets.*` vs `vars.*` references match where the values are actually set, prefer OIDC/workload-identity (`azure wi`, `aws irsa`) over static credentials, and guard against unknown providers (`getPlatform` may return `undefined`).
- **Changesets**: A user-facing change to `radius-core` or `adapters/canvas` should include a changeset under `.changeset/`.
- **Typecheck**: Confirm `pnpm run typecheck` (core + canvas) passes for the change.

### Unit Test Review Criteria

When tests are present, look for: clear and concise test cases, adequate assertions,
proper setup/teardown, descriptive names, good helper reuse to avoid duplication,
parameterized cases instead of copy/paste, and coverage of edge cases and error paths.

## Step 3: Validate Your Review

Act as a critic of your own review before posting:

- **Accuracy**: File names, paths, and line numbers are correct.
- **Clarity**: Comments are clear, concise, and actionable.
- **Value**: Remove comments that are purely complimentary.
- **Correctness**: Findings align with the actual diff (the cited line is on the `RIGHT`/added side).

### Line-number accuracy (mandatory)

GitHub silently attaches a comment to whatever line you name, so a wrong number is
never reported as an error. To prevent this:

- **Never type a line number from memory.** Find the exact line by searching the file for a unique substring on it:

  ```bash
  grep -n 'function radiusRenderGraph' adapters/canvas/src/client.mjs
  ```

- Record the **anchor** (the unique snippet you grepped for) next to each comment; the anchor — not the integer — is the source of truth.
- Verify before posting by printing the actual content at each cited line and confirming it matches the anchor.

## Review Output Format

Structure review comments as:

```text
path/to/file.ext
    Line X (anchor: `unique snippet from line X`): Specific issue description
    Line Y (anchor: `unique snippet from line Y`): Suggestion for improvement
```

Close with an overall PR assessment that summarizes the key findings and a clear
recommendation. Choose the review disposition based on severity:

- **Comment** for informational/non-blocking feedback.
- **Request changes** when blocking bugs, security issues, or broken builds exist.
- **Approve** only when explicitly asked.

## Best Practices

1. Prefer specific over general — "Pass args as argv on line 14 instead of joining into a bash string" beats "improve the shell handling".
2. Provide rationale — explain *why* a change is needed, not just *what* to change.
3. Show correct vs incorrect patterns when clarifying a non-trivial issue.
4. Keep feedback consistent with existing codebase patterns and the core/adapter boundary.
5. Prioritize correctness, security, and readability over style nits.
