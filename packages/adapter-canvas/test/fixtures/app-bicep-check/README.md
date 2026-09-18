# App Bicep checker fixtures

These fixtures record Bicep source, compiled templates, and diagnostics for shapes the app Bicep checker must understand. The JSON outputs were captured with Bicep CLI 0.42.1 (caea9302e8), the checked-in `bicepconfig.json`, and `bicep build app.bicep --diagnostics-format sarif --stdout --no-restore`. Diagnostic artifact URIs are normalized to `file:///fixture/app.bicep`.

Tests consume only the captured JSON; they do not invoke Bicep, access user storage, restore extensions, or use the network. Regenerate the matching output when the supported compiler changes its template or diagnostic shape.
