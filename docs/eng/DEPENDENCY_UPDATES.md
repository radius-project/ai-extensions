# Dependency updates runbook

This runbook is for whoever triages dependency pull requests, including the on-call engineer. It covers how Dependabot updates arrive and which dependencies need more than a passing CI run before they merge.

## How updates arrive

Dependabot is configured by [`.github/dependabot.yml`](../../.github/dependabot.yml). That file is synced from [`radius-project/.github`](https://github.com/radius-project/.github), so do not edit it here: changes are overwritten by the next sync. It opens one weekly pull request per ecosystem after a 7-day cooldown. Every npm version update lands in the single `javascript-deps` group, so one dependency that needs manual work blocks the whole group until someone completes that work.

## Triage a failing Dependabot pull request

1. Open the failing check and find the first assertion failure.
2. Match the failure to a row below and follow the linked section. If nothing matches, treat the failure as a normal regression in the updated dependency.
3. Check out the Dependabot branch, apply the required changes, and push them to the same pull request. Once someone else pushes to it, Dependabot stops rebasing that pull request; comment `@dependabot recreate` only if you want to discard your commits and start over.
4. Run [`pnpm changeset`](../../CONTRIBUTING.md#changesets) when the update changes a released package, as described in the section you followed.

| Failure                                                                                  | Section                                                     |
|------------------------------------------------------------------------------------------|-------------------------------------------------------------|
| `flow.css does not match the pinned @xyflow/react`                                       | [React Flow](#react-flow-xyflowreact)                       |
| `React Flow no longer ships <hook>, which hosts may style`                               | [React Flow](#react-flow-xyflowreact)                       |
| A `THIRD-PARTY-NOTICES.txt` marker is missing after a bundled dependency changes version | [Bundled third-party notices](#bundled-third-party-notices) |

## React Flow (`@xyflow/react`)

`@radius-project/graph-react` pins `@xyflow/react` to an exact version in `packages/graph-react/package.json`. That pin is the only place the version is written: the stylesheet generator, the packed-manifest check, and the notice test all read it. Dependabot updates it for you, so the only manual work is reviewing what the new version changes:

- **Vendored stylesheet.** `packages/graph-react/src/flow.css` is a scoped copy of React Flow's `dist/style.css`, stamped with the version it was generated from. It is checked into source and must be regenerated, and reviewed, whenever the pin changes.
- **Public styling hooks.** Hosts may style `.radius-graph__edge .react-flow__edge-path`, `.react-flow__controls`, `.react-flow__controls-button`, `.react-flow__background`, and the `--xy-background-pattern-color` custom property. A test fails if the vendored stylesheet loses one of them; that change requires a graph-react major release. See [Styling contract](../../packages/graph-react/README.md#styling-contract) in the graph-react README for the full contract.

To unblock a Dependabot pull request that bumps `@xyflow/react`:

1. Check out the Dependabot branch and run `pnpm install`.
2. Run `node scripts/graph-vendor-styles.mjs` to regenerate `packages/graph-react/src/flow.css`.
3. Review the `flow.css` diff alongside the React Flow release notes. Look for changes to the supported hooks above, node and handle markup, `Controls`, `Background`, and viewport behavior.
4. Run `pnpm run test:integration:libraries` and `pnpm run test:component`. If **Visual comparisons** then reports an intended rendering change, follow [Canvas visual baselines](../../CONTRIBUTING.md#canvas-visual-baselines).
5. Commit `flow.css` to the Dependabot branch. Add a [changeset](../../CONTRIBUTING.md#changesets) when the update changes shipped graph behavior or appearance; a removed or renamed supported hook is a major change.

The Headlamp qualification fixture (`scripts/fixtures/headlamp/package.json` and `TOOL_VERSIONS` in `scripts/fixtures/headlamp/contracts.mjs`) pins Headlamp's own React Flow peer, which is a different host's version. It is checked only by the scheduled real-host qualification, so it does not need to change to unblock a pull request.

## Bundled third-party notices

The build writes `THIRD-PARTY-NOTICES.txt` from the packages actually bundled into Canvas, and `packages/adapter-canvas/test/integration/artifact/built-extension.test.ts` reads the expected versions from the installed packages. A routine version bump of `react`, `react-dom`, `@xyflow/react`, `@xyflow/system`, `dagre`, `graphlib`, `lodash`, or `yaml` therefore needs no test change.

If that test fails, the bundle no longer includes one of those packages, or the notice is missing its license file. Run `pnpm run build`, open `.artifacts/radius/THIRD-PARTY-NOTICES.txt`, and confirm whether the dependency was intentionally removed or replaced. A license change needs maintainer review before the update merges.
