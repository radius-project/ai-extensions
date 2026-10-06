# Copilot app UX test PoC

This folder is a proof of concept (PoC). It shows how Playwright can run UX tests against the GitHub Copilot desktop app on Windows.

The app uses Tauri with Microsoft Edge WebView2. It is not an Electron app, so `_electron.launch` does not work. Instead, the app starts with a Chrome DevTools Protocol (CDP) port open, and Playwright connects to that port with `chromium.connectOverCDP`. Playwright does not download or start a browser.

> [!WARNING]
> This PoC is not supported. It uses no public test API, and a new app version can break it at any time.

## Limits

- **Windows only.** On macOS (WKWebView) and Linux (WebKitGTK), the app has no CDP endpoint.
- **Not supported.** The app has no public test API and no known `data-testid` attributes. Locators use roles and text, so app updates can break them.
- **Security risk while the port is open.** Port 9222 gives full control of the app and the signed-in account to any local process. Open the port only for a test run. Quit the app when the run is complete.
- **Real profile.** The tests use your real WebView2 profile (`%LOCALAPPDATA%\com.github.githubapp\EBWebView`) and your real GitHub account.
- **Read-only.** The tests do not click or type. They do not send prompts, start sessions, or change data. Keep new tests read-only too.
- **Quitting ends sessions.** To start the app with the CDP port, you must quit the app fully first. This stops all running agent sessions.

## Prerequisites

- Windows 10 or Windows 11.
- The GitHub Copilot app at `%LOCALAPPDATA%\Programs\GitHub Copilot\github.exe`. The PoC was written for version 1.1.26.
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

   The script stops with an error if the app is already running, or if another process already uses the port. It sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<Port>` only for the app process. Then it waits for `http://localhost:<Port>/json/version` to answer. Use `-Port` to change the port and `-TimeoutSeconds` to change the wait time.

4. Run the tests:

   ```powershell
   npm test
   ```

   If you used a different port, set `COPILOT_APP_CDP_URL` first, for example `$env:COPILOT_APP_CDP_URL = "http://localhost:9333"`. The URL must point to a loopback host.

5. Open the HTML report:

   ```powershell
   npm run report
   ```

6. Quit the app to close the CDP port. Start the app again in the usual way.

If the CDP endpoint is not reachable, the smoke tests are skipped with a message. The unit tests in `tests/cdp.spec.ts` do not need the app, so they always run.

## Accessibility dump

To find stable locators, save an ARIA snapshot of the app and a count of all `data-test*` attribute values:

```powershell
npm run dump-a11y
```

The script writes `output/a11y-dump.json`. It does not change the app.

## Files

| Path                     | Purpose                                                                                    |
|--------------------------|--------------------------------------------------------------------------------------------|
| `scripts/launch-app.ps1` | Starts the app with the CDP port open and waits for the endpoint.                          |
| `fixtures/cdp.ts`        | Validates the CDP URL, checks the endpoint, selects the main app page, counts test IDs.    |
| `fixtures/app.ts`        | Playwright fixture. Connects over CDP, gives `appPage`, and disconnects. It does not quit. |
| `tests/smoke.spec.ts`    | Read-only smoke tests against the running app.                                             |
| `tests/cdp.spec.ts`      | Unit tests for `fixtures/cdp.ts`. No app needed.                                           |
| `scripts/dump-a11y.ts`   | Saves the ARIA snapshot and the `data-test*` counts.                                       |

## Notes

- The fixture skips DevTools, blank, browser-internal, and loopback canvas targets. It prefers the Tauri app origin (`tauri.localhost`).
- At teardown, the fixture only disconnects from CDP. The app continues to run.
- Playwright takes automatic failure screenshots and traces only for pages that it creates. For this reason, the fixture attaches its own screenshot of the app page when a test fails.
