# Common Radius graph libraries

- **Author**: Nicole James (@nicolejms), with Copilot
- **Date**: 2026-09
- **Status**: Draft

## Overview

Radius clients should present the same resources and relationships consistently. Separate graph implementations allow layout, status presentation, controls, and details interactions to drift, while requiring each client to repeat fixes and accessibility work.

Introduce common graph contracts and React components owned by `ai-extensions`. Clients reuse one normalization and rendering pipeline, supplying only their data, theme, and host-specific actions. This reduces code duplication and makes a graph improvement available to every consumer through a versioned library update. Consistency means shared visual language and interaction rules, not pretending that live inventory and modeled topology contain the same information.

Potential consumers include the Copilot Canvas extension and the Radius Dashboard, whether running as a standalone application or as a plugin in an existing Backstage installation. Both dashboard modes could use the same graph libraries while retaining their host's navigation, authentication, and page composition.

## Terms and definitions

**Canvas** is the Radius extension for the GitHub Copilot app. **UCP** is the Radius control plane. **Live graph** means retrieved UCP inventory; **deployed projection** means workflow status over modeled topology, not live inventory.

## Objectives

> **Issue Reference:** N/A; this proposal defines the common graph-library boundary.

### Goals

- Share one graph model-to-view pipeline, layout engine, renderer, details pane, legend, and stylesheet across hosts.
- Make equivalent graph data and presentation options produce consistent resource cards, relationships, status cues, and keyboard interactions across clients.
- Keep domain contracts browser-safe and host-independent; preserve distinct graph-source semantics.
- Reduce duplicated implementation and maintenance by migrating consumers to shared behavior, not adding a library alongside existing copies.
- Preserve client behavior while producing compiled packages consumable by React 18 and React 19 hosts.

### Non-goals

Client page composition, authentication, transport, resource retrieval, and workflow orchestration remain host responsibilities. This design adds no backend service, iframe, generic Radius API client, or modeling/deployment capability. It does not require clients to adopt identical branding, page dimensions, or a new React major.

### User scenarios (optional)

#### User story 1

A Canvas user retains graph navigation, source actions, deployment/diff presentation, and keyboard-accessible details after extraction.

#### User story 2

A developer moves between Radius Dashboard, running standalone or as a Backstage plugin, and the Copilot Canvas extension and recognizes the same resource cards, zoom controls, and details interactions. Each client supplies its own navigation actions without copying graph code.

## User experience (if applicable)

Use a common visual language for resource types, relationships, selection, status, and details. Zoom, keyboard navigation, focus restoration, and legend meanings behave consistently across clients. Theme tokens and optional capabilities adapt the component to its host without creating independent renderers. Unsupported actions are absent rather than misleadingly enabled.

Preserve incumbent Canvas appearance and interaction during migration. The host owns loading, retrieval errors, routing, and surrounding layout. The library owns graph interaction and presentation.

**Sample input:** A normalized live graph with explicit connection, plane, and full application ID, plus theme and navigation callbacks.

**Sample output:** Resource cards, connections, and details, without fabricated deployment success or modeled source actions.

## Design

### High-level design

`packages/core` owns identity and graph semantics. `packages/graph-react` owns presentation. Each client supplies data and capabilities through a thin adapter. Canvas consumes workspace dependencies; separately built clients consume versioned packages. Neither library depends on a client.

### Architecture diagram

Arrows mean build-time dependency, not network traffic.

```mermaid
flowchart TD
    Canvas["Canvas host adapter"] --> Graph["graph-react: shared React UI"]
    Dashboard["Dashboard or other React client"] -. npm .-> Graph
    Graph --> Core["core: browser-safe domain and graph"]
    Canvas --> Core
    Dashboard -. npm .-> Core
```

### Detailed design

#### Option 1: Common contracts and renderer in ai-extensions

##### Advantages

Contracts, components, and the first client migration evolve atomically. Other clients adopt the same implementation through package releases, reducing visual drift and duplicated fixes.

##### Disadvantages

Requires public-package boundaries, cross-React qualification, and coordinated consumer updates. Shared regressions can affect multiple clients, making consumer-level checks essential.

#### Option 2: Share contracts but retain host-specific renderers

##### Advantages

Smaller initial extraction and fewer immediate host changes.

##### Disadvantages

Duplicates layout, styling, details, and bug fixes; fails the requirement to minimize duplication.

#### Proposed option

Choose Option 1. Extract reusable behavior from the existing Canvas implementation, replace its callers, and delete superseded behavior. Subsequent clients use the same renderer with explicit capabilities rather than forks. Temporary compatibility modules may only forward exports. Review attribution and licensing before transferring source from another package.

### API design (if applicable)

The public surface provides `RadiusGraph`, `RadiusGraphProps`, `GraphCallbacks`, and `mountRadiusGraph`. `RadiusGraph` accepts `graph`, presentation options, theme, and optional selection/details/navigation/external/source/retry callbacks. The mount helper wraps the same React component for server-rendered shells; it is not another renderer.

