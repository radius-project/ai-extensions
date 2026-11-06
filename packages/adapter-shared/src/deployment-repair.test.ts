import { describe, expect, it } from "vitest";
import { createDeploymentDeferred } from "../test/support/deployment.js";
import { redactCredentials, type DeploymentState } from "@radius-project/core";
import {
  createDeploymentRepairCoordinator,
  type DeploymentRepairDependencies,
  type DeploymentRepairRequest
} from "./deployment-repair.js";

function fixture(overrides: Partial<DeploymentRepairDependencies> = {}) {
  const retries: (() => Promise<void>)[] = [];
  const diagnostics: string[] = [];
  const deliveries: unknown[] = [];
  const state: DeploymentState = {
    deployAttempt: { id: "loop" },
    deployGeneration: 1,
    deployStatus: "failed",
    deployError: "password=synthetic-value"
  };
  const request: DeploymentRepairRequest = {
    state,
    attemptId: "loop",
    generation: 1,
    repo: "example/app",
    branch: "feature",
    isCurrent: () => true
  };
  const coordinator = createDeploymentRepairCoordinator({
    sendRepair: (input) => {
      deliveries.push(input);
    },
    sendNotice: (input) => {
      deliveries.push(input);
    },
    redactDiagnostic: redactCredentials,
    reportDiagnostic: (message) => {
      diagnostics.push(message);
    },
    scheduleRetry: (identity, callback, delay) => {
      expect(identity).toEqual({ attemptId: "loop", generation: 1 });
      expect(delay).toBe(2000);
      retries.push(callback);
    },
    ...overrides
  });
  return { coordinator, request, state, retries, diagnostics, deliveries };
}

describe("explicit deployment repair coordination", () => {
  it("reports non-Error delivery rejection with absent optional diagnostics", async () => {
    const f = fixture({ sendRepair: () => Promise.reject("offline") });
    f.state.deployError = null;
    expect(await f.coordinator.coordinate(f.request)).toEqual({
      kind: "repair",
      status: "retryable"
    });
    expect(f.diagnostics).toEqual([
      "Deployment repair delivery failed: offline"
    ]);
    delete f.state.deployAttempt;
    expect(await f.coordinator.coordinate(f.request)).toEqual({
      status: "stale"
    });
  });

  it("delivers once and redacts before the host publication boundary", async () => {
    const f = fixture();
    expect(await f.coordinator.coordinate(f.request)).toEqual({
      kind: "repair",
      status: "delivered"
    });
    expect(await f.coordinator.coordinate(f.request)).toEqual({
      status: "ineligible"
    });
    expect(f.state.deployRepairing).toBe(true);
    expect(f.state.deployHandoffAttempts).toBe(1);
    expect(f.deliveries).toHaveLength(1);
    expect(JSON.stringify(f.deliveries)).not.toContain("synthetic-value");
    expect(f.deliveries[0]).toMatchObject({
      attemptId: "loop",
      branch: "feature"
    });
  });

  it("keeps unconfirmed notices separate and omits repair authority", async () => {
    const f = fixture();
    f.state.deployErrorKind = "run-unconfirmed";
    f.state.deployRunUrl = "https://github.com/example/app/actions/runs/1";
    f.request.instanceId = "view";
    expect(await f.coordinator.coordinate(f.request)).toEqual({
      kind: "notice",
      status: "delivered"
    });
    expect(f.deliveries[0]).not.toHaveProperty("attemptId");
    expect(f.deliveries[0]).toMatchObject({ instanceId: "view" });
    expect(f.state.deployRepairing).toBeUndefined();
    expect(f.state.deployNoticeAttempts).toBe(1);
  });

  it.each(["repair", "notice"] as const)(
    "reports absent %s capability without claiming delivery",
    async (kind) => {
      const f = fixture({ sendRepair: undefined, sendNotice: undefined });
      if (kind === "notice") f.state.deployErrorKind = "run-unconfirmed";
      expect(await f.coordinator.coordinate(f.request)).toEqual({
        kind,
        status: "unavailable"
      });
      expect(f.state.deployHandoffState).toBeUndefined();
      expect(f.state.deployNoticeState).toBeUndefined();
    }
  );

  it.each(["repair", "notice"] as const)(
    "bounds rejected %s delivery independently of repair deployments",
    async (kind) => {
      const fail = () => {
        throw new Error("password=rejected-value");
      };
      const f = fixture({ sendRepair: fail, sendNotice: fail });
      if (kind === "notice") f.state.deployErrorKind = "run-unconfirmed";
      expect(await f.coordinator.coordinate(f.request)).toEqual({
        kind,
        status: "retryable"
      });
      await f.retries[0]();
      await f.retries[1]();
      expect(f.retries).toHaveLength(2);
      expect(
        f.state[kind === "repair" ? "deployHandoffState" : "deployNoticeState"]
      ).toBe("failed");
      expect(
        f.state[
          kind === "repair" ? "deployHandoffAttempts" : "deployNoticeAttempts"
        ]
      ).toBe(3);
      expect(f.state.deployRepairAttempts).toBeUndefined();
      expect(f.diagnostics).toHaveLength(3);
      expect(f.diagnostics.join("")).not.toContain("rejected-value");
      expect(await f.coordinator.coordinate(f.request)).toEqual({
        status: "ineligible"
      });
    }
  );

  it("resumes a persisted exhausted budget without another send", async () => {
    const f = fixture();
    f.state.deployHandoffAttempts = 3;
    f.state.deployHandoffState = "retryable";
    expect(await f.coordinator.coordinate(f.request)).toEqual({
      kind: "repair",
      status: "failed"
    });
    expect(f.deliveries).toEqual([]);
  });

  it.each([true, false])(
    "fences old-generation delivery completion (rejection=%s)",
    async (reject) => {
      const delivery = createDeploymentDeferred<void>();
      const f = fixture({ sendRepair: () => delivery.promise });
      const result = f.coordinator.coordinate(f.request);
      expect(await f.coordinator.coordinate(f.request)).toEqual({
        status: "ineligible"
      });
      f.state.deployGeneration = 2;
      f.state.deployHandoffState = "pending";
      f.state.deployRepairing = true;
      if (reject) delivery.reject(new Error("old delivery"));
      else delivery.resolve();
      expect(await result).toEqual({ status: "stale" });
      expect(f.state.deployHandoffState).toBe("pending");
      expect(f.state.deployRepairing).toBe(true);
      expect(f.retries).toEqual([]);
    }
  );

  it("fences queued retries and retired identities", async () => {
    const f = fixture({
      sendRepair: () => Promise.reject(new Error("offline"))
    });
    await f.coordinator.coordinate(f.request);
    f.request.isCurrent = () => false;
    await f.retries[0]();
    expect(f.state.deployHandoffAttempts).toBe(1);
    expect(await f.coordinator.coordinate(f.request)).toEqual({
      status: "stale"
    });
    f.request.isCurrent = () => true;
    f.state.deployAttempt = { id: "replacement" };
    expect(await f.coordinator.coordinate(f.request)).toEqual({
      status: "stale"
    });
  });

  it("propagates a failed owner retry binding rather than claiming scheduling succeeded", async () => {
    const f = fixture({
      sendRepair: () => Promise.reject(new Error("offline")),
      scheduleRetry: () => {
        throw new Error("owner stopped");
      }
    });
    await expect(f.coordinator.coordinate(f.request)).rejects.toThrow(
      "owner stopped"
    );
    expect(f.state.deployHandoffState).toBe("retryable");
  });
});
