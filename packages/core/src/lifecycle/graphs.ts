import type {
  LifecycleRequestFor,
  LifecycleResponseFor
} from "./contracts/catalog.js";
import type {
  CanonicalGraph,
  Observation,
  ResolvedSource
} from "./contracts/common.js";
import {
  portCancelled,
  portFailure,
  portForbidden,
  portSuccess,
  portUnavailable,
  type PortResult,
  type PortError
} from "./errors.js";
import { compareRadiusGraphs } from "./graph-result.js";
import { sameLifecycleData } from "./operations.js";
import type {
  AuthorizationRequest,
  AuthorizedScope,
  CallerContext,
  ClockPort,
  EnvironmentAccessPort,
  GraphExecutionPort,
  ReadonlyData,
  RecipeRegistrationEvidence,
  RequestControl,
  SourceAccessPort,
  SourceSelection,
  SourceSnapshot
} from "./ports.js";
import { validateSourceSelection, verifySourceExpectation } from "./source.js";

type GraphResult = LifecycleResponseFor<"graph.get">["result"];
type DiffResult = LifecycleResponseFor<"graph.diff">["result"];
type DiffInput = LifecycleRequestFor<"graph.diff">["input"];
type SourceTarget = DiffInput["base"];
type GraphScope = AuthorizedScope<"graph.get" | "graph.diff">;
type SourceGraphResult = GraphResult & { provenance: ResolvedSource };
type SourceReadRequest =
  | { kind: "authored"; target: SourceSelection }
  | {
      kind: "planned";
      target: ReadonlyData<Extract<DiffInput, { kind: "planned" }>["base"]>;
    }
  | {
      kind: "deployed";
      target: ReadonlyData<Extract<DiffInput, { kind: "deployed" }>["base"]>;
    };

function graphSelection(
  input: DiffInput,
  side: "base" | "head"
): SourceReadRequest {
  if (input.kind === "authored")
    return { kind: input.kind, target: input[side] };
  if (input.kind === "planned")
    return { kind: input.kind, target: input[side] };
  return { kind: input.kind, target: input[side] };
}
export interface LifecycleGraphDependencies {
  source: Pick<SourceAccessPort, "capture" | "releaseSnapshot">;
  graph: GraphExecutionPort;
  environment: Pick<EnvironmentAccessPort, "registrations">;
  identity: {
    authorize(
      request: AuthorizationRequest<"graph.diff">,
      control: RequestControl
    ): Promise<PortResult<AuthorizedScope<"graph.diff">>>;
  };
  clock: Pick<ClockPort, "now">;
}

