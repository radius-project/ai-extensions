# Validation Quickstart

This guide records the implementation checkpoints completed through T050. Source, evidence, and host limitations are explicit below. No T051+ deployment, configuration, or deletion implementation is claimed.

## Implemented Foundation and Limits

The core lifecycle package publishes versioned schemas for all 21 operation variants, source-expectation policy, operation/action state, and the dispatcher. The shared adapter provides strict validators and authorized source snapshots. The App registers the additive `radius_lifecycle` tool without requiring a Canvas, retains existing tools/routes, and includes routing guards and a bridge to legacy setup/deletion records.

The App registers `capabilities.get`, `application.list`, `application.inspect`, `environment.list`, `environment.inspect`, `graph.get`, and `graph.diff` alongside the foundation's `operation.respond` handler. Discovery uses fresh trusted authorization, GET-only GitHub reads, and confined current-worktree capture. Other lifecycle operations remain unavailable. The production binding still does not fabricate host approval or agent-assignment verification; a public approval claim cannot grant authority. Guarded action success is verified with injected trusted contexts, not claimed as real-host qualification. Source-capture limitations are documented in [data-model.md](data-model.md#source-snapshot-and-definition).

Authored inspection returns source and definition evidence without requiring a graph or environment. Environment inspection retains partial configuration and explicitly unavailable recipe observations without fabricating an empty registration list. Deployed evidence requires an explicit environment and application-correlated GitHub metadata; uncorrelated metadata is unavailable, not proof of current Radius state.

## Prerequisites

