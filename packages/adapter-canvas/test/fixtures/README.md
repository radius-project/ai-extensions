# Radius Canvas test fixtures

These fixtures contain stable test inputs and packaged-artifact expectations. They are not generated from production runtime code.

- `artifact-registration.json` records the exact retained registration schemas emitted by the built extension.
- `app-bicep-check/` records source Bicep and compiled template pairs used to verify the checker against real compiler output without invoking Bicep during tests.
- `coverage-summary.json` records the coverage summary shape the CI coverage check parses.
- `browser/` holds the synthetic browser entries that prove the in-memory compiler rejects unsafe output.
- `radius-type-definition/` holds a compact generated-resource index and namespace definitions for the just-in-time Radius type resolver. Its `radius/radius.test/` namespace is synthetic and does not exist upstream; the nesting intentionally mirrors the real upstream `radius/radius.core/...` layout.
