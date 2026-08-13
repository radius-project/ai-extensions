# Radius Canvas compatibility fixtures

These files are reviewed compatibility oracles and are intentionally independent of the production declarations they test. Tests must not regenerate them from live runtime code.

- `pre-removal-runtime-declarations.json` preserves the six-action and ten-tool inventory that existed before the approved Phase 0 cleanup. It is historical evidence, not a supported surface.
- `runtime-compatibility.json` records the accepted Phase 0 metadata, seven page values, retained and removed names, 37 route method/path pairs, stable page markers, branch-selection behavior, and built artifact path.
- `artifact-registration.json` records the exact retained registration schemas emitted by the built extension.

Any update to these files is a deliberate compatibility decision and must be reviewed with the production change that requires it.
