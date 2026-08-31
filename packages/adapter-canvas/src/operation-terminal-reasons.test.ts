import { describe, expect, it } from "vitest";
import {
  CLEANUP_COMPLETE_REASON,
  isSetupDeletedReason,
  ROLLBACK_COMPLETE_REASON,
  SETUP_DELETED_REASONS,
  SETUP_EXITED_REASON
} from "./operation-terminal-reasons.js";

describe("operation terminal reasons", () => {
  it("identifies every setup deletion reason", () => {
    expect(SETUP_DELETED_REASONS).toEqual([
      ROLLBACK_COMPLETE_REASON,
      CLEANUP_COMPLETE_REASON
    ]);
    expect(SETUP_DELETED_REASONS.every(isSetupDeletedReason)).toBe(true);
  });

  it.each(["", SETUP_EXITED_REASON, "stopped-at-boundary"])(
    "does not classify %j as setup deletion",
    (reason) => {
      expect(isSetupDeletedReason(reason)).toBe(false);
    }
  );
});
