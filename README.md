# Radius Canvas Extension

A GitHub Copilot canvas extension for modeling and deploying applications with
Radius. The product logic is UI-agnostic and lives in a shared core; the canvas
adapter wires it into the Copilot canvas surface.

## Layout

| Path                     | Responsibility                                                                 |
| ------------------------ | ----------------------------------------------------------------------------- |
| `packages/radius-core/` | Shared, UI-agnostic core: app graph, modeling, compute platforms, workflows.  |
| `adapters/canvas/`       | Copilot canvas adapter: SDK wiring + loopback HTTP host that backs the webview. |

See each package's `README.md` for module-level detail and extension recipes.

## Build

```bash
npm install
npm run build        # bundles the canvas extension -> .github/radius/extension.mjs
```

Other scripts:

```bash
npm run watch        # rebuild on change
npm run typecheck    # typecheck core + canvas
```

The Copilot SDK (`@github/copilot-sdk`) is resolved by the canvas loader at
runtime and is intentionally not bundled.
