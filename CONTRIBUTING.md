# Contributing to Radius Canvas

Radius Canvas is in preview and under active development. We welcome feedback in the form of issues along with code contributions that follow the guidelines below.

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

- [Node.js](https://nodejs.org/) 24 (the active major is recorded in [`.node-version`](./.node-version))
- [pnpm](https://pnpm.io/) `>= 9` (this repo uses `pnpm@9.15.9`)

## Repository layout

This is a [pnpm](https://pnpm.io/) workspace monorepo. Packages live under the
`@radius-project` scope.

| Path                       | npm name                         | Responsibility                                                                  |
|----------------------------|----------------------------------|---------------------------------------------------------------------------------|
| `packages/core/`           | `@radius-project/core`           | Shared, UI-agnostic core: app graph, modeling, compute platforms, workflows.    |
| `packages/adapter-shared/` | `@radius-project/adapter-shared` | Helpers shared across adapters (e.g. building the app graph via `rad`).         |
| `packages/adapter-canvas/` | `@radius-project/adapter-canvas` | Copilot canvas adapter: SDK wiring + loopback HTTP host that backs the webview. |

The `adapter-` directory prefix is deliberate: it marks a package as an adapter at a glance and is what the core boundary lint rule in [`eslint.config.mjs`](./eslint.config.mjs) matches on to reject relative imports that escape into an adapter. The npm names stay unprefixed, so a directory name and its npm name differ by that prefix.

### The dependency rule

`packages/core` never imports from an adapter, the Copilot SDK, `node:http`, or the
DOM. Anything that touches the outside world goes through a **port**
(`packages/core/src/ports/index.ts`). Reading a repository is the only side
effect core's use-cases need today, so `GitHub` is the only port. Adapters depend
on the core, supply port implementations, and own all UI/transport concerns. This
keeps the product logic testable in isolation and makes adding a second UI a thin
layer rather than a fork.

See [`packages/core/README.md`](./packages/core/README.md) for the architecture and
step-by-step guides for the three most common changes: **adding a compute
platform**, **adding a canvas action/tool**, and **adding a new UI adapter**.

### Agentic skills

Agentic skills live in [`extensions/radius/skills/`](./extensions/radius/skills), one directory
per skill, each with a `SKILL.md` (name + description frontmatter and guidance)
and optional `references/`. The skills (`radius-app-bicep`, `radius-app-graph`,
`radius-environment`, `radius-deploy`) drive the same workflows the canvas
actions and tools expose. When you change a canvas action, tool, or workflow
behavior, update the matching skill so the agent's guidance stays in sync.

## Building

```bash
pnpm install
pnpm build           # assembles the installable plugin -> .artifacts/radius/
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

Tests live across the workspace packages and run together through the root [Vitest](https://vitest.dev/) projects configuration.

```bash
pnpm test              # run every workspace test project once
pnpm test:watch        # run every workspace test project in watch mode
pnpm coverage          # run every project with unified V8 coverage
```

Run a single test file:

```bash
pnpm test -- packages/core/src/graph/diff.test.ts
```

### Canvas visual baselines

Run `pnpm test:visual:canonical` before opening a pull request that can affect Canvas UI. The command works from Linux, macOS, and Windows by building and running the same pinned multi-architecture Ubuntu 24.04, Node.js, pnpm, Playwright, and Chromium container used by **Canvas Functional Tests**. It compares every visual state twice with retries disabled, exits nonzero for a mismatch or unstable repeat, and cannot rewrite the committed PNGs because check mode mounts the baseline directory read-only. Docker Desktop or Docker Engine with a Linux AMD64 or ARM64 engine must be installed and running; the image selects the matching native architecture instead of relying on CPU emulation. The command reports which prerequisite is unavailable before attempting a build.

When a check fails, inspect `packages/adapter-canvas/test-results/visual/` for actual, expected, and diff images or open `packages/adapter-canvas/playwright-visual-report/index.html`. If the UX change is intentional, run `pnpm test:visual:canonical:update`, review every changed file under `packages/adapter-canvas/test/visual/__screenshots__/`, rerun `pnpm test:visual:canonical`, and commit the reviewed PNGs with the product change. Do not use update mode to accept an unexplained rendering difference.

The container supplies canonical Linux rasterization on every developer host; it does not prove native Canvas functionality on that host. The separate reliability workflow continues to qualify behavioral checks natively on Ubuntu, Windows, and macOS.

## Before you open a pull request

1. `pnpm typecheck` passes.
2. `pnpm test` passes across all projects (add or update tests for behavior changes).
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
your PR. Do not hand-edit any version: Changesets bumps `extensions/radius/package.json`, and `plugin.json` and `marketplace.json` are derived from it by `pnpm run version:sync`, which CI verifies. See [`RELEASING.md`](./docs/eng/RELEASING.md) for the version/tag convention and
release flow.

Not every change ships something. A pull request without a changeset is never blocked - CI only leaves a reminder comment. If the omission is deliberate, either add an empty changeset with `pnpm changeset --empty` or label the pull request `pr:no-changeset`, which replaces the reminder with a note that it was waived.

## Developer Certificate of Origin

The Radius project follows the [Developer Certificate of Origin](https://developercertificate.org/).
This is a lightweight way for contributors to certify that they wrote or
otherwise have the right to submit the code they are contributing to the
project.

Contributors sign off that they adhere to these requirements by adding a
`Signed-off-by` line to commit messages.

```text
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
