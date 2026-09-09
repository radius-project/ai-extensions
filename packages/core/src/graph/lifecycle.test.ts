import { describe, expect, it } from "vitest";
import {
  classifyLifecycleConclusion,
  lifecycleOutcomeMessage,
  stateSaveFailureWarning,
  unfinishedNodeMessage
} from "./lifecycle.js";
import type { LifecycleOutcome } from "./lifecycle.js";

describe("classifyLifecycleConclusion", () => {
  it.each([
    ["success", "succeeded"],
    ["succeeded", "succeeded"],
    ["SUCCESS", "succeeded"],
    ["  success  ", "succeeded"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
    ["timed_out", "timed_out"],
    ["timed-out", "timed_out"],
    ["timeout", "timed_out"],
    ["failure", "failed"],
    ["failed", "failed"],
    ["startup_failure", "failed"],
    ["action_required", "failed"],
    ["neutral", "failed"],
    ["skipped", "failed"],
    ["stale", "failed"]
  ] as const)("maps %s to %s", (conclusion, expected) => {
    expect(classifyLifecycleConclusion(conclusion)).toBe(expected);
  });

  it.each([undefined, null, "", "   "])(
    "reports an unobserved conclusion (%s) as unknown rather than succeeded",
    (conclusion) => {
      expect(classifyLifecycleConclusion(conclusion)).toBe("unknown");
    }
  );
});

describe("lifecycleOutcomeMessage", () => {
  it.each([
    ["succeeded", "Deployment succeeded", "Deletion succeeded"],
    ["failed", "Deployment failed", "Deletion failed"],
    ["cancelled", "Deployment cancelled", "Deletion cancelled"],
    ["timed_out", "Deployment timed out", "Deletion timed out"],
    ["unknown", "Deployment outcome unknown", "Deletion outcome unknown"]
  ] as const)(
    "renders %s for both operations",
    (outcome: LifecycleOutcome, deployment, deletion) => {
      expect(lifecycleOutcomeMessage("deployment", outcome)).toBe(deployment);
      expect(lifecycleOutcomeMessage("deletion", outcome)).toBe(deletion);
    }
  );
});

describe("unfinishedNodeMessage", () => {
  it("leaves a successful run with no per-node explanation", () => {
    expect(unfinishedNodeMessage("deployment", "succeeded")).toBeNull();
    expect(unfinishedNodeMessage("deletion", "succeeded")).toBeNull();
  });

  it.each([
    ["cancelled", "Deployment cancelled"],
    ["timed_out", "Deployment timed out"],
    ["failed", "Deployment failed"],
    ["unknown", "Deployment outcome unknown"]
  ] as const)("explains an unfinished node for %s", (outcome, expected) => {
    expect(unfinishedNodeMessage("deployment", outcome)).toBe(expected);
  });
});

describe("stateSaveFailureWarning", () => {
  it("names the consequence and the recovery path for a deployment", () => {
    const warning = stateSaveFailureWarning("deployment");

    expect(warning).toContain(
      "The deployment ran, but Radius could not save its state."
    );
    expect(warning).toContain("Orphaned cloud resources may exist.");
    expect(warning).toContain("redeploy the application");
    expect(warning).toContain("delete the deployment and redeploy it");
  });

  it("uses the deletion noun for a delete run", () => {
    expect(stateSaveFailureWarning("deletion")).toContain(
      "The deletion ran, but Radius could not save its state."
    );
  });

  it("appends a supplied detail block", () => {
    expect(stateSaveFailureWarning("deployment", "rad shutdown: exit 1")).toBe(
      `${stateSaveFailureWarning("deployment")}\n\nrad shutdown: exit 1`
    );
  });

  it.each([undefined, null, "", "   "])(
    "omits an empty detail (%s) rather than trailing blank lines",
    (detail) => {
      expect(stateSaveFailureWarning("deployment", detail)).toBe(
        stateSaveFailureWarning("deployment")
      );
    }
  );
});
