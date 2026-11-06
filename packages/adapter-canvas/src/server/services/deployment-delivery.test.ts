import { describe, expect, it, vi } from "vitest";
import { createDeploymentDelivery } from "./deployment-delivery.js";
import { createDeferred } from "../../../test/support/browser/fakes.js";

const notice = {
  repo: "acme/app",
  branch: "feature",
  error: "Model failed",
  deployRunUrl: "https://github.com/acme/app/actions/runs/42",
  instanceId: ""
};
const repair = { ...notice, attemptId: "attempt:one" };

describe("runtime-owned deployment delivery", () => {
  it("fails explicitly before handlers are registered or after they are removed", () => {
    const delivery = createDeploymentDelivery();
    expect(() => delivery.ports.sendRepair(repair)).toThrow("unavailable");
    expect(() => delivery.ports.sendNotice(notice)).toThrow("unavailable");
    delivery.setDeployRepairHandoff(() => "repair-message");
    delivery.setDeployFailureNotice(() => "notice-message");
    expect(delivery.ports.sendRepair(repair)).toBe("repair-message");
    expect(delivery.ports.sendNotice(notice)).toBe("notice-message");
    delivery.setDeployRepairHandoff(null);
    delivery.setDeployFailureNotice(null);
    expect(() => delivery.ports.sendRepair(repair)).toThrow("unavailable");
    expect(() => delivery.ports.sendNotice(notice)).toThrow("unavailable");
  });

  it("forwards complete identity and preserves synchronous and asynchronous acknowledgements", async () => {
    const sendRepair = vi.fn(() => "repair-id");
    const sendNotice = vi.fn(async () => "notice-id");
    const delivery = createDeploymentDelivery({ sendRepair, sendNotice });
    expect(delivery.ports.sendRepair(repair)).toBe("repair-id");
    await expect(delivery.ports.sendNotice(notice)).resolves.toBe("notice-id");
    expect(sendRepair).toHaveBeenCalledWith(repair);
    expect(sendNotice).toHaveBeenCalledWith(notice);
  });

  it("isolates runtimes and replaces only the selected handler", () => {
    const left = createDeploymentDelivery({ sendRepair: () => "left" });
    const right = createDeploymentDelivery({ sendRepair: () => "right" });
    left.setDeployRepairHandoff(() => "replacement");
    expect(left.ports.sendRepair(repair)).toBe("replacement");
    expect(right.ports.sendRepair(repair)).toBe("right");
    expect(() => left.ports.sendNotice(notice)).toThrow("unavailable");
  });

  it("propagates host failure so the shared coordinator owns retry policy", async () => {
    const failure = new Error("SDK unavailable");
    const delivery = createDeploymentDelivery({
      sendRepair: () => {
        throw failure;
      },
      sendNotice: async () => {
        throw failure;
      }
    });
    expect(() => delivery.ports.sendRepair(repair)).toThrow(failure);
    await expect(delivery.ports.sendNotice(notice)).rejects.toBe(failure);
  });

  it("does not lose an issued delivery acknowledgement when the handler is detached", async () => {
    const pending = createDeferred<string>();
    const delivery = createDeploymentDelivery({
      sendRepair: () => pending.promise
    });
    const result = delivery.ports.sendRepair(repair);
    delivery.setDeployRepairHandoff(null);
    pending.resolve("acknowledged");
    await expect(result).resolves.toBe("acknowledged");
  });
});
