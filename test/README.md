# Tests

End-to-end tests for the Radius Canvas product core.

## Running

```bash
pnpm test
```

## How it works

`radius-core` is UI-agnostic TypeScript/ESM that uses `.js` import specifiers
resolving to `.ts` sources (`moduleResolution: "bundler"`), so Node's test
runner cannot execute it directly. `test/run.mjs` therefore reuses the same
[esbuild](https://esbuild.github.io/) dependency the canvas build pipeline uses
to bundle each `test/e2e/*.test.ts` file, then runs the bundles with Node's
built-in test runner (`node:test`). No additional test framework is introduced.

## Layout

| Path                              | Responsibility                                              |
| --------------------------------- | ---------------------------------------------------------- |
| `test/run.mjs`                    | esbuild bundler + `node --test` runner.                    |
| `test/e2e/radius-core.e2e.test.ts`| End-to-end walk through the `@radius-project/core` API.     |

The end-to-end test drives the full product pipeline through the package's
public API: model a repository (docker-compose + Terraform) → build the
application graph from Bicep → diff two branches → select a compute platform →
generate the verify/deploy GitHub Actions workflows → build and hash a graph
from a symbolic ARM template. It uses only deterministic, port-free functions,
so it needs no network, GitHub, or SDK access.
