import type {
  ActionResponse,
  CanonicalGraph,
  DefinitionInput,
  DefinitionProposal,
  DeletionPlan,
  ExecutionAttempt,
  LifecycleError,
  Observation,
  OperationRecord,
  RequiredAction,
  RecipeRegistration,
  ResolvedSource,
  Source
} from "./contracts/common.js";
import type {
  EnvironmentConfiguration,
  EnvironmentConfigurationPatch,
  LifecycleOperation,
  LifecycleRequestFor,
  LifecycleResponseFor,
  RepairPolicy
} from "./contracts/catalog.js";
import type {
  PortCancelled,
  PortError,
  PortResult,
  ReadResult,
  RedactedDiagnostics
} from "./errors.js";

export type ReadonlyData<T> =
  T extends readonly (infer Item)[] ? readonly ReadonlyData<Item>[]
  : T extends object ? { readonly [Key in keyof T]: ReadonlyData<T[Key]> }
  : T;

export interface CancellationSignal {
  readonly aborted: boolean;
  /** Returns an idempotent unsubscribe function; already-aborted signals notify immediately. */
  onAbort(listener: () => void): () => void;
}
export interface RequestControl {
  readonly requestId: string;
  readonly cancellation: CancellationSignal;
}

/** Host-issued opaque references, never reconstructed from public lifecycle input. */
export interface HostCallerBinding {
  readonly bindingRef: string;
  readonly sessionRef: string;
}
export interface CallerContext {
  readonly principalRef: string;
  readonly sessionRef: string;
  readonly identityRef: string;
  readonly responder: "user" | "agent" | "service";
  readonly agentBindingRef?: string;
  readonly approvedHostActionRef?: string;
}
/** Diff authorization binds each selected side as well as the outer repository. */
export type AuthorizationTarget<O extends LifecycleOperation> = ReadonlyData<
  O extends "graph.diff" ?
    | LifecycleRequestFor<O>["target"]
    | LifecycleRequestFor<"graph.diff">["input"]["base"]
  : LifecycleRequestFor<O>["target"]
>;
export type AuthorizationRequest<
  O extends LifecycleOperation = LifecycleOperation
> =
  O extends LifecycleOperation ?
    {
      readonly caller: CallerContext;
      readonly operation: O;
      readonly target: AuthorizationTarget<O>;
      readonly source?: ReadonlyData<ResolvedSource>;
      readonly operationId?: string;
      readonly approvalRef?: string;
      readonly configuration?: ConfigurationAuthorizationIntent;
    }
  : never;
/** The identity adapter must revalidate this reference at each privileged boundary. */
export type AuthorizedScope<O extends LifecycleOperation = LifecycleOperation> =
  O extends LifecycleOperation ?
    {
      readonly authorizationRef: string;
      readonly principalRef: string;
      readonly operation: O;
      readonly target: AuthorizationTarget<O>;
      readonly source?: ReadonlyData<ResolvedSource>;
      readonly operationId?: string;
      readonly approvalRef?: string;
      readonly configuration?: ConfigurationAuthorizationIntent;
    }
  : never;
export interface IdentityObservation {
  readonly prerequisites: ReadonlyData<
    LifecycleResponseFor<"credentials.inspect">["result"]["prerequisites"]
  >;
  readonly observation: ReadonlyData<Observation>;
}
export interface IdentityConfigurationReceipt {
  readonly identityRef: string;
  readonly observation: ReadonlyData<Observation>;
}
export interface IdentityPort {
  resolveCaller(
    binding: HostCallerBinding,
    control: RequestControl
  ): Promise<PortResult<CallerContext>>;
  authorize<O extends LifecycleOperation>(
    request: AuthorizationRequest<O>,
    control: RequestControl
  ): Promise<PortResult<AuthorizedScope<O>>>;
  authorizeResponse(
    caller: CallerContext,
    action: ReadonlyData<RequiredAction>,
    response: ReadonlyData<ActionResponse>,
    control: RequestControl
  ): Promise<PortResult<AuthorizedScope<"operation.respond">>>;
  inspect(
    scope: AuthorizedScope<"credentials.inspect">,
    input: ReadonlyData<LifecycleRequestFor<"credentials.inspect">["input"]>,
    control: RequestControl
  ): Promise<PortResult<IdentityObservation>>;
  configure(
    scope: AuthorizedScope<"credentials.configure">,
    input: ReadonlyData<LifecycleRequestFor<"credentials.configure">["input"]>,
    control: RequestControl
  ): Promise<PortResult<IdentityConfigurationReceipt>>;
}

