# Lifecycle Contract: github-radius/v1

This document defines the proposed in-process library contract for the shared services and App binding. These are not existing HTTP routes or tool names. The implementation must publish the corresponding machine-readable schemas and executable fixtures; this design artifact is not an implemented API.

## Common Envelope

Every shared-service request contains `apiVersion: github-radius/v1`, `requestId`, an operation discriminator from the catalog below, an explicit `target`, and typed `input`. A target always identifies `repo`; application, environment, definition path, and source are required according to the operation.

The caller context is a separate injected argument containing trusted identity and authorization handles. Public messages cannot establish identity, approval, or arbitrary filesystem authority. Reject invalid types, malformed paths, unsupported versions/operations, and undeclared mutation fields rather than coercing or ignoring them.

Sources use the workspace/git union in [the data model](../data-model.md). A current-session App request resolves its authorized worktree and current branch. A remote source is always resolved to an exact commit. Caller-provided expectations must not be overwritten by a fresher value just to make validation pass.

Common response forms:

- **Read result**: `apiVersion`, `requestId`, typed `result`, resolved target/provenance and observation metadata where relevant.
- **Accepted mutation**: `apiVersion`, `requestId`, `operationId`, resolved target, initial lifecycle state and observation, optional required action.
- **Operation observation**: The same stable `operationId`, target, current evidenced state, observation quality, available attempts/actions/result, and explicit limitations.
- **Error**: `apiVersion`, `requestId`, `error` containing `code`, `message`, `retryable`, optional `operationId`, redacted details, and safe next action when known.

`retryable` applies to the request that failed, not an associated mutation. Read retries may be safe when deployment retries are not. Unavailable graph comparison is a typed result, not an empty diff.

## Operation Catalog

All operations require caller authorization for the resolved scope. Mutations additionally require current policy approval where applicable.

| Operation               | Required target and input                                                                                                  | Result and effect                                                                                                            |
|-------------------------|----------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------|
| `application.delete`    | Repository, environment, application; deletion intent and optional previously approved plan reference                      | Accepted operation with scope preview/approval before deleting one application and reconciling its status artifacts          |
| `application.inspect`   | Repository, application; source and definition path for authored inspection; environment for deployed observations         | Identity and available resource/deployment evidence with source, time, freshness, and limitations; read-only                 |
| `application.list`      | Repository; optional environment and source filters                                                                        | Paged authored/deployed discovery with explicit completeness; read-only                                                      |
| `capabilities.get`      | Repository; optional environment                                                                                           | Supported operation/version/context combinations and limitations for the caller; read-only and not an authorization grant    |
| `credentials.configure` | Repository, provider and declared identity-configuration intent                                                            | Accepted scoped configuration operation, possibly an authentication action; raw credentials excluded                         |
| `credentials.inspect`   | Repository; optional environment/provider                                                                                  | Prerequisite observations and required actions; no interactive login                                                         |
| `definition.author`     | Repository, authorized workspace source, definition path; authoring intent and supported provider                          | Accepted staged authoring operation; validated guarded replacement only, no commit/push/deploy                               |
| `definition.validate`   | Repository, source, definition path; validation policy version                                                             | Validation report, performed/skipped checks and diagnostics; no agent, replacement, or deployment                            |
| `deployment.start`      | Repository, environment, application, definition path, published git source; approval reference and declared repair policy | Accepted operation correlated to actual execution; no acceptance of uncommitted workspace source                             |
| `environment.configure` | Repository, environment; validated configuration patch and approval reference where required                               | Accepted configuration operation; never implicitly deploy                                                                    |
| `environment.create`    | Repository, new environment name, provider; configuration and approval reference                                           | Accepted creation operation configuring workflows, identity references, and recipe registrations                             |
| `environment.delete`    | Repository, environment; teardown intent and optional previously approved plan reference                                   | Accepted operation with phase-plan preview/approval before destructive work; shared-resource protection and partial outcomes |
| `environment.inspect`   | Repository, environment                                                                                                    | Configuration, identity references, recipe registrations, capability limitations and observation metadata; read-only         |
| `environment.list`      | Repository; pagination                                                                                                     | Caller-visible environments and coverage; read-only                                                                          |
| `graph.diff`            | Explicit base and head repository/source/definition selections; graph kind and environment where required                  | Available canonical diff with both provenances, or unavailable source/reason; read-only                                      |
| `graph.get`             | Repository, source/definition for authored or planned graph; environment/application for deployed graph; graph kind        | Canonical graph with kind, provenance, observation and actual environment enrichment; read-only                              |
| `operation.cancel`      | Repository and operation target; `operationId`                                                                             | Cancellation request receipt plus observation of the same operation; no implied rollback                                     |
| `operation.get`         | Repository and operation target; `operationId`                                                                             | Read-only operation observation; no agent handoff or repair initiation                                                       |
| `operation.list`        | Repository; environment/application filters and pagination                                                                 | Available authorized operations with explicit coverage and continuation; no durable-history promise                          |
| `operation.repair`      | Failed operation target; `operationId`, approved repair source, finite attempt policy                                      | New linked repair operation/attempt, usually requiring agent action; publication/deployment remain separately authorized     |
| `operation.respond`     | Parent operation target; `operationId`, `actionId`, typed response                                                         | Parent's resulting state after authorized response handling; no automatic declaration of parent success                      |

