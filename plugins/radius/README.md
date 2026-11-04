# Radius Plugin

Model, visualize, and deploy applications with [Radius](https://radapp.io) from the GitHub Copilot app. The plugin bundles six skills and Radius Canvas, which turn Copilot into a Radius application-modeling and deployment assistant.

## Installation

The `radius` plugin is available in the [`github/awesome-copilot`](https://github.com/github/awesome-copilot) plugin catalog.

Open the GitHub Copilot app, select **Customize** in the side menu, and then select **Plugins**. Search for `radius` and install the plugin. See [Adding plugins](https://docs.github.com/en/copilot/how-tos/github-copilot-app/customize-github-copilot-app#adding-plugins) for details.

Restart your Copilot session after installing so the skills and the canvas extension become available. Use the plugin's three-dot menu to update or uninstall it.

### Update approval

When Radius Canvas starts in a new session, it considers one request to update the installed plugin from its current marketplace. Radius calls Copilot's session plugin update API only after you approve. After any answer, including approval, decline, or cancellation, Radius waits 7 days before asking again for that marketplace. This wait also applies when an approved check finds that the plugin is already current or installs a new version. Once 7 days have passed, the next eligible session can ask again. A different marketplace has its own saved answer. You can still update manually at any time. You can keep using the canvas while the request is open. Active sessions keep their loaded code and skills. Start a new session to load installed changes.

The request names the marketplace and asks to update to its latest available version. Copilot's SDK does not expose available plugin versions, so Radius cannot check whether a newer version exists before asking. After an approved update, Radius reports the old and new versions when Copilot provides them, or says the plugin is already up to date if they match.

Update requests skip CI, disabled plugins, local marketplace paths, direct installs, built-in copies, enterprise-managed plugins, and multiple enabled Radius installs. Set `COPILOT_AUTO_UPDATE=false` or `COPILOT_AUTO_UPDATE=0` in the environment that starts Copilot to turn off the request. `CI=false` and `CI=0` do not disable requests. If the host lacks the plugin API or approval UI, Radius skips the request and writes a diagnostic without showing a session warning. If saved history cannot be read, Radius skips the request with a diagnostic. If an answer cannot be saved, Radius writes a diagnostic and still follows your answer; a later session may ask again sooner. Preference-storage errors never show an update-failure warning. If approval or an update fails, Radius reports a warning and leaves the current session running. A failed completion notice does not report an installed update as a failed update. Use **Customize > Installed** to update manually.

Radius stores answer timestamps under `~/.copilot/radius/plugin-update-responses` (`USERPROFILE` on Windows). To allow another request before the 7-day wait ends, remove Radius's saved answer records from that directory. The old `plugin-update-declines` records are not used.

## What's Included

### Skills

| Skill                 | Use it when you want to…                                                                                                      |
|-----------------------|-------------------------------------------------------------------------------------------------------------------------------|
| `radius-app-bicep`    | Generate or update the `.radius/app.bicep` manifest from a repo's contents.                                                   |
| `radius-app-graph`    | Build, refresh, or diff the Radius application graph.                                                                         |
| `radius-environment`  | Create and verify an AWS/Azure deploy environment and its OIDC trust.                                                         |
| `radius-deploy`       | Deploy (or troubleshoot) an app via the generated GitHub Actions workflow.                                                    |
| `radius-delete`       | Delete a deployed app via the generated GitHub Actions workflow, or delete a deploy environment and clean up its cloud state. |
| `radius-report-issue` | Prepare and review a bug report after a Radius failure, then submit it only with explicit permission.                         |

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

When a Radius operation fails and recovery stops, Copilot offers to prepare an issue for the Radius team in `radius-project/ai-extensions`. If you agree, it collects relevant diagnostics, removes personal data and secrets, and records known session settings, model, reasoning level, and versions. You can review and change the complete draft. Copilot asks for separate explicit permission before it submits the issue. Declining the offer creates no report.

## Source

This plugin is part of [radius-project/ai-extensions](https://github.com/radius-project/ai-extensions).

## License

Apache-2.0