function copyGraph(graph: ReadonlyData<CanonicalGraph>): CanonicalGraph {
  return {
    resources: graph.resources.map((resource) => ({
      ...resource,
      connections: resource.connections.map((connection) => ({
        ...connection
      })),
      outputResources: resource.outputResources.map((output) => ({ ...output }))
    }))
  };
}
function unavailable(message: string) {
  return portUnavailable(
    "RESULT_UNAVAILABLE",
    {
      quality: "unknown",
      completeness: "unavailable",
      evidence: "source",
      limitation: message
    },
    { diagnostics: [{ message, truncated: false }] }
  );
}
function observation(time: string): Observation {
  return {
    quality: "current",
    completeness: "complete",
    evidence: "source",
    observedAt: time
  };
}
function comparisonObservation(
  kind: GraphResult["kind"],
  base: Observation,
  head: Observation
): Observation {
  const quality =
    base.quality === "unknown" || head.quality === "unknown" ? "unknown"
    : base.quality === "stale" || head.quality === "stale" ? "stale"
    : "current";
  const completeness =
    (
      kind === "planned" ||
      base.completeness !== "complete" ||
      head.completeness !== "complete"
    ) ?
      "partial"
    : "complete";
  const observedAt =
    base.observedAt && head.observedAt ?
      Date.parse(base.observedAt) <= Date.parse(head.observedAt) ?
        base.observedAt
      : head.observedAt
    : undefined;
  return {
    quality,
    completeness,
    evidence: kind === "deployed" ? "radius" : "source",
    ...(observedAt ? { observedAt } : {}),
    ...(kind === "planned" ?
      {
        limitation:
          "Expected primary resources are inferred from actual registered recipe references; supporting resources are not enumerated."
      }
    : completeness === "partial" || quality !== "current" ?
      {
        limitation:
          "The comparison retains incomplete or non-current observations from one or both selected graphs."
      }
    : {})
  };
}
function selected(target: ReadonlyData<SourceTarget>): SourceSelection {
  return {
    repo: target.repo,
    definition: target.definition,
    source: { ...target.source }
  };
}
function comparisonFailure(
  value: PortError
): Pick<Extract<DiffResult, { status: "unavailable" }>, "reason" | "message"> {
  const reason = value.error.code;
  return {
    reason:
      (
        reason === "DEFINITION_NOT_FOUND" ||
        reason === "SOURCE_UNAVAILABLE" ||
        reason === "SOURCE_CHANGED" ||
        reason === "FORBIDDEN" ||
        reason === "CAPABILITY_UNAVAILABLE"
      ) ?
        reason
      : "RESULT_UNAVAILABLE",
    message:
      value.error.details?.[0]?.message ??
      (value.status === "unavailable" ?
        value.observation.limitation
      : undefined) ??
      value.error.message
  };
}

