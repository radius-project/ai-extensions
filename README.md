# Radius AI Extension

Radius AI Extension is a GitHub Copilot **plugin** for the
[GitHub Copilot app](https://docs.github.com/en/copilot/concepts/agents/github-copilot-app).
It lets you define, visualize, and deploy an
application with [Radius](https://github.com/radius-project/radius) without
leaving Copilot. Radius is a cloud-native application platform that helps
developers and platform engineers build and manage applications together.

## Install the plugin

The Radius canvas runs only in the
[GitHub Copilot app](https://docs.github.com/en/copilot/concepts/agents/github-copilot-app),
so install the plugin from the app: open app settings, click **Plugins**, add the
`radius-project/ai-extensions` marketplace, and install the `radius` plugin.

The canvas extension is a compiled bundle that is not committed to `main`. CI builds it on every merge and publishes it — together with the skills and manifest — to a generated `release` branch, and the marketplace manifest points the plugin at that branch, so installing from the app pulls the skills and canvas automatically. See [`docs/design/2026-07-canvas-bundle-publishing.md`](./docs/design/2026-07-canvas-bundle-publishing.md) for how this works.

See [`plugins/radius/README.md`](./plugins/radius/README.md) for what the plugin
bundles and how to use it.

> **NOTE:** Radius AI Extension is in preview. Send us your feedback:
> [open an issue](https://github.com/radius-project/ai-extensions/issues/new/choose)
> and tell us what you think.

## Overview

The [GitHub Copilot app](https://docs.github.com/en/copilot/concepts/agents/github-copilot-app)
is a desktop application for agent-driven development, available on macOS, Linux,
and Windows. It is built on the GitHub Copilot CLI and integrates natively with
GitHub, so your repositories, branches, issues, and pull requests work out of the
box. The app gives you one place to direct AI agents across parallel workstreams
and manage the full development lifecycle.

Within the app, a [canvas extension](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions)
is a shared, interactive surface where people and agents collaborate on a work
artifact. Canvases are bidirectional: the agent updates the canvas as it works,
and you steer, edit, and verify directly on the same surface instead of relying
on chat alone. A canvas opens in the app's right side panel and combines UI
controls for people with agent-callable capabilities. Each canvas extension is a
small package (typically a `package.json` and an `extension.mjs` entry file) that
defines the canvas behavior and its capabilities.

The **Radius Canvas extension** turns your source code into a modeled Radius
application, shows that application as a live graph across its lifecycle, and
deploys it to your cloud environment, all from inside Copilot. It is organized
into three areas:

- **Applications.** The application graph models the source code in your GitHub
  repository and renders it as a live graph with four views:
  - **Modeled**: the application as you've designed it.
  - **Planned**: the application as you want it deployed.
  - **Deployed**: the application as it runs in your environments.
  - **Diff**: what changed between two branches, such as a pull request against
    `main`.
- **Environments.** An environment is the landing zone that defines where an
  application deploys. You create an environment for Azure, verify its
  credentials, and configure the infrastructure your applications run on.
- **Deployments.** A deployment sends an application to a configured environment.
  Radius provisions the cloud infrastructure the application needs and runs it
  through the generated GitHub Actions workflow.

The product logic is UI-agnostic and lives in a shared core (`radius-core`), so
the same modeling, graph, platform, and workflow-generation logic can back
additional UI surfaces beyond the Copilot canvas in the future.

## Agentic skills

The repository also ships a set of agentic skills under
[`plugins/radius/skills/`](./plugins/radius/skills). Each skill tells the agent how and when
to drive a part of the Radius workflow, and pairs with the matching canvas
actions and tools:

| Skill                                                              | What it does                                                                                              |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| [`radius-app-bicep`](./plugins/radius/skills/radius-app-bicep/SKILL.md)     | Analyze a repository and generate a Radius application definition that models the app's components and their dependencies. |
| [`radius-app-graph`](./plugins/radius/skills/radius-app-graph/SKILL.md)     | Build and visualize the Radius application graph for a repo, including single-branch and PR-diff modes.   |
| [`radius-environment`](./plugins/radius/skills/radius-environment/SKILL.md) | Create and verify a Radius deploy environment for Azure, including the OIDC trust with GitHub Actions. |
| [`radius-deploy`](./plugins/radius/skills/radius-deploy/SKILL.md)           | Deploy a Radius application to a configured environment via the auto-generated GitHub Actions workflow.    |
| [`radius-fix-canvas-installation`](./plugins/radius/skills/radius-fix-canvas-installation/SKILL.md) | Repair a missing Radius canvas after install/update by copying the canvas files into the app's probed `extensions/` folder (temporary workaround for a GitHub Copilot app bug). |

## Architecture

This is a [pnpm](https://pnpm.io/) workspace monorepo. UI-agnostic product logic
lives in a shared core (`radius-core`), and the Copilot canvas adapter
(`adapters/canvas`) wires it into the GitHub Copilot app. The core never depends
on an adapter, the Copilot SDK, HTTP, or the DOM; anything that touches the
outside world goes through a **port**, which keeps the same logic reusable
across future UI surfaces.

See [`radius-core/README.md`](./radius-core/README.md) for the full architecture
and extension guides, and [Contributing](./CONTRIBUTING.md) for the repository
layout and development workflow.

## Getting started

Build the extension bundle locally:

```bash
pnpm install
pnpm build           # bundles the canvas extension -> plugins/radius/extension.mjs
```

See [Contributing](./CONTRIBUTING.md) for prerequisites, the full development
workflow, testing, and how to add compute platforms, canvas actions, or new UI
adapters.

## Getting help

- ❓ **Have a question?** - Visit our [Discord server](https://aka.ms/radius/discord) to post your question and we'll get back to you.
- ⚠️ **Found an issue?** - [Open a bug report](https://github.com/radius-project/ai-extensions/issues/new/choose)
- 💡 **Have a proposal?** - [Open a feature request](https://github.com/radius-project/ai-extensions/issues/new/choose)

## Contributing to Radius AI Extension

Visit [Contributing](./CONTRIBUTING.md) for more information on how to build,
test, and contribute to this repository.

## Community

We welcome your contributions and suggestions! One of the easiest ways to
contribute is to participate in Issue discussions, chat on our
[Discord server](https://aka.ms/radius/discord). For more information on community engagement, developer and contributing
guidelines and more, head over to the
[Radius community repo](https://github.com/radius-project/community).

## Releasing

Packages are versioned and changelogged with
[Changesets](https://github.com/changesets/changesets). See
[`RELEASING.md`](./RELEASING.md) for the version/tag convention and release flow.

## Code of conduct

Please refer to our [Radius Community Code of Conduct](https://github.com/radius-project/community/blob/main/CODE-OF-CONDUCT.md).
