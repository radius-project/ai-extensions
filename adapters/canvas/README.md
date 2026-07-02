# Canvas adapter

The Copilot-canvas UI adapter for Radius Canvas. It owns the SDK surface and the
loopback HTTP host that backs the webview, and delegates all product logic to
[`@radius-project/core`](../../radius-core/README.md).

## Modules

| File           | Responsibility                                                        |
| -------------- | --------------------------------------------------------------------- |
| `extension.mjs`| SDK entry: `joinSession()` canvas + tool wiring, process lifecycle.   |
| `server.mjs`   | Loopback HTTP host: request handler, page router, server lifecycle.   |
| `pages.mjs`    | HTML page renderers.                                                   |
| `client.mjs`   | Browser-side JS injected into pages as string constants.              |
| `vendor.mjs`   | CDN/vendor script caching.                                            |
| `deploy.mjs`   | Deploy monitoring + log parsing.                                      |
| `infra.mjs`    | OIDC / workflow / portal wrappers over the core.                     |
| `gh.mjs`       | Shell + GitHub API port primitives.                                  |
| `shared.mjs`   | `escapeHtml` + shared credential state.                              |

## Build

```bash
pnpm build:canvas   # esbuild -> plugins/radius/extensions/radius/extension.mjs
```

`@github/copilot-sdk` is marked external; everything else (the sibling `.mjs`
modules and the TypeScript core) is bundled.

## Extending

See the architecture recipes in
[`radius-core/README.md`](../../radius-core/README.md) for
adding a compute platform, a canvas action/tool, or a new UI adapter.
