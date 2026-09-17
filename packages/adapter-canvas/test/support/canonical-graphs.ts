import { vi } from "vitest";
import {
  LIFECYCLE_API_VERSION,
  lifecycleError,
  portSuccess,
  projectRadiusGraph,
  type LifecycleResponseFor,
  type LifecycleErrorResponse,
  type CanonicalGraph
} from "@radius-project/core/lifecycle";
import {
  createLifecycleValidators,
  readObject
} from "@radius-project/adapter-shared";
import { createGraphPlanningWorkflows } from "../../src/server/routes/graph-workflows.js";
import type { GraphLifecycleReader } from "../../src/runtime/graph-reader.js";
import {
  prepareSourceRefResources,
  setSourceRefResources
} from "../../src/source-refs.js";
import {
  addGraphProgress,
  beginPlannedGraphRequest,
  isCurrentPlannedGraphRequest,
  isCurrentSourceRefToken
} from "../../src/server.js";
import {
  resolveGraphBranchForRequest,
  commitWorkspaceBranchResolution
} from "../../src/workspace.js";
import type { CanvasState } from "../../src/shared.js";

export function authoredResponse(): LifecycleResponseFor<"graph.get"> {
  return {
    apiVersion: LIFECYCLE_API_VERSION,
    requestId: "request-test",
    operation: "graph.get",
    result: {
      kind: "authored",
      target: {
        repo: "owner/repo",
        definition: ".radius/app.bicep",
        source: { kind: "git", ref: "feature", expectedCommit: "a".repeat(40) }
      },
      provenance: {
        kind: "git",
        repo: "owner/repo",
        ref: "feature",
        commit: "a".repeat(40),
        fingerprint: `sha256:${"a".repeat(64)}`,
        resolvedAt: "2026-09-15T00:00:00Z"
      },
      graph: {
        resources: [
          {
            id: "cache",
            name: "cache",
            type: "Radius.Data/redisCaches",
            diffHash: `sha256:${"a".repeat(64)}`,
            connections: [],
            outputResources: []
          }
        ]
      },
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "source",
        observedAt: "2026-09-15T00:00:00Z"
      }
    }
  };
}
export function graphFailure(
  code: Parameters<typeof lifecycleError>[0] = "RESULT_UNAVAILABLE"
): LifecycleErrorResponse {
  return {
    apiVersion: LIFECYCLE_API_VERSION,
    requestId: "request-test",
    error: lifecycleError(code)
  };
}
export function strictGraphReader() {
  return {
    resolveWorkspaceSource: vi.fn<
      GraphLifecycleReader["resolveWorkspaceSource"]
    >(async () => {
      throw new Error("Unmodeled workspace source");
    }),
    execute: vi.fn<GraphLifecycleReader["execute"]>(async () => {
      throw new Error("Unmodeled canonical graph request");
    }),
    resolveCommittedSource: vi.fn<
      GraphLifecycleReader["resolveCommittedSource"]
    >(async () => {
      throw new Error("Unmodeled committed source");
    })
  };
}
type FixtureGraphResource = Pick<
  CanonicalGraph["resources"][number],
  "id" | "name" | "type"
> &
  Partial<CanonicalGraph["resources"][number]>;
