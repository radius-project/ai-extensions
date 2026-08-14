import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";

// The registry and the client projection stay in `operations.ts`, which is
// independently tested. These routes are a thin lookup-and-project adapter, so
// they take the narrow functions they call and nothing else — no registry
// object, no container, no global server map.
//
// The three read routes (the two GETs plus the projection they share) keep the
// original four ports. The POST that registers a new environment operation adds
// its own seams below rather than widening a single port object into a
// general-purpose registry handle: each is a single function, and the test
// fakes throw on anything a given route is not supposed to reach.
export interface OperationsStatusDependencies {
  latest(repo: string): unknown;
  latestAny(): unknown;
  get(operationId: string): unknown;
  toClientView(record: unknown): unknown;
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
  | { ok: false; conflict: { operationId: string; [key: string]: unknown } };

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

const OPERATIONS_PREFIX = "/api/operations/";

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
  op.request = {
    needsAzureCredentials,
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
    environment: { ...data, environment, provider }
  };
  if (provider === "azure") {
    op.resumeRequest = {
      needsAzureCredentials,
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
        origin: data.origin || null,
        resumeTarget: data.resumeTarget || null,
        resumeBranch: data.resumeBranch || null,
        resumeReason: data.resumeReason || null
      }
    };
  }
  const started = dependencies.startOperation(op);
  if (!started.ok) {
    jsonError(context, 409, {
      error: `Setup is already running for ${repo}.`,
      code: "operation-in-progress",
      operationId: started.conflict.operationId
    });
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
        message: "Radius could not durably register the environment operation.",
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
    dependencies.finish(op, "failed", {
      failure: {
        code: "operation-scheduling-failed",
        stage: op.currentStage,
        stepSeq: null,
        message:
          "Radius accepted the environment operation but could not start any setup work for it.",
        classification: "unknown",
        evidence: `No server-owned task runner was available for instance ${context.instanceId}.`
      }
    });
    try {
      await dependencies.persistOperations();
    } catch (error) {
      // Best-effort: the in-memory record is already terminal, so polling
      // reflects the failure even if this durable write does not land.
      dependencies.errorMessage(error);
    }
  }
}

export function createOperationsStatusRoutes(
  dependencies: OperationsStatusDependencies,
  createDependencies: CreateOperationDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/operations": (context) =>
      handleLatestOperation(context, dependencies),
    "GET /api/operations/": (context) =>
      handleOperationById(context, dependencies),
    "POST /api/operations": (context) =>
      handleCreateOperation(context, createDependencies)
  };
}
