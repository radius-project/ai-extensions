import { describe, expect, it } from "vitest";
import {
  createOperation,
  finish,
  requireInput,
  requestStop
} from "../operations.js";
import {
  projectEnvironmentOperation,
  projectEnvironmentVerification
} from "./environment-tool-result.js";

const redact = (value: string) =>
  value.replaceAll("opaque-private-value", "[redacted]");
const operation = () =>
  createOperation({
    operationId: "op-1",
    repo: "fixture/app",
    environment: "dev",
    provider: "azure"
  });

describe("allowlisted environment results", () => {
  it("omits pending Stop so clients cannot treat it as a new command", () => {
    const op = operation();
    requestStop(op);
    expect(projectEnvironmentOperation(op, redact).actions).not.toContain(
      "stop"
    );
  });
  it("exposes only operation identity, state and eligible actions", () => {
    const op = operation();
    op.request = { private: "opaque-private-value" };
    op.context = { githubLogin: "octocat", private: "opaque-private-value" };
    op.currentStage = "configure-environment";
    const value = projectEnvironmentOperation(op, redact);
    expect(value).toEqual({
      operationId: "op-1",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure",
      state: "running",
      terminal: false,
      stage: "configure-environment",
      actions: ["stop"]
    });
    expect(JSON.stringify(value)).not.toContain("opaque-private-value");
  });
  it("bounds redacted diagnostics and never exposes legacy failure evidence", () => {
    const op = operation();
    finish(op, "failed", {
      failure: {
        code: "test",
        message: `opaque-private-value ${"x".repeat(5000)}`,
        evidence: "never-return-this"
      }
    });
    const result = projectEnvironmentOperation(op, redact);
    expect(result.message).toHaveLength(4000);
    expect(result.message).toMatch(/^\[redacted\]/);
    expect(JSON.stringify(result)).not.toContain("never-return-this");
    expect(result.terminal).toBe(true);
  });
  it.each(["provider", "repo", "environment", "state"])(
    "rejects malformed saved %s",
    (key) => {
      const op = operation();
      op[key] = "";
      expect(() => projectEnvironmentOperation(op, redact)).toThrow(
        "valid environment"
      );
    }
  );
  it("refuses deletion operations and only offers supported live Azure prompts", () => {
    const op = operation();
    op.kind = "delete";
    expect(() => projectEnvironmentOperation(op, redact)).toThrow();
    op.kind = "create";
    requireInput(op, {
      code: "app-selection-required",
      checkpoint: "selection"
    });
    expect(projectEnvironmentOperation(op, redact).actions).toContain("resume");
    op.provider = "aws";
    expect(projectEnvironmentOperation(op, redact).actions).not.toContain(
      "resume"
    );
  });
  it.each([
    "pending",
    "in_progress",
    "success",
    "failed",
    "unknown",
    "expired"
  ])("preserves %s evidence without inventing run data", (state) => {
    expect(
      projectEnvironmentVerification({ state, logs: ["hidden"] }, redact)
    ).toEqual({ state });
  });
  it("allowlists run URLs and redacts before truncating observation errors", () => {
    expect(
      projectEnvironmentVerification(
        {
          state: "failed",
          runId: 42,
          runUrl: "https://github.com/fixture/app/actions/runs/42",
          error: "opaque-private-value",
          rawLogs: "private"
        },
        redact
      )
    ).toEqual({
      state: "failed",
      runId: "42",
      runUrl: "https://github.com/fixture/app/actions/runs/42",
      message: "[redacted]"
    });
    expect(
      projectEnvironmentVerification(
        {
          state: "unknown",
          runId: "not-a-run",
          runUrl: "https://other.example/private"
        },
        redact
      )
    ).toEqual({ state: "unknown" });
    expect(() =>
      projectEnvironmentVerification({ state: "complete" }, redact)
    ).toThrow("unsupported");
  });
});
