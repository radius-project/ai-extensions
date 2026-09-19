import { describe, expect, it } from "vitest";
import {
  createOperation,
  fromPersistedOperation,
  toPersistedOperation
} from "./operations.js";
import { findExactVerificationRun } from "./verification-run-identity.js";

describe("verification identity persistence boundary", () => {
  it.each([true, false])(
    "preserves an exact pre-dispatch marker (recorded: %s)",
    (recorded) => {
      const operation = createOperation({
        operationId: "op_verify",
        provider: "azure",
        repo: "octo/app",
        environment: "dev"
      });
      operation.verification = {
        dispatchedAt: Date.parse("2026-08-22T00:00:00Z"),
        workflow: "radius-verify-credentials.yml",
        ref: "main",
        environment: "dev",
        baselineRunId: 40,
        runId: null,
        runUrl: null,
        ...(recorded ?
          { event: "workflow_dispatch", operationMarker: "op_verify" }
        : {})
      };
      const restored = fromPersistedOperation(toPersistedOperation(operation));
      expect(restored.verification.operationMarker).toBe(
        recorded ? "op_verify" : undefined
      );
      expect(restored.verification.event).toBe(
        recorded ? "workflow_dispatch" : undefined
      );
      expect(restored.verification.runId).toBeNull();
      expect(
        findExactVerificationRun(
          [
            {
              databaseId: 41,
              createdAt: "2026-08-22T00:00:01Z",
              displayTitle: "Radius verify dev [op_verify]",
              event: "workflow_dispatch",
              headBranch: "main"
            }
          ],
          {
            ...restored.verification,
            event: "workflow_dispatch",
            operationMarker: restored.verification.operationMarker || ""
          }
        )
      ).toEqual(
        recorded ? { state: "applied", runId: "41" } : { state: "not_found" }
      );
    }
  );
});
