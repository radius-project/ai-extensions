# Validation Quickstart

This guide records the completed checkpoints through T078 and runnable response, repair, and cancellation scenarios for the authorized T079–T089 checkpoint. Deletion and T090 onward remain outside this slice.

## Implemented Foundation and Limits

The core lifecycle package publishes versioned schemas for all 21 operation variants, source-expectation policy, operation/action state, and the dispatcher. The shared adapter provides strict validators and authorized source snapshots. The App registers the additive `radius_lifecycle` tool without requiring a Canvas, retains existing tools/routes, and includes routing guards and a bridge to legacy setup/deletion records.

The App registers `capabilities.get`, `application.list`, `application.inspect`, `environment.list`, `environment.inspect`, `graph.get`, and `graph.diff` alongside the foundation's `operation.respond` handler and session-owned `operation.get`/`operation.list` readers. Discovery uses fresh trusted authorization, GET-only GitHub reads, and confined current-worktree capture. Deployment registration requires injected trusted execution dependencies; the production binding does not fabricate host approval or agent-assignment verification. A public approval claim cannot grant authority. Guarded action success is verified with injected trusted contexts, not claimed as real-host qualification. Source-capture limitations are documented in [data-model.md](data-model.md#source-snapshot-and-definition).

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

Expected future outcome: the real production runtime composition, with a fake SDK session and controlled external ports, performs the acceptance sequence without opening a Canvas or starting a loopback server. This full-feature file remains deferred; use the checkpoint-specific fixtures below.

## End-to-End Acceptance Scenarios

### Runnable Panel-Free Deployment and Observation

Run the actual core, shared execution adapter, runtime binding, retained tools, and loopback HTTP boundary with controlled external ports:

```powershell
npm exec --yes --package=pnpm@11.19.0 -- pnpm exec vitest run packages\core\src\lifecycle\deployment.test.ts packages\core\src\lifecycle\execution-result.test.ts packages\core\src\lifecycle\operation-reads.test.ts packages\adapter-shared\src\lifecycle\workflow-execution.test.ts packages\adapter-shared\src\lifecycle\execution-evidence.test.ts packages\adapter-canvas\test\integration\runtime\lifecycle-deployment.test.ts packages\adapter-canvas\test\integration\http\lifecycle-deployment.test.ts packages\adapter-canvas\src\runtime\lifecycle-deploy-tools.test.ts --maxWorkers=2
```

The supported-host fixture supplies a trusted source-bound authorization port, captured published source, the actual reviewed workflow templates, and controlled workflow observations. It uses the real composed lifecycle services rather than an unavailable handler. It does not qualify the current Copilot SDK as a trusted approval host and never dispatches a live GitHub workflow.

Expected outcomes:

- One accepted deployment creates an operation and attempt before exactly one dispatch. A timeout or transport exception remains unconfirmed and does not permit a second dispatch with the same preparation.
- Exact operation, attempt, repository, environment, application, source commit, workflow, run ID, and run attempt determine correlation. A newer unrelated run is not a substitute; zero or multiple matches remain uncertain.
- Confirmed success requires matching final evidence for checkout, restore, command, state-save, and cleanup as well as successful workflow conclusion. State-save failure is failed, not deployed success. Workflow failure or cancellation remains authoritative even when the final artifact is absent.
- Missing or foreign final artifacts cannot establish success; independently confirmed workflow failure or cancellation remains known. Resource progress has a separate sequence stream and cannot establish final command or operation success.
- Each success, save-failure, missing-artifact, foreign-artifact, cancellation, and timeout case performs **100 reads with zero repairs, zero additional dispatches, and no source mutation**. Retained status works without a panel and continues reading a known canonical operation after writer rollback.
- Operation listing exposes only authorized session-owned records and scope-bound pagination. It does not promise durable history or reconstruction after restart.

Run the shipped shell helpers from Bash:

```bash
bash .github/extension/actions/lifecycle-evidence/evidence_test.sh
bash .github/extension/actions/deploy-progress/progress_test.sh
```

These tests check the actual restore/save/cleanup blocks with fake commands, distinguish their exits, preserve command failure while attempting save after successful restore, and verify progress identity, monotonic sequences, interruption, and diagnostic withholding. Canonical deployment does not create environments, change recipe registrations, prepare shared Gateway infrastructure, or inject unreviewed deployment parameters; those prerequisites must already be configured.

