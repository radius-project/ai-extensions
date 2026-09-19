import { describe, expect, it } from "vitest";
import {
  activeDeploymentMutation,
  reserveDeploymentMutation,
  releaseDeploymentMutation,
  deploymentStatusBlocksMutation,
  localDeploymentBlocksMutation,
  DEPLOYMENT_MUTATION_LEASE_MS
} from "./mutation.js";
import type { DeploymentState } from "./types.js";

describe("deployment reservations", () => {
  it("reserves admission, refuses a duplicate and releases only the owning lease", () => {
    const state: DeploymentState = {};
    const target = {
      repo: "acme/app",
      environment: "dev",
      kind: "delete" as const
    };
    const lease = reserveDeploymentMutation(state, target, 10);
    expect(lease).toEqual({
      ...target,
      expiresAt: DEPLOYMENT_MUTATION_LEASE_MS + 10
    });
    expect(reserveDeploymentMutation(state, target, 11)).toBeNull();
    expect(activeDeploymentMutation(state, 12)).toBe(lease);
    releaseDeploymentMutation(state, { ...target, expiresAt: 12 });
    expect(state.deploymentMutation).toBe(lease);
    if (!lease) throw new Error("Expected reservation");
    releaseDeploymentMutation(state, lease);
    expect(activeDeploymentMutation(state, 12)).toBeUndefined();
  });

  it("expires at the exact deadline before admitting another operation", () => {
    const state: DeploymentState = {};
    const target = {
      repo: "acme/app",
      environment: "dev",
      kind: "deploy" as const
    };
    reserveDeploymentMutation(state, target, 0);
    expect(
      activeDeploymentMutation(state, DEPLOYMENT_MUTATION_LEASE_MS - 1)
    ).toBeDefined();
    expect(
      activeDeploymentMutation(state, DEPLOYMENT_MUTATION_LEASE_MS)
    ).toBeUndefined();
    expect(
      reserveDeploymentMutation(state, target, DEPLOYMENT_MUTATION_LEASE_MS)
    ).not.toBeNull();
  });

  it.each(["pending", "in_progress", "deleting"])(
    "blocks external status %s",
    (status) => {
      expect(deploymentStatusBlocksMutation(status)).toBe(true);
    }
  );
  it.each(["success", "delete-failed", null, 0])(
    "does not treat terminal status %s as running",
    (status) => {
      expect(deploymentStatusBlocksMutation(status)).toBe(false);
    }
  );
  it("holds a local operation with no start evidence and bounds known start times", () => {
    expect(localDeploymentBlocksMutation({}, 1)).toBe(false);
    expect(
      localDeploymentBlocksMutation({ deployStatus: "in_progress" }, 1)
    ).toBe(true);
    expect(
      localDeploymentBlocksMutation(
        { deployStatus: "in_progress", deployStartedAt: 0 },
        1
      )
    ).toBe(true);
    expect(
      localDeploymentBlocksMutation(
        { deployStatus: "in_progress", deployStartedAt: 0 },
        DEPLOYMENT_MUTATION_LEASE_MS
      )
    ).toBe(false);
  });
});
