import { expect, it } from "vitest";
import { portForbidden } from "@radius-project/core/lifecycle";
import {
  authoredResponse,
  graphFailure,
  graphWorkflowHarness,
  scriptGraphDiff
} from "../../../test/support/canonical-graphs.js";
import { createGraphPlanningWorkflows } from "./graph-workflows.js";

const body = {
  repo: "owner/repo",
  branch: "feature",
  environment: "dev",
  base: "main",
  head: "feature"
};
it.each(["loadGraph", "planGraph", "diffBranches"] as const)(
  "preserves 400 for external %s failures and 409 for superseded rejection",
  async (method) => {
    const h = graphWorkflowHarness();
    h.remote();
    h.lifecycle.execute.mockResolvedValue(graphFailure("FORBIDDEN"));
    expect(await h.workflows[method](h.request(body))).toMatchObject({
      kind: "json",
      status: 400,
      payload: { unavailable: true, reason: "FORBIDDEN" }
    });
    h.lifecycle.execute.mockRejectedValue(
      new Error("private compiler diagnostic")
    );
    const failed = await h.workflows[method](h.request(body));
    expect(failed).toMatchObject({
      status: 400,
      payload: { reason: "RESULT_UNAVAILABLE" }
    });
    expect(JSON.stringify(failed)).not.toContain("private compiler diagnostic");
    h.lifecycle.execute.mockImplementation(async () => {
      h.state.contextBranch = "superseded";
      throw new Error("late failure");
    });
    expect(await h.workflows[method](h.request(body))).toEqual({
      kind: "json",
      status: 409,
      payload: { stale: true }
    });
  }
);
it.each(["loadGraph", "planGraph"] as const)(
  "retains the branch-unavailable 409 response on %s",
  async (method) => {
    const h = graphWorkflowHarness();
    h.deps.resolveBranchForRequest.mockResolvedValue({
      status: "unavailable",
      error: "Restore the worktree branch."
    });
    expect(await h.workflows[method](h.request(body))).toEqual({
      kind: "json",
      status: 409,
      payload: {
        error: "Restore the worktree branch.",
        workspaceBranchUnavailable: true,
        repo: "owner/repo"
      }
    });
    expect(h.lifecycle.execute).not.toHaveBeenCalled();
  }
);
it("fences a request superseded while resolving its worktree branch", async () => {
  const h = graphWorkflowHarness();
  h.deps.resolveBranchForRequest.mockImplementation(async () => {
    const workspaceSnapshot = {
      workspaceBranch: h.state.workspaceBranch,
      contextBranch: h.state.contextBranch
    };
    h.state.contextBranch = "new-selection";
    return {
      status: "resolved",
      branch: "feature",
      followsWorkspaceBranch: true,
      workspaceSnapshot
    };
  });
  expect(await h.workflows.loadGraph(h.request(body))).toMatchObject({
    status: 409,
    payload: { stale: true }
  });
  expect(h.lifecycle.execute).not.toHaveBeenCalled();
});
it("fences a remote selection replaced while resolving a commit", async () => {
  const h = graphWorkflowHarness();
  h.lifecycle.resolveCommittedSource.mockImplementation(async () => {
    h.replace();
    return portForbidden();
  });
  expect(
    await h.workflows.loadGraph(h.request({ ...body, branch: "remote" }))
  ).toMatchObject({ status: 409, payload: { stale: true } });
  expect(h.lifecycle.execute).not.toHaveBeenCalled();
});
it("fences an independently invalidated planned generation", async () => {
  const h = graphWorkflowHarness();
  h.lifecycle.execute.mockImplementation(async () => {
    h.deps.beginPlannedGraphRequest(h.state);
    return graphFailure();
  });
  expect(await h.workflows.planGraph(h.request(body))).toMatchObject({
    status: 409,
    payload: { stale: true }
  });
});
it("accepts the real instance-bound reader and rejects a missing committed-source dependency", async () => {
  const h = graphWorkflowHarness();
  const workflows = createGraphPlanningWorkflows({
    ...h.deps,
    lifecycle: (entry) => {
      expect(entry.state).toBe(h.state);
      return h.lifecycle;
    }
  });
  scriptGraphDiff(h.lifecycle, [], body.repo, [body.base, body.head]);
  expect(await workflows.diffBranches(h.request(body))).toMatchObject({
    status: 200,
    payload: { resources: [] }
  });
  Reflect.set(h.lifecycle, "resolveCommittedSource", undefined);
  expect(() => createGraphPlanningWorkflows(h.deps)).toThrow(
    "canonical lifecycle"
  );
});
it("uses context fallback only for the same attached workspace", async () => {
  const h = graphWorkflowHarness();
  delete h.state.workspaceRepo;
  delete h.state.workspaceBranch;
  h.lifecycle.execute.mockResolvedValue(authoredResponse());
  expect(await h.workflows.loadGraph(h.request(body))).toMatchObject({
    status: 200
  });
  expect(h.lifecycle.resolveCommittedSource).not.toHaveBeenCalled();
  h.state.workspacePath = undefined;
  h.remote();
  expect(await h.workflows.loadGraph(h.request(body))).toMatchObject({
    status: 200
  });
  expect(h.lifecycle.resolveCommittedSource).toHaveBeenCalledWith(
    body.repo,
    body.branch
  );
});
it.each([[], false, 42])(
  "rejects non-object request %j without source I/O",
  async (value) => {
    const h = graphWorkflowHarness();
    expect(await h.workflows.loadGraph(h.request(value))).toMatchObject({
      status: 400
    });
    expect(h.lifecycle.execute).not.toHaveBeenCalled();
  }
);
it.each([
  ["DEFINITION_NOT_FOUND", 200],
  ["SOURCE_CHANGED", 409],
  ["RESULT_UNAVAILABLE", 400],
  ["SOURCE_UNAVAILABLE", 400],
  ["CAPABILITY_UNAVAILABLE", 400],
  ["EVIDENCE_MISMATCH", 400]
] as const)(
  "maps %s to HTTP %s without inventing resources",
  async (code, status) => {
    const h = graphWorkflowHarness();
    h.lifecycle.execute.mockResolvedValue(graphFailure(code));
    const response = await h.workflows.loadGraph(h.request(body));
    expect(response).toMatchObject({
      status,
      payload: { unavailable: true, reason: code }
    });
    expect(response.payload).not.toHaveProperty("resources");
  }
);
