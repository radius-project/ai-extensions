import {
  lifecycleError,
  portSuccess,
  type CanonicalGraph,
  type LifecycleResponseFor,
  type LifecycleError
} from "@radius-project/core/lifecycle";
import type { CanvasGraphResource, CanvasState } from "../shared.js";
import type { LifecycleBinding } from "./create-lifecycle-binding.js";

export type GraphLifecycleReader = Pick<
  LifecycleBinding,
  "execute" | "resolveCommittedSource" | "resolveWorkspaceSource"
>;
export type GraphReadResult<T> =
  { status: "ok"; value: T } | { status: "error"; error: LifecycleError };

export async function readWorkspaceGraphRevision(
  entry:
    { state: CanvasState; graphLifecycle?: GraphLifecycleReader } | undefined
): Promise<string | null> {
  const evidence = entry?.state.graphReadEvidence?.graph;
  if (!entry?.graphLifecycle || !evidence || evidence.unavailable) return null;
  const graph = evidence.result;
  if (
    !("target" in graph) ||
    graph.kind !== "authored" ||
    graph.provenance.kind !== "workspace"
  )
    return null;
  const source = await entry.graphLifecycle.resolveWorkspaceSource({
    repo: graph.target.repo,
    definition: graph.target.definition
  });
  if (
    entry.state.graphReadEvidence?.graph !== evidence ||
    source.status !== "ok" ||
    source.value.kind !== "workspace" ||
    source.value.workspaceRef !== graph.provenance.workspaceRef
  )
    return null;
  return source.value.expectedFingerprint;
}

export function canvasResources(graph: CanonicalGraph): CanvasGraphResource[] {
  return graph.resources.map((resource) => ({
    ...resource,
    connections: resource.connections.map((connection) => ({ ...connection })),
    outputResources: resource.outputResources.map((output) => ({ ...output }))
  }));
}

export async function readCommittedGraphDiff(
  lifecycle: GraphLifecycleReader,
  repo: string,
  base: string,
  head: string,
  definition = ".radius/app.bicep"
): Promise<GraphReadResult<LifecycleResponseFor<"graph.diff">["result"]>> {
  const selections = [];
  for (const [side, ref] of [
    ["base", base],
    ["head", head]
  ] as const) {
    const source = await lifecycle.resolveCommittedSource(repo, ref);
    if (source.status !== "ok")
      return portSuccess({
        status: "unavailable",
        source: side,
        reason:
          source.status === "forbidden" ? "FORBIDDEN" : "SOURCE_UNAVAILABLE",
        message: "The selected committed source is unavailable.",
        observation: {
          quality: "unknown",
          completeness: "unavailable",
          evidence: "source"
        }
      });
    selections.push({ repo, definition, source: source.value });
  }
  const response = await lifecycle.execute({
    operation: "graph.diff",
    target: { repo },
    input: { kind: "authored", base: selections[0], head: selections[1] }
  });
  return (
    "error" in response ? { status: "error", error: response.error }
    : response.operation === "graph.diff" ? portSuccess(response.result)
    : { status: "error", error: lifecycleError("EVIDENCE_MISMATCH") }
  );
}
