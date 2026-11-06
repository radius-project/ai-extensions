import { describe, expect, it } from "vitest";
import {
  classifyDeployDispatchFailure,
  deploymentHandoffEligible,
  deploymentNoticeEligible,
  resolveDeployRepairLoop,
  shouldRetryWithKeyringCredential
} from "./deployment-policy.js";
import type { DeploymentErrorKind, DeploymentState } from "./deployment.js";

const failure: DeploymentState = {
  deployAttempt: { id: "loop" },
  deployStatus: "failed"
};

describe("deployment repair policy", () => {
  it.each<DeploymentErrorKind>([
    "branch-not-pushed",
    "oidc-subject-missing",
    "oidc-subject-case-mismatch",
    "cloud-auth-drift",
    "run-unconfirmed"
  ])(
    "preserves the distinct handoff and explicit admission rules for %s",
    (kind) => {
      const state = { ...failure, deployErrorKind: kind };
      expect(deploymentHandoffEligible(state)).toBe(false);
      expect(resolveDeployRepairLoop(state, "loop").repairLoop).toBe(
        kind !== "run-unconfirmed"
      );
      expect(deploymentNoticeEligible(state)).toBe(kind === "run-unconfirmed");
    }
  );

  it.each(["idle", "retryable", "delivered", undefined])(
    "admits an unowned confirmed failure with handoff state %s",
    (deployHandoffState) => {
      expect(
        deploymentHandoffEligible({ ...failure, deployHandoffState })
      ).toBe(true);
    }
  );

  it.each<Partial<DeploymentState>>([
    { deployStatus: "in_progress" },
    { deployStatus: "complete" },
    { deployStatus: undefined },
    { deployRepairing: true },
    { deployHandoffState: "pending" },
    { deployHandoffState: "failed" }
  ])("refuses automatic repair while owned or nonterminal: %j", (fields) => {
    expect(deploymentHandoffEligible({ ...failure, ...fields })).toBe(false);
  });

  it.each(["pending", "delivered", "failed"])(
    "does not repeat an informational notice in state %s",
    (deployNoticeState) => {
      expect(
        deploymentNoticeEligible({
          ...failure,
          deployErrorKind: "run-unconfirmed",
          deployNoticeState
        })
      ).toBe(false);
    }
  );

  it("does not treat running observation or confirmed failure as a notice", () => {
    expect(deploymentNoticeEligible(failure)).toBe(false);
    expect(
      deploymentNoticeEligible({
        deployStatus: "in_progress",
        deployErrorKind: "run-unconfirmed"
      })
    ).toBe(false);
  });

  it.each([undefined, null, 42, ""])(
    "leaves unbound %s calls outside repair",
    (id) => {
      expect(resolveDeployRepairLoop(failure, id)).toEqual({
        repairLoop: false,
        attemptId: "",
        repairAttempt: 0
      });
    }
  );

  it("rejects missing and superseded attempts without choosing another", () => {
    expect(resolveDeployRepairLoop({}, "loop").error).toContain("no longer");
    expect(resolveDeployRepairLoop(failure, "other").error).toContain(
      "no longer"
    );
  });

  it.each(["pending", "in_progress", "complete", undefined])(
    "refuses a repair against %s",
    (deployStatus) => {
      const decision = resolveDeployRepairLoop(
        { ...failure, deployStatus },
        "loop"
      );
      expect(decision.repairLoop).toBe(false);
      expect(decision.error).toContain(
        deployStatus === "in_progress" ? "still running" : (
          "not in a failed state"
        )
      );
    }
  );

  it.each(["", "https://github.com/example/repo/actions/runs/1"])(
    "includes actionable unconfirmed evidence %s",
    (deployRunUrl) => {
      const decision = resolveDeployRepairLoop(
        {
          ...failure,
          deployErrorKind: "run-unconfirmed",
          deployRunUrl
        },
        "loop"
      );
      expect(decision.error).toContain(deployRunUrl || "Actions tab");
      expect(decision.error).toContain("run may still be in flight");
    }
  );

  it("keeps the five-deploy budget separate from the three delivery attempts", () => {
    expect(resolveDeployRepairLoop(failure, "loop").repairAttempt).toBe(1);
    expect(
      resolveDeployRepairLoop(
        {
          ...failure,
          deployRepairAttempts: 4,
          deployHandoffAttempts: 3
        },
        "loop"
      )
    ).toEqual({ repairLoop: true, attemptId: "loop", repairAttempt: 5 });
    expect(
      resolveDeployRepairLoop(
        {
          ...failure,
          deployRepairAttempts: 5
        },
        "loop"
      ).error
    ).toContain("5 automatic repair attempts");
  });
});

describe("dispatch uncertainty and credential policy", () => {
  it.each([
    "No ref found",
    "Could not resolve branch",
    "No commit found for the ref"
  ])("classifies an explicit branch refusal: %s", (stderr) => {
    expect(classifyDeployDispatchFailure(stderr)).toBe("branch-not-pushed");
  });
  it.each(["", "HTTP 404", "connection closed", "missing workflow scope"])(
    "does not claim a confirmed remote outcome for %s",
    (stderr) => {
      expect(classifyDeployDispatchFailure(stderr)).toBe("run-unconfirmed");
    }
  );
  it.each([
    {
      stderr: "missing workflow scope",
      hasInjectedToken: true,
      expected: true
    },
    {
      stderr: "missing workflow scope",
      hasInjectedToken: false,
      expected: false
    },
    {
      stderr: "missing workflow scope",
      hasInjectedToken: true,
      timedOut: true,
      expected: false
    },
    { stderr: "HTTP 404", hasInjectedToken: true, expected: false },
    { hasInjectedToken: true, expected: false }
  ])(
    "permits only proven missing-scope fallback: %j",
    ({ expected, ...input }) => {
      expect(shouldRetryWithKeyringCredential(input)).toBe(expected);
    }
  );
});