For `application.inspect`, authored inspection requires an authorized source and definition path but no environment, including when the repository has no environments. Deployed observations require an explicit environment. A request may select both, with authorization and evidence kept separate; a request selecting neither is invalid. Do not infer an environment or report missing deployed evidence as absence of an authored application.

The standard target repo identifies the head for `graph.diff`; its input supplies both complete source selections, allowing an independently authorized base repository. Do not reuse one source's authorization or provenance for the other. Keep authorized source fetching separate from graph compilation. Compilation of untrusted inputs, including fork sources, must not receive deployment credentials, and graph inspection must not dispatch privileged workflows.

Configuration payloads contain provider-specific non-secret settings and recipe-registration references, validated by the selected provider's capability schema. A patch is explicit about changed fields; omitted fields are not silently reset. Unsupported provider fields fail rather than select another provider.

Starting a mutation may return `action_required` before any remote mutation occurs. If no current approval or deletion-plan reference is available, the service resolves the proposed scope, creates the operation-bound preview and required user decision, and waits for `operation.respond`. The caller does not need an undocumented plan-creation API. Reject stale supplied plan references; do not silently substitute a different destructive scope. Revalidate authority and ownership before each approved phase.

Lists accept a positive page size bounded by the advertised implementation limit and an opaque continuation token. The same caller scope and filters must be used when continuing. Document the selected bounds in the published schema and test zero, minimum, maximum, and one-above-maximum; do not introduce pagination limits on unrelated legacy routes during a structural extraction.

## Required Actions and Validation

`operation.respond.input.response` is a discriminated union:

- `user.decision`: A choice and any declared input; accepted only for the matching user action.
- `agent.outcome`: `completed`, `failed`, or `cancelled`; completed work supplies authorized staged references, not arbitrary paths.

An authentication action completes only after the identity adapter verifies the actual identity/configuration. An environment approval completes only after GitHub confirms it. A claimed completion in the public payload is never sufficient authority.

Validate that the action is outstanding, the caller is its authorized responder, the operation and target match, and the bound source remains current. Consume the response once in the live context and recheck all preconditions before subsequent side effects. Conflicting or unavailable action state never starts work again.