Core contracts distinguish `live`, `modeled`, `planned`, `deployed-projection`, and `diff`. Live normalization requires full IDs and explicit connection/plane/application context, retains raw provisioning status, and does not require diff hashes. Canvas filtering, output expansion, diff provenance, and workflow status remain non-live capabilities. `@radius-project/core/domain` and `/graph` are deliberate browser-safe entry points; the core root is not this public browser contract.

### Implementation details

#### Core package - packages/core

Own resource-ID parsing, graph variants, and deterministic, non-mutating live normalization. Coalesce identical duplicates with diagnostics; reject conflicting duplicates. Report omitted malformed, dangling, and self-referential connections. Keep legacy gateway direction correction opt-in and source-specific.

#### Common React package - packages/graph-react

Own one Dagre implementation with per-instance state, React Flow nodes/edges, React-controlled details, legends, and styles. Accept host capabilities rather than fetching data. Preserve focus, viewport, and open details across unrelated host renders. Fill the host container; expose `.radius-graph` and `.radius-graph__viewport` as documented layout hooks. Scope custom CSS and preserve vendor control geometry.

#### Canvas adapter - packages/adapter-canvas

Own SDK lifecycle, page state, local source HTTP/fallback, and workflow integration. Mount/update/unmount the shared component. Preserve Canvas's legend placement and 450px drawing area without imposing that height on other consumers.

#### Shared adapter - packages/adapter-shared

No new responsibilities. Managed `rad` execution and process lifecycle remain outside the browser libraries.

#### Plugin - extensions/radius

Keep the Copilot distribution separate. Bundle the shared graph into the existing `com.github.copilot/extensions/radius/extension.mjs` artifact under `.artifacts/radius`; no runtime module download or second extension.

#### Build & packaging

Build core before graph-react; emit JavaScript, declarations, and CSS. Canvas uses workspace dependencies; external hosts install versioned npm artifacts and import `@radius-project/graph-react/styles.css`. React/ReactDOM remain peers, not bundled copies. Keep library Changesets/release selection separate from Copilot plugin discovery. Release compatible library versions together and record each client's resolved versions so a regression can be rolled back to a known-compatible set.

### Error handling

Hosts display fetch/authentication failures and own retry policy. Libraries reject invalid essential input, expose normalization warnings, and render explicit empty/degraded-layout states instead of success-shaped fallbacks. Callback failures must not be silently swallowed.

## Test plan

Require pure identity/normalization/layout tests, real-browser details/focus/lifecycle tests, client host-boundary tests, and exact packed JS/declarations/CSS consumption with matching React peers. Canonical visual checks use unchanged snapshots and thresholds, two repetitions, and no retries.

Establish real-renderer behavior and visual baselines before migrating each client. Exercise equivalent fixtures across hosts to verify shared card/edge semantics, control dimensions, legend meanings, and keyboard behavior while allowing intentional theme and container differences. Include multiple instances, live graphs without modeled metadata, status-only updates, source actions, and teardown.

Common-library changes must install exact candidate packages into pinned supported client revisions and run client-owned journeys. Verify transitive core resolution and stylesheet loading; deliberately missing CSS must fail the check. Do not mock the renderer or fall back to the old implementation. Run untrusted candidate code without secrets. Passing isolated library tests is necessary but insufficient to claim client compatibility.

## Security

Shared code receives data and callbacks, not credentials or arbitrary backend URLs. Hosts retain authorization and approved navigation/source-opening policy. Render resource content as text, validate link destinations, and keep Node/SDK/network implementations outside the browser dependency closure. Preserve source attribution and approve license/notice obligations before transferring code between packages.

## Compatibility (optional)

Support React 18 and React 19 through peer dependencies and matching runtime/type checks, without forcing a host upgrade. The initial target ranges are `^18.3.1 || ^19.2.8`; widening them requires evidence from the added versions. Retain React Flow 11 unless evidence requires migration. Maintain a supported client/compiler/React matrix and qualify public declarations as well as runtime behavior. Host-specific features remain optional capabilities, not required properties of every graph.

## Monitoring and logging

Expose graph diagnostics to the host; add no telemetry service. Preserve canonical reports, traces, package receipts, and consumer revision identities to distinguish rendering regressions from host/environment failures.

## Development plan

1. Establish browser-safe contracts and a package build/pack boundary.
2. Extract the canonical React graph and migrate Canvas atomically, removing duplicated behavior.
3. Preserve visual/interaction fidelity and qualify exact packed artifacts on both React majors.
4. Establish each additional client's baseline and candidate-package CI, migrate its adapter, and remove its duplicate renderer before declaring that integration complete.

Release acceptance requires both shared-library checks and supported-client journeys. Retaining an independent renderer after migration does not satisfy the consolidation goal.

## Open questions

- Who owns public npm publishing, supported consumer pins, and cross-repository CI?
- Which client/compiler/React patch combinations must qualify, including demand for React 18.2?
- Which existing graph-package consumers need forwarding exports or a deprecation period?

## Alternatives considered

Keeping shared UI inside a client package couples other clients to that application's release process. Copying components per client preserves short-term independence but perpetuates drift. Embedding a hosted graph or iframe introduces runtime integration and accessibility costs where a build-time library is sufficient.

## Design review notes

Pending review of the common contracts, host boundaries, compatibility matrix, and release acceptance criteria.