export type SourceSelection = ReadonlyData<
  LifecycleRequestFor<"definition.validate">["target"]
>;
export type SourceOperation =
  | "application.inspect"
  | "application.list"
  | "definition.author"
  | "definition.validate"
  | "graph.get"
  | "graph.diff"
  | "deployment.start"
  | "operation.repair"
  | "operation.respond";
export type EnvironmentSelection = ReadonlyData<
  LifecycleRequestFor<"environment.inspect">["target"]
>;
export type ApplicationSelection = ReadonlyData<
  LifecycleRequestFor<"application.delete">["target"]
>;
export type Pagination = ReadonlyData<
  LifecycleRequestFor<"environment.list">["input"]
>;
export interface Page<T, Scope> {
  readonly target: Scope;
  readonly items: readonly T[];
  readonly observation: ReadonlyData<Observation>;
  readonly continuationToken?: string;
}

export interface CompleteInputManifest {
  readonly completeness: "complete";
  readonly definition: DefinitionInput["path"];
  readonly inputs: readonly ReadonlyData<DefinitionInput>[];
  readonly fingerprint: string;
}
export interface IncompleteInputManifest {
  readonly completeness: "incomplete";
  readonly definition: DefinitionInput["path"];
  readonly inputs: readonly ReadonlyData<DefinitionInput>[];
  readonly diagnostics: RedactedDiagnostics;
}
export type EffectiveInputManifest =
  CompleteInputManifest | IncompleteInputManifest;
export interface SourceSnapshot {
  readonly snapshotRef: string;
  readonly selection: SourceSelection;
  readonly provenance: ReadonlyData<ResolvedSource>;
  readonly manifest: CompleteInputManifest;
}
export type SourceCapture =
  | { readonly status: "captured"; readonly snapshot: SourceSnapshot }
  | {
      readonly status: "incomplete";
      readonly manifest: IncompleteInputManifest;
    };
export interface CapturedText {
  readonly input: ReadonlyData<DefinitionInput>;
  readonly text: string;
}
export interface CapturedBytes {
  readonly input: ReadonlyData<DefinitionInput>;
  readonly bytes: Uint8Array;
}
export interface StagingArea {
  readonly stagingRef: string;
  readonly operationId: string;
  readonly actionId: string;
  readonly snapshot: SourceSnapshot;
}
export interface StagedOutputs {
  readonly staging: StagingArea;
  readonly outputRefs: readonly string[];
  readonly outputs: readonly ReadonlyData<DefinitionInput>[];
  readonly fingerprint: string;
}
export interface PromotionRequest {
  readonly scope: AuthorizedScope<
    "definition.author" | "operation.repair" | "operation.respond"
  >;
  readonly outputs: StagedOutputs;
  readonly proposal: ReadonlyData<DefinitionProposal>;
  readonly expectedManifest: CompleteInputManifest;
}
export type PromotionResult =
  | { readonly status: "promoted"; readonly manifest: CompleteInputManifest }
  | { readonly status: "refused"; readonly failure: PortError }
  | {
      readonly status: "failed";
      readonly failure: PortError;
      readonly rollback: "restored" | "incomplete" | "not_needed";
      readonly diagnostics: RedactedDiagnostics;
    }
  | PortCancelled;
