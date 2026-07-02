# Radius Plugin

Model, visualize, and deploy applications with [Radius](https://radapp.io) from
GitHub Copilot CLI. The plugin bundles four skills and a canvas extension that
turn Copilot into a Radius application-modeling and deployment assistant.

## Installation

### Via the GitHub Copilot CLI plugin marketplace

```bash
# 1. Open GitHub Copilot CLI
copilot

# 2. Add this marketplace (one-time setup)
/plugin marketplace add radius-project/ai-extensions

# 3. Install the plugin
/plugin install radius@ai-extensions
```

Restart your Copilot CLI session after installing so the skills and the canvas
extension become available.

## What's included

### Skills

| Skill | Use it when you want to… |
| ----- | ------------------------- |
| `radius-app-bicep` | Generate or update the `.radius/app.bicep` manifest from a repo's contents. |
| `radius-app-graph` | Build, refresh, or diff the Radius application graph. |
| `radius-environment` | Create and verify an AWS/Azure deploy environment and its OIDC trust. |
| `radius-deploy` | Deploy (or troubleshoot) an app via the generated GitHub Actions workflow. |

### Canvas extension

`extensions/radius/extension.mjs` registers the **Radius** canvas (`lattice`)
plus supporting tools for OIDC configuration, `app.bicep` generation,
application-graph rendering, PR graph diffs, and environment creation. It is a
built artifact — see [Development](#development) to rebuild it.

## Usage

Once installed, just ask Copilot naturally:

```
You: generate an app.bicep for this repo
You: show me the application graph
You: set up cloud credentials for Azure
You: deploy my app
```

## Development

The canvas extension is produced from TypeScript source in the repository root
(`radius-core/` + `adapters/canvas/`) via esbuild:

```bash
pnpm install
pnpm build        # bundles -> plugins/radius/extensions/radius/extension.mjs
```

See the repository [`README.md`](../../README.md) and
[`radius-core/README.md`](../../radius-core/README.md) for architecture and
extension recipes.
