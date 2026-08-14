import type { CanvasRequestContext } from "../request-context.js";
import type { RouteHandlerRegistry } from "../route-table.js";
import type {
  GraphPlanningWorkflows,
  GraphWorkflowOutcome
} from "./graph-workflows.js";

// The three write halves of the `graphs-planning` family, as HTTP adapters.
//
// Everything these routes decide lives in `graph-workflows.ts`; this module only
// reads the request body, invokes the matching workflow and serializes the
// outcome it returns. That split is why the route layer takes a single seam.
//
// Each route answers a different question about the same model:
//   load-graph    - what does this branch's application look like?
//   plan-graph    - what would it become on a given cloud provider?
//   diff-branches - what changes between two committed branches?

export interface GraphsPlanningWritesDependencies {
  workflows: GraphPlanningWorkflows;
}

// The legacy branches read the body manually, outside their `try`. That is
// observable: a socket error while reading rejects the handler rather than
// answering 400, and only a *parse* failure becomes 400. Reading the text here
// and letting the workflow parse inside its own `try` reproduces both halves.
function readBody(context: CanvasRequestContext): Promise<string> {
  return context.readTextBody();
}

// `bare` outcomes are written without a `Content-Type` header, matching legacy:
// the missing-entry 503 on all three routes and load-graph's pre-compile 409.
// Every other response sets the header first, via `context.json`. Reproducing
// that asymmetry is the whole reason the outcome carries its serialization kind.
function respond(
  context: CanvasRequestContext,
  outcome: GraphWorkflowOutcome
): void {
  if (outcome.kind === "bare") {
    context.response.writeHead(outcome.status);
    context.response.end(JSON.stringify(outcome.payload));
    return;
  }
  context.json(outcome.status, outcome.payload);
}

export async function handleLoadGraph(
  context: CanvasRequestContext,
  dependencies: GraphsPlanningWritesDependencies
): Promise<void> {
  const body = await readBody(context);
  respond(
    context,
    await dependencies.workflows.loadGraph({
      instanceId: context.instanceId,
      body
    })
  );
}

export async function handlePlanGraph(
  context: CanvasRequestContext,
  dependencies: GraphsPlanningWritesDependencies
): Promise<void> {
  const body = await readBody(context);
  respond(
    context,
    await dependencies.workflows.planGraph({
      instanceId: context.instanceId,
      body
    })
  );
}

export async function handleDiffBranches(
  context: CanvasRequestContext,
  dependencies: GraphsPlanningWritesDependencies
): Promise<void> {
  const body = await readBody(context);
  respond(
    context,
    await dependencies.workflows.diffBranches({
      instanceId: context.instanceId,
      body
    })
  );
}

export function createGraphsPlanningWritesRoutes(
  dependencies: GraphsPlanningWritesDependencies
): RouteHandlerRegistry {
  return {
    "POST /api/load-graph": (context) => handleLoadGraph(context, dependencies),
    "POST /api/plan-graph": (context) => handlePlanGraph(context, dependencies),
    "POST /api/diff-branches": (context) =>
      handleDiffBranches(context, dependencies)
  };
}
