import { expect, it, vi } from "vitest";
import { portForbidden } from "@radius-project/core/lifecycle";
import {
  authoredResponse,
  graphFailure,
  graphWorkflowHarness
} from "../../../test/support/canonical-graphs.js";
import { createGraphPlanningWorkflows } from "./graph-workflows.js";

it("requires the canonical reader during construction", () => {
  const h = graphWorkflowHarness();
  Reflect.set(h.lifecycle, "execute", undefined);
  expect(() => createGraphPlanningWorkflows(h.deps)).toThrow(
    "canonical lifecycle"
  );
});
it.each(["loadGraph", "planGraph", "diffBranches"] as const)(
  "preserves missing-instance and malformed-body distinctions for %s",
  async (method) => {
    const h = graphWorkflowHarness();
    expect(
      await h.workflows[method]({ instanceId: "graph-test", body: "{" })
    ).toMatchObject({ kind: "json", status: 400 });
    expect(await h.workflows[method](h.request(null))).toMatchObject({
      status: 400
    });
    expect(await h.workflows[method](h.request({}))).toMatchObject({
      status: 400
    });
    expect(h.lifecycle.execute).not.toHaveBeenCalled();
    h.remove();
    expect(await h.workflows[method](h.request())).toMatchObject({
      kind: "bare",
      status: 503
    });
  }
);
it("reads worktree source every time instead of reusing a definition-only cache", async () => {
  const h = graphWorkflowHarness();
  h.lifecycle.execute.mockResolvedValue(authoredResponse());
  const first = await h.workflows.loadGraph(h.request());
  const token = h.state.sourceRefContexts?.graph?.token;
  const second = await h.workflows.loadGraph(h.request());
  expect(first.payload.resources).toEqual(
    authoredResponse().result.graph.resources
  );
  expect(second.payload.provenance).toEqual(
    authoredResponse().result.provenance
  );
  expect(h.state.sourceRefContexts?.graph?.token).not.toBe(token);
  expect(h.lifecycle.execute).toHaveBeenCalledTimes(2);
  expect(h.lifecycle.execute).toHaveBeenCalledWith({
    operation: "graph.get",
    target: { repo: "owner/repo", definition: ".radius/app.bicep" },
    input: { kind: "authored" }
  });
  expect(h.lifecycle.resolveCommittedSource).not.toHaveBeenCalled();
});
it("pins a non-worktree branch remotely and retains its provenance", async () => {
  const h = graphWorkflowHarness();
  h.remote();
  h.lifecycle.execute.mockResolvedValue(authoredResponse());
  const result = await h.workflows.loadGraph(
    h.request({
      repo: "owner/repo",
      branch: "remote",
      followWorkspaceBranch: false
    })
  );
  expect(result.payload.branch).toBe("remote");
  expect(h.lifecycle.resolveCommittedSource).toHaveBeenCalledWith(
    "owner/repo",
    "remote"
  );
  expect(h.lifecycle.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      target: expect.objectContaining({
        source: { kind: "git", ref: "remote", expectedCommit: "a".repeat(40) }
      })
    })
  );
});
it.each(["DEFINITION_NOT_FOUND", "RESULT_UNAVAILABLE", "FORBIDDEN"] as const)(
  "clears stale graph evidence and reports %s without requesting authoring",
  async (code) => {
    const h = graphWorkflowHarness();
    h.state.graphResources = [{ id: "old" }];
    h.lifecycle.execute.mockResolvedValue(graphFailure(code));
    expect(await h.workflows.loadGraph(h.request())).toMatchObject({
      status: code === "DEFINITION_NOT_FOUND" ? 200 : 400,
      payload: { unavailable: true, reason: code }
    });
    expect(h.state.graphResources).toBeUndefined();
    expect(h.state.graphReadEvidence?.graph).toMatchObject({
      unavailable: true,
      reason: code
    });
  }
);
it("does not manufacture planned resources without actual registrations", async () => {
  const h = graphWorkflowHarness();
  h.lifecycle.execute.mockResolvedValue(graphFailure());
  const result = await h.workflows.planGraph(
    h.request({
      repo: "owner/repo",
      branch: "feature",
      environment: "dev",
      provider: "azure"
    })
  );
  expect(result.payload).toMatchObject({
    unavailable: true,
    reason: "RESULT_UNAVAILABLE"
  });
  expect(result.payload).not.toHaveProperty("needsAppBicep");
  expect(h.state.plannedResources).toBeUndefined();
});
it("projects actual planned enrichment and empty graphs without reload loops", async () => {
  const h = graphWorkflowHarness();
  const authored = authoredResponse().result;
  if (authored.kind !== "authored") throw new Error("Unexpected fixture");
  h.lifecycle.execute.mockResolvedValue({
    ...authoredResponse(),
    result: {
      ...authored,
      kind: "planned",
      target: { ...authored.target, environment: "dev" },
      graph: { resources: [] },
      enrichment: { recipes: [], observation: authored.observation }
    }
  });
  const result = await h.workflows.planGraph(
    h.request({ repo: "owner/repo", branch: "feature", environment: "dev" })
  );
  expect(result.payload).toMatchObject({
    resources: [],
    enrichment: { recipes: [] }
  });
  expect(result.payload).not.toHaveProperty("reload");
  expect(h.state.graphReadEvidence?.planned).toMatchObject({
    unavailable: false
  });
});
it.each(["remove", "replace", "context", "newer"] as const)(
  "fences late reads after %s",
  async (change) => {
    const h = graphWorkflowHarness();
    let complete: (
      result: ReturnType<typeof authoredResponse>
    ) => void = () => {
      throw new Error("Not started");
    };
    h.lifecycle.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = h.workflows.loadGraph(h.request());
    await vi.waitFor(() => expect(h.lifecycle.execute).toHaveBeenCalled());
    if (change === "remove") h.remove();
    else if (change === "replace") h.replace();
    else if (change === "context") h.state.contextBranch = "new-context";
    else {
      h.lifecycle.execute.mockResolvedValue(graphFailure("SOURCE_CHANGED"));
      await h.workflows.loadGraph(h.request());
    }
    complete(authoredResponse());
    expect(await pending).toMatchObject({
      status: 409,
      payload: { stale: true }
    });
    expect(h.state.graphResources).toBeFalsy();
  }
);
it("fails closed on branch-resolution failures, commit fences and wrong result kinds", async () => {
  const h = graphWorkflowHarness();
  h.deps.resolveBranchForRequest.mockResolvedValueOnce({
    status: "unavailable",
    error: "No branch"
  });
  expect(await h.workflows.loadGraph(h.request())).toMatchObject({
    status: 409,
    payload: {
      workspaceBranchUnavailable: true,
      repo: "owner/repo",
      error: "No branch"
    }
  });
  h.remote();
  h.lifecycle.resolveCommittedSource.mockResolvedValueOnce(portForbidden());
  expect(
    await h.workflows.loadGraph(
      h.request({ repo: "owner/repo", branch: "remote" })
    )
  ).toMatchObject({ payload: { unavailable: true } });
  h.lifecycle.execute.mockResolvedValue(authoredResponse());
  h.deps.commitBranchResolution.mockReturnValueOnce(false);
  expect(await h.workflows.loadGraph(h.request())).toMatchObject({
    payload: { stale: true }
  });
  expect(
    await h.workflows.planGraph(
      h.request({ repo: "owner/repo", environment: "dev" })
    )
  ).toMatchObject({ payload: { reason: "EVIDENCE_MISMATCH" } });
  h.lifecycle.execute.mockRejectedValue(new Error("private external detail"));
  expect(await h.workflows.loadGraph(h.request())).toMatchObject({
    payload: { reason: "RESULT_UNAVAILABLE" }
  });
});