Validation reports use the required/advisory rules in [the data model](../data-model.md#validation-report). Required checks cannot be downgraded after failure or unavailability. Promotion requires all required checks to pass on the same proposed outputs and unchanged original source.

## Typed Ports

| Port                    | Responsibility                                                                                                        | Exclusions                                                              |
|-------------------------|-----------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------|
| Source access           | Authorize opaque workspaces; capture input manifests; resolve commits; prepare read snapshots and guarded replacement | No arbitrary caller paths or implicit commit/push                       |
| Graph execution         | Run canonical Radius graph construction and return typed results with provenance                                      | No duplicate compiler or graph-archive publication on reads             |
| Environment access      | Read actual registrations/configuration; perform approved provider changes                                            | No provider-default substitution or implicit deployment                 |
| Identity/authorization  | Resolve trusted principal; enforce repository/environment scope and action approval                                   | No public credential values or caller-asserted authority                |
| Workflow execution      | Validate execution prerequisites; dispatch once; correlate/observe/cancel exact runs                                  | No newest-run guess or unrestricted command execution                   |
| Agent assistance        | Issue operation/action-bound work and receive authenticated outcomes                                                  | No shared-service dependence on a local skill filename or SDK object    |
| Operation registry      | Store scoped operation/action state in the injected context; bridge existing setup persistence                        | No new durable-history or distributed-lock guarantee                    |
| Clock, IDs, diagnostics | Deterministic time/identity, bounded redacted diagnostics and cleanup signals                                         | No hidden clocks, shared mutable globals, or unsanitized log forwarding |

Each port returns typed success, absence, unavailable evidence, or failure as appropriate. It must not collapse forbidden/network failure into an empty successful result. Reuse existing concrete adapters after narrowing their outputs at this boundary.

## Copilot App Binding

Add an additive `radius_lifecycle` tool through `runtime/declarations.ts` and the existing runtime factory. It accepts typed operation intent and target/input fields from this catalog. The host adapter supplies the contract version and request ID when constructing the shared request, resolves omitted current-session source intent through authorized workspace context, and preserves any explicitly supplied expected commit/fingerprint. It does not open a Canvas or discover a Canvas server to execute the operation.

The implementation's tool schema must enumerate the same operation variants as the shared schema. The tool must not accept arbitrary operations through an untyped object bag. Trusted identity, workspace mappings, approval handles, and agent outcome authority are resolved by the binding, not copied from tool arguments.

Retain the seven current tools and two current actions as compatibility wrappers. Existing authoring, graph-diff Markdown, publish, deploy, and status tools keep their names and accepted inputs. Last-deploy convenience context belongs to the session binding and must resolve to an explicit validated target before invocation. A new explicit repeat remains a new authorized request; an ambiguous previous dispatch must never cause an automatic repeat.

Panel-only concerns such as graph selection, source-link update context tokens, focus, source navigation, and render state stay in the App adapter. Auxiliary custom-type/recipe publication remains a separately authorized capability of existing tools; it is not smuggled into read-only graph operations.

The exact existing `SERVER_ROUTE_DECLARATIONS` remains the HTTP ownership source. Existing routes translate legacy requests/results into the shared services; the lifecycle envelope does not become a replacement global HTTP response shape. Add routes only for approved user interactions needed by this feature, with before/after HTTP fixtures and matching declaration/handler tests.

## Error Vocabulary

| Code                      | Meaning and caller behavior                                                               |
|---------------------------|-------------------------------------------------------------------------------------------|
| `INVALID_REQUEST`         | Malformed operation input; correct it before retrying                                     |
| `VERSION_UNSUPPORTED`     | Unsupported lifecycle or execution version; use a declared supported version              |
| `FORBIDDEN`               | Caller lacks required authority; do not retry with a fabricated approval                  |
| `CAPABILITY_UNAVAILABLE`  | This provider/context/binding lacks the operation or prerequisite                         |
| `SOURCE_CHANGED`          | Expected source no longer matches; resolve it again and renew source-dependent approval   |
| `DEFINITION_NOT_FOUND`    | Authorized source was resolved but no definition exists at the selected path              |
| `SOURCE_UNAVAILABLE`      | Source could not be established; do not claim it is absent                                |
| `RECIPE_PACK_REQUIRED`    | Target registration does not supply a recipe for a known type                             |
| `VALIDATION_FAILED`       | At least one required check failed                                                        |
| `VALIDATION_INCOMPLETE`   | Required checks could not run; replacement is prohibited                                  |
| `ACTION_NOT_OUTSTANDING`  | Action already answered, expired, superseded, or not valid for this request               |
| `ACTION_RESPONSE_INVALID` | Wrong response kind, input, target, responder, or source                                  |
| `OPERATION_UNAVAILABLE`   | The current supported evidence sources cannot locate the operation                        |
| `DISPATCH_UNCONFIRMED`    | Dispatch may have started; reconcile, do not automatically redispatch                     |
| `RESULT_UNAVAILABLE`      | Detailed execution evidence is missing, expired, or unreadable                            |
| `EVIDENCE_MISMATCH`       | Result identity does not match the requested run/target/version                           |
| `EVIDENCE_CONFLICT`       | Correlated evidence disagrees; report uncertainty instead of choosing success             |
| `PRECONDITION_FAILED`     | Ownership, approval, execution state, or another required precondition is not established |
| `REPAIR_LIMIT_REACHED`    | The declared repair budget is exhausted                                                   |

Errors from external systems may carry a namespaced classification and safe diagnostic details without replacing the stable lifecycle category. Output contains no secret values, even when a provider's raw response does.

## Evolution and Publication

Publish schema data and public TypeScript types from the core lifecycle subpath; publish fixtures that validate the same union variants against the App binding. Version lifecycle, resource schemas, command results, and progress/evidence artifacts independently.

Within v1, optional response metadata may be additive; readers ignore unknown non-authoritative metadata but reject unknown discriminators and unsupported versions. Security-sensitive request objects remain closed to undeclared fields. A new operation or authoritative field requires advertised schema support rather than relying on an older reader to ignore it.

Retain supported v1/legacy decoding through migration and at least one published plugin release after a replacement version ships with deprecation guidance. Never remove a decoder still needed by a known in-flight operation. This is an explicit compatibility window, not permission to infer stronger guarantees from old artifacts.