export interface CleanupReceipt {
  readonly status: "released" | "already_released";
}
export type CleanupResult = Exclude<PortResult<CleanupReceipt>, PortCancelled>;
export interface SourceAccessPort {
  /** Captures the complete effective input closure as stable bytes before returning a snapshot. */
  capture(
    scope: AuthorizedScope<SourceOperation>,
    selection: SourceSelection,
    control: RequestControl
  ): Promise<ReadResult<SourceCapture>>;
  discoverDefinitions(
    scope: AuthorizedScope<"application.list">,
    source: ReadonlyData<Source>,
    pagination: Pagination,
    control: RequestControl
  ): Promise<PortResult<Page<SourceSelection, Readonly<{ repo: string }>>>>;
  /** Only paths in the snapshot's captured manifest may be read. */
  readText(
    snapshot: SourceSnapshot,
    path: DefinitionInput["path"],
    control: RequestControl
  ): Promise<ReadResult<CapturedText>>;
  /** Returns a fresh copy of owned bytes, including binary compiler inputs. */
  readBytes(
    snapshot: SourceSnapshot,
    path: DefinitionInput["path"],
    control: RequestControl
  ): Promise<ReadResult<CapturedBytes>>;
  prepareStaging(
    scope: AuthorizedScope<"definition.author" | "operation.repair">,
    binding: Readonly<{
      operationId: string;
      actionId: string;
      snapshot: SourceSnapshot;
    }>,
    control: RequestControl
  ): Promise<PortResult<StagingArea>>;
  inspectStagedOutputs(
    staging: StagingArea,
    outputRefs: readonly string[],
    control: RequestControl
  ): Promise<PortResult<StagedOutputs>>;
  /** Rechecks authorization, output confinement and the original manifest under the promotion guard. */
  promote(
    request: PromotionRequest,
    control: RequestControl
  ): Promise<PromotionResult>;
  /** Cleanup is idempotent and is not suppressed by an already-cancelled request. */
  releaseSnapshot(snapshot: SourceSnapshot): Promise<CleanupResult>;
  releaseStaging(staging: StagingArea): Promise<CleanupResult>;
}

export interface RecipeRegistrationEvidence {
  readonly target: EnvironmentSelection;
  readonly provider: EnvironmentConfiguration["provider"];
  readonly recipes: readonly ReadonlyData<RecipeRegistration>[];
  readonly observation: ReadonlyData<Observation>;
}
export type GraphCompilationInput =
  | { readonly kind: "authored"; readonly snapshot: SourceSnapshot }
  | {
      readonly kind: "planned";
      readonly snapshot: SourceSnapshot;
      readonly registrations: RecipeRegistrationEvidence;
    };
export interface GraphCompilation {
  readonly graph: ReadonlyData<CanonicalGraph>;
  readonly diagnostics: RedactedDiagnostics;
}
export type DeployedGraphObservation = ReadonlyData<
  Extract<LifecycleResponseFor<"graph.get">["result"], { kind: "deployed" }>
>;
export interface GraphExecutionPort {
  /** No caller, approval, identity or workflow handles enter the compilation context. */
  compile(
    input: GraphCompilationInput,
    control: RequestControl
  ): Promise<PortResult<GraphCompilation>>;
  observeDeployed(
    scope: AuthorizedScope<"graph.get" | "graph.diff" | "application.inspect">,
    target: ApplicationSelection,
    control: RequestControl
  ): Promise<ReadResult<DeployedGraphObservation>>;
}

export type EnvironmentInspection = ReadonlyData<
  LifecycleResponseFor<"environment.inspect">["result"]
>;
export type EnvironmentChange =
  | {
      readonly operation: "environment.create";
      readonly configuration: ReadonlyData<EnvironmentConfiguration>;
    }
  | {
      readonly operation: "environment.configure";
      readonly patch: ReadonlyData<EnvironmentConfigurationPatch>;
    };
export type ConfigurationAuthorizationIntent =
  | EnvironmentChange
  | {
      readonly operation: "credentials.configure";
      readonly input: ReadonlyData<
        LifecycleRequestFor<"credentials.configure">["input"]
      >;
    };
