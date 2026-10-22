import { describe, expect, it } from "vitest";
import { successfulSelectedGhExecutor } from "../../../test/support/server/selected-gh.js";
import {
  createDeploymentExecutionOwner,
  type DeploymentInvocation
} from "../../runtime/deployment-execution-owner.js";
import type { CanvasState } from "../../shared.js";
import { createWorkflowObservationScope } from "./workflow-observation-scope.js";
import { createDeploymentPresentation } from "./deployment-presentation.js";

const TARGET = {
  repo: "fixture/app",
  environment: "dev",
  branch: "feature/model",
  provider: "azure",
  appFile: ".radius/app.bicep",
  githubLogin: "fixture-user"
};

function fixture() {
  let nextId = 0;
  const owner = createDeploymentExecutionOwner({
    now: () => 0,
    newAttemptId: () => `attempt-${++nextId}`,
    reportError: (error) => {
      throw error;
    },
    createObservation: () =>
      createWorkflowObservationScope(() => {
        throw new Error("Unexpected artifact read");
      })
  });
  const begin = (
    state: CanvasState = {},
    target = TARGET,
    previous?: DeploymentInvocation
  ) => {
    const reservation = owner.reserve(target, "deploy");
    if (!reservation) throw new Error("Expected reservation");
    const result = owner.begin({
      reservation,
      target,
      previous,
      repair: Boolean(previous),
      state,
      executor: successfulSelectedGhExecutor({
        login: target.githubLogin,
        run: async () => {
          throw new Error("Unexpected GitHub command");
        }
      })
    });
    if (result.kind !== "resolved") throw new Error(result.kind);
    owner.release(reservation);
    return result.invocation;
  };
  const panel = (): CanvasState => ({
    contextRepo: TARGET.repo,
    contextBranch: TARGET.branch,
    envName: TARGET.environment
  });
  return {
    owner,
    begin,
    panel,
    presentation: createDeploymentPresentation(owner)
  };
}

