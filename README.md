# Radius Canvas Extension

A GitHub Copilot canvas extension for modeling and deploying applications with
Radius. The product logic is UI-agnostic and lives in a shared core; the canvas
adapter wires it into the Copilot canvas surface.

## Layout

| Path                     | Responsibility                                                                 |
| ------------------------ | ----------------------------------------------------------------------------- |
| `radius-core/`           | Shared, UI-agnostic core: app graph, modeling, compute platforms, workflows.  |
| `adapters/canvas/`       | Copilot canvas adapter: SDK wiring + loopback HTTP host that backs the webview. |

See each package's `README.md` for module-level detail and extension recipes.

## Build

This is a [pnpm](https://pnpm.io/) workspace monorepo (packages live under the
`@radius-project` scope).

```bash
pnpm install
pnpm build           # bundles the canvas extension -> .github/radius/extension.mjs
```

Other scripts:

```bash
pnpm watch           # rebuild on change
pnpm typecheck       # typecheck core + canvas
```

## Running Tests

Tests currently live in `radius-core` and are run with Vitest.

```bash
pnpm -C radius-core test           # run all core tests once
pnpm -C radius-core test:watch     # run tests in watch mode
```

Run a single test file:

```bash
pnpm -C radius-core test -- src/graph/diff_test.ts
```

The Copilot SDK (`@github/copilot-sdk`) is resolved by the canvas loader at
runtime and is intentionally not bundled.

## Releasing

Packages are versioned and changelogged with
[Changesets](https://github.com/changesets/changesets). Add a changeset with
your change (`pnpm changeset`) and see [`RELEASING.md`](./RELEASING.md) for the
version/tag convention and release flow.
