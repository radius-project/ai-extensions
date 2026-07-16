# Radius Plugin

Model, visualize, and deploy applications with [Radius](https://radapp.io)
directly from GitHub Copilot. The plugin bundles four skills and a canvas
extension that turn Copilot into a Radius application-modeling and deployment
assistant.

It is a standard [GitHub Copilot plugin](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-cli-plugins),
so it works anywhere plugins are supported — including the
[GitHub Copilot app](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app#adding-plugins)
and the GitHub Copilot CLI.

## Installation

### GitHub Copilot app

Open app settings, click **Plugins**, then browse to and install the `radius`
plugin from the `radius-project/ai-extensions` marketplace. See
[Adding plugins](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app#adding-plugins)
for details.

### GitHub Copilot CLI

Type these at the Copilot prompt (they are Copilot slash commands, not shell commands):

```text
# Add this marketplace (one-time setup)
/plugin marketplace add radius-project/ai-extensions

# Install the plugin
/plugin install radius@radius-plugins
```

Restart your Copilot session after installing so the skills and the canvas
extension become available.

> **NOTE:** The canvas `extension.mjs` is a compiled build artifact that is not committed to `main`. CI rebuilds it on every merge and publishes it to a generated `release` branch, and the marketplace manifest pins the plugin `source` to that branch — so the commands above install the skills and a working canvas without any manual build. See [`docs/design/2026-07-canvas-bundle-publishing.md`](../../docs/design/2026-07-canvas-bundle-publishing.md).

## What's included

### Skills

| Skill | Use it when you want to… |
| ----- | ------------------------- |
| `radius-app-bicep` | Generate or update the `.radius/app.bicep` manifest from a repo's contents. |
| `radius-app-graph` | Build, refresh, or diff the Radius application graph. |
| `radius-environment` | Create and verify an AWS/Azure deploy environment and its OIDC trust. |
| `radius-deploy` | Deploy (or troubleshoot) an app via the generated GitHub Actions workflow. |

### Canvas extension

`extension.mjs` registers the **Radius** canvas
plus supporting tools for OIDC configuration, `app.bicep` generation,
application-graph rendering, PR graph diffs, and environment creation. It is a
built artifact — see [Development](#development) to rebuild it.

## Usage

Once installed, just ask Copilot naturally:

```
generate an app.bicep for this repo
show me the application graph
set up cloud credentials for Azure
deploy my app
```

## Development

The canvas extension is produced from TypeScript source in the repository root
(`radius-core/` + `adapters/canvas/`) via esbuild:

```bash
pnpm install
pnpm build        # bundles -> plugins/radius/extension.mjs
```

See the repository [`README.md`](../../README.md) and
[`radius-core/README.md`](../../radius-core/README.md) for architecture and
extension recipes.