The current SDK has no trusted source-bound approval seam. Canonical mutation remains explicitly unavailable there, while existing legacy deployment remains available. Public approval references are identifiers, not authority. An accepted canonical mutation never falls back to legacy execution. Status polling only observes; a failure notice does not authorize an agent repair, source publication, or redeployment.

#### Deployment Checkpoint Gate

The final same-source gate passes **12,909 Node tests with 47 intentional skips**, static type/lint/format checks, unchanged coverage floors, build, **18 built-extension tests**, **33 component tests**, **78 Chromium cases with zero retries**, and **16 Windows process tests**. Extension self-tests pass all **13 discovered shell suites**, both contrib policy/verifier checks, shellcheck over **25 scripts**, and **6 uploader tests** with an unchanged rebuilt bundle.

Qualification used Node 24.13.1, pnpm 11.19.0, isolated non-root Linux dependencies/Git metadata, and the pinned Playwright image. The complete Node coverage command used `vitest run --maxWorkers=2 --coverage --coverage.reportOnFailure`: bounded concurrency resolved an earlier unrelated compiler-process timeout without extending test budgets, lowering thresholds, or accepting retry-only passes. The source archive SHA-256 is `2C0149679831B6D167498AFCADFDCF2432AE894A93AF70C85B143E0D9CAA6A47`; only checkpoint documentation/checkmarks changed after qualification.

The eleven new lifecycle/phase modules have 100% statements, branches, functions, and lines. Exact counts and the existing composition-root instrumentation limitation are recorded in [conformance.md](contracts/conformance.md). Logs and per-file source identities are retained under `.artifacts/t067-*`. No live workflow or infrastructure deployment was triggered, no personal credentials were used, and the shared worktree was not committed, pushed, or submitted as a pull request.

An additional Windows artifact run passes 17 of 18 assertions. Its unchanged graph-read smoke expects `CAPABILITY_UNAVAILABLE` but receives `INVALID_REQUEST`; the same failure was reproduced from an isolated archive of baseline commit `7d2c4c903175e708a709ee2684337f07413c5385`. That pre-existing platform limitation was not changed in this slice. The required Linux artifact gate passes all 18 assertions, and the final local Windows build is retained.

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

Canonical promotion binds the complete original effective-input manifest and exact validated output bytes, including expected absence for a first definition. Newly introduced dependencies outside that captured baseline remain incomplete. Multi-file replacement is not a filesystem transaction: rollback and cleanup failures are reported, and unresolved recovery material is retained. The separately requested legacy agent loop keeps five repairs after its initial compile; independent verification does not consume or reset that legacy record. Canonical staging uses the coordinator-owned budget described in the response/repair checkpoint below, not another agent compiler loop.

For canonical operations, registry-dependent models, unsafe Windows cache configuration, and missing applicable schema, runtime/client, source-reference, or Recipe evidence remain incomplete or unavailable. Application-only evidence can establish genuine non-applicability; that is not proof that workload models pass. Native qualification separately exercised five captures and five real Bicep builds with owned Radius 0.60.2/Bicep 0.42.1 tools, including warnings and property-type errors. Native tests are opt-in, not ordinary passing assertions. The new legacy CLI native qualification case was not run; its ordinary executable cases use a recorded compiler protocol and the real retained checks.

The final checkpoint passes 12,639 Linux Node assertions with 47 intentional skips, static checks, coverage floors, build, 18 built-extension assertions, 30 component tests, 75 Chromium cases without retries, and 16 dedicated Windows process assertions. The CLI suite passes 30 executable cases on Windows. The new verification functions and retained generation helper have complete changed-function coverage; existing invariant-only exceptions remain recorded in the conformance inventory. No real-host or live-cloud qualification is implied.

### Environment and Credential Checkpoint (T068–T078)

Environment preparation is independent of application deployment. Inspection reads the current Azure or AWS caller without login or changing the active subscription. Configuration requires an outstanding user action, rechecks the exact approved settings or patch, verifies identity independently, preserves omitted settings and existing environment protections, and records environment, workflow-publication, and actual recipe-registration evidence. A timeout or incomplete publication remains unconfirmed or partial rather than successful. Never repeat a write merely because its status is uncertain.

