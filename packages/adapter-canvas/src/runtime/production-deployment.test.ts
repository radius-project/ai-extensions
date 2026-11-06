import { describe, expect, it, vi } from "vitest";
import { createProductionDeploymentRuntime } from "./production-deployment.js";

describe("Canvas deployment host composition", () => {
  it("constructs independent owners without opening a panel or issuing commands", async () => {
    const first = createProductionDeploymentRuntime({ awsEnabled: false });
    const second = createProductionDeploymentRuntime({ awsEnabled: false });
    try {
      expect(first.owner).not.toBe(second.owner);
      first.setDeployRepairHandoff(vi.fn());
      first.setDeployFailureNotice(vi.fn());
      first.setDeployRepairHandoff(null);
      first.setDeployFailureNotice(null);
      expect(await first.start({})).toMatchObject({ ok: false, status: 400 });
      expect(first.owner.hasActiveWork()).toBe(false);
      expect(second.owner.hasActiveWork()).toBe(false);
    } finally {
      expect(await first.owner.shutdown(0)).toEqual({
        complete: true,
        pending: []
      });
      expect(await second.owner.shutdown(0)).toEqual({
        complete: true,
        pending: []
      });
    }
  });
});