The T018-T038 scope remains strictly read-only. Where existing evidence cannot establish actual environment recipe registrations, the implementation discloses unavailable recipe evidence and planned graphs rather than restoring a control plane or producing new workflow artifacts. Authored inspection and authored graph reads remain independent of environment registration evidence. This user-approved limitation is recorded in [research.md](research.md#5-environment-specific-planned-graphs).

- Node.js 24 and the repository-pinned pnpm 11.19.0.
- An isolated repository worktree, not the primary checkout.
- For full CI-equivalent checks, the Windows process job and the pinned Linux Playwright image used by `.github/workflows/build.yml`.
- Tests use fake GitHub/cloud/agent/source ports, synthetic repository names, temporary workspaces, and no personal credentials or live cloud resources.

Run commands from the repository root. Restore packages only when required by dependency changes or missing tools:

```powershell
corepack pnpm install --frozen-lockfile
```

The current environment's npm registry is configured to `https://packagefeedproxy.microsoft.io/npm/`. Registry selection is developer setup, not a lifecycle feature or a credential to embed in fixtures.

If Corepack cannot fetch the pinned package manager through the configured feed, run `npm exec --yes --package=pnpm@11.19.0 -- pnpm --version` to bootstrap the same version through npm's registry resolution. Replace the `corepack pnpm` prefix below with `npm exec --yes --package=pnpm@11.19.0 -- pnpm` on that machine. Do not disable TLS verification or change repository version pins to bypass bootstrap failures.

## Focused Development Checks

Run owning package tests while implementing:

```powershell
corepack pnpm --filter @radius-project/core test
corepack pnpm --filter @radius-project/adapter-shared test
corepack pnpm run test:integration:runtime
corepack pnpm run test:integration:http
```

Expected outcome: all selected tests execute and pass with fake external dependencies. An empty selection is not a pass for this feature.

Run the implemented lifecycle contracts, state, adapters, and public-entry assertions:

```powershell
corepack pnpm exec vitest run lifecycle packages\adapter-shared\src\index.test.ts
```

Run the implemented panel-free foundation boundary:

```powershell
corepack pnpm --filter @radius-project/adapter-canvas exec vitest run test\integration\runtime\lifecycle-foundation.test.ts
```

Expected outcome: the real runtime composition with a fake SDK session preserves declared tool schemas and caller expectations, rejects untrusted responses, consumes a trusted response once, retains operation lifetime without a panel, and rejects routing transitions that orphan or redispatch known work. These tests do not execute the story scenarios below.

The later full-feature conformance file remains a planned deliverable:

```powershell
corepack pnpm --filter @radius-project/adapter-canvas exec vitest run test\integration\runtime\lifecycle-conformance.test.ts
```

Expected future outcome: the real production runtime composition, with a fake SDK session and controlled external ports, performs the acceptance sequence without opening a Canvas or starting a loopback server. This full-feature file is not part of the current T018-T038 scope.

## End-to-End Acceptance Scenarios

### Runnable Panel-Free Discovery

T018-T026 are complete. Panel-free discovery and legacy listing routes use the same core factories and shared adapters. The discovery checkpoint includes unit, runtime, HTTP, built-extension, and existing browser-journey evidence.

Run the real runtime fixture:

```powershell
corepack pnpm exec vitest run packages\adapter-canvas\test\integration\runtime\lifecycle-discovery.test.ts
```

The scenarios `exposes truthful discovery capabilities through the panel-free public tool` and `discovers and inspects real authored bytes with zero environments and fences supplied source expectations` use the actual runtime composition, a fake SDK, controlled GitHub reads, and real temporary authored files. They require no personal credentials, cloud resources, publication, or Canvas server.

Exercise the real-loopback compatibility and source boundaries with:

```powershell
corepack pnpm exec vitest run packages\adapter-canvas\test\integration\http\lifecycle-discovery.test.ts packages\adapter-shared\src\lifecycle\workspace-source.test.ts packages\adapter-shared\src\lifecycle\github-source.test.ts
```

Expect both canonical definitions to remain observable, exact captured source expectations, explicit absence versus unavailable errors, caller-scoped cache reuse, and partial environment evidence that is neither cached nor workflow-synced. Browser fixtures use finite canonical GET responses and reject unmatched commands; the complete Chromium gate covers the retained environment and deployment journeys.

For a host attached to `owner/repo` with an `app.bicep` definition declaring application `app`, the public tool request is:

```json
{
  "operation": "application.inspect",
  "target": {
    "repo": "owner/repo",
    "application": "app",
    "definition": "app.bicep"
  },
  "input": {}
}
```

Replace the target values with the attached repository's actual values. Omit `source` to use the authorized current workspace: the binding supplies the context-owned reference and computed fingerprint, as well as the contract version and request ID. No environment is required. An explicit source expectation remains a constraint and is not overwritten when files change.

Authored listing reads `.radius/app.bicep` and then `app.bicep`, retaining both applications when present, and reports partial coverage rather than claiming recursive repository enumeration. Explicit inspection selects the requested definition; an unsupported first definition is not silently skipped. The legacy single-application picker chooses the first canonical definition and warns when multiple definitions exist. Recipe observations may be unavailable even when environment configuration is readable, and correlated GitHub deployment metadata does not prove fresh Radius control-plane state.

### Graph Fixtures and Current Limits

T027-T038 are complete for the supported source and evidence forms below. The final checkpoint includes 11,892 passing Linux Node assertions, 17 built-extension assertions, 16 Windows process assertions, 30 component tests, and 75 Chromium cases with retries disabled. Existing HTTP failure statuses, source freshness, and separately labeled retained diagnostics are covered; this is not a claim of general registry-model or live-environment support.

Run the fixture-backed graph boundary and process cases:

```powershell
corepack pnpm exec vitest run packages\core\src\lifecycle\graphs.test.ts packages\core\src\lifecycle\recipe-registrations.test.ts packages\adapter-canvas\test\integration\runtime\lifecycle-graphs.test.ts packages\adapter-canvas\test\integration\http\lifecycle-graphs.test.ts packages\adapter-shared\src\lifecycle\graph-execution.test.ts packages\adapter-shared\src\rad-process-isolation.test.ts
```

These cover changed supporting and binary inputs, independently authorized committed fork sources, exact source expectations, unavailable comparisons, zero publication, literal process arguments, isolated environment/home/cache, and cleanup. Runtime fixtures use real composition and snapshots with an injected compiler boundary; process cases run real child processes. They do not claim live cloud or actual-host qualification.

The independent scenario changes a captured supporting file and binary artifact, requests another authored graph, then compares separately pinned base/head commits across authorized repositories. It verifies both provenances and refusal when either authorization or expectation fails. The core recipe fixtures use distinct actual-registration observations for two environments and distinguish a known missing recipe from unavailable registration evidence. No provider-default pack substitutes for either observation.

For a fixture or attached repository containing a supported definition:

```json
{
  "operation": "graph.get",
  "target": {
    "repo": "owner/repo",
    "definition": ".radius/app.bicep"
  },
  "input": { "kind": "authored" }
}
```

Omitting source selects the authorized current workspace. A committed comparison supplies independent `input.base` and `input.head` selections, each with repository, definition, and a Git source containing the explicit ref and expected commit. The outer target repository must match the head. Never invent a workspace reference or treat fixture commit values as live repository evidence.

Authored reads require complete, supported, self-contained inputs and usable managed binaries. Static local extension archives are supported; ordinary generated registry-valued `bicepconfig.json` entries are not generally supported because isolated compilation does not restore registry dependencies. On Windows, captured configuration is refused unless its cache location matches the owned compilation cache; captured user configuration is never rewritten. The successful native Windows qualification used an inline local `.tgz` extension with no repository configuration. This is a limited supported source form, not a claim that ordinary generated models work unchanged.

The native qualification used Radius v0.60.2 and Bicep 0.42.1 against the checked-in `packages/adapter-shared/test/fixtures/lifecycle-registry-inputs` model and local archive, including inert registry strings in companion data. On Windows, the separate `packages/adapter-shared/src/lifecycle/graph-execution-native.test.ts` case runs only when `RADIUS_NATIVE_GRAPH_TEST_TOOLS` explicitly selects an owned native-tool directory; routine runs intentionally skip it. Production acquisition may reuse an existing managed or explicitly selected Radius binary and managed Bicep; these qualification versions are not production pins. An unavailable or incompatible binary is a failure, not permission to replace a user's explicit override.

Production planned reads return unavailable actual registration evidence. Production deployed reads return unavailable Radius graph provenance; GitHub deployment metadata is not a canonical deployed graph. A separately labeled, exact-run retained-monitoring projection can preserve settled diagnostics without supplying topology or deletion inventory. Available planned/deployed port fixtures prove service behavior only.

### Authoring and Validation Checkpoint

Standalone `definition.validate` is production-wired through authorized captured source, isolated native Bicep compilation, and the shipped validation rules. T039-T050 are complete, including the repaired legacy generation and CLI verification paths. Passing fixture authoring does not establish actual-host canonical authoring support.

The generation tool follows the selected writer. The current SDK retains legacy skill bootstrap; a lifecycle-selected request never falls back after failure. The user explicitly chose to preserve legacy compiler/static checks while keeping canonical validation strict. The original standalone `--begin`, validate, write-origin, promote sequence remains supported: promotion performs actual verification before creating its first seal. An optional `--seal --staging <dir>` command permits a separate verification checkpoint. Missing or changed evidence after sealing is rejected; an origin hash alone does not authorize promotion. The shipped modeling skill documents both modes and the full sequence.

Exercise the repaired runtime and executable CLI boundaries with:

```text
pnpm exec vitest run packages/adapter-canvas/src/runtime/create-radius-tools.test.ts packages/adapter-canvas/test/integration/runtime/lifecycle-authoring.test.ts packages/adapter-canvas/src/promote-app-model.cli.test.ts
```

For a supported definition in the attached repository:

```json
{
  "operation": "definition.validate",
  "target": {
    "repo": "owner/repo",
    "definition": ".radius/app.bicep"
  },
  "input": {
    "policyVersion": "github-radius/validation/v1"
  }
}
```

The binding resolves omitted source intent through the authorized current workspace and preserves explicit commit/fingerprint expectations. Validation requires no agent or Canvas and does not modify source, publish artifacts, commit, push, or deploy. A failed required check produces `failed`; unavailable or skipped required evidence produces `incomplete` unless another required check failed. Advisory warnings are separate and cannot downgrade a required check.

Run the runtime and promotion fixtures:

```powershell
corepack pnpm exec vitest run packages\adapter-canvas\test\integration\runtime\lifecycle-authoring.test.ts packages\adapter-shared\src\lifecycle\definition-promotion.test.ts packages\core\src\modeling\app-staging.test.ts packages\adapter-canvas\src\promote-app-model.guard.test.ts packages\adapter-canvas\src\promote-app-model.test.ts
```

The trusted-host fixture exercises assignment, authenticated completion, actual validation, and promotion; it rejects changed source, revoked approval, and foreign-agent outcomes. Production canonical authoring remains unavailable because the current SDK cannot prove source-bound approval or authenticated assignment/outcome. Public approval claims and an agent's completion message cannot supply that missing authority. This limitation does not disable the retained legacy workflow described above.

Canonical promotion binds the complete original effective-input manifest and exact validated output bytes, including expected absence for a first definition. Newly introduced dependencies outside that captured baseline remain incomplete. Multi-file replacement is not a filesystem transaction: rollback and cleanup failures are reported, and unresolved recovery material is retained. The staged agent loop keeps five repairs after its initial compile; independent verification does not consume or reset that agent record.

For canonical operations, registry-dependent models, unsafe Windows cache configuration, and missing applicable schema, runtime/client, source-reference, or Recipe evidence remain incomplete or unavailable. Application-only evidence can establish genuine non-applicability; that is not proof that workload models pass. Native qualification separately exercised five captures and five real Bicep builds with owned Radius 0.60.2/Bicep 0.42.1 tools, including warnings and property-type errors. Native tests are opt-in, not ordinary passing assertions. The new legacy CLI native qualification case was not run; its ordinary executable cases use a recorded compiler protocol and the real retained checks.

The final checkpoint passes 12,639 Linux Node assertions with 47 intentional skips, static checks, coverage floors, build, 18 built-extension assertions, 30 component tests, 75 Chromium cases without retries, and 16 dedicated Windows process assertions. The CLI suite passes 30 executable cases on Windows. The new verification functions and retained generation helper have complete changed-function coverage; existing invariant-only exceptions remain recorded in the conformance inventory. No real-host or live-cloud qualification is implied.

### Remaining Full-Feature Scenarios

These broader scenarios are not claimed as implemented by the current checkpoint.

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
