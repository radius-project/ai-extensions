# Radius Plugin

Model, visualize, and deploy applications with [Radius](https://radapp.io) directly from the GitHub Copilot app. The plugin bundles seven skills and a canvas extension that turn Copilot into a Radius application-modeling and deployment assistant.

The canvas runs only in the
[GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app#adding-plugins),
which is the only host that can display it, so the plugin is installed from the app.

## Installation

Install the plugin from the GitHub Copilot app: open app settings, click
**Plugins**, add the `radius-project/ai-extensions` marketplace, then browse to and
install the `radius` plugin. See
[Adding plugins](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app#adding-plugins)
for details.

Restart your Copilot session after installing so the skills and the canvas
extension become available.

> **NOTE:** Due to a GitHub Copilot app bug, the canvas may not appear after installing or updating the plugin, even though the skills load. If the Radius canvas is missing, run the bundled `radius-fix-canvas-installation` skill (ask Copilot to "fix radius canvas") and then reload extensions or restart the app. This is a temporary workaround that will be removed once the upstream bug is fixed.

<!-- markdownlint-disable-next-line MD028 -->

> **NOTE:** The canvas `extension.mjs` is a compiled build artifact that is not committed to `main`. CI rebuilds it on every merge, assembles the complete plugin into `plugins/radius/dist/`, and publishes that to a generated `releases/edge` branch (also tagged `edge`); the marketplace manifest pins the plugin `source` to that path and branch — so installing from the app delivers the skills and canvas without any manual build. See [`docs/design/2026-07-canvas-bundle-publishing.md`](../../docs/design/2026-07-canvas-bundle-publishing.md).

## What's included

### Skills

| Skill                            | Use it when you want to…                                                                                                                                                        |
|----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `radius-app-overview`            | Understand an application and discover how Radius can visualize and deploy it.                                                                                                  |
| `radius-app-bicep`               | Generate or update the `.radius/app.bicep` manifest from a repo's contents.                                                                                                     |
| `radius-app-graph`               | Build, refresh, or diff the Radius application graph.                                                                                                                           |
| `radius-environment`             | Create and verify an AWS/Azure deploy environment and its OIDC trust.                                                                                                           |
| `radius-deploy`                  | Deploy (or troubleshoot) an app via the generated GitHub Actions workflow.                                                                                                      |
| `radius-delete`                  | Delete a deployed app via the generated GitHub Actions workflow, or remove a GitHub deploy environment.                                                                         |
| `radius-fix-canvas-installation` | Repair a missing Radius canvas after install/update by copying the canvas files into the app's probed `extensions/` folder (temporary workaround for a GitHub Copilot app bug). |

### Canvas extension

`extension.mjs` registers the **Radius** canvas
plus supporting tools for OIDC configuration, `app.bicep` generation,
application-graph rendering, PR graph diffs, and environment creation. It is a
built artifact — see [Development](#development) to rebuild it.

## Usage

Once installed, just ask Copilot naturally:

```text
explain this app to me
generate an app.bicep for this repo
show me the application graph
set up cloud credentials for Azure
deploy my app
```

## Development

The canvas extension is produced from TypeScript source in the repository root
(`packages/core/` + `packages/adapter-canvas/`) via esbuild:

```bash
pnpm install
pnpm build        # bundles -> plugins/radius/dist/
```

See the repository [`README.md`](../../README.md) and
[`packages/core/README.md`](../../packages/core/README.md) for architecture and
extension recipes.
