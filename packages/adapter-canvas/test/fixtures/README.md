# Radius Canvas compatibility fixtures

These files are reviewed compatibility oracles and are intentionally independent of the production declarations they test. Tests must not regenerate them from live runtime code.

- `pre-removal-runtime-declarations.json` preserves the six-action and ten-tool inventory that existed before the approved Phase 0 cleanup. It is historical evidence, not a supported surface.
- `runtime-compatibility.json` records the accepted Phase 0 metadata, seven page values, retained and removed names, 40 route method/path pairs, stable page markers, branch-selection behavior, and built artifact path. The prior 38-route count omitted the active operation resume and abandon template routes.
- `artifact-registration.json` records the exact retained registration schemas emitted by the built extension.
- `page-renderer-compatibility.json` records semantic projections of every routed page and the shared shell as rendered by the pre-extraction monolith at `f2282b7`, so the Phase 3 renderer extraction stays behavior-compatible. It stores titles, navigation, ordered ids/roles/names, disabled and status semantics, the values of an allowlisted set of state-carrying elements, the active graph and environment sub-tab targets, normalized environment pane visibility, request paths, ordering-sensitive markers, serialized initial state, and digests of inline script payloads — never whole pages. Its own `source` block documents the commit, generator, projection, the payloads excluded because upstream #367 changed them, and why hostile inputs are deliberately out of scope.

Any update to these files is a deliberate compatibility decision and must be reviewed with the production change that requires it.
