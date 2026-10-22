import { describe, expect, it } from "vitest";
import type { CanvasState } from "../shared.js";
import {
  beginDeployAttempt,
  deploymentStatusBlocksMutation,
  localDeploymentBlocksMutation,
  resolveDeploymentEnvironment
} from "./deployment-attempt.js";

describe("shared deployment attempt transitions", () => {
  const target = {
    repo: "fixture/app",
    environment: "dev",
    branch: "feature",
    provider: "azure",
    appFile: "model.bicep"
  };
  it("starts a fresh attempt with cleared evidence and independent delivery and repair budgets", () => {
    const state: CanvasState = {
      deployError: "previous failure",
      deployHandoffAttempts: 3,
      deployRepairAttempts: 5,
      deployNoticeState: "delivered",
      deployNoticeAttempts: 2,
      deployRunId: 42,
      deployRunUrl: "https://example.test/run",
      deployedGraph: []
    };
    beginDeployAttempt(state, { ...target, repairLoop: false });
    expect(state).toMatchObject({
      deployStatus: "in_progress",
      deployGeneration: 1,
      deployError: null,
      deployRunId: null,
      deployedGraph: null,
      deployHandoffState: "idle",
      deployNoticeState: "idle",
      deployNoticeAttempts: 0,
      deployRepairAttempts: 0,
      deployHandoffAttempts: 0,
      deployRepairing: false,
      deployAttempt: { targetRepo: target.repo, branch: target.branch }
    });
    expect(state.deployAttempt?.id).toBeTruthy();
  });
  it.each([undefined, 2])(
    "retains repair identity and budgets from %s attempts",
    (attempts) => {
      const state: CanvasState = {
        deployGeneration: 4,
        deployRepairAttempts: attempts,
        deployHandoffAttempts: attempts
      };
      beginDeployAttempt(state, {
        ...target,
        repairLoop: true,
        attemptId: "owned"
      });
      expect(state).toMatchObject({
        deployGeneration: 5,
        deployAttempt: { id: "owned" },
        deployRepairing: true,
        deployHandoffState: "delivered",
        deployHandoffAttempts: attempts || 0,
        deployRepairAttempts: (attempts || 0) + 1
      });
    }
  );
  it.each([
    "pending",
    "in_progress",
    "deleting",
    "complete",
    "failed",
    undefined
  ])("classifies mutation status %s", (status) => {
    expect(deploymentStatusBlocksMutation(status)).toBe(
      ["pending", "in_progress", "deleting"].includes(String(status))
    );
  });
  it("retains the legacy unowned-panel lease boundary", () => {
    expect(localDeploymentBlocksMutation({ deployStatus: "complete" })).toBe(
      false
    );
    expect(localDeploymentBlocksMutation({ deployStatus: "in_progress" })).toBe(
      true
    );
    const state: CanvasState = {
      deployStatus: "in_progress",
      deployStartedAt: 100
    };
    expect(localDeploymentBlocksMutation(state, 1800099)).toBe(true);
    expect(localDeploymentBlocksMutation(state, 1800100)).toBe(false);
  });
  it("prefers explicit environments and otherwise retains panel fallback", () => {
    expect(resolveDeploymentEnvironment({ envName: "old" }, "new")).toBe("new");
    expect(resolveDeploymentEnvironment({ envName: "old" }, null)).toBe("old");
    expect(resolveDeploymentEnvironment({}, "")).toBe("");
  });
});