export interface EnvironmentConfigurationPlan {
  readonly target: EnvironmentSelection;
  readonly change: EnvironmentChange;
  readonly configuration: ReadonlyData<EnvironmentConfiguration>;
  readonly expected: EnvironmentInspection | null;
}
export interface EnvironmentConfigurationReceipt {
  readonly state: "succeeded" | "failed" | "running";
  readonly inspection?: EnvironmentInspection;
  readonly observation: ReadonlyData<Observation>;
  readonly phases: ReadonlyData<
    Extract<OperationRecord["result"], { kind: "configuration" }>["phases"]
  >;
  readonly error?: ReadonlyData<OperationRecord["error"]>;
}
export interface DeployedApplication {
  readonly target: ApplicationSelection;
  readonly evidence: ReadonlyData<
    NonNullable<
      LifecycleResponseFor<"application.inspect">["result"]["deployed"]
    >[number]
  >;
}
export type DeletionOperation = "application.delete" | "environment.delete";
export interface DeletionPhaseReceipt {
  readonly phase: DeletionPlan["phases"][number]["phase"];
  readonly disposition: "deleted" | "retained";
  readonly observation: ReadonlyData<Observation>;
}
export interface EnvironmentAccessPort {
  list(
    scope: AuthorizedScope<"environment.list">,
    pagination: Pagination,
    control: RequestControl
  ): Promise<
    PortResult<ReadonlyData<LifecycleResponseFor<"environment.list">["result"]>>
  >;
  inspect(
    scope: AuthorizedScope<"environment.inspect">,
    control: RequestControl
  ): Promise<ReadResult<EnvironmentInspection>>;
  listApplications(
    scope: AuthorizedScope<"application.list">,
    pagination: Pagination,
    control: RequestControl
  ): Promise<
    PortResult<
      Page<
        DeployedApplication,
        ReadonlyData<LifecycleRequestFor<"application.list">["target"]>
      >
    >
  >;
  registrations(
    scope: AuthorizedScope<
      SourceOperation | "environment.inspect" | "capabilities.get"
    >,
    target: EnvironmentSelection,
    control: RequestControl
  ): Promise<ReadResult<RecipeRegistrationEvidence>>;
  /** Applies only the declared environment changes; never initiates application deployment. */
  configure(
    scope: AuthorizedScope<"environment.create" | "environment.configure">,
    plan: EnvironmentConfigurationPlan,
    control: RequestControl
  ): Promise<PortResult<EnvironmentConfigurationReceipt>>;
  planDeletion(
    scope: AuthorizedScope<DeletionOperation>,
    previousPlanRef: string | undefined,
    control: RequestControl
  ): Promise<PortResult<ReadonlyData<DeletionPlan>>>;
  /** Revalidates plan scope, current ownership and approval before each destructive phase. */
  executeDeletionPhase(
    scope: AuthorizedScope<DeletionOperation>,
    plan: ReadonlyData<DeletionPlan>,
    phase: DeletionPlan["phases"][number]["phase"],
    control: RequestControl
  ): Promise<PortResult<DeletionPhaseReceipt>>;
}

export type WorkflowOperation =
  | "deployment.start"
  | "environment.create"
  | "environment.configure"
  | "application.delete"
  | "environment.delete";
export type WorkflowIntent =
  | {
      readonly operation: "deployment.start";
      readonly target: ReadonlyData<
        LifecycleRequestFor<"deployment.start">["target"]
      >;
    }
  | {
      readonly operation: "environment.create";
      readonly target: EnvironmentSelection;
      readonly change: Extract<
        EnvironmentChange,
        { operation: "environment.create" }
      >;
    }
  | {
      readonly operation: "environment.configure";
      readonly target: EnvironmentSelection;
      readonly change: Extract<
        EnvironmentChange,
        { operation: "environment.configure" }
      >;
    }
  | {
      readonly operation: "application.delete";
      readonly target: ApplicationSelection;
      readonly plan: ReadonlyData<DeletionPlan>;
      readonly phase: DeletionPlan["phases"][number]["phase"];
    }
  | {
      readonly operation: "environment.delete";
      readonly target: EnvironmentSelection;
      readonly plan: ReadonlyData<DeletionPlan>;
      readonly phase: DeletionPlan["phases"][number]["phase"];
    };