export function createLifecycleGraphs(deps: LifecycleGraphDependencies) {
  if (
    [
      deps?.source?.capture,
      deps?.source?.releaseSnapshot,
      deps?.graph?.compile,
      deps?.graph?.observeDeployed,
      deps?.environment?.registrations,
      deps?.identity?.authorize,
      deps?.clock?.now
    ].some((method) => typeof method !== "function")
  )
    throw new Error(
      "Graph reads require complete source, graph, environment, identity and clock ports."
    );
  let closed = false;
  const stopped = (control: RequestControl) =>
    closed || control.cancellation.aborted;

  async function deployed(
    scope: GraphScope,
    target: { repo: string; environment: string; application: string },
    control: RequestControl
  ): Promise<PortResult<Extract<GraphResult, { kind: "deployed" }>>> {
    const result = await deps.graph.observeDeployed(scope, target, control);
    if (result.status === "absent")
      return unavailable(
        "No deployed graph evidence was observed for the selected application and environment."
      );
    if (result.status !== "ok") return result;
    if (
      result.value.kind !== "deployed" ||
      !sameLifecycleData(result.value.target, target)
    )
      return portFailure("EVIDENCE_MISMATCH");
    if (result.value.observation.completeness === "unavailable")
      return unavailable("Detailed deployed graph evidence is unavailable.");
    return portSuccess({
      kind: "deployed",
      target: { ...target },
      graph: copyGraph(result.value.graph),
      observation: { ...result.value.observation },
      ...(result.value.provenance ?
        { provenance: { ...result.value.provenance } }
      : {})
    });
  }

  async function sourceGraph(
    request: SourceReadRequest,
    scope: GraphScope,
    control: RequestControl
  ): Promise<PortResult<SourceGraphResult>> {
    if (stopped(control)) return portCancelled("request_cancelled");
    const selection = selected(request.target);
    const valid = validateSourceSelection(selection, control.cancellation);
    if (valid.status !== "ok") return valid;
    const captured = await deps.source.capture(scope, selection, control);
    if (captured.status === "absent")
      return portFailure("DEFINITION_NOT_FOUND");
    if (captured.status !== "ok") return captured;
    if (captured.value.status === "incomplete")
      return portUnavailable(
        "VALIDATION_INCOMPLETE",
        {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "source",
          limitation:
            "The complete compiler input closure has not been captured."
        },
        { diagnostics: captured.value.manifest.diagnostics }
      );
    const snapshot = captured.value.snapshot;
    let result: PortResult<SourceGraphResult>;
    try {
      result = await compileCaptured(request, scope, snapshot, control);
    } catch {
      result = unavailable(
        "The graph adapter failed while reading captured inputs."
      );
    }
    const cleanup = await deps.source.releaseSnapshot(snapshot);
    if (cleanup.status !== "ok") return cleanup;
    return stopped(control) ? portCancelled("request_cancelled") : result;
  }

  async function compileCaptured(
    request: SourceReadRequest,
    scope: GraphScope,
    snapshot: SourceSnapshot,
    control: RequestControl
  ): Promise<PortResult<SourceGraphResult>> {
    const { kind, target } = request;
    if (stopped(control)) return portCancelled("request_cancelled");
    const selection = selected(target);
    if (!sameLifecycleData(snapshot.selection, selection))
      return portFailure("EVIDENCE_MISMATCH");
    const match = verifySourceExpectation(
      selection,
      snapshot.provenance,
      snapshot.manifest,
      control.cancellation
    );
    if (match.status !== "ok") return match;
    if (scope.source) {
      const authorized = verifySourceExpectation(
        selection,
        scope.source,
        snapshot.manifest,
        control.cancellation
      );
      if (authorized.status !== "ok") return authorized;
    }
    if (kind === "deployed") {
      const result = await deployed(
        scope,
        {
          repo: target.repo,
          environment: target.environment,
          application: target.application
        },
        control
      );
      if (result.status !== "ok") return result;
      if (!result.value.provenance)
        return unavailable(
          "The deployed graph has no recorded source provenance for comparison."
        );
      const match = verifySourceExpectation(
        snapshot.selection,
        result.value.provenance,
        snapshot.manifest,
        control.cancellation
      );
      if (match.status !== "ok") return match;
      return portSuccess({
        ...result.value,
        provenance: { ...result.value.provenance }
      });
    }
    let registrations: RecipeRegistrationEvidence | undefined;
    if (kind === "planned") {
      const environment = {
        repo: target.repo,
        environment: target.environment
      };
      const result = await deps.environment.registrations(
        scope,
        environment,
        control
      );
      if (result.status === "absent") return portFailure("PRECONDITION_FAILED");
      if (result.status !== "ok") return result;
      if (!sameLifecycleData(result.value.target, environment))
        return portFailure("EVIDENCE_MISMATCH");
      if (
        result.value.observation.quality !== "current" ||
        result.value.observation.completeness !== "complete"
      )
        return unavailable(
          "Current complete actual recipe registration evidence is unavailable."
        );
      registrations = result.value;
    }
    if (stopped(control)) return portCancelled("request_cancelled");
    const compiled = await deps.graph.compile(
      registrations ?
        { kind: "planned", snapshot, registrations }
      : { kind: "authored", snapshot },
      control
    );
    if (compiled.status !== "ok") return compiled;
    const common = {
      provenance: { ...snapshot.provenance },
      graph: copyGraph(compiled.value.graph),
      observation: observation(deps.clock.now())
    };
    if (registrations && "environment" in target)
      return portSuccess({
        ...common,
        kind: "planned",
        target: { ...selected(target), environment: target.environment },
        enrichment: {
          recipes: registrations.recipes.map((recipe) => ({ ...recipe })),
          observation: {
            ...registrations.observation,
            completeness: "partial",
            limitation:
              "Expected primary resources are inferred from actual registered recipe references using the existing Radius mapping; supporting resources are not enumerated."
          }
        }
      });
    return portSuccess({
      ...common,
      kind: "authored",
      target: { ...selected(target) }
    });
  }

  async function read(
    scope: GraphScope,
    kind: GraphResult["kind"],
    target: GraphScope["target"],
    control: RequestControl
  ): Promise<PortResult<GraphResult>> {
    if (stopped(control)) return portCancelled("request_cancelled");
    if (kind === "deployed") {
      if (!("environment" in target) || !("application" in target))
        return portFailure("INVALID_REQUEST");
      const result = await deployed(scope, target, control);
      return stopped(control) ? portCancelled("request_cancelled") : result;
    }
    if (!("source" in target) || !("definition" in target))
      return portFailure("INVALID_REQUEST");
    if (kind === "planned") {
      if (!("environment" in target)) return portFailure("INVALID_REQUEST");
      return sourceGraph({ kind, target }, scope, control);
    }
    return sourceGraph({ kind, target }, scope, control);
  }

  return {
    get(
      scope: AuthorizedScope<"graph.get">,
      input: LifecycleRequestFor<"graph.get">["input"],
      control: RequestControl
    ) {
      return read(scope, input.kind, scope.target, control);
    },
    async diff(
      scope: AuthorizedScope<"graph.diff">,
      request: DiffInput,
      caller: CallerContext,
      control: RequestControl
    ): Promise<PortResult<DiffResult>> {
      const input = structuredClone(request);
      if (stopped(control)) return portCancelled("request_cancelled");
      if (
        caller.principalRef !== scope.principalRef ||
        scope.target.repo.toLowerCase() !== input.head.repo.toLowerCase()
      )
        return portForbidden();
      async function side(
        request: SourceReadRequest
      ): Promise<PortResult<SourceGraphResult>> {
        if (stopped(control)) return portCancelled("request_cancelled");
        const target = request.target;
        const authorized = await deps.identity.authorize(
          { caller, operation: "graph.diff", target: structuredClone(target) },
          control
        );
        if (authorized.status !== "ok") return authorized;
        if (
          authorized.value.operation !== "graph.diff" ||
          authorized.value.principalRef !== caller.principalRef ||
          !sameLifecycleData(authorized.value.target, target)
        )
          return portForbidden();
        return sourceGraph(request, authorized.value, control);
      }
      const base = await side(graphSelection(input, "base"));
      if (base.status === "cancelled") return base;
      const head = await side(graphSelection(input, "head"));
      if (head.status === "cancelled") return head;
      if (stopped(control)) return portCancelled("request_cancelled");
      function failedComparison(
        failure: PortError,
        source: "base" | "head" | "both"
      ): PortResult<DiffResult> {
        return portSuccess({
          status: "unavailable",
          source,
          ...comparisonFailure(failure),
          observation: {
            quality: "unknown",
            completeness: "unavailable",
            evidence: "source"
          }
        });
      }
      if (base.status !== "ok")
        return failedComparison(
          head.status === "forbidden" ? head : base,
          head.status !== "ok" ? "both" : "base"
        );
      if (head.status !== "ok") return failedComparison(head, "head");
      const graph = compareRadiusGraphs(base.value.graph, head.value.graph);
      if (graph.status !== "ok") return graph;
      const common = {
        base: { ...base.value.provenance },
        head: { ...head.value.provenance },
        graph: graph.value,
        observation: comparisonObservation(
          input.kind,
          base.value.observation,
          head.value.observation
        )
      };
      const targets =
        input.kind === "authored" ?
          {
            kind: input.kind,
            baseTarget: { ...input.base, source: { ...input.base.source } },
            headTarget: { ...input.head, source: { ...input.head.source } }
          }
        : input.kind === "planned" ?
          {
            kind: input.kind,
            baseTarget: { ...input.base, source: { ...input.base.source } },
            headTarget: { ...input.head, source: { ...input.head.source } }
          }
        : {
            kind: input.kind,
            baseTarget: { ...input.base, source: { ...input.base.source } },
            headTarget: { ...input.head, source: { ...input.head.source } }
          };
      return portSuccess({
        status: "available",
        ...common,
        ...targets
      });
    },
    close() {
      closed = true;
    }
  };
}
