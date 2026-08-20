# Radius Canvas test fixtures

These fixtures contain stable test inputs and packaged-artifact expectations. They are not generated from production runtime code.

- `artifact-registration.json` records the exact retained registration schemas emitted by the built extension.
- `app-bicep-check/` records source Bicep and compiled template pairs used to verify the checker against real compiler output without invoking Bicep during tests.
- `coverage-summary.json` records the coverage summary shape the CI coverage check parses.
- `browser/` holds the synthetic browser entries that prove the in-memory compiler rejects unsafe output.
