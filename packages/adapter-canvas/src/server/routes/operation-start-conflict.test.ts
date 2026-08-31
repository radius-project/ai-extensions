import { describe, expect, it } from "vitest";
import { setupStartConflictResponse } from "./operation-start-conflict.js";

describe("setup start conflict response", () => {
  it("describes a setup already in progress", () => {
    expect(
      setupStartConflictResponse("octo/app", {
        conflict: { operationId: "op-running" }
      })
    ).toEqual({
      error: "Setup is already running for octo/app.",
      code: "operation-in-progress",
      operationId: "op-running"
    });
  });

  it("describes cleanup that must finish before setup restarts", () => {
    expect(
      setupStartConflictResponse("octo/app", {
        reason: "previous-cleanup-required",
        conflict: { operationId: "op-cleanup" }
      })
    ).toEqual({
      error:
        "An earlier setup for octo/app must finish deletion before a new setup can start.",
      code: "previous-cleanup-required",
      operationId: "op-cleanup"
    });
  });
});
