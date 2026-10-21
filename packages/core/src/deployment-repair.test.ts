import { describe, expect, it } from "vitest";
import {
  resolveDeploymentRepairLoop,
  claimDeploymentRepairHandoff,
  settleDeploymentRepairHandoff,
  DEPLOY_HANDOFF_MAX_ATTEMPTS,
  DEPLOY_REPAIR_ATTEMPT_CAP,
  type DeploymentRepairState
} from "./deployment-repair.js";

function failed(
  changes: Partial<DeploymentRepairState> = {}
): DeploymentRepairState {
  return {
    deployAttempt: { id: "attempt-1" },
    deployGeneration: 1,
    deployStatus: "failed",
    ...changes
  };
}

const nonrepairable = [
  "branch-not-pushed",
  "dispatch-refused",
  "oidc-subject-missing",
  "oidc-subject-case-mismatch",
  "cloud-auth-drift",
  "run-unconfirmed"
];

describe("deployment repair admission", () => {
  it.each([undefined, null, 1, ""])(
    "keeps an unbound request %s a new manual deployment",
    (requested) => {
      expect(resolveDeploymentRepairLoop({}, requested)).toEqual({
        repairLoop: false,
        attemptId: "",
        repairAttempt: 0
      });
    }
  );

  it.each([{}, failed()])("rejects an absent or replaced attempt", (state) => {
    expect(resolveDeploymentRepairLoop(state, "old-attempt")).toMatchObject({
      repairLoop: false,
      attemptId: "",
      repairAttempt: 0,
      error: expect.stringContaining("no longer the current attempt")
    });
  });

  it.each([undefined, "pending", "in_progress", "complete"])(
    "refuses repair from %s without spending budget",
    (deployStatus) => {
      const state = failed({ deployStatus });
      const original = structuredClone(state);
      expect(resolveDeploymentRepairLoop(state, "attempt-1")).toMatchObject({
        repairLoop: false,
        repairAttempt: 0,
        error: expect.stringContaining(
          deployStatus === "in_progress" ? "still running" : "nothing to repair"
        )
      });
      expect(state).toEqual(original);
    }
  );

  it.each(nonrepairable)(
    "refuses non-model repair for %s",
    (deployErrorKind) => {
      const state = failed({ deployErrorKind });
      expect(resolveDeploymentRepairLoop(state, "attempt-1")).toMatchObject({
        repairLoop: false,
        attemptId: "",
        repairAttempt: 0,
        error: expect.stringContaining("without an attemptId")
      });
    }
  );

  it.each([undefined, "https://github.com/acme/app/actions/runs/42"])(
    "keeps uncertain-run guidance without treating absence of a link as a confirmed refusal",
    (deployRunUrl) => {
      const result = resolveDeploymentRepairLoop(
        failed({ deployErrorKind: "run-unconfirmed", deployRunUrl }),
        "attempt-1"
      );
      expect(result.error).toContain("may still be in flight");
      expect(result.error).toContain(
        deployRunUrl || "repository's Actions tab"
      );
    }
  );

  it.each([undefined, 0, DEPLOY_REPAIR_ATTEMPT_CAP - 1])(
    "admits the next repair after %s completed attempts",
    (deployRepairAttempts) => {
      expect(
        resolveDeploymentRepairLoop(
          failed({ deployRepairAttempts }),
          "attempt-1"
        )
      ).toEqual({
        repairLoop: true,
        attemptId: "attempt-1",
        repairAttempt: (deployRepairAttempts || 0) + 1
      });
    }
  );

  it.each([DEPLOY_REPAIR_ATTEMPT_CAP, DEPLOY_REPAIR_ATTEMPT_CAP + 1])(
    "refuses a repair after the five-attempt limit (%s)",
    (deployRepairAttempts) => {
      expect(
        resolveDeploymentRepairLoop(
          failed({ deployRepairAttempts }),
          "attempt-1"
        ).error
      ).toContain("already used its 5 automatic repair attempts");
    }
  );
});

describe("atomic repair handoff transitions", () => {
  it.each([
    { deployStatus: "in_progress" },
    { deployRepairing: true },
    { deployHandoffState: "pending" },
    { deployHandoffState: "failed" },
    { deployHandoffAttempts: DEPLOY_HANDOFF_MAX_ATTEMPTS },
    ...nonrepairable.map((deployErrorKind) => ({ deployErrorKind }))
  ])("refuses an ineligible handoff without mutation: %j", (changes) => {
    const state = failed(changes);
    const before = structuredClone(state);
    expect(claimDeploymentRepairHandoff(state)).toBeUndefined();
    expect(state).toEqual(before);
  });

  it("claims synchronously so concurrent consumers cannot deliver twice", () => {
    const state = failed();
    expect(claimDeploymentRepairHandoff(state)).toEqual({
      attemptId: "attempt-1",
      generation: 1,
      deliveryAttempt: 1
    });
    expect(claimDeploymentRepairHandoff(state)).toBeUndefined();
    expect(state.deployHandoffAttempts).toBe(1);
  });

  it("preserves the attempt-less legacy state contract", () => {
    const state: DeploymentRepairState = { deployStatus: "failed" };
    const claim = claimDeploymentRepairHandoff(state);
    if (!claim) throw new Error("Expected a delivery claim");
    expect(claim).toEqual({ attemptId: "", generation: 0, deliveryAttempt: 1 });
    expect(settleDeploymentRepairHandoff(state, claim, true)).toBe("delivered");
    expect(state.deployRepairing).toBe(true);
    expect(claimDeploymentRepairHandoff(state)).toBeUndefined();
  });

  it("bounds failed delivery independently of repair budget", () => {
    const state = failed({ deployRepairAttempts: 2 });
    for (let attempt = 1; attempt <= DEPLOY_HANDOFF_MAX_ATTEMPTS; attempt++) {
      const claim = claimDeploymentRepairHandoff(state);
      if (!claim) throw new Error("Expected a delivery claim");
      expect(claim.deliveryAttempt).toBe(attempt);
      expect(settleDeploymentRepairHandoff(state, claim, false)).toBe(
        attempt === DEPLOY_HANDOFF_MAX_ATTEMPTS ? "failed" : "retryable"
      );
      expect(state.deployRepairing).toBe(false);
    }
    expect(state.deployRepairAttempts).toBe(2);
    expect(claimDeploymentRepairHandoff(state)).toBeUndefined();
  });

  it.each([
    { deployAttempt: { id: "replacement" } },
    { deployAttempt: undefined },
    { deployGeneration: 2 },
    { deployGeneration: undefined },
    { deployHandoffState: "delivered" },
    { deployHandoffAttempts: 2 }
  ])("fences stale settlement without touching newer state: %j", (changes) => {
    const state = failed();
    const claim = claimDeploymentRepairHandoff(state);
    if (!claim) throw new Error("Expected a delivery claim");
    Object.assign(state, changes);
    const before = structuredClone(state);
    expect(settleDeploymentRepairHandoff(state, claim, true)).toBe("stale");
    expect(state).toEqual(before);
  });

  it("rejects replay of the same delivered callback", () => {
    const state = failed();
    const claim = claimDeploymentRepairHandoff(state);
    if (!claim) throw new Error("Expected a delivery claim");
    expect(settleDeploymentRepairHandoff(state, claim, true)).toBe("delivered");
    expect(settleDeploymentRepairHandoff(state, claim, false)).toBe("stale");
    expect(state.deployRepairing).toBe(true);
  });
});
