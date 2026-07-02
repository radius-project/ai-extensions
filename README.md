# Radius for GitHub Copilot CLI

A GitHub Copilot CLI **plugin marketplace** for modeling and deploying
applications with Radius. The product logic is UI-agnostic and lives in a shared
core; the canvas adapter wires it into the Copilot canvas surface, and the whole
thing is packaged as an installable plugin.

## Install the plugin

```bash
# In GitHub Copilot CLI
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

The Copilot SDK (`@github/copilot-sdk`) is resolved by the canvas loader at
runtime and is intentionally not bundled.

## Releasing

Packages are versioned and changelogged with
[Changesets](https://github.com/changesets/changesets). Add a changeset with
your change (`pnpm changeset`) and see [`RELEASING.md`](./RELEASING.md) for the
version/tag convention and release flow.
