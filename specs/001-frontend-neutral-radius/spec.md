# Feature Specification: Frontend-Neutral GitHub Radius

**Feature Branch**: `nellshamrell-spec-kit-setup`

**Created**: 2026-09-15

**Status**: Draft

**Input**: User description: "Create a spec for the architecture described in this pull request <https://github.com/radius-project/radius/pull/12967>"

**Source**: [radius-project/radius#12967](https://github.com/radius-project/radius/pull/12967), [architecture proposal at revision `1d218580e2eee9ea0ccc99bda647891fac29dd0a`](https://github.com/radius-project/radius/blob/1d218580e2eee9ea0ccc99bda647891fac29dd0a/docs/architecture/repo-radius.md). This specification describes proposed behavior, not capabilities already shipped.

**Release Scope**: Deliver the shared lifecycle contract and Copilot App migration. Copilot CLI integration is deferred and is not a release acceptance requirement. All lifecycle stories below apply to the shared contract and App; validate frontend neutrality through panel-free App invocation and shared conformance scenarios, without requiring a second production frontend.

## Clarifications

### Session 2026-09-15

- Q: What must the first release support in Copilot CLI before this feature is considered complete? -> A: Shared contract and App migration only; CLI deferred.
- Q: How should definition validation be reported when some checks cannot run? -> A: Required checks block replacement; advisory checks warn. An unavailable required check makes validation incomplete, while an unavailable advisory check produces a disclosed warning.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover Applications and Available Actions (Priority: P1)

As an application owner, I can discover applications and environments I can access, inspect their known state, and learn which lifecycle actions my current interface supports without opening a graphical panel or knowing a previous deployment's identifier.

**Why this priority**: Reliable discovery and explicit limitations let users choose a valid target and avoid mistaking a local definition or an old observation for a live deployment.

**Independent Test**: With controlled authored definitions, deployment observations, environment visibility, and caller permissions, perform discovery and inspection through the shared contract and App. Verify the results and limitations without performing a mutation.

**Acceptance Scenarios**:

1. **Given** a repository containing an authored application definition and a separate deployed application, **When** an authorized user lists applications in an explicit scope, **Then** each result identifies its evidence source and distinguishes authored from deployed state.
2. **Given** deployment evidence is missing or stale, **When** the user inspects an application, **Then** the result identifies the application and environment, includes available deployment and resource status with observation time and freshness, and does not equate missing evidence with application absence.
3. **Given** environments with different access permissions, **When** the user lists or inspects environments, **Then** only authorized information is returned.
4. **Given** the current interface lacks an agent or a provider-specific action, **When** the user checks available capabilities or requests that action, **Then** its supported versions, execution contexts, and limitations are explicit, and the unsupported request does not report success.

### User Story 2 - Understand and Compare the Correct Application (Priority: P1)

As a developer, I can inspect authored, planned, and deployed application graphs and compare changes using the source I selected, including my uncommitted work, without modifying or publishing that source.

**Why this priority**: Graphs are useful only when users can trust which source and environment they represent. This is also a useful first capability for an interface without a panel.

**Independent Test**: Use a worktree with uncommitted definition changes, two remote revisions, and two environments with different recipe registrations. Verify graph identity, differences, limitations, and the absence of source or remote mutations.

**Acceptance Scenarios**:

1. **Given** the current session has uncommitted changes to an application definition or its supporting inputs, **When** the user requests its authored graph, **Then** the graph reflects those changes and identifies the resolved worktree source instead of substituting the default branch.
2. **Given** base and head identify different branches or repositories, **When** the user compares them, **Then** both sources are resolved independently, both provenances are returned, and the App preserves the shared contract's comparison result.
3. **Given** either comparison source lacks a resolvable definition, **When** the user requests a comparison for a pull request, **Then** the unavailable source and reason are reported, no empty diff is substituted, and pull request creation can proceed without a graph section while preserving the actual change description.
4. **Given** two environments register different recipes, **When** the user requests a planned graph for one environment, **Then** enrichment uses that environment's registrations and is described as expected outputs rather than a guaranteed deployment plan.
5. **Given** a known resource type has no matching registered recipe, **When** planned resolution is requested, **Then** the missing registration is reported instead of inventing a new resource type to bypass it.
6. **Given** a deployed graph is available, **When** the user requests it, **Then** it is identified as an observation of deployed resources with its environment and observation time, not presented as the authored or planned graph.

### User Story 3 - Author and Validate Definitions Without Losing Work (Priority: P1)

As a developer, I can ask for a new or updated application definition, review a validated result, and retain edits made while authoring was underway. I can also validate an existing definition without an agent or a deployment.

**Why this priority**: Safe source authoring is a prerequisite for a trustworthy create-or-update application experience through the shared contract and App.

**Independent Test**: Author against a controlled workspace, change a referenced input while the proposed definition is being prepared, and verify that replacement is rejected. Separately validate existing definitions with agent capabilities disabled.

**Acceptance Scenarios**:

1. **Given** an authorized workspace and agent capability, **When** authoring finishes and the original effective inputs are unchanged, **Then** validated proposed files may replace the working definition without committing, pushing, or deploying it.
2. **Given** the entry definition, a referenced local module, or relevant configuration changes during authoring, **When** the proposed files are ready, **Then** replacement is rejected with a source-change explanation and concurrent edits remain intact.
3. **Given** an existing definition and no agent, **When** validation is requested, **Then** performed checks, diagnostics, and skipped or unavailable checks are reported without replacing source or deploying; success is not described as a guarantee of deployment success.
4. **Given** no suitable built-in resource type exists, **When** authoring considers a custom type, **Then** it may propose the type and its recipe pack only within declared provider support, and reports an explicit limitation for a service that cannot be provisioned.
5. **Given** the interface cannot provide agent assistance, **When** authoring is requested, **Then** the limitation is returned without claiming a definition was created.
6. **Given** a required validation check cannot run, **When** validation or authoring is requested, **Then** validation is reported as incomplete rather than successful and proposed files cannot replace the working definition.
7. **Given** all required checks pass and an advisory check cannot run, **When** validation completes, **Then** validation may succeed with a warning identifying the unavailable advisory check, and replacement remains subject to the unchanged-source and authorization checks.

### User Story 4 - Prepare Environments Without Deploying Accidentally (Priority: P2)

As an environment administrator, I can inspect identity prerequisites, explicitly configure credentials, and create or update deployment environments without unintentionally deploying an application.

**Why this priority**: Environment administration is independently useful and must remain distinct from application deployment, especially where it needs elevated permissions.

**Independent Test**: Inspect and configure a controlled environment through the shared contract and App, including a configuration change that requires interactive authentication. Verify declared changes, permission checks, and zero implicit deployments.

**Acceptance Scenarios**:

1. **Given** identity prerequisites are incomplete, **When** the user inspects them, **Then** the result describes what is missing without initiating interactive login.
2. **Given** configuration needs authentication or approval, **When** an authorized user requests it, **Then** the required action is explicit and completion is checked before configuration continues.
3. **Given** permission to create an environment, **When** the user creates it, **Then** its workflows, identity references, and recipe registrations are configured within the requested scope, with any unsupported provider capabilities disclosed.
4. **Given** an existing environment, **When** an authorized user changes its configuration or recipe registrations, **Then** the configuration is validated and updated without implicit redeployment or bypassing separate deployment approval.

### User Story 5 - Deploy and Observe a Specific Revision Without a Panel (Priority: P1)

As an application owner, I can deploy a published revision to an explicit environment and follow the same operation through the App's tools without opening a Canvas panel or confusing another user's run with mine.

**Why this priority**: This is the central frontend-neutral lifecycle outcome. Correct source, correlation, and completion evidence are necessary before users can trust deployment reports.

**Independent Test**: Start deployments with no panel open against controlled execution outcomes. Cover successful completion, stale source, ambiguous dispatch, concurrent runs, state-save failure, and missing observations.

**Acceptance Scenarios**:

1. **Given** an authorized, approved deployment target and published source, **When** deployment starts without a panel, **Then** the user receives a stable operation identifier and resolved target, and execution is correlated to that operation and source.
2. **Given** the selected source changed after it was approved or differs from the revision that would execute, **When** deployment is attempted, **Then** the mismatch is rejected before executing the unintended revision.
3. **Given** dispatch times out before a run is confirmed, **When** the result is reported, **Then** the user is told execution may have started and no duplicate deployment is dispatched automatically.
4. **Given** deployment commands succeed but saving Radius state fails, **When** status is read, **Then** deployment is not reported as successful and the user is told resources may have changed without successfully saved state.
5. **Given** status retrieval fails or detailed results are missing, **When** status is read, **Then** observation uncertainty is reported separately from execution state; any confirmed workflow conclusion is preserved without inventing unavailable phase outcomes.
6. **Given** a deployment command fails and cleanup also fails, **When** status is displayed, **Then** the original failure remains primary, cleanup is reported separately, and the App preserves the affected target and safe next action from the shared result.
7. **Given** a known operation and a repository containing other runs, **When** the user lists or inspects operations, **Then** results are access-controlled and correlated to the requested scope, with pagination and history coverage limitations disclosed.

### User Story 6 - Respond, Repair, and Cancel Deliberately (Priority: P2)

As an application owner, I can answer an outstanding action, authorize bounded repair of a failed operation, or request cancellation without granting unintended permissions or treating observation as permission to mutate.

**Why this priority**: Interactive actions make longer workflows usable, but must not turn polling, stale approvals, or repeated responses into additional work.

**Independent Test**: Use an operation awaiting a decision, a failed deployment, and a running deployment. Exercise authorized and unauthorized responses, stale source, bounded repair, repeated status reads, and unconfirmed cancellation.

**Acceptance Scenarios**:

1. **Given** an outstanding user decision, **When** an authorized caller submits a response matching its declared choices and current target/source, **Then** the operation can proceed to its next prerequisite or execution state without the response alone declaring success.
2. **Given** an outstanding agent action, **When** the authorized agent reports completion, failure, or cancellation, **Then** the outcome is associated with that action and completed outputs still require validation and unchanged-source checks.
3. **Given** an action is stale, expired, superseded, already answered, or of the wrong kind, **When** a response is submitted, **Then** it is rejected without starting work again; uncertain action status is reported as uncertain.
4. **Given** a failed operation, **When** status is read repeatedly, **Then** no repair or redeployment begins.
5. **Given** a failed operation and authorization to repair, **When** repair starts, **Then** it creates a distinct linked attempt against approved source within a declared attempt limit; editing permission does not authorize publication or redeployment.
6. **Given** a running operation, **When** cancellation is requested, **Then** the request is distinguished from confirmed cancellation, with no promise of cloud rollback and any known incomplete cleanup reported.

### User Story 7 - Delete Only What Was Approved (Priority: P2)

As an administrator, I can delete a single application or explicitly tear down an environment while seeing the destructive scope, protecting shared resources, and understanding any partial completion.

**Why this priority**: Deletion completes the lifecycle but requires its own authorization and recovery semantics rather than being inferred from deployment behavior.

**Independent Test**: Delete one application in an environment containing another application, then separately exercise environment teardown with shared identities and an injected phase failure.

**Acceptance Scenarios**:

1. **Given** explicit approval to delete one application, **When** deletion runs, **Then** it removes that application and reconciles its status artifacts without implying permission to tear down the environment.
2. **Given** an environment teardown request, **When** approval is requested, **Then** the treatment of workloads, stored state, workflows, and identities is declared, including shared resources.
3. **Given** ownership or permissions cannot be established for a destructive phase, **When** teardown reaches that phase, **Then** the phase does not proceed and the reason is reported.
4. **Given** some approved destructive phases succeed and another fails, **When** the outcome is shown, **Then** completed and incomplete phases and recovery steps are reported rather than claiming an atomic success or rollback.

### User Story 8 - Keep Existing Workflows Usable During Adoption (Priority: P2)

As an existing Copilot App user, I can continue using familiar tools and panel interactions while lifecycle capabilities move to a common contract, with the App preserving that contract's results and errors. A future Copilot CLI integration can use the same contract but is not part of this release.

**Why this priority**: Adoption should not require users to abandon working integrations, duplicate mutations, or lose access to operations already underway.

**Independent Test**: Exercise supported legacy requests and results alongside the new contract using the same controlled scenarios. Switch compatible routing while an operation is underway and verify observation remains possible without redispatch.

**Acceptance Scenarios**:

1. **Given** an existing supported tool request or workflow result, **When** the capability migrates, **Then** supported tool names, inputs, and panel behavior remain usable through the compatibility period.
2. **Given** the same authorized request and controlled execution evidence, **When** the shared contract and App handle it, **Then** results, errors, required actions, and authorized side effects have the same meaning even if presentation differs.
3. **Given** an unsupported contract or result version, **When** it is encountered, **Then** an explicit incompatibility is reported instead of guessing its meaning.
4. **Given** an in-flight operation, **When** routing is migrated or rolled back, **Then** the operation remains addressable through a compatible execution path and is neither redispatched nor discarded; a transition unable to preserve this is not performed.

### Edge Cases

- A source reference attempts to access an unauthorized workspace or a definition outside the repository: reject it before reading or writing the target.
- A fork pull request contains untrusted definitions or recipe references: graph inspection must not gain deployment credentials or execute privileged untrusted workflows.
- A progress artifact belongs to another repository, environment, application, run, or attempt: reject it as evidence for the current operation.
- Progress arrives out of order: order observations only within their matching run; do not compare sequence values across runs.
- A workflow is queued or awaiting environment approval: do not classify the wait as deployment failure or accept a frontend claim as approval.
- State restoration fails or never runs: do not deploy or save uninitialized state over the existing archive.
- A runner disappears or cancellation prevents final results: report known evidence and uncertainty without promising final state persistence or rollback.
- A workflow conclusion conflicts with a phase result: disclose the conflict rather than selecting the successful-looking result.
- Status access is rate-limited: bound observation retries and disclose stale or unavailable observations; never convert a read retry into a deployment retry.
- Diagnostics contain secrets or exceed the display limit: redact before publication or delivery, bound output, and disclose truncation.
- Two mutations affect the same deployment-state scope: preserve execution safeguards against unsafe overlap without claiming cross-session coordination guarantees.
- A capability exists but its caller lacks permission: deny the request; capability discovery is not authorization.

## Requirements *(mandatory)*

### Functional Requirements

#### Common Behavior and Discovery

- **FR-001**: The system MUST expose one versioned lifecycle contract usable without an open Canvas panel and migrate Copilot App lifecycle capabilities to it, preserving the contract's semantic results. It MUST publish shared machine-readable request, result, error, and required-action definitions and shared behavioral conformance scenarios. This release MUST demonstrate frontend neutrality through panel-free App invocation and shared conformance scenarios; a production Copilot CLI integration is deferred.
- **FR-002**: The system MUST disclose supported operations, versions, execution contexts, and provider or agent limitations for the caller and repository. Unsupported capabilities MUST return an explicit limitation rather than a no-op or misleading success.
- **FR-003**: The system MUST discover and inspect applications within explicit repository and, where needed, environment scope, identifying application identity, available resource and deployment status, authored versus deployed evidence, observation time, freshness, and incomplete or unavailable results.
- **FR-004**: The system MUST list caller-visible deployment environments within a repository and inspect a selected environment without mutation.
- **FR-005**: Each request MUST identify its contract version, request identity, intended operation, and explicit target, including application and environment where needed. Authorization MUST derive from trusted caller identity and be enforced for reads, mutations, and action responses, not from caller-supplied permission claims.
- **FR-006**: The system MUST version the lifecycle contract independently from resource and execution-result formats, reject unsupported versions, and define an explicit compatibility period for incompatible changes. Supported additive changes and supported legacy formats MUST retain their established meaning.

#### Source and Graph Safety

- **FR-007**: Source-dependent operations MUST distinguish an authorized workspace snapshot from a remote revision, validate repository-relative paths, return actual resolved provenance, and reject stale expectations. Workspace references MUST NOT grant arbitrary filesystem access.
- **FR-008**: Current-session source reads MUST use the current worktree and branch, including uncommitted effective definition inputs. Other repository or branch reads MUST resolve remote source to a specific commit rather than substitute the default branch.
- **FR-009**: The system MUST return authored, environment-specific planned, and deployed graphs with graph kind, source provenance, environment where relevant, and observation time. It MUST preserve canonical resource and relationship meaning without adding presentation state or treating planned outputs as a guaranteed deployment plan.
- **FR-010**: Graph comparison MUST resolve both sources independently and use consistent equivalence rules across interfaces. Missing or unresolvable definitions MUST produce an explicit unavailable comparison identifying the source and reason, not an empty difference.
- **FR-011**: Graph reads and comparisons MUST NOT commit, push, deploy, publish graph archives, or silently author missing definitions. Temporary computation output is permitted. An unavailable comparison MUST NOT block pull request creation or replace its actual change description.
- **FR-012**: Planned graphs MUST use the selected environment's actual recipe registrations. A known type lacking a matching recipe MUST be reported as requiring registration, not replaced by a new custom type.

#### Definition Authoring and Validation

- **FR-013**: Definition authoring MUST require authorized workspace and agent capabilities, prepare proposed outputs separately, validate them, and replace existing files only after all required validation checks pass and all effective original inputs remain unchanged, including referenced local modules and relevant configuration.
- **FR-014**: Successful authoring MUST NOT itself commit, push, or deploy. Failed validation or changed source MUST leave concurrent working definition edits intact and report the reason replacement was refused.
- **FR-015**: Existing-definition validation MUST work without agent assistance, source replacement, or deployment and report performed checks, diagnostics, and unavailable or skipped checks. Checks MUST be classified as required or advisory before execution; a required check MUST NOT be downgraded because it cannot run. A failed required check MUST prevent successful validation and replacement. An unavailable or skipped required check MUST make validation incomplete and block replacement. Unavailable or skipped advisory checks MUST produce disclosed warnings but MUST NOT alone prevent successful validation or replacement when all required checks pass. Validation MUST NOT promise deployment success.
- **FR-016**: Authoring MAY propose a custom resource type and its recipe pack only when no suitable built-in type exists and the provider capability supports it. Unsupported services MUST be explicit limitations; missing registrations MUST NOT be bypassed using custom types or inline singleton recipes.

#### Credentials and Environments

- **FR-017**: Identity inspection MUST remain read-only and MUST NOT unexpectedly initiate login. Credential configuration MUST be an explicit, scoped action with declared authentication and authorization prerequisites.
- **FR-018**: Environment creation and updates MUST validate authorized changes to workflows, identity references, and recipe registrations. Environment configuration MUST NOT implicitly deploy applications; any combined configuration-and-deployment flow requires explicit authorization for both.
- **FR-019**: Raw credentials MUST NOT appear in public requests, results, graphs, or diagnostics. Deployment MUST use the selected environment's authorized identity configuration, preserve its protection rules, and limit privileges to the requested work.

#### Deployment and Observation

- **FR-020**: Deployment MUST require an explicit application, repository, environment, published source, and appropriate authorization and approval. The requested revision MUST match the revision actually executed, with source mismatch rejected before deployment.
- **FR-021**: Approvals MUST bind to the relevant operation, target, and source. Changed source MUST invalidate source-dependent approval, and frontend decisions MUST NOT replace authoritative environment approvals.
- **FR-022**: Starting a long-running mutation MUST return a stable operation identity, resolved target, and initial state independently of panel identity. Execution MUST correlate that operation to its source, run, and attempt rather than infer ownership from the latest run.
- **FR-023**: The system MUST distinguish queued, running, action-required, succeeded, failed, and cancelled lifecycle states from current, stale, or unknown observation quality. Missing evidence, runner loss, or a failed observation MUST NOT invent a terminal execution outcome.
- **FR-024**: Operation discovery MUST be access-controlled, paginated, and filterable by repository, environment, and optionally application, with coverage limitations disclosed. Operation inspection MUST report available progress and results without substituting for application inspection.
- **FR-025**: Status reads MUST NOT initiate repair or other user mutations. Transient observation retries MUST be bounded and respect rate limits; a read being safe to retry MUST NOT imply that the underlying mutation is safe to repeat.
- **FR-026**: Unconfirmed dispatch MUST be reported as uncertain without automatic redispatch. Conflicting mutations MUST NOT run unsafely against the same deployment-state scope; no exactly-once or cross-session coordination guarantee is implied.
- **FR-027**: Progress and results MUST be checked against repository, environment, application, run, attempt, and supported result version before use. Sequence ordering MUST apply within a run only; contradictory evidence MUST be disclosed rather than resolved in favor of success.
- **FR-028**: Deployment reporting MUST distinguish command outcome, workflow conclusion, state persistence, and cleanup. Success MUST require evidence that all required completion phases succeeded; command success followed by state-save failure MUST NOT be reported as deployment success.
- **FR-029**: Execution MUST protect existing Radius state: failed or absent restore prevents deployment commands and state save, while successful restore permits a state-save attempt even after command failure. Missing final evidence MUST remain explicit, and graph artifacts MUST NOT be treated as restorable deployment state.
- **FR-030**: Errors MUST include a stable classification, concise explanation, request identity, whether retrying the failed request is safe, and operation identity when available. Execution diagnostics MUST identify the affected target, failed phase, correlated run or attempt, workflow link, uncertainty, and safe next action when known.
- **FR-031**: Reporting MUST preserve the primary failure and present diagnostic-collection or cleanup failures separately. Logs MUST support, not replace, structured execution evidence; confirmed workflow conclusions MUST remain visible even when detailed artifacts are unavailable.
- **FR-032**: Diagnostics MUST be redacted before publication or delivery to a frontend or agent, bounded with truncation disclosed, and access-controlled. Repository content, generated definitions, recipes, and artifacts MUST be treated as untrusted inputs, not authority; fork graph inspection MUST NOT receive deployment credentials or run privileged untrusted workflows.

#### Required Actions, Repair, and Cancellation

- **FR-033**: A blocked operation MUST expose an identifiable required action and accept responses only from callers authorized for that operation, target, action kind, and bound source. User decisions and agent outcomes MUST remain distinct; agent completion MUST NOT bypass output validation, unchanged-source checks, or deployment approval.
- **FR-034**: Responses MUST apply only to outstanding actions and match declared choices or required input. Conflicting, stale, expired, superseded, or wrong-kind responses MUST fail explicitly; uncertainty about action status MUST NOT restart work. Acceptance MUST return the parent operation's resulting state, not assume success.
- **FR-035**: Repair MUST be explicitly authorized, bounded by a declared attempt limit, and linked as a distinct attempt to the failed operation and approved source. It MUST require agent and edit capability, while publishing and redeploying require separate authorization. Any automatic repair policy MUST be explicit, bounded, and independent of status polling.
- **FR-036**: Cancellation MUST be authorized and best-effort, distinguishing a request from confirmed cancellation. It MUST NOT promise cloud rollback and MUST report known incomplete cleanup and preserved state when available.

#### Deletion and Compatibility

- **FR-037**: Application deletion MUST require explicit target approval, delete only the selected application, and reconcile its status artifacts. It MUST NOT imply environment teardown.
- **FR-038**: Environment teardown MUST be a separately authorized destructive operation declaring treatment of workloads, state, workflows, and identities, including shared resources. Ownership, provenance, and permissions MUST be verified before each destructive phase; partial completion and recovery steps MUST be reported.
- **FR-039**: Migration MUST preserve supported existing tool names, inputs, panel interactions, and execution contracts through explicit compatibility handling. New lifecycle requests MUST represent bounded, authorized actions rather than unrestricted command execution.
- **FR-040**: Migration and rollback MUST NOT dual-run mutations, redispatch existing operations, or discard in-flight operations. Routing may change only when a compatible execution path can continue handling those operations.

### Key Entities *(include if feature involves data)*

- **Application**: A named application within a repository and environment, with authored and deployed evidence kept distinct.
- **Application Definition**: The entry definition and supporting modules, custom types, recipe packs, and relevant configuration that describe the intended application.
- **Source Snapshot**: An authorized worktree snapshot or resolved remote revision, including branch, effective-input fingerprint or commit, and provenance.
- **Environment**: A deployment target with workflow configuration, identity references, recipe registrations, protection rules, and declared provider capabilities.
- **Application Graph**: Resources and relationships derived from authored inputs, enriched for planning, or observed from deployment, with source and observation context.
- **Graph Comparison**: Differences between two independently resolved graphs, or an unavailable result identifying the affected source and reason.
- **Capability Declaration**: Supported operations, versions, execution contexts, and limitations for a caller and repository; not an authorization grant.
- **Operation**: One lifecycle activity with a stable identity, explicit target, source, state, observation quality, progress, and available result.
- **Execution Attempt**: A correlated execution of an operation or authorized repair, with run identity, phase outcomes, and a relationship to any original failed operation.
- **Required Action**: An outstanding user or agent interaction bound to an operation, authorized responder, target, source, and permitted response.
- **Approval**: Authorization for a particular operation and target, bound to source where relevant and invalidated by changes to that scope.
- **Execution Evidence**: Correlated observations and phase results, distinct from supporting diagnostics and from the Radius state needed to restore a deployment.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All shared acceptance scenarios produce the same semantic result, required action, and authorized side effects through the shared contract and Copilot App. Every unsupported capability is identified explicitly; none reports fabricated success. No Copilot CLI integration is required to meet this release criterion.
- **SC-002**: A user can use Copilot App tools to discover an application, inspect its graph, deploy a selected published revision, and observe the resulting operation with no Canvas panel open and no need to supply a panel identifier.
- **SC-003**: In every source-safety scenario, returned provenance matches the source used, stale source is rejected before protected mutation, and concurrent edits are preserved. All graph-read and comparison scenarios produce zero commits, pushes, deployments, or graph-archive publications. Every unavailable-required-check scenario reports incomplete validation and performs zero definition replacements; unavailable advisory checks produce warnings without alone blocking replacement.
- **SC-004**: Across all dispatch, status-loss, cancellation, and contradictory-evidence scenarios, there are zero automatically duplicated uncertain mutations and zero unsupported terminal-success claims. Every state-save failure following command success remains distinguishable from deployment success.
- **SC-005**: Repeating status reads 100 times for a failed operation starts zero repair attempts or redeployments. Explicit repair cannot exceed its configured attempt limit or publish or redeploy without the corresponding authorization.
- **SC-006**: Every permission, stale-approval, and unauthorized-response scenario is rejected before protected side effects. All credential-bearing diagnostic scenarios redact the sensitive values before publication or display and identify truncation where applicable.
- **SC-007**: Every environment-configuration scenario completes or reports a specific prerequisite without implicit deployment. Every deletion scenario preserves unapproved targets and describes any partial completion and recovery steps.
- **SC-008**: All supported legacy compatibility scenarios retain their established user-facing behavior, and all migration or rollback scenarios preserve access to in-flight operations without duplicate execution.
- **SC-009**: For every modeled failure or unavailable observation, the user can distinguish confirmed failure, cancellation, waiting for action, and unknown outcome from the report alone, identify the affected target, and find the stated next action without interpreting raw logs.

## Assumptions

- The scope is the proposed lifecycle across `radius-project/ai-extensions` and `radius-project/radius`, recorded in this repository for planning. It is not limited to the files changed by the documentation-only source pull request, and it does not authorize immediate implementation.
- This release delivers the shared lifecycle contract and Copilot App migration across the full lifecycle. Copilot CLI remains a future consumer, not a required deliverable or acceptance environment for this release. Future bindings must preserve the shared contract's semantics and disclose unsupported capabilities.
- Existing Radius graph meaning, resource behavior, and deployment-state safeguards remain authoritative. This feature does not introduce a second definition compiler or redefine graph equivalence independently in each frontend.
- The application definition includes `.radius/app.bicep` and its effective supporting inputs. Existing index-staging behavior may be preserved; authoring still does not imply a commit, push, or deployment.
- Remote deployment continues to use GitHub Actions and published source. Workflow availability on the default branch is a prerequisite for dispatch, not permission to substitute that branch for the selected application source.
- Existing repository and environment access controls and protected deployment approvals remain authoritative. Provider-specific setup and teardown capabilities must be declared; Azure and AWS parity is not assumed. The source proposal's current custom-type authoring path supports Azure, not every provider.
- Durable operation history, recovery across sessions or process restarts, replay guarantees, cross-session coordination, and safe automatic retry after uncertain mutations are outside this specification. Existing durable Radius deployment state remains in scope.
- Concrete transports, hosting, package placement, schema format, and exact per-action field layouts belong to planning. The requirements do not mandate an always-running service or a specific frontend integration mechanism.
- No production latency or throughput targets are stated in the source proposal. Success criteria therefore measure correctness, safety, capability parity, and user task completion rather than inventing performance commitments.
- The project constitution is still an unfilled installation template and establishes no additional ratified principles. Existing repository engineering instructions remain applicable during planning and implementation.