export interface ExecutionCorrelation {
  readonly operationId: string;
  readonly attemptId: string;
  readonly operation: WorkflowOperation;
  readonly target: Readonly<EnvironmentSelection & { application?: string }>;
  readonly expectedCommit: string;
}
export type WorkflowRunIdentity = ReadonlyData<
  Omit<NonNullable<ExecutionAttempt["run"]>, "conclusion">
>;
export interface ExecutionIdentity extends ExecutionCorrelation {
  readonly run: WorkflowRunIdentity;
}
export interface WorkflowPreparation {
  readonly scope: AuthorizedScope<WorkflowOperation>;
  readonly correlation: ExecutionCorrelation;
  readonly intent: WorkflowIntent;
  readonly source: ReadonlyData<Extract<ResolvedSource, { kind: "git" }>>;
}
export interface PreparedWorkflow {
  readonly preparationRef: string;
  readonly preparation: WorkflowPreparation;
  readonly concurrencyScope: "repository";
}
export type DispatchResult =
  | { readonly status: "dispatched"; readonly identity: ExecutionIdentity }
  | {
      readonly status: "unconfirmed";
      readonly correlation: ExecutionCorrelation;
      readonly error: LifecycleError & { code: "DISPATCH_UNCONFIRMED" };
    }
  | PortError
  | PortCancelled;
export interface ExecutionEvidence {
  readonly executionSchemaVersion: 1;
  readonly identity: ExecutionIdentity;
  readonly actualCommit: string;
  readonly sequence: number;
  readonly observedAt: string;
  readonly phases: ReadonlyData<ExecutionAttempt["phases"]>;
  readonly primaryFailure?: ReadonlyData<LifecycleError>;
  readonly additionalFailures: readonly ReadonlyData<LifecycleError>[];
  readonly diagnostics: RedactedDiagnostics;
}
export interface WorkflowObservation {
  readonly identity: ExecutionIdentity;
  readonly conclusion: NonNullable<ExecutionAttempt["run"]>["conclusion"];
  readonly evidence: ReadResult<ExecutionEvidence>;
  readonly observation: ReadonlyData<Observation>;
}
export interface CancellationReceipt {
  readonly status: "requested" | "confirmed" | "already_completed";
  readonly requestedAt: string;
  readonly observation: ReadonlyData<Observation>;
}
export interface WorkflowExecutionPort {
  /** Verifies tuple/source equality, published commit, workflow availability and authoritative environment approval. */
  prepare(
    input: WorkflowPreparation,
    control: RequestControl
  ): Promise<PortResult<PreparedWorkflow>>;
  /** Dispatches once. Ambiguous delivery returns unconfirmed, never permission to retry dispatch. */
  dispatch(
    prepared: PreparedWorkflow,
    control: RequestControl
  ): Promise<DispatchResult>;
  reconcile(
    scope: AuthorizedScope<"operation.get" | "operation.cancel">,
    correlation: ExecutionCorrelation,
    control: RequestControl
  ): Promise<
    PortResult<
      Readonly<{
        matches: readonly WorkflowRunIdentity[];
        observation: ReadonlyData<Observation>;
      }>
    >
  >;
  observe(
    scope: AuthorizedScope<"operation.get" | "operation.cancel">,
    identity: ExecutionIdentity,
    control: RequestControl
  ): Promise<ReadResult<WorkflowObservation>>;
  cancel(
    scope: AuthorizedScope<"operation.cancel">,
    identity: ExecutionIdentity,
    control: RequestControl
  ): Promise<PortResult<CancellationReceipt>>;
}

export type AgentAction = ReadonlyData<
  Extract<RequiredAction, { responder: "agent" }>
>;
export type AgentOutcome = ReadonlyData<
  Extract<ActionResponse, { kind: "agent.outcome" }>
>;
export type AgentAssignment =
  | {
      readonly operation: "definition.author";
      readonly action: AgentAction;
      readonly staging: StagingArea;
      readonly intent: ReadonlyData<
        LifecycleRequestFor<"definition.author">["input"]
      >;
    }
  | {
      readonly operation: "operation.repair";
      readonly action: AgentAction;
      readonly staging: StagingArea;
      readonly failedOperationId: string;
      readonly failedAttemptId?: string;
      readonly failure: ReadonlyData<LifecycleError>;
      readonly policy: ReadonlyData<RepairPolicy>;
    };
