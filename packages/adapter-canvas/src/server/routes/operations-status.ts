import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";

// The registry and the client projection stay in `operations.ts`, which is
// independently tested. These routes are a thin lookup-and-project adapter, so
// they take the four narrow functions they call and nothing else — no registry
// object, no container, no global server map.
export interface OperationsStatusDependencies {
  latest(repo: string): unknown;
  latestAny(): unknown;
  get(operationId: string): unknown;
  toClientView(record: unknown): unknown;
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

export function createOperationsStatusRoutes(
  dependencies: OperationsStatusDependencies
): RouteHandlerRegistry {
  return {
    "GET /api/operations": (context) =>
      handleLatestOperation(context, dependencies),
    "GET /api/operations/": (context) =>
      handleOperationById(context, dependencies)
  };
}
