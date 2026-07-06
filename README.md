# Radius for GitHub Copilot

A GitHub Copilot **plugin** for modeling and deploying applications with Radius.
The product logic is UI-agnostic and lives in a shared core; the canvas adapter
wires it into the Copilot canvas surface, and the whole thing is packaged as an
installable plugin (distributed through the marketplace in this repo) that works
anywhere GitHub Copilot plugins are supported — the GitHub Copilot app and the
GitHub Copilot CLI.

## Install the plugin

In the **GitHub Copilot app**, open app settings, click **Plugins**, and install
the `radius` plugin from the `radius-project/ai-extensions` marketplace.

In the **GitHub Copilot CLI**:

```bash
/plugin marketplace add radius-project/ai-extensions
/plugin install radius@ai-extensions
```

See [`plugins/radius/README.md`](./plugins/radius/README.md) for what the plugin
bundles and how to use it.

## Layout

| Path                     | Responsibility                                                                 |
| ------------------------ | ----------------------------------------------------------------------------- |
| `.github/plugin/marketplace.json` | Marketplace manifest listing the `radius` plugin.                     |
| `plugins/radius/`        | The installable plugin: `plugin.json` manifest, skills, and the canvas extension. |
| `radius-core/`           | Shared, UI-agnostic core: app graph, modeling, compute platforms, workflows.  |
| `adapters/canvas/`       | Copilot canvas adapter: SDK wiring + loopback HTTP host that backs the webview. |

The plugin's canvas extension (`plugins/radius/extensions/radius/extension.mjs`)
is a build artifact produced from `radius-core/` + `adapters/canvas/`.

See each package's `README.md` for module-level detail and extension recipes.

## Build

This is a [pnpm](https://pnpm.io/) workspace monorepo (packages live under the
`@radius-project` scope).

```bash
pnpm install
pnpm build           # bundles the canvas extension -> plugins/radius/extensions/radius/extension.mjs
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
