import type { CanvasRequestContext } from "../request-context.js";
import type { SelectionHandleClaim } from "../services/github-account-readiness.js";
import {
  createOperationDiagnosticContext,
  createOperationDiagnosticExport,
  operationDiagnosticContextFingerprint,
  operationDiagnosticAvailable
} from "../services/operation-diagnostic-export.js";
import {
  templatePathParameters,
  type RouteHandlerRegistry
} from "../route-table.js";

// The registry and the client projection stay in `operations.ts`, which is
// independently tested. These routes are a thin lookup-and-project adapter, so
// they take the narrow functions they call and nothing else — no registry
// object, no container, no global server map.
//
// The read routes keep one narrow dependency set. The three POST routes that
// register, resume, and abandon environment operations add their own seams below
// rather than widening a single port object into a general-purpose registry
// handle: each is a single function, and the test fakes throw on anything a
// given route is not supposed to reach.
export interface OperationsStatusDependencies {
  latest(repo: string): unknown;
  latestAny(): unknown;
  get(operationId: string): unknown;
  toClientView(record: unknown): unknown;
  productVersion(): string;
  now(): number;
}

interface OperationRequest {
  azure: {
    serviceManagementReference?: unknown;
    appId?: unknown;
    createNew?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function isOperationRequest(value: unknown): value is OperationRequest {
  if (typeof value !== "object" || value === null || !("azure" in value)) {
    return false;
  }
  return typeof value.azure === "object" && value.azure !== null;
}

// The record `createOperation` returns and every seam that touches it. Typed as
// broadly as `operations.ts` types it (that module is all `any`), so the route
// stays a pass-through and never reimplements a field the registry owns.
export type OperationRecord = {
  operationId: string;
  currentStage: unknown;
  request?: unknown;
  resumeRequest?: unknown;
  [key: string]: unknown;
};

export type StartOperationResult =
  | { ok: true; operation: OperationRecord }
  | {
      ok: false;
      reason?: "operation-in-progress" | "previous-cleanup-required";
      conflict: { operationId: string; [key: string]: unknown };
    };

export type OperationStartConflict = Extract<
  StartOperationResult,
  { ok: false }
>;

// Seams the POST handler drives to register and start an environment operation.
// Every one is a single function the legacy arm already called; grouping them
// under one interface keeps the composition root readable without turning any
// of them into a broad port object.
export interface CreateOperationDependencies {
  // Pure guards and factories. Injected rather than imported so the module
  // spawns nothing and the boundary of what this route can reach stays visible.
  isValidRepoSlug(value: unknown): boolean;
  isResourceGroupName(value: unknown): boolean;
  isAksClusterName(value: unknown): boolean;
  isUuid(value: unknown): boolean;
  buildStages(options: { includeIdentity: boolean }): unknown;
  createOperation(input: unknown): OperationRecord;
  claimSelectionHandle(input: {
    instanceId: string;
    repo: string;
    environment: string;
    handle: string;
  }): SelectionHandleClaim;
  startConflict(repo: string): OperationStartConflict | null;
  // Registry writes. `start` refuses a second operation for a repo already in
  // flight; `persist` durably records the registration before any work runs.
  startOperation(op: OperationRecord): StartOperationResult;
  persistOperations(): Promise<void>;
  // Closes a record out in a terminal state. Only reached on the persist-failure
  // path, exactly as the legacy arm reached it.
  finish(
    op: OperationRecord,
    state: string,
    options: { failure: Record<string, unknown> }
  ): void;
  // Bridges to the per-instance server-owned task runner. The migrated handler
  // is composed once at module init, but scheduling is per-instance closure
  // state, so the instance that received the request is passed through and the
  // composition root resolves the right runner. This is the one place the
  // module-level route reaches per-instance state, and it does so through a
  // single function rather than a handle to the instance map.
  //
  // Returns whether the operation was actually handed to a runner. In the
  // legacy arm this could not fail: the request was dispatched by the very
  // per-instance handler that owned the scheduler, so the scheduler was always
  // in scope. The migration replaced that closure with a map lookup keyed by
  // instance id, which reintroduces a should-never-happen miss (a stopped
  // instance, or a map out of sync). The handler repairs that case rather than
  // leaving an accepted operation durably `running` with no work behind it.
  scheduleEnvironmentOperation(
    instanceId: string,
    op: OperationRecord
  ): boolean;
  errorMessage(error: unknown): string;
}

export interface OperationActionRecord extends OperationRecord {
  state?: string;
  failure?: { code?: unknown; message?: unknown; [key: string]: unknown };
  inputRequired?: unknown;
  executionActive?: boolean;
  request?: OperationRequest;
  resumeRequest?: OperationRequest;
  repo?: unknown;
  environment?: unknown;
  provider?: unknown;
}

export interface OperationActionDependencies {
  getOperation(operationId: string): OperationActionRecord | null | undefined;
  canResumeInput(
    operation: OperationActionRecord,
    input: {
      code: string;
      checkpoint?: string;
      repo?: string;
      environment?: string;
      provider?: string;
    }
  ): boolean;
  resumeAfterInput(operation: OperationActionRecord): void;
  requireInput(operation: OperationActionRecord, input: unknown): void;
  finish(
    operation: OperationActionRecord,
    state: string,
    options?: { failure: Record<string, unknown> }
  ): void;
  isTerminalState(state: unknown): boolean;
  persistOperations(): Promise<void>;
  toClientView(operation: OperationActionRecord): unknown;
  scheduleEnvironmentOperation(
    instanceId: string,
    operation: OperationActionRecord
  ): boolean;
  errorMessage(error: unknown): string;
  inputRequiredState: string;
}

const ACTION_FUNCTION_DEPENDENCIES = [
  "getOperation",
  "canResumeInput",
  "resumeAfterInput",
  "requireInput",
  "finish",
  "isTerminalState",
  "persistOperations",
  "toClientView",
  "scheduleEnvironmentOperation",
  "errorMessage"
] as const;

function assertOperationActionDependencies(
  dependencies: OperationActionDependencies
): void {
  for (const name of ACTION_FUNCTION_DEPENDENCIES) {
    if (typeof dependencies[name] !== "function") {
      throw new Error(`Missing operations action dependency: ${name}`);
    }
  }
  if (!dependencies.inputRequiredState) {
    throw new Error("Missing operations action dependency: inputRequiredState");
  }
}

const OPERATIONS_PREFIX = "/api/operations/";
export const OPERATION_DIAGNOSTICS_ROUTE =
  "/api/operations/:operationId/diagnostics";
export const RESUME_OPERATION_ROUTE =
  "/api/operations/:operationId/resume/:code";
export const ABANDON_OPERATION_ROUTE = "/api/operations/:operationId/abandon";

interface ResumeOperationBody extends Record<string, unknown> {
  checkpoint?: string;
  repo?: string;
  environment?: string;
  provider?: string;
}

async function finishSchedulingFailure(
  operation: OperationRecord,
  instanceId: string,
  finishOperation: (failure: Record<string, unknown>) => void,
  persistOperations: () => Promise<void>,
  errorMessage: (error: unknown) => string
): Promise<void> {
  finishOperation({
    code: "operation-scheduling-failed",
    stage: operation.currentStage,
    stepSeq: null,
    message:
      "Radius accepted the environment operation but could not start any setup work for it.",
    classification: "unknown",
    evidence: `No server-owned task runner was available for instance ${instanceId}.`
  });
  try {
    await persistOperations();
  } catch (error) {
    // The in-memory record is already terminal, so polling still reflects the
    // failure when this best-effort durable repair cannot be written.
    errorMessage(error);
  }
}

// Operation status. The panel polls this instead of waiting on the POST,
// which is what lets it stop blocking: the record outlives the request
// that created it, so a reload or a trip to another page can rejoin an
// operation already in flight.
//
// Polled rather than streamed on purpose. SSE would be smoother, but the
// canvas reloads on navigation and a reload mid-operation is a routine
// event here, not an edge case — a plain GET is trivially resumable and
// a reconnecting EventSource is not.
export function handleLatestOperation(
  context: CanvasRequestContext,
  dependencies: OperationsStatusDependencies
): void {
  const repo = context.url.searchParams.get("repo") || "";
  // No repo in hand means "the operation that matters right now": the status
  // chip renders on every page and only some pages know their repository.
  const record = repo ? dependencies.latest(repo) : dependencies.latestAny();
  context.response.setHeader("Content-Type", "application/json");
  context.response.setHeader("Cache-Control", "no-store");
  context.response.writeHead(200);
  context.response.end(
    JSON.stringify({
      operation: record ? dependencies.toClientView(record) : null
    })
  );
}

export function handleOperationById(
  context: CanvasRequestContext,
  dependencies: OperationsStatusDependencies
): void {
  // `decodeURIComponent` throws a URIError on a malformed escape such as
  // `/api/operations/%`, which Node's URL parser leaves intact in the pathname.
  // The throw propagates out of the handler exactly as it did from the legacy
  // branch: the async listener does not catch it, so it becomes an unhandled
  // rejection, no response is written, and the request hangs until the client
  // times out. That is a latent bug, deliberately preserved — converting it
  // into a 4xx or 5xx here would be observable hardening, which this structural
  // slice excludes. It belongs in the separately approved hardening slice.
  const operationId = decodeURIComponent(
    context.pathname.slice(OPERATIONS_PREFIX.length)
  );
  const record = dependencies.get(operationId);
  context.response.setHeader("Content-Type", "application/json");
  context.response.setHeader("Cache-Control", "no-store");
  context.response.writeHead(record ? 200 : 404);
  context.response.end(
    JSON.stringify(
      record ?
        { operation: dependencies.toClientView(record) }
      : { error: "Unknown operation." }
    )
  );
}

function sendDiagnosticJson(
  context: CanvasRequestContext,
  status: number,
  payload: unknown,
  attachment = false
): void {
  context.response.setHeader("Content-Type", "application/json");
  context.response.setHeader("Cache-Control", "no-store");
  if (attachment) {
    context.response.setHeader(
      "Content-Disposition",
      'attachment; filename="radius-environment-operation-diagnostics.json"'
    );
  }
  context.response.writeHead(status);
  context.response.end(
    attachment ?
      `${JSON.stringify(payload, null, 2)}\n`
    : JSON.stringify(payload)
  );
}

export function handleOperationDiagnostics(
  context: CanvasRequestContext,
  dependencies: OperationsStatusDependencies
): void {
  const rawOperationId =
    templatePathParameters(OPERATION_DIAGNOSTICS_ROUTE, context.pathname)
      ?.operationId ?? "";
  let operationId: string;
  try {
    operationId = decodeURIComponent(rawOperationId);
  } catch {
    sendDiagnosticJson(context, 400, {
      error: "Invalid operation identifier.",
      code: "invalid-operation-id"
    });
    return;
  }

  const operation = dependencies.get(operationId);
  if (!operation) {
    sendDiagnosticJson(context, 404, {
      error: "Unknown operation.",
      code: "unknown-operation"
    });
    return;
  }
  if (!operationDiagnosticAvailable(operation)) {
    sendDiagnosticJson(context, 409, {
      error:
        "Diagnostics are available after Stop is requested, while Radius is waiting for input, or after the operation finishes.",
      code: "operation-diagnostics-unavailable"
    });
    return;
  }

  try {
    const identifiers = context.url.searchParams.get("identifiers");
    if (
      identifiers !== null &&
      identifiers !== "preview" &&
      identifiers !== "include"
    ) {
      sendDiagnosticJson(context, 400, {
        error: "Invalid diagnostic identifier profile.",
        code: "invalid-diagnostic-profile"
      });
      return;
    }
    if (identifiers === "preview") {
      const contextualIdentifiers = createOperationDiagnosticContext(operation);
      sendDiagnosticJson(context, 200, {
        contextualIdentifiers,
        contextFingerprint: operationDiagnosticContextFingerprint(
          contextualIdentifiers
        )
      });
      return;
    }
    if (identifiers === "include") {
      const contextualIdentifiers = createOperationDiagnosticContext(operation);
      const expectedFingerprint = operationDiagnosticContextFingerprint(
        contextualIdentifiers
      );
      if (
        context.url.searchParams.get("contextFingerprint") !==
        expectedFingerprint
      ) {
        sendDiagnosticJson(context, 409, {
          error:
            "The contextual identifiers changed after review. Review them again before downloading.",
          code: "diagnostic-context-changed"
        });
        return;
      }
    }
    const diagnostic = createOperationDiagnosticExport({
      operation,
      version: dependencies.productVersion(),
      now: dependencies.now(),
      includeContext: identifiers === "include"
    });
    sendDiagnosticJson(context, 200, diagnostic, true);
  } catch {
    sendDiagnosticJson(context, 500, {
      error: "Radius could not create operation diagnostics.",
      code: "operation-diagnostics-failed"
    });
  }
}

function jsonError(
  context: CanvasRequestContext,
  status: number,
  payload: Record<string, unknown>
): void {
  context.response.setHeader("Content-Type", "application/json");
  context.response.writeHead(status);
  context.response.end(JSON.stringify(payload));
}

function sendStartConflict(
  context: CanvasRequestContext,
  repo: string,
  started: OperationStartConflict
): void {
  const previousCleanup = started.reason === "previous-cleanup-required";
  jsonError(context, 409, {
    error:
      previousCleanup ?
        `An earlier setup for ${repo} must finish rollback before a new setup can start.`
      : `Setup is already running for ${repo}.`,
    code:
      previousCleanup ? "previous-cleanup-required" : "operation-in-progress",
    operationId: started.conflict.operationId
  });
}

// Register a new environment-setup operation and hand back a status URL the
// panel polls. The request returns 202 the moment the record is durably
// registered; the actual setup runs as a server-owned background task so the
// panel never blocks on it and a reload can rejoin the operation by id.
//
// Body handling is transcribed from the legacy arm rather than routed through
// `context.readJsonBody`: a malformed body must answer 400 with the specific
// `{ error, code: "invalid-json" }` shape, not throw. `bodyPolicy: "json"` on
// the route declaration is metadata nothing enforces yet, so this handler reads
// and parses the body itself exactly as the legacy dispatcher did — wiring
// enforcement here would be a behavior change reserved for its own slice.
//
// Every `|| ""` / `|| "dev"` default and the `data.provider === "aws"` check
// are preserved verbatim: they differ from `??` on `0` and `""`, and those
// values reach the response and the persisted record.
export async function handleCreateOperation(
  context: CanvasRequestContext,
  dependencies: CreateOperationDependencies
): Promise<void> {
  const body = await context.readTextBody();
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    jsonError(context, 400, {
      error: "Invalid JSON body.",
      code: "invalid-json"
    });
    return;
  }
  const repo = String(data.repo || "");
  const environment = String(data.environment || data.name || "dev").trim();
  const provider = data.provider === "aws" ? "aws" : "azure";
  if (!dependencies.isValidRepoSlug(repo)) {
    jsonError(context, 400, {
      error: `Invalid repository "${repo}". Expected "owner/repo".`,
      code: "invalid-repo"
    });
    return;
  }
  if (!environment.trim()) {
    jsonError(context, 400, {
      error: "Environment name is required.",
      code: "environment-required"
    });
    return;
  }
  if (provider === "azure") {
    if (
      !dependencies.isResourceGroupName(String(data.resourceGroup || "")) ||
      !dependencies.isAksClusterName(String(data.cluster || "")) ||
      !dependencies.isUuid(String(data.tenantId || "")) ||
      !dependencies.isUuid(String(data.subscriptionId || ""))
    ) {
      jsonError(context, 400, {
        error:
          "Azure setup requires valid tenantId, subscriptionId, resourceGroup, and cluster values.",
        code: "invalid-azure-operation-input"
      });
      return;
    }
  } else if (
    !String(data.roleArn || "").trim() ||
    !String(data.accountId || "").trim() ||
    !String(data.region || "").trim() ||
    !String(data.cluster || "").trim()
  ) {
    jsonError(context, 400, {
      error: "AWS setup requires roleArn, accountId, region, and cluster.",
      code: "invalid-aws-operation-input"
    });
    return;
  }
  const startConflict = dependencies.startConflict(repo);
  if (startConflict) {
    sendStartConflict(context, repo, startConflict);
    return;
  }
  const selection = dependencies.claimSelectionHandle({
    instanceId: context.instanceId,
    repo,
    environment,
    handle: String(data.selectionHandle || "")
  });
  if (!selection.ok) {
    jsonError(context, 409, {
      error:
        "The selected GitHub account is no longer ready. Re-check the account and try again.",
      code: `github-selection-${selection.error}`
    });
    return;
  }
  let selectionCommitted = false;
  try {
    const needsAzureCredentials =
      provider === "azure" && !String(data.clientId || "").trim();
    const op = dependencies.createOperation({
      provider,
      repo,
      environment,
      stages: dependencies.buildStages({
        includeIdentity: needsAzureCredentials
      }),
      journey: {
        origin: data.origin || null,
        resumeTarget: data.resumeTarget || null,
        resumeBranch: data.resumeBranch || data.branch || null,
        resumeReason: data.resumeReason || null
      }
    });
    op.context = {
      githubLogin: selection.login,
      githubCredentialSource: selection.credentialSource
    };
    const environmentRequest = {
      repo,
      environment,
      provider,
      cluster: data.cluster || "",
      namespace: data.namespace || "",
      profileName: data.profileName || "",
      branch: data.branch || "",
      clientId: data.clientId || "",
      tenantId: data.tenantId || "",
      subscriptionId: data.subscriptionId || "",
      resourceGroup: data.resourceGroup || "",
      clusterResourceGroup: data.clusterResourceGroup || "",
      appName: data.appName,
      appId: data.appId || "",
      createNew: data.createNew === true,
      serviceManagementReference: data.serviceManagementReference || "",
      roleArn: data.roleArn || "",
      accountId: data.accountId || "",
      region: data.region || "",
      vpcId: data.vpcId || "",
      subnetIds: data.subnetIds || "",
      origin: data.origin || null,
      resumeTarget: data.resumeTarget || null,
      resumeBranch: data.resumeBranch || null,
      resumeReason: data.resumeReason || null,
      githubLogin: selection.login
    };
    op.request = {
      needsAzureCredentials,
      github: {
        login: selection.login,
        credentialSource: selection.credentialSource
      },
      azure: {
        resourceGroup: data.resourceGroup || "",
        cluster: data.cluster || "",
        clusterResourceGroup: data.clusterResourceGroup || "",
        subscriptionId: data.subscriptionId || "",
        tenantId: data.tenantId || "",
        appName: data.appName,
        appId: data.appId || "",
        createNew: data.createNew === true,
        serviceManagementReference: data.serviceManagementReference || ""
      },
      environment: environmentRequest
    };
    if (provider === "azure") {
      op.resumeRequest = {
        needsAzureCredentials,
        github: {
          login: selection.login,
          credentialSource: selection.credentialSource
        },
        azure: structuredClone((op.request as { azure: unknown }).azure),
        environment: {
          repo,
          environment,
          provider,
          cluster: data.cluster || "",
          namespace: data.namespace || "",
          profileName: data.profileName || "",
          branch: data.branch || "",
          tenantId: data.tenantId || "",
          subscriptionId: data.subscriptionId || "",
          resourceGroup: data.resourceGroup || "",
          githubLogin: selection.login,
          origin: data.origin || null,
          resumeTarget: data.resumeTarget || null,
          resumeBranch: data.resumeBranch || null,
          resumeReason: data.resumeReason || null
        }
      };
    }
    const started = dependencies.startOperation(op);
    if (!started.ok) {
      sendStartConflict(context, repo, started);
      return;
    }
    try {
      await dependencies.persistOperations();
    } catch (error) {
      dependencies.finish(op, "failed", {
        failure: {
          code: "operation-registration-persist-failed",
          stage: op.currentStage,
          stepSeq: null,
          message:
            "Radius could not durably register the environment operation.",
          classification: "unknown",
          evidence: dependencies.errorMessage(error)
        }
      });
      jsonError(context, 500, {
        error:
          "Radius could not durably register the environment operation. No setup work was started.",
        code: "operation-registration-persist-failed"
      });
      return;
    }
    selection.commit();
    selectionCommitted = true;
    const statusUrl = `/api/operations/${encodeURIComponent(op.operationId)}`;
    context.response.setHeader("Content-Type", "application/json");
    context.response.setHeader("Location", statusUrl);
    context.response.writeHead(202);
    context.response.end(
      JSON.stringify({ operationId: op.operationId, statusUrl })
    );
    // Scheduling comes strictly after the 202 is written, mirroring the legacy
    // ordering the boundary test pins (`res.end` before `scheduleServerOwnedTask`).
    const scheduled = dependencies.scheduleEnvironmentOperation(
      context.instanceId,
      op
    );
    if (!scheduled) {
      // No runner accepted the operation, so nothing will ever advance or finish
      // it. Leaving it `running` would keep polling clients spinning and block a
      // fresh start for the same repo with a 409 until the record went stale.
      // The 202 is already on the wire and cannot be recalled, but the record can
      // be moved to a terminal state and persisted so the failure is observable
      // through the same status endpoint the client is already polling.
      await finishSchedulingFailure(
        op,
        context.instanceId,
        (failure) => dependencies.finish(op, "failed", { failure }),
        dependencies.persistOperations,
        dependencies.errorMessage
      );
    }
  } finally {
    if (!selectionCommitted) selection.release();
  }
}

function requiredTemplateParameters(
  template: string,
  pathname: string
): Readonly<Record<string, string>> {
  const parameters = templatePathParameters(template, pathname);
  if (!parameters) {
    throw new Error(
      `Operation action path ${pathname} does not match ${template}`
    );
  }
  return parameters;
}

export async function handleResumeOperation(
  context: CanvasRequestContext,
  dependencies: OperationActionDependencies
): Promise<void> {
  const parameters = requiredTemplateParameters(
    RESUME_OPERATION_ROUTE,
    context.pathname
  );
  const operationId = decodeURIComponent(parameters.operationId);
  const code = decodeURIComponent(parameters.code);
  const operation = dependencies.getOperation(operationId);
  if (!operation) {
    jsonError(context, 404, {
      error: "Unknown operation.",
      code: "unknown-operation"
    });
    return;
  }
  if (
    operation.state === "failed_partial" &&
    operation.failure?.code === "operation-input-expired"
  ) {
    jsonError(context, 410, {
      error: operation.failure.message,
      code: "operation-input-expired",
      operation: dependencies.toClientView(operation)
    });
    return;
  }
  const body = await context.readTextBody();
  let data: ResumeOperationBody;
  try {
    data = JSON.parse(body) as ResumeOperationBody;
  } catch {
    data = {};
  }
  if (
    !dependencies.canResumeInput(operation, {
      code,
      checkpoint: data.checkpoint,
      repo: data.repo,
      environment: data.environment,
      provider: data.provider
    })
  ) {
    jsonError(context, 409, {
      error: "The operation is not waiting for this input.",
      code: "operation-resume-mismatch",
      operationId
    });
    return;
  }
  if (!operation.request && operation.resumeRequest) {
    operation.request = structuredClone(operation.resumeRequest);
  }
  if (!isOperationRequest(operation.request)) {
    jsonError(context, 409, {
      error:
        "The operation cannot be resumed because its saved request is unavailable.",
      code: "operation-resume-request-unavailable",
      operationId
    });
    return;
  }
  const resumeSnapshot = {
    inputRequired: structuredClone(operation.inputRequired),
    request: structuredClone(operation.request),
    resumeRequest:
      operation.resumeRequest ?
        structuredClone(operation.resumeRequest)
      : undefined
  };
  const request = operation.request;
  if (code === "service-management-reference-required") {
    request.azure.serviceManagementReference =
      data.serviceManagementReference || "";
    if (operation.resumeRequest?.azure) {
      operation.resumeRequest.azure.serviceManagementReference =
        data.serviceManagementReference || "";
    }
  } else if (code === "app-selection-required") {
    request.azure.appId = data.appId || "";
    request.azure.createNew = data.createNew === true;
    if (operation.resumeRequest?.azure) {
      operation.resumeRequest.azure.appId = data.appId || "";
      operation.resumeRequest.azure.createNew = data.createNew === true;
    }
  } else {
    jsonError(context, 400, {
      error: "Unsupported resume prompt.",
      code: "unsupported-resume"
    });
    return;
  }
  dependencies.resumeAfterInput(operation);
  try {
    await dependencies.persistOperations();
  } catch (error) {
    operation.request = resumeSnapshot.request;
    if (resumeSnapshot.resumeRequest === undefined) {
      delete operation.resumeRequest;
    } else {
      operation.resumeRequest = resumeSnapshot.resumeRequest;
    }
    dependencies.requireInput(operation, resumeSnapshot.inputRequired);
    jsonError(context, 500, {
      error:
        "Radius could not persist the resumed operation. Your answer was not accepted; retry the prompt.",
      code: "operation-resume-persist-failed",
      operationId,
      detail: dependencies.errorMessage(error)
    });
    return;
  }
  context.json(202, {
    operationId,
    statusUrl: `/api/operations/${encodeURIComponent(operationId)}`
  });
  const scheduled = dependencies.scheduleEnvironmentOperation(
    context.instanceId,
    operation
  );
  if (!scheduled) {
    await finishSchedulingFailure(
      operation,
      context.instanceId,
      (failure) => dependencies.finish(operation, "failed", { failure }),
      dependencies.persistOperations,
      dependencies.errorMessage
    );
  }
}

export async function handleAbandonOperation(
  context: CanvasRequestContext,
  dependencies: OperationActionDependencies
): Promise<void> {
  const parameters = requiredTemplateParameters(
    ABANDON_OPERATION_ROUTE,
    context.pathname
  );
  const operationId = decodeURIComponent(parameters.operationId);
  const operation = dependencies.getOperation(operationId);
  if (
    !operation ||
    operation.state !== dependencies.inputRequiredState ||
    operation.executionActive ||
    dependencies.isTerminalState(operation.state)
  ) {
    jsonError(context, operation ? 409 : 404, {
      error:
        operation ?
          "The operation is not waiting for input."
        : "Unknown operation.",
      code: operation ? "operation-abandon-mismatch" : "unknown-operation"
    });
    return;
  }
  dependencies.finish(operation, "cancelled");
  try {
    await dependencies.persistOperations();
  } catch (error) {
    jsonError(context, 500, {
      error: "Radius could not persist the abandoned operation.",
      code: "operation-abandon-persist-failed",
      detail: dependencies.errorMessage(error)
    });
    return;
  }
  context.json(200, { operation: dependencies.toClientView(operation) });
}

export function createOperationsStatusRoutes(
  dependencies: OperationsStatusDependencies,
  createDependencies: CreateOperationDependencies,
  actionDependencies: OperationActionDependencies
): RouteHandlerRegistry {
  assertOperationActionDependencies(actionDependencies);
  return {
    "GET /api/operations": (context) =>
      handleLatestOperation(context, dependencies),
    [`GET ${OPERATION_DIAGNOSTICS_ROUTE}`]: (context) =>
      handleOperationDiagnostics(context, dependencies),
    "GET /api/operations/": (context) =>
      handleOperationById(context, dependencies),
    "POST /api/operations": (context) =>
      handleCreateOperation(context, createDependencies),
    "POST /api/operations/:operationId/resume/:code": (context) =>
      handleResumeOperation(context, actionDependencies),
    "POST /api/operations/:operationId/abandon": (context) =>
      handleAbandonOperation(context, actionDependencies)
  };
}
