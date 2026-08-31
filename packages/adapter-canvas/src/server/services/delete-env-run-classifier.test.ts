import { describe, it, expect } from "vitest";
import { DELETE_ENV_GUARD_STEP_NAME } from "@radius-project/core";
import { classifyCompletedDeleteEnvRun } from "./delete-env-run-classifier.js";

describe("classifyCompletedDeleteEnvRun", () => {
  it("treats a success conclusion as a clean delete", () => {
    expect(classifyCompletedDeleteEnvRun("success", [])).toEqual({
      outcome: "deleted"
    });
  });

  it("reports apps_present when the guard step is the failure", () => {
    const result = classifyCompletedDeleteEnvRun("failure", [
      { name: "Register cloud credentials with Radius", conclusion: "success" },
      { name: DELETE_ENV_GUARD_STEP_NAME, conclusion: "failure" }
    ]);
    expect(result.outcome).toBe("apps_present");
    if (result.outcome === "apps_present") {
      expect(result.detail).toMatch(/Delete the application\(s\) first/);
    }
  });

  it("reports a generic failure when the guard step passed but the run failed", () => {
    const result = classifyCompletedDeleteEnvRun("failure", [
      { name: DELETE_ENV_GUARD_STEP_NAME, conclusion: "success" },
      { name: "Delete Radius resource", conclusion: "failure" }
    ]);
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.detail).toContain('conclusion "failure"');
    }
  });

  it("does not treat a skipped guard step as apps_present", () => {
    const result = classifyCompletedDeleteEnvRun("cancelled", [
      { name: DELETE_ENV_GUARD_STEP_NAME, conclusion: "skipped" }
    ]);
    expect(result.outcome).toBe("failed");
  });

  it("labels an unknown conclusion when none is provided", () => {
    const result = classifyCompletedDeleteEnvRun(null, []);
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.detail).toContain('conclusion "unknown"');
    }
  });
});
