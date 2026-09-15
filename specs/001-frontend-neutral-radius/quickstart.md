# Validation Quickstart

This guide validates the planned implementation. The lifecycle contract and conformance cases are not implemented by this planning change. Baseline commands below exist now; the proposed fixture-specific command is runnable only after the implementation adds the named tests.

## Prerequisites

- Node.js 24 and the repository-pinned pnpm 11.19.0.
- An isolated repository worktree, not the primary checkout.
- For full CI-equivalent checks, the Windows process job and the pinned Linux Playwright image used by `.github/workflows/build.yml`.
- Tests use fake GitHub/cloud/agent/source ports, synthetic repository names, temporary workspaces, and no personal credentials or live cloud resources.

Run commands from the repository root. Restore packages only when required by dependency changes or missing tools:

```powershell
corepack pnpm install --frozen-lockfile
```

The current environment's npm registry is configured to `https://packagefeedproxy.microsoft.io/npm/`. Registry selection is developer setup, not a lifecycle feature or a credential to embed in fixtures.

## Focused Development Checks

Run owning package tests while implementing:

```powershell
corepack pnpm --filter @radius-project/core test
corepack pnpm --filter @radius-project/adapter-shared test
corepack pnpm run test:integration:runtime
corepack pnpm run test:integration:http
```

Expected outcome: all selected tests execute and pass with fake external dependencies. An empty selection is not a pass for this feature.

Add the proposed panel-free runtime conformance file under the already included runtime integration directory, then run:

```powershell
corepack pnpm --filter @radius-project/adapter-canvas exec vitest run test\integration\runtime\lifecycle-conformance.test.ts
```

Expected outcome: the real production runtime composition, with a fake SDK session and controlled external ports, performs the acceptance sequence without opening a Canvas or starting a loopback server. This file is a required implementation deliverable, not present at planning time.

## End-to-End Acceptance Scenarios

Use the fixture families in [conformance.md](contracts/conformance.md), with identities and state transitions from [data-model.md](data-model.md). Exercise these sequences through the actual App binding, not test-only service entry points:

1. **Panel-free deployment**: Discover the controlled application and environment, request an authored graph, start deployment from a published synthetic revision, and inspect its operation. Expect a stable operation ID, exact provenance, and success only after all required phase and workflow evidence succeeds. Assert zero panel/server starts.
2. **Uncommitted source safety**: Change the worktree definition and a supporting local module, then request a graph. Expect those bytes, not default-branch content. Change a guarded input during authoring; expect replacement rejection and preserved user files.
3. **Required versus advisory checks**: Make a required compiler/schema check unavailable; expect incomplete validation and no promotion. Make only an advisory check unavailable; expect a disclosed warning and no advisory-only blocker.
4. **Uncertain dispatch and status**: Timeout dispatch before run identity is confirmed, then supply a uniquely matching run or unrelated runs. Expect reconciliation only for the matching run, no redispatch, and explicit uncertainty otherwise. Repeat failed-operation status 100 times and assert zero agent/repair/deploy calls.
5. **Completion failures**: Supply command success followed by state-save failure, then command failure followed by cleanup failure. Expect no false success and preservation of the primary failure. Remove detailed artifacts while retaining a failed workflow conclusion; expect that known conclusion plus unavailable phase detail.
6. **Explicit actions and repair**: Return an outstanding agent action, submit an unauthorized/wrong-kind/stale response, then a valid response. Expect rejection without side effects for invalid responses, and required validation before continuation for valid ones. Exhaust the declared repair budget and verify no further attempt or implicit publication.
7. **Configuration and deletion**: Configure an environment with a fake identity prerequisite and verify no deployment. Delete one application while another remains. Tear down an environment with an unauthorized shared identity phase; expect partial completion or a blocked phase with safe recovery guidance.
8. **Compatibility and rollback**: Execute retained tools and routes with baseline fixtures, then route through the new service. Preserve accepted legacy shapes except explicitly documented safety changes. Roll back routing while a controlled operation is in flight; preserve observation/control without dispatching it again.

For browser-visible flows, extend existing critical journeys and include keyboard/accessibility checks for new required-action, uncertainty, warning, and partial-deletion states. Use real renderers and loopback HTTP with external fakes; an all-mocked browser page does not prove the browser/server seam.

## Complete Pull-Request Gate

After focused checks, run the existing baseline:

```powershell
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm run format:check
corepack pnpm run coverage
corepack pnpm run build
corepack pnpm run test:integration:artifact
```

`coverage` already includes runtime and HTTP integration. Inspect changed-code coverage and the unchanged baseline floors; passing aggregate coverage alone is not sufficient.

Run Windows process evidence on Windows:

```powershell
corepack pnpm run test:integration:windows-process
```

Run the following in the repository's pinned Playwright CI environment:

```text
pnpm run test:component
pnpm run test:chromium
```

Expected build output includes one loadable `.artifacts/radius/com.github.copilot/extensions/radius/extension.mjs` with SDK imports externalized. Built-extension smoke verifies registration and shutdown from the real production artifact.

For changed workflow/action sources, require both jobs in **Extension self-tests**: shell helper checks/tests and artifact-uploader tests/rebuild consistency. The uploader is a standalone package with its own lockfile; its workflow installs with `--ignore-workspace`. Do not replace executable shell behavior tests with YAML/source string searches.

Visual and reliability workflows are scheduled gates. Real-host qualification and dedicated live-cloud checks follow their existing release/scheduled policies; none is claimed by passing local fakes.

## Planning Artifact Checks

These commands check the documentation produced by planning:

```powershell
$files = Get-ChildItem -LiteralPath "specs\001-frontend-neutral-radius" -Recurse -File -Filter "*.md" | Select-Object -ExpandProperty FullName
corepack pnpm exec markdownlint-cli2 @files --config ".github\linters\.markdownlint-cli2.yaml"
corepack pnpm exec markdown-table-formatter @files --check
```

Expand file paths before invoking the tools on Windows; a backslash-containing glob can produce an empty selection or be treated as a literal filename. Expected outcome: every Markdown file in the feature directory is selected, with no Markdown or table-formatting errors. No runtime feature test result should be reported as passing until the implementation and its fixtures exist.
