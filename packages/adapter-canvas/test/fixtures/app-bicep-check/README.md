# App Bicep checker fixtures

These fixtures record Bicep source, compiled templates, and diagnostics for shapes the app Bicep checker must understand. The JSON outputs were captured with Bicep CLI 0.42.1 (caea9302e8), the checked-in `bicepconfig.json`, and `bicep build app.bicep --diagnostics-format sarif --stdout --no-restore`. Diagnostic artifact URIs are normalized to `file:///fixture/app.bicep`.

Tests consume only the captured JSON; they do not invoke Bicep, access user storage, restore extensions, or use the network. Regenerate every compiled output when the supported compiler changes its template shape, and regenerate the matching diagnostic output when it changes diagnostic shape.

`username-copy`, `aks-store-demo-before`, and `aks-store-demo-after` were captured with the staged types of a modeling run instead, because the cached `radius:latest` schema has no `username` on `Radius.Messaging/rabbitMQ`. In a scratch `git init` directory, run `promote-app-model.mjs --begin`, then `show-radius-type.mjs --staging <dir>` for every type the model uses, then run the same `bicep build` command in the staging directory. That staged `bicepconfig.json` pins `br:biceptypes.azurecr.io/radius:0.61`. The two `aks-store-demo` models are real generated models of that sample application before and after the shared username guidance.