Run the composed core, runtime, and real-loopback contracts without cloud credentials:

```powershell
corepack pnpm exec vitest run packages\core\src\lifecycle\credentials.test.ts packages\core\src\lifecycle\environments.test.ts packages\core\src\lifecycle\environment-configuration.test.ts packages\adapter-shared\src\lifecycle\environment-configuration.test.ts packages\adapter-canvas\test\integration\runtime\lifecycle-environments.test.ts packages\adapter-canvas\test\integration\http\lifecycle-environments.test.ts
```

The fixtures use the real action engine, registry, scoped credential adapter, provider writer, existing workflow publisher, and HTTP route owners. Their external identity, GitHub, and recipe effects are controlled. They assert that configuration starts no application deployment, duplicate continuation consumes an action only once, and 100 subsequent operation reads produce no additional external calls. In the pinned Chromium environment, run `pnpm run test:component` and `pnpm run test:chromium --retries=0`; the new journeys cover explicit authentication, Azure/AWS create/configure, partial publication, navigation/resume, keyboard focus, and WCAG checks.

For a supported injected host, start `environment.create` with an explicit provider configuration or `environment.configure` with a provider-bound patch. The compatible HTTP start is `POST /api/operations` with `{repo, environment, configuration}` or `{repo, environment, patch}`. Credential configuration uses `{repo, provider, credentialIntent: "authenticate"}` or explicit identity selection. Read the returned `statusUrl`, then submit the outstanding action ID to its projected continuation path with `{actionId, choice: "continue"}`. Browser mutation requests retain the existing origin and nonce requirements; these do not replace trusted lifecycle authority. In the App, return to the **Environments** tab to review and continue outstanding setup actions. Navigating to **Credentials** does not consume or abandon them.

The current SDK still cannot establish trusted approval or authenticated agent outcome, and the native environment reader/publisher does not provide the complete qualified canonical configuration contract. Native canonical create/configure therefore remains unavailable rather than falling back after acceptance. Supported injected-host Azure/AWS fixture success is not a claim of native-host or cloud feature parity. Existing legacy setup, profiles, publication, and durable controls remain available; a fresh verification that could automatically chain deployment is refused until that unsafe workflow is removed. Existing verification-run observation/reconciliation remains usable without another dispatch.

T068–T078 passed on 2026-09-17: 13,213 Linux Node assertions with 47 intentional skips, typecheck/lint/format, unchanged coverage floors, build, 18 built-extension assertions, 36 component cases, 82 Chromium cases with zero retries, and 16 Windows process assertions. The 13 workflow helper suites, contrib policy/verifier, 25-script shellcheck, and six uploader assertions/rebuild-consistency checks also passed. All final Node, browser, artifact, Windows-process, and helper runs used the same 1,166-file source snapshot: SHA256 `AC9C1A365A16CFE862FA12C016B690EB24228D68FDA125D32FDB6C2E9AE93350`. Only checkpoint-closeout documentation changed afterward. Detailed commands, hashes, counts, and logs are recorded in `.artifacts/t078-closeout-evidence.json`.

