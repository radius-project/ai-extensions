import { describe, expect, it } from "vitest";
import {
  portForbidden,
  portFailure,
  portSuccess
} from "@radius-project/core/lifecycle";
import {
  authoredResponse,
  graphFailure,
  strictGraphReader,
  scriptGraphDiff
} from "../../test/support/canonical-graphs.js";
import {
  canvasResources,
  readCommittedGraphDiff,
  readWorkspaceGraphRevision
} from "./graph-reader.js";
import type { CanvasState } from "../shared.js";

describe("canonical Canvas graph reader", () => {
  it("compares fresh workspace closure with rendered provenance without changing the baseline", async () => {
    const reader = strictGraphReader();
    const graph = authoredResponse().result;
    if (graph.kind !== "authored") throw new Error("Expected authored fixture");
    graph.provenance = {
      kind: "workspace",
      repo: "owner/repo",
      workspaceRef: "workspace",
      branch: "feature",
      fingerprint: `sha256:${"a".repeat(64)}`,
      resolvedAt: "2026-09-15T00:00:00Z"
    };
    const state: CanvasState = {
      graphReadEvidence: { graph: { unavailable: false, result: graph } }
    };
    const entry = { state, graphLifecycle: reader };
    reader.resolveWorkspaceSource.mockResolvedValue(
      portSuccess({
        kind: "workspace",
        workspaceRef: "workspace",
        branch: "feature",
        expectedFingerprint: `sha256:${"b".repeat(64)}`
      })
    );
    expect(await readWorkspaceGraphRevision(entry)).toBe(
      `sha256:${"b".repeat(64)}`
    );
    expect(graph.provenance.fingerprint).toBe(`sha256:${"a".repeat(64)}`);
    expect(reader.execute).not.toHaveBeenCalled();
    reader.resolveWorkspaceSource.mockImplementation(async () => {
      state.graphReadEvidence = {};
      return portSuccess({
        kind: "workspace",
        workspaceRef: "workspace",
        branch: "feature",
        expectedFingerprint: `sha256:${"b".repeat(64)}`
      });
    });
    expect(await readWorkspaceGraphRevision(entry)).toBeNull();
    state.graphReadEvidence = { graph: { unavailable: false, result: graph } };
    for (const source of [
      portForbidden(),
      portSuccess({
        kind: "git" as const,
        ref: "main",
        expectedCommit: "a".repeat(40)
      }),
      portSuccess({
        kind: "workspace" as const,
        workspaceRef: "other",
        branch: "feature",
        expectedFingerprint: `sha256:${"b".repeat(64)}`
      })
    ]) {
      reader.resolveWorkspaceSource.mockResolvedValue(source);
      expect(await readWorkspaceGraphRevision(entry)).toBeNull();
    }
  });
  it("does not read revisions for missing, unavailable, remote or comparison views", async () => {
    const reader = strictGraphReader();
    expect(await readWorkspaceGraphRevision(undefined)).toBeNull();
    expect(await readWorkspaceGraphRevision({ state: {} })).toBeNull();
    expect(
      await readWorkspaceGraphRevision({ state: {}, graphLifecycle: reader })
    ).toBeNull();
    for (const state of [
      {
        graphReadEvidence: {
          graph: {
            unavailable: true,
            reason: "SOURCE_UNAVAILABLE",
            message: "Unavailable"
          }
        }
      },
      {
        graphReadEvidence: {
          graph: { unavailable: false, result: authoredResponse().result }
        }
      }
    ] satisfies CanvasState[])
      expect(
        await readWorkspaceGraphRevision({ state, graphLifecycle: reader })
      ).toBeNull();
    expect(reader.resolveWorkspaceSource).not.toHaveBeenCalled();
    const diff = scriptGraphDiff(reader).response.result;
    expect(
      await readWorkspaceGraphRevision({
        state: {
          graphReadEvidence: { graph: { unavailable: false, result: diff } }
        },
        graphLifecycle: reader
      })
    ).toBeNull();
    expect(
      await readWorkspaceGraphRevision({
        state: {
          graphReadEvidence: {
            graph: {
              unavailable: false,
              result: {
                kind: "deployed",
                target: {
                  repo: "owner/repo",
                  environment: "dev",
                  application: "app"
                },
                graph: { resources: [] },
                observation: {
                  quality: "current",
                  completeness: "complete",
                  evidence: "radius"
                }
              }
            }
          }
        },
        graphLifecycle: reader
      })
    ).toBeNull();
  });
  it("copies nested canonical collections without changing identities or statuses", () => {
    const graph = authoredResponse().result.graph;
    graph.resources[0].connections.push({ id: "web", direction: "Inbound" });
    graph.resources[0].outputResources.push({
      name: "cache",
      type: "Microsoft.Cache/redis",
      provider: "azure",
      displayType: "Redis",
      apiVersion: "2024-01-01"
    });
    const resources = canvasResources(graph);
    expect(resources).toEqual(graph.resources);
    const connection = resources[0].connections?.[0];
    const output = resources[0].outputResources?.[0];
    if (!connection || !output) throw new Error("Missing graph projection");
    connection.id = "changed";
    output.name = "changed";
    expect(graph.resources[0].connections[0].id).toBe("web");
    expect(graph.resources[0].outputResources[0].name).toBe("cache");
  });
  it("resolves both explicit commits before comparing and preserves canonical evidence", async () => {
    const reader = strictGraphReader();
    const scripted = scriptGraphDiff(reader);
    const result = await readCommittedGraphDiff(
      reader,
      "acme/widgets",
      "main",
      "feat",
      "infra/app.bicep"
    );
    expect(result).toMatchObject({
      status: "ok",
      value: {
        status: "available",
        base: { ref: "main" },
        head: { ref: "feat" }
      }
    });
    expect(scripted.execute).toHaveBeenCalledWith({
      operation: "graph.diff",
      target: { repo: "acme/widgets" },
      input: {
        kind: "authored",
        base: {
          repo: "acme/widgets",
          definition: "infra/app.bicep",
          source: { kind: "git", ref: "main", expectedCommit: "a".repeat(40) }
        },
        head: {
          repo: "acme/widgets",
          definition: "infra/app.bicep",
          source: { kind: "git", ref: "feat", expectedCommit: "a".repeat(40) }
        }
      }
    });
  });
  it.each(["base", "head"] as const)(
    "never compiles when the %s source is inaccessible",
    async (side) => {
      const reader = strictGraphReader();
      if (side === "head")
        reader.resolveCommittedSource.mockResolvedValueOnce(
          portSuccess({
            kind: "git",
            ref: "main",
            expectedCommit: "a".repeat(40)
          })
        );
      reader.resolveCommittedSource.mockResolvedValueOnce(portForbidden());
      expect(
        await readCommittedGraphDiff(reader, "acme/widgets", "main", "feat")
      ).toMatchObject({
        status: "ok",
        value: { status: "unavailable", source: side, reason: "FORBIDDEN" }
      });
      expect(reader.execute).not.toHaveBeenCalled();
    }
  );
  it("distinguishes unresolved source, lifecycle failure, and wrong operation evidence", async () => {
    const reader = strictGraphReader();
    reader.resolveCommittedSource.mockResolvedValueOnce(
      portFailure("EVIDENCE_MISMATCH")
    );
    expect(
      await readCommittedGraphDiff(reader, "acme/widgets", "main", "feat")
    ).toMatchObject({ status: "ok", value: { reason: "SOURCE_UNAVAILABLE" } });
    reader.resolveCommittedSource.mockImplementation(async (_repo, ref) =>
      portSuccess({ kind: "git", ref, expectedCommit: "a".repeat(40) })
    );
    reader.execute.mockResolvedValueOnce(graphFailure());
    expect(
      await readCommittedGraphDiff(reader, "acme/widgets", "main", "feat")
    ).toEqual({ status: "error", error: graphFailure().error });
    reader.execute.mockResolvedValueOnce(authoredResponse());
    expect(
      await readCommittedGraphDiff(reader, "acme/widgets", "main", "feat")
    ).toMatchObject({ status: "error", error: { code: "EVIDENCE_MISMATCH" } });
  });
});
