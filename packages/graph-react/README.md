# Radius graph React library

`@radius-project/graph-react` renders a Radius application graph in an ordinary React tree. The Canvas adapter and external consumers use the same node builder, Dagre layout, React Flow components, details panel, and legends. Hosts may retain the default appearance or supply their own stylesheet without replacing any renderer. It does not fetch graph data, open source files over HTTP, know about Copilot or Backstage, or create a service or iframe.

This implementation is an isolated candidate, **not a qualified dashboard replacement or stable-release recommendation**. See [qualification gates](#qualification-gates).

## React usage

Install the graph package, `@radius-project/core`, and matching React/ReactDOM peers in the host. Import the stylesheet once. Keep graph and options references stable between unrelated host renders; replace the graph object when its data changes.

```tsx
import { RadiusGraph } from "@radius-project/graph-react";
import "@radius-project/graph-react/styles.css";
import { normalizeLiveGraph } from "@radius-project/core/graph";

const graph = normalizeLiveGraph(ucpResponse, {
  connectionId: "production-connection",
  plane: { type: "radius", name: "local" },
  applicationId:
    "/planes/radius/local/resourceGroups/default/providers/Radius.Core/applications/store"
});

export function ApplicationGraph() {
  return (
    <div style={{ height: 600 }}>
      <RadiusGraph
        graph={graph}
        theme={{ colorScheme: "light", accent: "#0969da" }}
        options={{ showLegend: true }}
        callbacks={{
          onNavigate: (node) => navigateToResource(node.id),
          onSelect: (node) => selectResource(node.id)
        }}
      />
    </div>
  );
}
```

The host owns loading, retrieval failures, connection selection, permissions, and cache lifetime. The graph renders empty data explicitly and surfaces normalization/layout diagnostics. `graphContextKey` provides an identity containing the connection, plane, and full application ID; display names are not cache keys.

`parseResourceId` from `@radius-project/core/domain` parses full UCP and Azure Resource Manager IDs, including nested resource types and names. Both core subpaths are UI-agnostic and browser-safe; browser consumers should not import the server-oriented core root barrel.

## Input semantics

| Input kind            | Contract                                                                                                                                                                                             |
|-----------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `live`                | Normalized UCP resources identified by full IDs; raw optional provisioning status; no diff hashes, inferred deployment success, modeled source links, Canvas visibility filter, or output expansion. |
| `modeled`             | Canvas modeled resources; hide visualization-only image/registry-secret nodes and expand concrete outputs.                                                                                           |
| `planned`             | Preserve modeled resource identity/topology, show representative resolved types, and use planned styling.                                                                                            |
| `deployed-projection` | Preserve modeled topology and explicit workflow deployment status; this is not a live UCP inventory.                                                                                                 |
| `diff`                | Preserve explicit node/connection changes, output expansion, and base/head source provenance.                                                                                                        |

The public component's discriminant selects the mode. Legacy boolean mode flags are confined to presentation helpers and the thin Canvas compatibility adapter.

`normalizeLiveGraph(payload, context)` accepts an unknown payload and validates essential fields. UCP `Outbound` is presented as owner-to-target, and `Inbound` as target-to-owner, matching the modeled graph. Connection directions must be `Outbound` or `Inbound`; any other value throws. Direction comes from the payload alone — no resource type is special-cased. Any resource type renders, so Azure, AWS and other non-`Radius.*` resources appear as generic cards. A resource whose ID cannot be parsed is dropped with a warning rather than failing the graph. `parseResourceId` accepts UCP IDs (`/planes/...`, including AWS `accounts/.../regions/...` scopes) and Azure Resource Manager IDs (`/subscriptions/...`). Each entry in `warnings` is an object with a stable `code` (`duplicate-resource`, `invalid-resource-id`, `invalid-connection` or `unresolved-connection`), a `severity` (`info` or `warning`), the owning `resourceId` and an English `message`; hosts should branch on `code` and `severity`, not on the message text. Normalization never mutates the original payload or changes the meaning of its connection records.

Identical duplicate resource records are coalesced with a diagnostic. Conflicting duplicate records fail explicitly. Malformed, missing-target, and self-referential connections are omitted with actionable diagnostics; surviving resources remain visible. The no-self-loop rule follows the authoritative dashboard plan's GU-06 intended invariant, which records the incumbent self-loop as a known defect. Reciprocal connections producing the same presentation edge are deduplicated.

## Host capabilities

`callbacks` provides optional `onSelect`, `onDetails`, `onNavigate`, `onOpenExternal`, `onOpenSource`, `onRetry`, and `onError` functions. `onError` receives the thrown value once when rendering fails and the graph shows its error state, so the host can log or report it; `onRetry` adds a **Reload graph** button to that state. Source callbacks receive `{ path, line, fallbackUrl }`. The library does not implement editor opening or fallback networking. Without an external-opening callback, valid HTTPS links retain native browser navigation. Source locality is explicitly supplied through `localSource` or `workspaceBranch`; removed diff resources retain their base-branch source.

`options` supports legends, popup enablement, edge style, repository URL, source branches, and locality. `theme` supports background, text, muted text, accent, font family, and color scheme. Appearance belongs to the host through the [styling contract](#styling-contract).

The component fills a sized container. The default skin retains its existing 450px minimum height; custom appearance has no minimum container height. Canvas continues to own its normal-flow legend and 450px drawing area. `.radius-graph` and `.radius-graph__viewport` are supported geometry hooks.

Each component has independent layout, viewport, overlay, and timer state. Status-only updates preserve the viewport; changed node membership refits it. Details controls work by keyboard, Escape closes the overlay and restores focus, and teardown releases roots/listeners/timers. The details overlay is a React-rendered element: it is anchored beside the card it describes, follows that card when a relayout or drag moves it, closes when its node leaves the data, and stays mounted while closed if the graph is non-empty. A partial layout preserves valid placements and the unplaced nodes' prior positions, with a visible diagnostic. A wholly missing, non-finite, or failed layout produces readable stacked cards and a degraded-layout message.

Inline `options` and `callbacks` objects are safe. A host render that reallocates them keeps an open details overlay, its restorable focus, and any dragged node positions, and the newest callback closures still receive events. Replace `graph` only when the data itself changes, because new node membership intentionally refits the viewport.

For a server-rendered shell, `mountRadiusGraph(element, props)` mounts this same component and returns `update(props): boolean` and idempotent `unmount()`. It is a compatibility boundary, not a separate renderer. Canvas keeps SDK interaction, local HTTP, source-opening fallback, worktree context, and workflow orchestration in `packages/adapter-canvas`.

## Headlamp integration

Headlamp plugins render `RadiusGraph` inside their existing React tree, not through the standalone mount helper. Match the host's React and ReactDOM peers rather than installing Canvas's React version. The qualification target is [Headlamp v0.45.0](https://github.com/kubernetes-sigs/headlamp/tree/0e9fe810cb618964172f420666727c9a67fd6ebf), which uses React/ReactDOM 18.3.1 and React Flow 12.10.2 for its own graphs. The library renders with its own pinned React Flow 12 dependency, so the plugin needs no separate React Flow install. The published plugin SDK is `@kinvolk/headlamp-plugin@0.14.0`; its TypeScript 5.6.2 configuration uses classic `node` module resolution. The library's declaration mappings support that configuration without aliases, casts, or a host compiler upgrade.

Import one of the public CSS entry points in the plugin entry. The SDK builds the plugin and injects its imported CSS. `theme` can derive palette values from Headlamp's MUI `useTheme()` hook; use custom appearance and stable styling hooks for more extensive host styling. Headlamp's cluster-free plugin routes use `useClusterURL: false` and `noAuthRequired: true`, but a production Radius route must retain whatever cluster and authorization requirements its data retrieval needs.

The package compiles its existing Dagre engine and locked graphlib/lodash dependencies into browser-safe ESM. Headlamp's published builder leaves some CommonJS conditional `require()` calls unresolved, so shipping the raw Dagre entry would fail during plugin initialization even after a successful TypeScript check and plugin build. Consumers do not need global `graphlib` or lodash objects, custom CommonJS settings, or another layout engine. React, ReactDOM, React Flow, and browser-safe core imports retain their explicit package boundaries; bundled dependency licenses ship in `dist/THIRD_PARTY_NOTICES.txt`.

The host adapter still owns cluster selection, retrieving or mapping Radius resources, navigation, and authorization. This library is not a generic Kubernetes graph normalizer and does not add a Radius plugin or Kubernetes API client to Headlamp. Core input semantics remain the same across hosts. Headlamp's lazy-loaded graph styles and the Radius stylesheet must coexist in either load order; importing Radius must not change Headlamp's own graph controls.

### Reproduce Headlamp qualification

With Docker available, run `pnpm run test:integration:headlamp`. Real-host qualification needs the official Headlamp image and the published plugin tooling, so it runs in the scheduled and on-demand `Headlamp Compatibility` workflow and never gates a pull request; every pull-request gate stays offline. The offline contracts protecting the same behavior on each pull request are the packaging and build-boundary checks, the harness contracts, the scoped vendor stylesheet drift check, and the host-peer styling regression in real Chromium. The qualification itself runs without external network access. It installs the exact packed core and graph candidates, checks declarations with the published SDK's unmodified classic-resolution configuration, builds a plugin through that SDK, and lets the real Headlamp server discover and load it. It does not mock `pluginLib` or install into a user's Headlamp instance.

The checked-in fixture verifies rendering and finite geometry, MUI theme context, keyboard details/focus restoration, icon sizing, navigation callbacks, zoom, component unmount/remount with route leave and re-entry, and dark theme. It does not exercise Headlamp's own plugin unload, reload, or reconnect lifecycle. A fixture-owned Flow 12 baseline graph, rendered inside the official host with Headlamp's actual lazy GraphView CSS, protects computed styles and rendered dimensions when that stylesheet loads before or after Radius CSS. Every sampled host graph element and property must be unchanged, and the fixture installs no `dagre` or `graphlib` of its own, so the candidate cannot pass by resolving a consumer-provided layout engine. A missing-stylesheet negative control must fail geometry checks. Receipts preserve candidate hashes, tooling/configuration hashes, host provenance, and browser version; the fixture pins its direct npm dependencies, resolves transitive dependencies when the image is built, and saves the resolved lockfile with each receipt.

The qualified target is the official Headlamp v0.45.0 web host, React 18.3.1, SDK 0.14.0, TypeScript 5.6.2, and Chromium 151.0.7922.34 on Linux ARM64. Both stylesheet orders and the interaction/negative-control checks pass without candidate initialization or page errors. Expected host-only empty-cluster CRD diagnostics remain recorded. This does not qualify Electron, other browsers, live Kubernetes authorization/data retrieval, ingress CSP restrictions, or the separate dashboard-host gates below.

## Styling contract

Choose one CSS entry point. Neither is imported automatically by JavaScript or downloaded at runtime:

| Entry point                              | Ownership                                                                                                                                                  |
|------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `@radius-project/graph-react/styles.css` | Required base styles plus the existing default skin. Existing consumers and Canvas need no change.                                                         |
| `@radius-project/graph-react/base.css`   | Required graph geometry, hit testing, and the pinned React Flow vendor CSS, without the Radius skin. Use with `appearance="custom"` and a host stylesheet. |

The same React tree implements both appearances. `appearance="custom"` disables the default skin for that instance even if another graph imports `styles.css` in the same document. `appearance` defaults to `"default"`. Both CSS entry points use `@scope`, so both require Chromium/Edge 118 or later, Safari 17.4 or later, or Firefox 146 or later; an older browser ignores the scoped rules and leaves the graph unstyled. Radius Canvas renders in the system WebView, so its bundle appends an unscoped copy of the scoped rules with the same specificity; older macOS WebKit uses that copy, and a browser that supports `@scope` resolves as before. Radius and vendor rules are confined to graph elements; vendor keyframe names are also prefixed. This prevents the library from restyling another host renderer, including Headlamp's React Flow 12 graph. It is not Shadow DOM isolation: incoming host resets can still affect the graph.

### Keep the default appearance, change tokens

Use `theme` for the original palette API, or set public CSS custom properties in a host stylesheet or the typed `GraphStyle` prop:

```tsx
import type { GraphStyle } from "@radius-project/graph-react";

const style: GraphStyle = {
  "--radius-graph-accent": "var(--host-link)",
  "--radius-graph-font": "var(--host-font)",
  "--radius-graph-node-radius": "4px",
  "--radius-graph-details-radius": "4px",
  "--radius-graph-edge-width": "3"
};

<RadiusGraph graph={graph} style={style} />;
```

Public tokens are `--radius-graph-background`, `--radius-graph-text`, `--radius-graph-muted`, `--radius-graph-accent`, `--radius-graph-font`, `--radius-graph-danger`, `--radius-graph-added`, `--radius-graph-modified`, `--radius-graph-removed`, `--radius-graph-node-background`, `--radius-graph-node-border`, `--radius-graph-node-radius`, `--radius-graph-details-background`, `--radius-graph-details-radius`, `--radius-graph-edge-color`, and `--radius-graph-edge-width`. Node color overrides intentionally replace semantic default fills/borders; preserve distinguishable diff/status states when using them. Only explicitly supplied `theme` values override corresponding `style` tokens. Omitting a theme value leaves inline or inherited host tokens intact.

### Supply a host stylesheet

```tsx
import { RadiusGraph } from "@radius-project/graph-react";
import "@radius-project/graph-react/base.css";
import "./application-graph.css";

<div style={{ height: 600 }}>
  <RadiusGraph graph={graph} appearance="custom" className="application-graph" />
</div>;
```

```css
.application-graph {
  font-family: var(--host-font, sans-serif);
  color: var(--host-text, #102a43);
  background: var(--host-background, #f0f4f8);
}
.application-graph [data-radius-part="node"] {
  background: var(--host-card, white);
  border: 2px solid var(--host-border, #627d98);
  border-radius: 4px;
  padding: 12px;
}
.application-graph [data-radius-part="node-type"] {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.application-graph [data-radius-part="details"] {
  background: var(--host-card, white);
  border: 1px solid var(--host-border, #627d98);
  padding: 12px;
}
.application-graph [data-radius-part="details-link"] {
  color: var(--host-link, #005a9c);
}
.application-graph .radius-graph__edge .react-flow__edge-path {
  stroke: var(--host-border, #627d98);
}
.application-graph :focus-visible {
  outline: 3px solid var(--host-link, #005a9c);
  outline-offset: 3px;
}
```

This is a starting palette, not a complete design system. The host owns readable contrast, visible focus, disabled/error styling, and distinguishable semantic states. Customize these stable `data-radius-part` values rather than depending on private markup:

| Surface       | Parts                                                                                                                                                 |
|---------------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| Graph         | `viewport`, `legend`, `legend-item`, `legend-icon`, `warning`, `empty`, `error`, `retry`                                                              |
| Resource card | `node`, `node-title`, `node-type`, `icon`, `badge`, `source`, `navigate`, `status`, `details-toggle`                                                  |
| Details panel | `details`, `details-summary`, `details-status`, `details-row`, `details-link`, `details-icon`, `details-subtitle`, `details-message`, `details-empty` |

The root exposes `data-radius-kind`; cards expose `data-radius-diff`, `data-radius-deploy`, and optional `data-radius-provisioning`; details messages expose `data-radius-failure`. These are raw model states, not new status classifications. `aria-disabled` still marks unavailable source actions. CSS can select these attributes without changing graph data or callbacks. Built-in resource and deploy glyphs remain image assets: CSS can size or hide them but cannot recolor the internals of a data-URI image. Do not hide the only status indicator without supplying an accessible alternative.

The supported vendor hooks are `.radius-graph__edge .react-flow__edge-path`, `.react-flow__controls`, `.react-flow__controls-button`, and `.react-flow__background` beneath your root class. These class names come from React Flow, which graph-react pins to an exact version; graph-react keeps them working across React Flow updates, and any React Flow upgrade that removes or renames one ships as a graph-react major release. Color the background dots by setting React Flow's `--xy-background-pattern-color` custom property on `.react-flow` beneath your root class; a direct `circle { fill }` rule loses to the scoped vendor rule. Keep node positioning, transforms, handles, hit testing, and the fixed 220px node width intact: Dagre owns those contracts. Arbitrarily sized/replaced nodes are not supported. Custom appearance releases automatic type-label shrinking so the host can choose typography and wrapping; default appearance retains it. Details positioning and hidden state remain inline because they are behavior, not appearance. All other node, edge, legend, and details paint comes from CSS.

Changing `appearance`, `theme`, `className`, or a stylesheet does not rebuild graph data, reset the viewport, or replace open details. Style changes that substantially alter content height may require the user to fit the graph with the existing controls; they do not trigger an unsolicited viewport reset. The callback, keyboard, focus-restoration, status, and teardown contracts are the same in both appearances.

## Brand mark

Hosts that place Radius navigation entries beside the graph need the same mark the graph's own chrome uses. `@radius-project/graph-react/brand` is a React-free, DOM-free subpath so a host can register the icon without loading the renderer:

```ts
import { RADIUS_BRAND_MARK, radiusBrandMarkSvg } from "@radius-project/graph-react/brand";

// Icon registries take a body plus a viewBox size.
addIcon("radius:mark", RADIUS_BRAND_MARK);

// Hosts that inline markup get a complete element instead.
element.innerHTML = radiusBrandMarkSvg({ size: 26, title: "Radius" });
```

`radiusBrandMarkSvg` defaults to 28px and is decorative (`aria-hidden`) unless you pass `title`, which promotes it to `role="img"` with an accessible name. The mark paints with `var(--rad-brand)` and `var(--rad-brand-dark)` over Radius-orange fallbacks, so host tokens apply only when the markup is inlined into the document — not when it is loaded through `<img>` or a data URI.

## Packaging and provenance

The package exports JavaScript and declarations, bundled `styles.css` and `base.css`, and a `brand` subpath for the Radius mark. React and ReactDOM remain peers. Canvas bundles shared source into its existing self-contained browser artifact, ultimately `.artifacts/radius/com.github.copilot/extensions/radius/extension.mjs`; no package source is downloaded at runtime. Library release/version handling is separate from Copilot plugin discovery and release selection. No public registry publication is part of this implementation; both libraries stay `private` until a publish workflow exists.

The `presentation` subpath (graph building, layout, and details helpers used by the Canvas adapter) is workspace-only: it is not in the packed `exports` map, so those helpers can change without a semver commitment. `core/graph`, `core/domain`, and `graph-react/brand` also provide `typesVersions` mappings for classic TypeScript Node resolution. Modern NodeNext/Bundler consumers continue using the existing `exports` map. Consumers do not need path aliases to the source tree or a compiler upgrade to resolve these declarations.

`src/flow.css` is generated from the pinned `@xyflow/react` 12.11.6 (React Flow 12) stylesheet, with its MIT license retained, a graph scope, and namespaced keyframes. It is not independently maintained vendor behavior. After reviewing a vendor update, regenerate it with `node scripts/graph-vendor-styles.mjs`; `--check` and the artifact tests detect drift. Keeping this asset in source ensures Vite consumers, the synchronous Canvas browser build, and packed libraries all use exactly the same rules.

The renderer and its existing pure/browser scenarios were extracted from `ai-extensions` at `172782e`. The old Canvas renderer, layout, details, legend, model, and graph-specific stylesheet ownership were removed rather than copied into a second implementation. Canvas callers import the shared public API directly; no legacy graph forwarding modules remain.

The design inputs are `docs/design/2026-09-radius-backstage-plugin.md` and `docs/design/2026-09-dashboard-plugin-test-plan.md` from dashboard commit `fd90d938267ceab5935b037bc7dd1ff59831e8b5`. The live normalization implementation and local fixtures are independently authored from those contracts. Dashboard implementation/fixture code was not copied because its package/repository license discrepancy remains unresolved.

## Qualification gates

`pnpm run coverage` and `pnpm run test:reliability` both discover the shared graph's Node and real Chromium suites alongside the Canvas host tests owned by each gate. The scheduled reliability workflow installs Chromium on each supported operating system. The shared package retains the original Canvas browser branch floor of 99.5%, with statements, functions, and lines pinned at 100%.

Local package and component checks cannot substitute for the required dashboard-host gate. At the pinned dashboard revision, phases 0 and 3 are complete, phases 1 and 2 are in progress, and phase 4 onward has not started. GU-01 through GU-10 Tier A fixtures/invariants exist; that is not a frozen regression baseline.

The dashboard-owned CP-01 through CP-05 candidate pin/install/external-host seam, GU-20 real-renderer/stylesheet-negative journeys, GU-21 through GU-24 records/manifest, and Tier B real-renderer journeys remain prerequisites. Tests in this fork must use the exact packed candidate JS/declarations/CSS and transitive core resolution with matching React 18 and React 19 hosts, but even passing isolated checks cannot discharge those absent consumer gates.

The implementation must not be described as fully dashboard-regression-tested or ready for stable merge/publication until those prerequisites and mandatory consumer CI are available and pass. Do not upgrade the dashboard to React 19 or migrate React Flow merely to make an isolated candidate pass.