Ten of the thirteen new production modules have complete statement, branch, function, and line coverage. Across all thirteen modules, measured coverage is 504/510 statements, 707/715 branches, 83/84 functions, and 435/441 lines; the exact producer-invariant guards and required-but-unreachable adapter callback are documented in [conformance.md](contracts/conformance.md#environment-coverage). The modified action engine, operation registry, lifecycle binding/authorization, and environment operation browser controller are fully covered. No coverage ignores or reduced floors were introduced. The previously reproduced optional Windows artifact limitation remains unchanged; the required Linux artifact gate passed all 18 cases. No live authentication, deployment, infrastructure mutation, or actual-host qualification was performed. Those T068–T078 results exclude the subsequent repair/cancellation checkpoint documented below; deletion remains excluded.

### Explicit Responses, Bounded Repair, and Cancellation

Run the actual core policies, shared execution adapter, authenticated agent binding, runtime, and existing loopback routes:

```powershell
corepack pnpm exec vitest run packages\core\src\lifecycle\repair.test.ts packages\core\src\lifecycle\cancellation.test.ts packages\adapter-shared\src\lifecycle\workflow-execution.test.ts packages\adapter-canvas\test\integration\runtime\lifecycle-controls.test.ts packages\adapter-canvas\test\integration\http\lifecycle-controls.test.ts
```

Start `operation.repair` only for an identified failed operation, using the host-approved current workspace source and an explicit `repairPolicy`. The default policy is manual. A new operation and attempt link back to the failed record; the failed original remains unchanged. All descendants and repeated requests against that original share at most five repair cycles. A lower authorized ceiling remains binding. Once exhausted, another request returns `REPAIR_LIMIT_REACHED` without another agent assignment, publication, or deployment.

An explicitly approved automatic policy advances only after the existing action engine consumes an authenticated failed response. It rechecks authority and source for each linked cycle. Delivery retries use the same receipt and require trusted proof of non-delivery; they do not spend another repair cycle or duplicate a delivered handoff. User decisions cannot attest agent output, and a late, foreign, stale, or already consumed action cannot promote a proposal.

Canonical staging is coordinator-owned. The standalone agent checker refuses to open a fresh compile loop there. The coordinator compiles at most the initial proposal plus five linked repair proposals; validation and guarded promotion still inspect the actual staged bytes. Separate authorization is required to publish or redeploy a repaired source. The legacy modeling checker retains its independent six-compile limit for a separately requested legacy run.

`operation.cancel` addresses the exact known operation and, for a deployment, its known workflow run and attempt. A received cancellation request is not proof of termination. Authenticated terminal agent evidence can still finish an outstanding requested cancellation, while owned local cancellation prevents a completed proposal from being promoted. Later observations retain known state-save and cleanup outcomes even if a new final artifact is missing. A terminal completion race keeps its evidence; cancellation never means cloud rollback. Unsupported stop, exit, or rollback mappings return an explicit refusal instead of guessing.

The existing operations HTTP routes expose these controls through their original nonce/origin guards and acceptance/status shapes. The deployment page shows explicit repair/cancel controls for a known lifecycle operation; the environment controller uses the same request builder and observes the exact accepted linked operation, never the repository's latest unrelated record. Refused repair acceptance starts no observation or mutation. Keyboard focus moves to the announcement before controls become disabled. Closing the panel stops observation only. Session shutdown fences local continuations and releases owned staging/process resources without claiming remote cancellation or restart recovery.

The runtime and loopback scenarios assert 100 reads with no additional agent work or mutations. Component and Chromium journeys cover explicit control acceptance, refusal, navigation, keyboard use, and WCAG checks. The current native SDK still lacks trusted source-bound approval and authenticated assignment/outcome support, so canonical repair remains unavailable there. Injected-host fixtures exercise real composed services, not native-host or live-cloud qualification.

T079–T089 passed on 2026-09-17: 13,404 Linux Node assertions with 47 intentional skips, typecheck/lint/format, unchanged coverage floors, build, 18 built-extension assertions, 42 component cases, 87 Chromium cases with zero retries, and 16 Windows process assertions. The 13 workflow helper suites, contribution policy/verifier, 25-script Shellcheck, and six uploader assertions/rebuild-consistency checks passed. The final gates used the same 1,180-file frozen source: SHA256 `7d3ed6394d4fcb56611c96cc32eb1a4fbfa417c2e79f25a39289c0b1ccf1815e`. Only this quickstart, conformance guidance, and task-closeout document changed afterward. `.artifacts/t089-closeout-evidence.json` records commands, counts, logs, limitations, and the per-file `{path, sha256}` inventory.

The five new production modules have 316/316 statements, 370/371 branches, 46/46 functions, and 284/284 lines covered. [Response and Control Coverage](contracts/conformance.md#response-and-control-coverage) identifies the three structurally unreachable changed guards and separate executable script evidence. No thresholds were reduced and no coverage ignores were introduced. The optional Windows artifact graph-read limitation reproduced on the earlier untouched baseline remains unchanged; the required Linux artifact gate passed all 18 cases. No live login, workflow dispatch, infrastructure mutation, or actual-host qualification was performed. Implementation stops before T090.

### Cumulative Acceptance Scenarios

Discovery, graph, authoring/validation, deployment/observation, and environment/credential configuration are covered within the supported-host and source limitations above. The response/repair/cancellation scenarios above are the current checkpoint; deletion remains a later slice. The following scenarios describe cumulative acceptance, not a claim that deletion is complete.

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
