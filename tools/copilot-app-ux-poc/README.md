# Copilot app UX test PoC

This folder is a proof of concept (PoC). It shows how Playwright can run UX tests against the GitHub Copilot desktop app on Windows.

The app uses Tauri with Microsoft Edge WebView2. It is not an Electron app, so `_electron.launch` does not work. Instead, the app starts with a Chrome DevTools Protocol (CDP) port open, and Playwright connects to that port with `chromium.connectOverCDP`. Playwright does not download or start a browser.

> [!WARNING]
> This PoC is not supported. It uses no public test API, and a new app version can break it at any time.

## Limits

- **Windows only.** On macOS (WKWebView) and Linux (WebKitGTK), the app has no CDP endpoint.
- **Not supported.** The app has no public test API. Some elements have `data-testid` attributes, but they are internal and can change. Locators use test IDs, roles, and text, so app updates can break them.
- **Security risk while the port is open.** Port 9222 gives full control of the app and the signed-in account to any local process. Open the port only for a test run. Quit the app when the run is complete.
- **Real profile.** The tests use your real WebView2 profile (`%LOCALAPPDATA%\com.github.githubapp\EBWebView`) and your real GitHub account.
- **No data changes by default.** The smoke tests do not click or type. The Radius canvas test clicks menu items to open a tab, and closes the tab again if it opened it. These tests do not type text, send prompts, start sessions, or change data. The [modeling journey](#modeling-journey-opt-in) is the only exception, and it is off by default.
- **Quitting ends sessions.** To start the app with the CDP port, you must quit the app fully first. This stops all running agent sessions.

## Prerequisites

- Windows 10 or Windows 11.
- The GitHub Copilot app at `%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe`. The PoC was written for version 1.1.26.
- For the Radius canvas test: the Radius plugin installed in the app, and an open project session.
- Node.js 24.
- Windows PowerShell 5.1 or PowerShell 7.

## Steps

1. Install the dependencies:

   ```powershell
   cd tools\copilot-app-ux-poc
   npm install
   ```

2. Quit the Copilot app fully. Also quit it from the system tray. Make sure that no `github.exe` process from the app folder is running.

3. Start the app with the CDP port open:

   ```powershell
   .\scripts\launch-app.ps1
   ```

   The script stops with an error if the app is already running, or if another process already uses the port. It sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<Port>` only for the app process. Then it waits for `http://127.0.0.1:<Port>/json/version` to answer. Use `-Port` to change the port and `-TimeoutSeconds` to change the wait time.

4. Run the tests:

   ```powershell
   npm test
   ```

   If you used a different port, set `COPILOT_APP_CDP_URL` first, for example `$env:COPILOT_APP_CDP_URL = "http://127.0.0.1:9333"`. The URL must point to a loopback host. Do not use `localhost`. See [Radius canvas test](#radius-canvas-test).

5. Open the HTML report:

   ```powershell
   npm run report
   ```

6. Quit the app to close the CDP port. Start the app again in the usual way.

If the CDP endpoint is not reachable, the smoke and canvas tests are skipped with a message. The unit tests in `tests/cdp.spec.ts` do not need the app, so they always run.

## Radius canvas test

`tests/radius-canvas.spec.ts` opens the Radius canvas in the selected session. It uses the UI path **Add tab** > **Canvas** > **Radius**. If a Radius tab is already open, the test selects that tab and does not close it.

The test then makes sure that:

- The Radius tab is selected.
- The canvas page has a Radius title (`<page> — Radius`).
- The canvas page shows a heading.

It attaches a screenshot of the canvas page and of the app window.

The canvas page runs in a second WebView2 browser process. Both processes get the same `--remote-debugging-port` value, so both listen on port 9222. The app process listens on `127.0.0.1`, and the canvas process listens on `[::1]`. For this reason:

- The default app URL is `http://127.0.0.1:9222`. With `localhost`, Node.js can connect to the canvas process instead of the app.
- The fixture finds the canvas process on the other loopback address. To set a different URL, use `COPILOT_APP_CANVAS_CDP_URL`.

This behavior is not documented, and an app or WebView2 update can change it.

## Modeling journey (opt-in)

`tests/modeling-journey.spec.ts` is like the cloud end-to-end suite in `packages/adapter-canvas/test/e2e-cloud`. The cloud suite uses a fixture repository that already has `.radius/app.bicep`, and it drives the canvas in a test harness. This journey starts from a clean fixture repository with no `.radius/` folder, and it uses the real Copilot app.

> [!CAUTION]
> This journey changes real data. It sends a prompt in a new Autopilot session, pushes a commit to the fixture default branch, and creates and deletes a GitHub environment, an Azure federated credential, and a Kubernetes deployment. It uses your signed-in GitHub account and your Azure CLI login. Use a fixture repository and Azure resources that are only for tests.

The journey is off by default. `npm test` skips it. When `COPILOT_APP_E2E_JOURNEY=1` is set, all required values must be valid, or test collection stops with a list of the problems.

### Steps of the journey

1. **Check the fixture.** The default branch must point to the baseline SHA, and the baseline must not contain `.radius/app.bicep`.
2. **Model the app.** On the **New** page, the journey selects the fixture project, sets **Autopilot** mode, and sends a prompt that runs the `radius-app-bicep` skill. It reads the worktree path from the session information dialog.
3. **Wait for the model.** It waits until `.radius/app.bicep`, `bicepconfig.json`, and `app.origin.json` exist and are staged. The skill stages them as its last step. Then it attaches `app.bicep` to the report.
4. **Show the graph.** It opens the Radius canvas and waits for a graph node.
5. **Publish the model.** It commits the model in the session worktree and pushes it to the fixture default branch. This must be a fast-forward from the baseline. The deploy flow reads `app.bicep` from GitHub, so this step is necessary.
6. **Create the environment.** It uses the credential profile, or creates it on the credentials page. Then it creates the environment and waits for the operation to succeed.
7. **Deploy.** It deploys the single application from the default branch, and waits for the status `complete` and for the deployment row.
8. **Refuse a live delete.** A delete of the environment must return `409` with code `app-deployed`.
9. **Delete the deployment.** It waits until the deployment row is gone.
10. **Delete the environment.** It waits for the operation to succeed, and checks that the GitHub environment is gone.

At the end, the journey resets the fixture default branch to the baseline SHA. If a deployment or an environment can still exist, the journey does not reset the branch, because the canvas delete flows need the workflow files on that branch. The report then shows `manual-cleanup` annotations. The journey does not archive the session. Archive it in the app when you no longer need it.

### Setup

1. Create a private fixture repository. Copy `Dockerfile` and `README.md` from `radius-project/ai-extensions-fixture`, but do not copy the `.radius/` folder. Record the SHA of the first commit on the default branch.
2. Add the repository to the Copilot app as a project.
3. Install the Radius plugin in the app.
4. Sign in with `gh auth login` and `az login`. The account must be able to push to the fixture and to create resources in the Azure subscription.
5. Make an Azure resource group and an AKS cluster for the test, or use existing test resources.

### Configuration

| Variable                                | Required | Default              | Value                                                   |
|-----------------------------------------|----------|----------------------|---------------------------------------------------------|
| `COPILOT_APP_E2E_JOURNEY`               | Yes      |                      | Set to `1` to run the journey.                          |
| `COPILOT_APP_E2E_REPO`                  | Yes      |                      | Fixture repository as `owner/name`.                     |
| `COPILOT_APP_E2E_BASELINE_SHA`          | Yes      |                      | Full SHA of the clean default branch.                   |
| `COPILOT_APP_E2E_AZURE_TENANT_ID`       | Yes      |                      | Azure tenant GUID.                                      |
| `COPILOT_APP_E2E_AZURE_SUBSCRIPTION_ID` | Yes      |                      | Azure subscription GUID.                                |
| `COPILOT_APP_E2E_AZURE_RESOURCE_GROUP`  | Yes      |                      | Resource group of the AKS cluster.                      |
| `COPILOT_APP_E2E_AKS_CLUSTER`           | Yes      |                      | AKS cluster name.                                       |
| `COPILOT_APP_E2E_PROJECT`               | No       | Repository name      | Project name in the app project picker.                 |
| `COPILOT_APP_E2E_DEFAULT_BRANCH`        | No       | `main`               | Default branch of the fixture.                          |
| `COPILOT_APP_E2E_NAMESPACE`             | No       | `default`            | Kubernetes namespace.                                   |
| `COPILOT_APP_E2E_CREDENTIAL_PROFILE`    | No       | `copilot-app-ux-e2e` | Credential profile name. The journey creates it if new. |
| `COPILOT_APP_E2E_ENV_NAME`              | No       | `uxe2e-<random>`     | Environment name.                                       |

### Run the journey

1. Start the app with `.\scripts\launch-app.ps1`, as in [Steps](#steps).
2. Set the variables and run the journey:

   ```powershell
   $env:COPILOT_APP_E2E_JOURNEY = "1"
   $env:COPILOT_APP_E2E_REPO = "<owner>/<fixture>"
   $env:COPILOT_APP_E2E_BASELINE_SHA = "<sha>"
   # Set the Azure variables too.
   npm run test:journey
   ```

The journey can take more than two hours. Its timeout is four hours. Do not use the app while it runs, because the journey changes the selected page and session.

The unit tests in `tests/journey.spec.ts` check the configuration, the response parsers, and the readiness rules. They do not need the app.

## Accessibility dump

To find stable locators, save an ARIA snapshot of the app and a count of all `data-test*` attribute values:

```powershell
npm run dump-a11y
```

The script writes `output/a11y-dump.json`. It does not change the app.

## Files

| Path                             | Purpose                                                                                                         |
|----------------------------------|-----------------------------------------------------------------------------------------------------------------|
| `scripts/launch-app.ps1`         | Starts the app with the CDP port open and waits for the endpoint.                                               |
| `fixtures/cdp.ts`                | Validates the CDP URLs, checks the endpoint, selects the main app page, finds the canvas page, counts test IDs. |
| `fixtures/app.ts`                | Playwright fixture. Connects over CDP, gives `appPage`, and disconnects. It does not quit.                      |
| `tests/smoke.spec.ts`            | Read-only smoke tests against the running app.                                                                  |
| `fixtures/radius-canvas.ts`      | Opens or selects the Radius canvas tab, finds the canvas page, and closes the tab it opened.                    |
| `tests/radius-canvas.spec.ts`    | Opens the Radius canvas and checks its page.                                                                    |
| `tests/cdp.spec.ts`              | Unit tests for `fixtures/cdp.ts`. No app needed.                                                                |
| `fixtures/journey.ts`            | Configuration and response parsers for the modeling journey.                                                    |
| `fixtures/app-ui.ts`             | Starts a session from the New page and reads the session information dialog.                                    |
| `fixtures/commands.ts`           | Runs `git` and `gh` with an argument list and no shell.                                                         |
| `tests/modeling-journey.spec.ts` | Opt-in journey: model a clean repository, then deploy and delete through the canvas.                            |
| `tests/journey.spec.ts`          | Unit tests for `fixtures/journey.ts`. No app needed.                                                            |
| `scripts/dump-a11y.ts`           | Saves the ARIA snapshot and the `data-test*` counts.                                                            |

## Notes

- The fixture skips DevTools, blank, browser-internal, and loopback canvas targets. It prefers the Tauri app origin (`tauri.localhost`).
- At teardown, the fixture only disconnects from CDP. The app continues to run.
- Playwright takes automatic failure screenshots and traces only for pages that it creates. For this reason, the fixture attaches its own screenshot of the app page when a test fails.
