import { describe, expect, it } from "vitest";
import { environmentSetupResult } from "./setup-result.js";

describe("environment setup outcomes", () => {
  it.each([
    [200, { success: true }, "completed"],
    [200, { success: true, actionRequired: true }, "action_required"],
    [200, { success: true, verifySkipped: true }, "action_required"],
    [409, { inputRequired: true }, "input_required"],
    [200, { cancelled: true }, "cancelled"],
    [202, { reconciling: true }, "reconciling"],
    [400, { error: "denied" }, "failed"],
    [200, {}, "failed"],
    [500, { success: true }, "failed"]
  ] as const)(
    "preserves status %s and payload %j with verdict %s",
    (status, body, outcome) => {
      const result = environmentSetupResult(status, body);
      expect(result).toEqual({ status, body, outcome });
      expect(result.body).toBe(body);
    }
  );
});