export function scriptGraphDiff(
  reader: GraphLifecycleReader,
  resources: FixtureGraphResource[] = [],
  repo = "acme/widgets",
  branches = ["main", "feat"]
) {
  const projected = projectRadiusGraph(
    {
      resources: resources.map((resource) => ({
        connections: [],
        outputResources: [],
        diffHash: `sha256:${"a".repeat(64)}`,
        ...resource
      }))
    },
    ".radius/app.bicep"
  );
  if (projected.status !== "ok")
    throw new Error("Invalid canonical graph fixture");
  const source = (ref: string) => ({
    kind: "git" as const,
    ref,
    expectedCommit: "a".repeat(40)
  });
  const provenance = (ref: string) => ({
    kind: "git" as const,
    ref,
    repo,
    commit: "a".repeat(40),
    fingerprint: `sha256:${"a".repeat(64)}`,
    resolvedAt: "2026-09-15T00:00:00Z"
  });
  const response = {
    apiVersion: LIFECYCLE_API_VERSION,
    requestId: "request-test",
    operation: "graph.diff",
    result: {
      status: "available",
      kind: "authored",
      baseTarget: {
        repo,
        definition: ".radius/app.bicep",
        source: source(branches[0])
      },
      headTarget: {
        repo,
        definition: ".radius/app.bicep",
        source: source(branches[1])
      },
      base: provenance(branches[0]),
      head: provenance(branches[1]),
      graph: {
        resources: projected.value.resources.map((resource) => ({
          ...resource,
          diffStatus:
            resources.find((fixture) => fixture.id === resource.id)
              ?.diffStatus ?? "unchanged"
        }))
      },
      observation: {
        quality: "current",
        completeness: "complete",
        evidence: "source",
        observedAt: "2026-09-15T00:00:00Z"
      }
    }
  } satisfies LifecycleResponseFor<"graph.diff">;
  const resolve = vi
    .spyOn(reader, "resolveCommittedSource")
    .mockImplementation(async (selectedRepo, ref) => {
      if (selectedRepo !== repo || !branches.includes(ref))
        throw new Error(`Unmodeled graph source ${selectedRepo}@${ref}`);
      return portSuccess(source(ref));
    });
  const validators = createLifecycleValidators();
  const execute = vi
    .spyOn(reader, "execute")
    .mockImplementation(async (input) => {
      const checked = validators.validateRequest({
        apiVersion: LIFECYCLE_API_VERSION,
        requestId: "request-test",
        ...(readObject(input) ? input : {})
      });
      if (!checked.valid) throw new Error("Invalid canonical graph request");
      const request = checked.value;
      if (
        request.operation !== "graph.diff" ||
        request.target?.repo !== repo ||
        request.input.kind !== "authored" ||
        request.input.base.source.kind !== "git" ||
        request.input.head.source.kind !== "git" ||
        !branches.includes(request.input.base.source.ref) ||
        !branches.includes(request.input.head.source.ref)
      )
        throw new Error("Unmodeled canonical graph comparison");
      return {
        ...response,
        result: {
          ...response.result,
          baseTarget: request.input.base,
          headTarget: request.input.head,
          base: provenance(request.input.base.source.ref),
          head: provenance(request.input.head.source.ref)
        }
      };
    });
  return { execute, resolve, response };
}
export function graphWorkflowHarness() {
  let state: CanvasState = {
    contextRepo: "owner/repo",
    contextBranch: "feature",
    workspaceRepo: "owner/repo",
    workspacePath: "owned-workspace",
    workspaceBranch: "feature"
  };
  let exists = true;
  const lifecycle = strictGraphReader();
  const deps = {
    lifecycle,
    readInstanceEntry: () => (exists ? { state } : undefined),
    resolveBranchForRequest: vi.fn(
      (
        entry: { state: CanvasState },
        repo: string,
        branch: string,
        follow: boolean | undefined
      ) =>
        resolveGraphBranchForRequest(
          entry.state,
          repo,
          branch,
          follow,
          async () => "feature"
        )
    ),
    commitBranchResolution: vi.fn(
      (
        entry: { state: CanvasState },
        repo: string,
        resolution: Parameters<typeof commitWorkspaceBranchResolution>[2]
      ) => commitWorkspaceBranchResolution(entry.state, repo, resolution)
    ),
    prepareSourceRefResources,
    setSourceRefResources,
    isCurrentSourceRefToken,
    addGraphProgress,
    beginPlannedGraphRequest,
    isCurrentPlannedGraphRequest,
    now: () => 1000
  };
  const workflows = createGraphPlanningWorkflows(deps);
  return {
    deps,
    lifecycle,
    workflows,
    get state() {
      return state;
    },
    remove: () => {
      exists = false;
    },
    replace: () => {
      state = { ...state };
    },
    request: (body: unknown = { repo: "owner/repo", branch: "feature" }) => ({
      instanceId: "graph-test",
      body: JSON.stringify(body)
    }),
    remote: () =>
      lifecycle.resolveCommittedSource.mockImplementation(async (_repo, ref) =>
        portSuccess({ kind: "git", ref, expectedCommit: "a".repeat(40) })
      )
  };
}
