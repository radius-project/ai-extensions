# App Bicep checker fixtures

These fixtures record Bicep source and compiled templates for expression shapes the app Bicep checker must understand. The compiled templates were captured with Bicep CLI 0.42.1 (caea9302e8), the checked-in `bicepconfig.json`, and `bicep build app.bicep --diagnostics-format sarif --stdout --no-restore`.

Tests consume only `compiled.json`; they do not invoke Bicep, access user storage, restore extensions, or use the network. Regenerate both outputs when the supported compiler changes its template shape.
