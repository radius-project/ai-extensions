# Contributing to Radius AI Extension

Radius AI Extension is in preview and under active development. We welcome
feedback in the form of issues along with code contributions that
follow the guidelines below.

For what this repository is and does, see the [README](./README.md). This guide
covers how to build, test, and contribute to it.

## How to contribute

We welcome pull request contributions from anyone (docs improvements, bug
fixes, features) as long as they follow a few guidelines:

- For very minor changes like correcting a typo, feel free to send a pull
  request.
- For larger changes, please start by [choosing an existing issue](https://github.com/radius-project/ai-extensions/issues),
  or [opening an issue](https://github.com/radius-project/ai-extensions/issues/new/choose)
  to work on.
- The maintainers will respond to your issue. Please work with the maintainers
  to ensure that what you're doing is in scope for the project before writing
  any code.
- If you have any doubt whether a contribution would be valuable, feel free to
  ask.

## Prerequisites

- [Node.js](https://nodejs.org/) `>= 18`
- [pnpm](https://pnpm.io/) `>= 9` (this repo uses `pnpm@9.15.9`)

## Repository layout

This is a [pnpm](https://pnpm.io/) workspace monorepo. Packages live under the
`@radius-project` scope.

| Path               | npm name                 | Responsibility                                                                     |
| ------------------ | ------------------------ | ---------------------------------------------------------------------------------- |
| `radius-core/`     | `@radius-project/core`   | Shared, UI-agnostic core: app graph, modeling, compute platforms, workflows.       |
| `adapters/shared/` | `@radius-project/shared` | Helpers shared across adapters (e.g. building the app graph via `rad`).            |
| `adapters/canvas/` | `@radius-project/canvas` | Copilot canvas adapter: SDK wiring + loopback HTTP host that backs the webview.    |

### The dependency rule

`radius-core` never imports from an adapter, the Copilot SDK, `node:http`, or the
DOM. Anything that touches the outside world goes through a **port**
(`radius-core/src/ports/index.ts`): `Shell`, `GitHub`, `StateStore`, `Clock`,
`Logger`. Adapters depend on the core, supply port implementations, and own all
UI/transport concerns. This keeps the product logic testable in isolation and
makes adding a second UI a thin layer rather than a fork.

See [`radius-core/README.md`](./radius-core/README.md) for the architecture and
step-by-step guides for the three most common changes: **adding a compute
platform**, **adding a canvas action/tool**, and **adding a new UI adapter**.

### Agentic skills

Agentic skills live in [`.copilot/skills/`](./.copilot/skills), one directory
per skill, each with a `SKILL.md` (name + description frontmatter and guidance)
and optional `references/`. The skills (`radius-app-bicep`, `radius-app-graph`,
`radius-environment`, `radius-deploy`) drive the same workflows the canvas
actions and tools expose. When you change a canvas action, tool, or workflow
behavior, update the matching skill so the agent's guidance stays in sync.

## Building

```bash
pnpm install
pnpm build           # bundles the canvas extension -> .github/radius/extension.mjs
```

Other useful scripts:

```bash
pnpm watch           # rebuild the canvas bundle on change
pnpm typecheck       # typecheck core + shared + canvas
```

> The compiled bundle is a generated artifact and is not committed. `pnpm build`
> (and CI) produces it. The canvas loader resolves the Copilot SDK
> (`@github/copilot-sdk`) at runtime, so the build intentionally leaves it
> unbundled.

## Testing

Tests live in `radius-core` and run with [Vitest](https://vitest.dev/).

```bash
pnpm -C radius-core test           # run all core tests once
pnpm -C radius-core test:watch     # run tests in watch mode
```

Run a single test file:

```bash
pnpm -C radius-core test -- src/graph/diff_test.ts
```

## Before you open a pull request

1. `pnpm typecheck` passes.
2. `pnpm -C radius-core test` passes (add or update tests for behavior changes).
3. `pnpm build` succeeds.
4. Add a changeset describing your change (see below).
5. Fill out the [pull request template](./.github/pull_request_template.md).

## Changesets

Packages are versioned and changelogged with
[Changesets](https://github.com/changesets/changesets). Add a changeset with
your change:

```bash
pnpm changeset
```

Select the affected packages, the bump level (`patch` / `minor` / `major`), and
write a user-facing summary. Commit the generated `.changeset/*.md` file with
your PR. See [`RELEASING.md`](./RELEASING.md) for the version/tag convention and
release flow.

## Developer Certificate of Origin

The Radius project follows the [Developer Certificate of Origin](https://developercertificate.org/).
This is a lightweight way for contributors to certify that they wrote or
otherwise have the right to submit the code they are contributing to the
project.

Contributors sign off that they adhere to these requirements by adding a
`Signed-off-by` line to commit messages.

```
This is my commit message

Signed-off-by: Random J Developer <random@developer.example.org>
```

Git has a `-s` command line option to append this automatically to your commit
message:

```bash
git commit -s -m 'This is my commit message'
```

Visual Studio Code has a setting, `git.alwaysSignOff`, to automatically add a
`Signed-off-by` line to commit messages. Search for "sign-off" in VS Code
settings to find it and enable it.

## Code of conduct

This project has adopted the [Contributor Covenant](https://contributor-covenant.org/).
For more information see the [Radius Community Code of Conduct](https://github.com/radius-project/community/blob/main/CODE-OF-CONDUCT.md).
