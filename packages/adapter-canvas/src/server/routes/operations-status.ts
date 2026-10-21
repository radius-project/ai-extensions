import type { CanvasRequestContext } from "../request-context.js";
import {
  type SetupResumeInput,
  type SetupResumeRequest
} from "@radius-project/core";
import {
  createOperationResumeService,
  type OperationResumeService
} from "../services/operation-resume.js";
import type { SelectionHandleClaim } from "../services/github-account-readiness.js";
import { createSetupStartService } from "../services/setup-start.js";
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

type OperationRequest = SetupResumeRequest;

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
  isKubernetesNamespace(value: string): boolean;
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
    instanceId: string | undefined,
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
  canDismissOperation(operation: OperationActionRecord): boolean;
  dismissOperation(operation: OperationActionRecord): void;
  persistOperations(): Promise<void>;
  toClientView(operation: OperationActionRecord): unknown;
  scheduleEnvironmentOperation(
    instanceId: string | undefined,
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
  "canDismissOperation",
  "dismissOperation",
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
export const DISMISS_OPERATION_ROUTE = "/api/operations/:operationId/dismiss";

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
  await createSetupStartService(dependencies)({
    data,
    instanceId: context.instanceId,
    claimAccount: ({ repo, environment }) =>
      dependencies.claimSelectionHandle({
        instanceId: context.instanceId,
        repo,
        environment,
        handle: String(data.selectionHandle || "")
      }),
    publish: (result) => {
      context.response.setHeader("Content-Type", "application/json");
      context.response.setHeader("Location", String(result.body.statusUrl));
      context.response.writeHead(result.status);
      context.response.end(JSON.stringify(result.body));
    }
  }).then((result) => {
    if (result.status !== 202) jsonError(context, result.status, result.body);
  });
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
  dependencies: OperationActionDependencies,
  service = createOperationResumeService(dependencies)
): Promise<void> {
  const parameters = requiredTemplateParameters(
    RESUME_OPERATION_ROUTE,
    context.pathname
  );
  const operationId = decodeURIComponent(parameters.operationId);
  const code = decodeURIComponent(parameters.code);
  await service(
    { operationId, code, instanceId: context.instanceId },
    async () => {
      const body = await context.readTextBody();
      try {
        return JSON.parse(body) as SetupResumeInput;
      } catch {
        return {};
      }
    },
    ({ status, body }) => {
      if (status === 202) context.json(status, body);
      else jsonError(context, status, body);
    }
  );
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

export async function handleDismissOperation(
  context: CanvasRequestContext,
  dependencies: OperationActionDependencies
): Promise<void> {
  const parameters = requiredTemplateParameters(
    DISMISS_OPERATION_ROUTE,
    context.pathname
  );
  const operationId = decodeURIComponent(parameters.operationId);
  const operation = dependencies.getOperation(operationId);
  if (!operation || !dependencies.canDismissOperation(operation)) {
    jsonError(context, operation ? 409 : 404, {
      error:
        operation ?
          "The operation cannot be dismissed while an action remains available."
        : "Unknown operation.",
      code: operation ? "operation-dismiss-mismatch" : "unknown-operation"
    });
    return;
  }
  const previousDismissedAt = operation.dismissedAt;
  const previousLastActivityAt = operation.lastActivityAt;
  dependencies.dismissOperation(operation);
  try {
    await dependencies.persistOperations();
  } catch (error) {
    operation.dismissedAt = previousDismissedAt;
    operation.lastActivityAt = previousLastActivityAt;
    jsonError(context, 500, {
      error: "Radius could not persist the dismissed operation.",
      code: "operation-dismiss-persist-failed",
      detail: dependencies.errorMessage(error)
    });
    return;
  }
  context.json(200, { operationId });
}

export function createOperationsStatusRoutes(
  dependencies: OperationsStatusDependencies,
  createDependencies: CreateOperationDependencies,
  actionDependencies: OperationActionDependencies,
  resumeService?: OperationResumeService
): RouteHandlerRegistry {
  assertOperationActionDependencies(actionDependencies);
  const resume =
    resumeService ?? createOperationResumeService(actionDependencies);
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
      handleResumeOperation(context, actionDependencies, resume),
    "POST /api/operations/:operationId/abandon": (context) =>
      handleAbandonOperation(context, actionDependencies),
    "POST /api/operations/:operationId/dismiss": (context) =>
      handleDismissOperation(context, actionDependencies)
  };
}