describe("optional deployment presentation", () => {
  it("projects detached dispatch evidence without aliasing and clears it for the replacement invocation", () => {
    const { owner, begin, panel, presentation } = fixture();
    const invocation = begin({
      deployDispatchEvidence: "uncertain",
      deployDispatchReference: {
        repo: TARGET.repo,
        branch: TARGET.branch,
        environment: TARGET.environment,
        workflowFile: "run-rad-commands.yml",
        dispatchedAt: 100,
        baselineRunId: 41
      }
    });
    const state = panel();
    presentation.synchronize("panel", state);
    const execution = owner.execution(invocation);
    expect(state.deployDispatchEvidence).toBe("uncertain");
    expect(state.deployDispatchReference).toEqual(
      execution?.state.deployDispatchReference
    );
    expect(state.deployDispatchReference).not.toBe(
      execution?.state.deployDispatchReference
    );
    const replacement = begin({}, TARGET, invocation);
    expect(state.deployGeneration).toBe(replacement.generation);
    expect(state.deployDispatchReference).toBeUndefined();
    expect(state.deployDispatchEvidence).toBeUndefined();
    presentation.dispose();
    owner.shutdown();
  });

  it("attaches an explicitly admitted target without relabeling the panel selection", () => {
    const { owner, begin, presentation } = fixture();
    const first = begin({ deployStatus: "in_progress", deployLogs: [] });
    const state: CanvasState = {
      contextRepo: "fixture/another",
      contextBranch: "other",
      envName: "staging"
    };
    presentation.attach("panel", state, first);
    expect(state.deployAttempt?.id).toBe(first.attemptId);
    expect(state.contextRepo).toBe("fixture/another");
    expect(state.contextBranch).toBe("other");
    expect(state.envName).toBe("staging");
    presentation.synchronize("panel", state);
    owner.appendLog(first, "owned");
    expect(state.deployLogs).toEqual(["owned"]);
    const repaired = begin(
      { deployStatus: "in_progress", deployLogs: ["repair"] },
      TARGET,
      first
    );
    expect(state.deployGeneration).toBe(repaired.generation);
    expect(state.deployLogs).toEqual(["repair"]);
    state.contextBranch = "new-selection";
    owner.publish(repaired);
    expect(state.deployAttempt).toBeUndefined();
    expect(presentation.owns(state)).toBe(false);
    expect(owner.execution(repaired)?.observation.stopped).toBe(false);
  });

  it("uses provider and application file to resolve otherwise ambiguous contexts", () => {
    const { begin, panel, presentation } = fixture();
    begin();
    begin({}, { ...TARGET, provider: "aws" });
    const selected = begin(
      { deployStatus: "complete" },
      { ...TARGET, appFile: "other.bicep" }
    );
    const state = {
      ...panel(),
      appFile: "other.bicep",
      plannedProvider: "azure"
    };
    presentation.synchronize("panel", state);
    expect(state.deployAttempt?.id).toBe(selected.attemptId);
    expect(state.deployStatus).toBe("complete");
  });

  it("does not project a retired or stopped explicit invocation", () => {
    const { owner, begin, presentation } = fixture();
    const first = begin({ deployStatus: "failed" });
    const replacement = begin({ deployStatus: "complete" });
    const state: CanvasState = {};
    presentation.attach("panel", state, first);
    expect(state).toEqual({});
    owner.shutdown();
    presentation.attach("panel", state, replacement);
    expect(state).toEqual({});
  });

  it("clears an explicit attachment when a later poll observes shutdown", () => {
    const { owner, begin, presentation } = fixture();
    const invocation = begin({ deployStatus: "in_progress" });
    const state: CanvasState = {};
    presentation.attach("panel", state, invocation);
    owner.shutdown();
    presentation.synchronize("panel", state);
    expect(state.deployAttempt).toBeUndefined();
    expect(presentation.owns(state)).toBe(false);
  });

  it("projects isolated deployment fields without copying workspace, setup, or reservation state", () => {
    const { owner, begin, panel, presentation } = fixture();
    const invocation = begin({
      deployStatus: "in_progress",
      deployLogs: ["started"],
      deployingResources: [{ name: "api" }],
      workspacePath: "execution-workspace",
      setupOperationId: "setup-execution",
      envName: "not-presentation",
      deploymentMutation: { ...TARGET, kind: "deploy", expiresAt: 99 }
    });
    const state = {
      ...panel(),
      workspacePath: "view-workspace",
      deployError: "previous"
    };
    presentation.synchronize("panel", state);
    expect(presentation.owns(state)).toBe(true);
    expect(presentation.owns(panel())).toBe(false);
    expect(state.deployStatus).toBe("in_progress");
    expect(state.deployError).toBeUndefined();
    expect(state.workspacePath).toBe("view-workspace");
    expect(state.envName).toBe("dev");
    expect(state).not.toHaveProperty("setupOperationId");
    expect(state.deploymentMutation).toBeUndefined();
    state.deployLogs?.push("view-only");
    state.deployingResources?.push({ name: "view-only" });
    expect(owner.snapshot(invocation)?.deployLogs).toEqual(["started"]);
    expect(owner.snapshot(invocation)?.deployingResources).toEqual([
      { name: "api" }
    ]);
  });

  it("refreshes unchanged attachments from authoritative state without opening another execution", () => {
    const { owner, begin, panel, presentation } = fixture();
    const invocation = begin({ deployStatus: "in_progress" });
    const state = panel();
    presentation.synchronize("panel", state);
    const execution = owner.execution(invocation);
    if (!execution) throw new Error("Expected execution");
    execution.state.deployStatus = "complete";
    presentation.synchronize("panel", state);
    expect(state.deployStatus).toBe("complete");
    expect(owner.execution(invocation)).toBe(execution);
    expect(owner.resolve()).toEqual({ kind: "resolved", invocation });
  });

  it("detaches and reopens presentation without stopping shared execution", () => {
    const { owner, begin, panel, presentation } = fixture();
    const invocation = begin({ deployLogs: [] });
    const first = panel();
    presentation.synchronize("panel", first);
    presentation.detach("panel");
    presentation.detach("panel");
    owner.appendLog(invocation, "after close");
    expect(first.deployLogs).toEqual([]);
    expect(owner.execution(invocation)?.observation.stopped).toBe(false);
    const reopened = panel();
    presentation.synchronize("panel", reopened);
    expect(reopened.deployLogs).toEqual(["after close"]);
  });

  it("replaces an attachment's state object and never updates the replaced panel", () => {
    const { owner, begin, panel, presentation } = fixture();
    const invocation = begin({ deployLogs: [] });
    const first = panel();
    const replacement = panel();
    presentation.synchronize("panel", first);
    presentation.synchronize("panel", replacement);
    owner.appendLog(invocation, "latest");
    expect(first.deployLogs).toEqual([]);
    expect(replacement.deployLogs).toEqual(["latest"]);
  });

  it("accepts a matching snapshot but does not replace another entry's independent attempt", () => {
    const { owner, begin, panel, presentation } = fixture();
    const invocation = begin({ deployStatus: "complete", deployLogs: ["old"] });
    const snapshot: CanvasState = { ...panel(), ...owner.snapshot(invocation) };
    presentation.synchronize("panel", snapshot);
    expect(presentation.owns(snapshot)).toBe(true);
    const independent: CanvasState = {
      ...panel(),
      deployAttempt: { id: "new-manual" },
      deployStatus: "in_progress"
    };
    presentation.synchronize("panel", independent);
    owner.appendLog(invocation, "after replacement");
    expect(independent.deployStatus).toBe("in_progress");
    expect(independent.deployAttempt?.id).toBe("new-manual");
    expect(snapshot.deployLogs).toEqual(["old"]);
    expect(presentation.owns(snapshot)).toBe(false);
    expect(presentation.owns(independent)).toBe(false);
  });

  it("inherits repair generations and clears prior error and graph projections", () => {
    const { owner, begin, panel, presentation } = fixture();
    const first = begin({
      deployStatus: "failed",
      deployError: "previous failure",
      deployedGraph: [{ name: "previous" }]
    });
    const state = panel();
    presentation.synchronize("panel", state);
    const repaired = begin({ deployStatus: "in_progress" }, TARGET, first);
    expect(repaired.attemptId).toBe(first.attemptId);
    expect(state.deployGeneration).toBe(repaired.generation);
    expect(state.deployStatus).toBe("in_progress");
    expect(state.deployError).toBeUndefined();
    expect(state.deployedGraph).toBeUndefined();
    owner.appendLog(first, "stale");
    presentation.synchronize("panel", state);
    expect(state.deployLogs).toBeUndefined();
  });

  it.each([
    {},
    { contextRepo: TARGET.repo },
    { contextRepo: "fixture/other", envName: "dev" },
    { contextRepo: TARGET.repo, envName: "dev", appFile: "another.bicep" },
    { contextRepo: TARGET.repo, envName: "dev", plannedProvider: "aws" }
  ])(
    "does not guess an attachment from missing or mismatched context %j",
    (state) => {
      const { begin, presentation } = fixture();
      begin({ deployStatus: "in_progress" });
      presentation.synchronize("panel", state);
      expect(state).not.toHaveProperty("deployAttempt");
    }
  );

  it("respects planned selection and refuses ambiguous branch context", () => {
    const { begin, presentation } = fixture();
    begin({ deployStatus: "failed" });
    const second = begin(
      { deployStatus: "complete" },
      { ...TARGET, branch: "other" }
    );
    const state: CanvasState = {
      plannedRepo: TARGET.repo,
      plannedEnvironment: "dev"
    };
    presentation.synchronize("panel", state);
    expect(state.deployAttempt).toBeUndefined();
    state.plannedBranch = "other";
    presentation.synchronize("panel", state);
    expect(state.deployAttempt?.id).toBe(second.attemptId);
    expect(state.deployStatus).toBe("complete");
  });

  it("fences publications after selection changes, including another known attempt", () => {
    const { owner, begin, panel, presentation } = fixture();
    const first = begin({ deployLogs: [] });
    begin({ deployLogs: ["different"] }, { ...TARGET, environment: "staging" });
    const state = panel();
    presentation.synchronize("panel", state);
    state.envName = "staging";
    owner.appendLog(first, "old selection");
    expect(state.deployLogs).toBeUndefined();
    expect(state.deployStatus).toBeUndefined();
    expect(state.deployAttempt).toBeUndefined();
    expect(presentation.owns(state)).toBe(false);
    presentation.synchronize("panel", state);
    expect(state.deployLogs).toEqual(["different"]);
    state.envName = "unknown";
    const selected = owner.resolve({ environment: "staging" });
    if (selected.kind !== "resolved") throw new Error(selected.kind);
    owner.appendLog(selected.invocation, "no longer selected");
    expect(state.deployLogs).toBeUndefined();
  });

  it("clears a detached projection but preserves a replacement's independently owned state", () => {
    const { begin, panel, presentation } = fixture();
    begin({ deployStatus: "in_progress" });
    const state = panel();
    presentation.synchronize("panel", state);
    state.envName = "staging";
    presentation.synchronize("panel", state);
    expect(state.deployStatus).toBeUndefined();
    state.envName = "dev";
    presentation.synchronize("panel", state);
    state.deployAttempt = { id: "independent-attempt" };
    state.deployStatus = "pending";
    expect(presentation.owns(state)).toBe(false);
    presentation.synchronize("panel", {});
    expect(state.deployAttempt?.id).toBe("independent-attempt");
    expect(state.deployStatus).toBe("pending");
  });

  it.each([
    { change: "attempt", update: "publish" },
    { change: "generation", update: "publish" },
    { change: "attempt", update: "synchronize" },
    { change: "generation", update: "synchronize" }
  ])(
    "preserves an independent $change replacement through $update and later polling",
    ({ change, update }) => {
      const { owner, begin, panel, presentation } = fixture();
      const invocation = begin({
        deployStatus: "complete",
        deployLogs: ["old"]
      });
      const state = panel();
      presentation.synchronize("panel", state);
      if (change === "attempt")
        state.deployAttempt = { id: "new-manual-attempt" };
      else state.deployGeneration = invocation.generation + 1;
      state.deployStatus = "in_progress";
      state.deployLogs = ["new"];
      const replacement = structuredClone(state);
      if (update === "publish") owner.publish(invocation);
      else presentation.synchronize("panel", state);
      presentation.synchronize("panel", state);
      owner.appendLog(invocation, "late old publication");
      presentation.synchronize("panel", state);
      expect(state).toEqual(replacement);
      expect(presentation.owns(state)).toBe(false);
      expect(owner.execution(invocation)?.observation.stopped).toBe(false);
    }
  );

  it("uses graph branch selection and disposes all panels idempotently", () => {
    const { owner, begin, panel, presentation } = fixture();
    const invocation = begin({ deployLogs: [] });
    const first = {
      ...panel(),
      contextBranch: undefined,
      graphBranch: TARGET.branch
    };
    const second = panel();
    presentation.synchronize("first", first);
    presentation.synchronize("second", second);
    presentation.dispose();
    presentation.dispose();
    owner.appendLog(invocation, "after disposal");
    expect(first.deployLogs).toEqual([]);
    expect(second.deployLogs).toEqual([]);
    owner.shutdown();
    presentation.synchronize("first", first);
    expect(first.deployLogs).toEqual([]);
  });
});
