# Working in ai-extensions

This pnpm monorepo builds Radius application modeling, graph visualization, and deployment tools. Read [CONTRIBUTING.md](../CONTRIBUTING.md) for setup and [the architecture index](../docs/architecture/README.md) for the relevant subsystem.

## Package boundaries

- `packages/core` owns UI-agnostic product logic behind typed ports. It must not depend on adapters, the Copilot SDK, HTTP implementations, or the DOM.
- `packages/adapter-shared` owns reusable Node adapter behavior.
- `packages/adapter-canvas` owns Copilot SDK wiring, loopback HTTP, pages, and browser behavior.
- `packages/graph-react` owns browser-safe React graph presentation. Follow the dependency rules in [radius-code-quality](skills/radius-code-quality/SKILL.md).
- `extensions/radius` contains the extension manifest and shipped agent skills. `.github/skills` contains contributor skills, not shipped product skills.
- `.github/extension` contains workflows shipped to users; `.github/workflows` runs repository CI. Both require careful review of credentials, permissions, and untrusted inputs.

## Source and generated files

Never hand-edit `.artifacts/`; rebuild from source. `plugins/` contains tracked plugin metadata in development and assembled artifacts on release branches. Do not assume every file there is generated. Files marked as synced from `radius-project/.github` must be changed upstream rather than only in this repository.

## Verification and review

Use the Node and pnpm versions specified by the repository and the [contributor prerequisites](../CONTRIBUTING.md#prerequisites).

For code changes, apply [radius-code-quality](skills/radius-code-quality/SKILL.md), its [test-evidence matrix](skills/radius-code-quality/SKILL.md#required-pull-request-test-evidence), and its [verification commands](skills/radius-code-quality/SKILL.md#verification). Keep those sections as the source of truth rather than copying the command list here. For prose-only changes, use [radius-markdown-lint](skills/radius-markdown-lint/SKILL.md); do not run product suites solely for prose.

When reviewing a PR or branch, use the canonical [radius-code-review](skills/radius-code-review/SKILL.md) skill. Before opening a PR as an implementation agent, use [radius-pre-pr-review](skills/radius-pre-pr-review/SKILL.md). A read-only reviewer must not start that implementation workflow. Use [monorepo-changeset](skills/monorepo-changeset/SKILL.md) to assess release impact. These skills do not authorize publishing a review, opening a PR, or changing repository settings.