export interface AgentDelivery {
  readonly deliveryRef: string;
  readonly operationId: string;
  readonly actionId: string;
}
export interface AuthenticatedAgentOutcome {
  readonly agentBindingRef: string;
  readonly operationId: string;
  readonly actionId: string;
  readonly outcome: AgentOutcome;
}
export interface AgentAssistancePort {
  assign(
    scope: AuthorizedScope<"definition.author" | "operation.repair">,
    assignment: AgentAssignment,
    control: RequestControl
  ): Promise<PortResult<AgentDelivery>>;
  authenticateOutcome(
    caller: CallerContext,
    action: AgentAction,
    outcome: AgentOutcome,
    control: RequestControl
  ): Promise<PortResult<AuthenticatedAgentOutcome>>;
  cancel(
    scope: AuthorizedScope<"operation.cancel">,
    delivery: AgentDelivery,
    control: RequestControl
  ): Promise<PortResult<CancellationReceipt>>;
}

export interface VersionedOperation {
  readonly revision: string;
  readonly operation: ReadonlyData<OperationRecord>;
}
export interface OperationRegistryPort {
  create(
    scope: AuthorizedScope,
    operation: ReadonlyData<OperationRecord>,
    control: RequestControl
  ): Promise<PortResult<VersionedOperation>>;
  get(
    scope: AuthorizedScope,
    operationId: string,
    control: RequestControl
  ): Promise<ReadResult<VersionedOperation>>;
  list(
    scope: AuthorizedScope<"operation.list">,
    pagination: Pagination,
    control: RequestControl
  ): Promise<
    PortResult<
      Page<
        VersionedOperation,
        ReadonlyData<LifecycleRequestFor<"operation.list">["target"]>
      >
    >
  >;
  /** Atomically replaces one context-owned record, including action consumption; stale revisions fail closed. */
  compareAndSwap(
    scope: AuthorizedScope,
    update: Readonly<{
      operationId: string;
      expectedRevision: string;
      replacement: ReadonlyData<OperationRecord>;
    }>,
    control: RequestControl
  ): Promise<PortResult<VersionedOperation>>;
  close(): Promise<CleanupResult>;
}

export interface ClockPort {
  now(): string;
  wait(
    milliseconds: number,
    cancellation: CancellationSignal
  ): Promise<PortResult<void>>;
}
export interface IdPort {
  next(
    kind: "request" | "operation" | "attempt" | "action" | "revision"
  ): string;
}
export interface DiagnosticCollection {
  readonly source:
    "source" | "graph" | "environment" | "identity" | "workflow" | "agent";
  readonly sourceRef: string;
  readonly operationId?: string;
  readonly attemptId?: string;
}
export interface DiagnosticEvent {
  readonly requestId: string;
  readonly operationId?: string;
  readonly attemptId?: string;
  readonly phase:
    | "source"
    | "validation"
    | "authorization"
    | "dispatch"
    | "observation"
    | "promotion"
    | "cleanup";
  readonly errorCode?: LifecycleError["code"];
}
export interface DiagnosticsPort {
  /** Resolves an authorized log handle, redacts in the adapter, and returns bounded diagnostics only. */
  collect(
    scope: AuthorizedScope,
    source: DiagnosticCollection,
    control: RequestControl
  ): Promise<PortResult<RedactedDiagnostics>>;
  record(event: DiagnosticEvent): Promise<PortResult<void>>;
}

export interface LifecyclePorts {
  readonly source: SourceAccessPort;
  readonly graph: GraphExecutionPort;
  readonly environment: EnvironmentAccessPort;
  readonly identity: IdentityPort;
  readonly workflow: WorkflowExecutionPort;
  readonly agent: AgentAssistancePort;
  readonly registry: OperationRegistryPort;
  readonly clock: ClockPort;
  readonly ids: IdPort;
  readonly diagnostics: DiagnosticsPort;
}
