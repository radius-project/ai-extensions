# Radius Plugin

Model, visualize, and deploy applications with [Radius](https://radapp.io) from the GitHub Copilot app. The plugin bundles five skills and Radius Canvas, which turn Copilot into a Radius application-modeling and deployment assistant.

## Installation

The `radius` plugin is available in the [`github/awesome-copilot`](https://github.com/github/awesome-copilot) plugin catalog.

Open the GitHub Copilot app, select **Customize** in the side menu, and then select **Plugins**. Search for `radius` and install the plugin. See [Adding plugins](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app#adding-plugins) for details.

Restart your Copilot session after installing so the skills and the canvas extension become available. Use the plugin's three-dot menu to update or uninstall it.

### Update approval

When Radius Canvas starts in a new session, it asks you to approve an update to the latest version available from the installed plugin's current marketplace. The request names that marketplace and runs once per extension process. Radius calls Copilot's session plugin update API only after you approve. If you decline or cancel, it does not install an update or ask again in that process. You can keep using the canvas while the request is open. Active sessions keep their loaded code and skills. Start a new session to load installed changes.

Update requests skip CI, disabled plugins, local marketplace paths, direct installs, built-in copies, enterprise-managed plugins, and multiple enabled Radius installs. Set `COPILOT_AUTO_UPDATE=false` in the environment that starts Copilot to turn off the request. If the host cannot ask for approval, Radius does not install an update. If approval fails, the runtime does not support session plugin updates, or an update fails, Radius reports a warning and leaves the current session running. Use **Customize > Installed** to update manually.

## What's Included

### Skills

| Skill                | Use it when you want to…                                                                                                      |
|----------------------|-------------------------------------------------------------------------------------------------------------------------------|
| `radius-app-bicep`   | Generate or update the `.radius/app.bicep` manifest from a repo's contents.                                                   |
| `radius-app-graph`   | Build, refresh, or diff the Radius application graph.                                                                         |
| `radius-environment` | Create and verify an AWS/Azure deploy environment and its OIDC trust.                                                         |
| `radius-deploy`      | Deploy (or troubleshoot) an app via the generated GitHub Actions workflow.                                                    |
| `radius-delete`      | Delete a deployed app via the generated GitHub Actions workflow, or delete a deploy environment and clean up its cloud state. |

### Radius Canvas

Radius Canvas is the interactive surface the plugin opens in the app's side panel. It renders your application graph, walks you through creating a deploy environment, and reports deployment progress, so you steer the work on the canvas instead of reading it back from chat.

## Usage

Once installed, ask Copilot naturally:

```text
generate an app.bicep for this repo
show me the application graph
set up cloud credentials for Azure
deploy my app
```

## Source

This plugin is part of [radius-project/ai-extensions](https://github.com/radius-project/ai-extensions).

## License

Apache-2.0
