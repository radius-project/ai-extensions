# Radius Canvas architecture

## Public npm graph API

The `@radius-project/core` npm package exports only the browser-safe `@radius-project/core/graph` and `@radius-project/core/domain` subpaths, with compiled ESM and TypeScript declarations. The root barrel and the modeling, platform, remediation, and workflow modules are workspace-only APIs. See the [React graph library](../graph-react/README.md) for a consumer example and the [npm release guide](../../docs/eng/RELEASING.md#releasing-npm-graph-libraries) for publication.

## Public Radius queries

`@radius-project/core/domain` exports `createRadiusQueryClient`, resource and recipe types, exact equivalent-type helpers, and the pure `aggregateRecipes` function. The client owns query paths, version discovery, equivalent-type merging, and resource hydration. It imports no HTTP client, credentials, Backstage code, or browser globals. The host supplies a `RadiusQueryPort` that returns decoded responses and rejects HTTP failures.

```typescript
import { createRadiusQueryClient } from "@radius-project/core/domain";
import type { RadiusQueryPort } from "@radius-project/core/domain";

function applicationQueries(port: RadiusQueryPort, signal: AbortSignal) {
  const client = createRadiusQueryClient(port, {
    connectionId: "selected-connection",
    plane: { type: "radius", name: "local" }
  });
  return client.listApplications({ signal });
}
```

The port receives `{ connectionId, plane, method, path, signal }`. Paths include `/apis/api.ucp.dev/v1alpha3` and the API version. The host maps the explicit connection to its transport; the client never chooses a cluster. Cancellation reaches discovery, inventory, resource, and graph requests. Hosts must stop their transport when the signal aborts and own timeout policy. The client limits in-flight requests across all operations, including nested discovery, to four by default; `concurrency` accepts integers from one to 32. It holds no cross-client cache.

`getResourceById<T>({ id, signal? })` requires a full UCP resource ID on the selected plane and fills a missing environment from the referenced application. Typed lists return their records directly. `listResources<T>({ resourceType?, resourceGroup?, signal? })`, `listApplications<T>`, and `listEnvironments<T>` return `{ value, complete, errors }`. Equivalent application and environment lists merge legacy `Applications.Core` before `Radius.Core`, with the first exact ID retained. Untyped inventory lists groups, then resources, then retrieves each resource; it omits `Microsoft.Resources/deployments`. Partial group, type, or resource failures remain in `errors`; an operation with no successful requests rejects with its first error. Empty successful lists remain empty.

`getResourceType({ namespace, typeName, signal? })` first uses the specific discovery endpoint, then the provider inventory if that endpoint fails. `listResourceTypes({ signal? })` includes all namespaces with at least one API version. Queries choose the first discovered API version, or `2023-10-01-preview` if discovery is unavailable or has no versions. This default is an explicit older-control-plane compatibility rule; cancellation never triggers it. Resource and graph transport failures propagate without fallback.

`getApplicationGraph({ applicationId, signal? })` makes a body-free POST and returns the raw `ApplicationGraphResponse` unchanged. It validates the application context and resources array, but does not normalize direction, filter records, synthesize status, or repair connections. Hosts choose their explicit source adapter, then call `normalizeLiveGraph` from `/graph`. The graph guard accepts both single-segment `Applications.Core/applications` and `Radius.Core/applications` IDs on the selected plane and retains their original IDs. Modeled graph hash requirements do not change.

`aggregateRecipes(environment, packsById)` uses only supplied data. It retains inline recipe order and duplicates, then linked-pack order. Pack lookup is case-insensitive, with the last matching key retained; missing packs are skipped. Hosts must load packs and report loading failures separately.

## Legacy public contracts

`parseLegacyResourceId` from `/domain` calls the canonical parser and projects `LegacyResourceId`: `{ plane, group, type, name }`. `plane` is the plane name, `group` is the resource group, and `type` is the full namespace/type. Values retain their original casing. This projection accepts only a Radius plane, one resource-group scope, and one resource segment. It rejects ARM, AWS, global, missing-group, and nested IDs rather than truncating them. Legal names with dots, underscores, and digits are accepted; rejecting these names was a defect in the old restricted parser. `isApplicationType` and `isEnvironmentType` accept an omitted type and return `false`.

`normalizeLegacyLiveGraph` from `/graph` adapts the explicitly selected legacy graph policy once. Ordinary Outbound connections point from dependency to owner; ordinary Inbound connections point from owner to dependency. Only an Inbound connection whose ID parses to the exact full type `Applications.Core/gateways` or `Radius.Compute/routes`, compared case-insensitively, points from dependency to owner. The canonical ID determines this rule even when the supplied connection type is absent or conflicts with the ID. Similar names in other namespaces and nested types are ordinary types. This does not change `normalizeLiveGraph` direction semantics.

Without a context, the legacy normalizer returns the explicit `legacy-live` graph variant; it does not invent an application or connection ID. With a real `GraphContext`, it applies the same strict context validation as `normalizeLiveGraph`. Both paths retain resource IDs, names, full types, and raw provisioning states without Canvas filtering. They never mutate the input. Self and dangling connections are dropped with warnings, identical resources are coalesced with a warning, conflicting duplicates fail, and duplicate presentation edges are coalesced. These are deliberate corrections to old graph defects, not preservation of invalid edges.

## Workspace architecture

Radius Canvas is the application-modeling and deployment product for the GitHub Copilot app. This document describes how the code is laid out after the modularization refactor (see [`docs/design/radius-extension-modularization.md`](../../docs/design/radius-extension-modularization.md)) and gives step-by-step guides for the three changes contributors make most often: **adding a compute platform**, **adding a canvas action/tool**, and **adding a whole new UI adapter**.

## Layout

```text
packages/core/      UI-agnostic core (this package). No SDK, no HTTP, no DOM.
  src/
    graph/                    Bicep -> application graph build + diff (pure).
    modeling/                 Repo modeling: app.bicep generation, recipe resolution.
    platforms/                Compute-platform abstraction (azure, aws) + registry.
    workflows/                GitHub Actions verify/deploy workflow generation.
    ports/                    Interfaces for the outside world (GitHub).
    index.ts                  The public use-case API surface.

packages/adapter-canvas/      The Copilot-canvas UI adapter (thin).
  src/
    extension.mjs             SDK entry: joinSession() wiring + process lifecycle.
    server.mjs                Loopback HTTP host: request handler, router, server lifecycle.
    pages.mjs                 HTML page renderers.
    client.mjs                Browser-side JS (string constants injected into pages).
    vendor.mjs                CDN/vendor script caching.
    deploy.mjs                Deploy monitoring + log parsing helpers.
    infra.mjs                 OIDC / workflow / portal wrappers over the core.
    gh.mjs                    Shell + GitHub API port primitives.
    shared.mjs               escapeHtml + shared credential state.
  build.mjs                   esbuild bundle -> .artifacts/radius/.
```

### The dependency rule

`packages/core` never imports from an adapter, the Copilot SDK, `node:http`, or the
DOM. Anything that touches the outside world is reached through a **port**
(`src/ports/index.ts`). Reading a repository is the only side effect core's
use-cases need today, so `GitHub` is the only port. Adapters depend on the core,
supply port implementations, and own all UI/transport concerns. This keeps the
product logic testable in isolation and makes a second UI (guide 3) a thin layer
rather than a fork.

## Guide 1: Add a compute platform

Everything provider-specific lives behind the `ComputePlatform` interface
(`src/platforms/types.ts`): the platform's id, display name, cluster service
name, and portal deep-links. Workflow selection is *not* behind the interface —
`workflows/verify.ts` keeps its own `VERIFY_FILE_BY_PLATFORM` map, so a platform
registered without an entry there resolves no verify template.

1. Create `src/platforms/<id>.ts` exporting a `ComputePlatform` (use
   `azure.ts` / `aws.ts` as the template). Implement `id`, `displayName`,
   `clusterServiceName`, and `portalUrl(...)`.
2. Register it in `src/platforms/index.ts`: import it and add it to `REGISTRY`.
   Platform objects are reached through `getPlatform(id)`, so they are not
   re-exported from the barrel.
3. Add the id to `VERIFY_FILE_BY_PLATFORM` in `src/workflows/verify.ts`, naming
   its upstream `verify-<id>.yml` template. Deploy and delete need no change:
   they commit every provider workflow and the dispatcher's `detect` job picks
   one at runtime.
4. Add its id to any UI `enum`s (e.g. the canvas `provider` action input in
   `packages/adapter-canvas/src/extension.ts`).
5. `pnpm --filter @radius-project/core typecheck && pnpm build:canvas`.

No changes to `pages.mjs` or `server.mjs` are needed.

## Guide 2: Add a canvas action / tool

Actions are invoked on an open canvas; tools are callable by the agent. Both are
declared in the `joinSession({ canvases, tools })` block in
`packages/adapter-canvas/src/extension.ts` and should delegate to a core use-case.

1. **Put the logic in the core.** Add (or reuse) a function in the relevant
   `src/<area>/` module and export it from `src/index.ts`. The core function
   takes data and ports — never the SDK `ctx`.
2. **Declare the action** in the `createCanvas({ actions: [...] })` array with a
   `name`, `description`, `inputSchema`, and a thin `handler: async (ctx) => …`
   that calls your core function and renders via `server.mjs`/`pages.mjs`.
3. **(Optional) expose a tool** in the top-level `tools: [...]` array so the
   agent can drive it; its `handler: async (args) => …` typically returns text
   telling the agent to `invoke_canvas_action` with the action name.
4. If the action renders a new page, add a renderer to `pages.mjs` and wire it
   into `PAGE_RENDERERS` in `server.mjs`.
5. `pnpm build:canvas`.

## Guide 3: Add a new UI adapter

Because all product logic is in `packages/core` behind ports, a new front-end
(browser panel, chat surface, CLI) is a thin adapter:

1. Create `packages/adapter-<name>/` with its own entry and build.
2. Implement the ports your adapter needs (today just `GitHub`) for that
   environment. The canvas implementation in `packages/adapter-canvas/src/gh.ts` is a reference.
3. Import use-cases from `@radius-project/core` and wire them to your transport
   and rendering. Reuse pure renderers/helpers where the environment allows;
   keep transport-specific code (HTTP host, SDK surface) in the adapter.
4. Add a build script that bundles the adapter, mirroring
   `packages/adapter-canvas/build.mjs`.

Do **not** copy logic out of an adapter into the new one — if something is
shared and UI-agnostic, lift it into `packages/core` first.

## Commands

```bash
pnpm --filter @radius-project/core typecheck
pnpm build:canvas     # esbuild -> .artifacts/radius/
```

## Testing

Run tests from the workspace root:

```bash
pnpm -C packages/core test         # run all tests once
pnpm -C packages/core test:watch   # run in watch mode
```

Or run from inside `packages/core/`:

```bash
pnpm test
pnpm test:watch
```

Run a single test file:

```bash
pnpm -C packages/core test -- src/graph/diff.test.ts
```
