# Canvas adapter

The Copilot-canvas UI adapter for Radius Canvas. It owns the SDK surface and the
loopback HTTP host that backs the webview, and delegates all product logic to
[`@radius-project/core`](../core/README.md).

## Modules

| File           | Responsibility                                                      |
|----------------|---------------------------------------------------------------------|
| `extension.ts` | SDK entry: `joinSession()` canvas + tool wiring, process lifecycle. |
| `server.ts`    | Loopback HTTP host: request handler, page router, server lifecycle. |
| `pages/`       | HTML page renderers split by page responsibility.                   |
| `browser/`     | Browser behavior compiled in memory into inline page scripts.       |
| `vendor.ts`    | CDN/vendor script caching.                                          |
| `deploy.ts`    | Deploy monitoring + log parsing.                                    |
| `infra.ts`     | OIDC / workflow / portal wrappers over the core.                    |
| `gh.ts`        | Shell + GitHub API port primitives.                                 |
| `shared.ts`    | `escapeHtml` + shared credential state.                             |

## Build

```bash
pnpm build:canvas   # esbuild -> .artifacts/radius/
```

`@github/copilot-sdk` is marked external; everything else (the sibling TypeScript
modules and the TypeScript core) is bundled.

## Extending

See the architecture guides in
[`packages/core/README.md`](../core/README.md) for
adding a compute platform, a canvas action/tool, or a new UI adapter.
