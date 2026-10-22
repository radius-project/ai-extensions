import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/support/browser/fakes.js";
import {
  retryDeploymentDelivery,
  type DeploymentDeliveryRetryPorts
} from "./deployment-delivery-retry.js";

function fixture() {
  const wait = createDeferred<void>();
  let current = true;
  const ports: DeploymentDeliveryRetryPorts = {
    delay: vi.fn(() => wait.promise),
    isCurrent: () => current,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    reportError: vi.fn()
  };
  return {
    wait,
    ports,
    stop: () => {
      current = false;
    }
  };
}

describe("deployment delivery retry", () => {
  it("waits for the owner clock before delivering once", async () => {
    const { wait, ports } = fixture();
    const callback = vi.fn();
    const pending = retryDeploymentDelivery(callback, 500, ports);
    expect(callback).not.toHaveBeenCalled();
    expect(ports.delay).toHaveBeenCalledExactlyOnceWith(500);
    wait.resolve();
    await pending;
    expect(callback).toHaveBeenCalledTimes(1);
    expect(ports.reportError).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a stopped or replaced invocation when its delay %ss",
    async (outcome) => {
      const { wait, ports, stop } = fixture();
      const callback = vi.fn();
      const pending = retryDeploymentDelivery(callback, 500, ports);
      stop();
      if (outcome === "resolve") wait.resolve();
      else wait.reject(new Error("stopped"));
      await expect(pending).resolves.toBeUndefined();
      expect(callback).not.toHaveBeenCalled();
      expect(ports.reportError).not.toHaveBeenCalled();
    }
  );

  it.each(["delay", "callback"] as const)(
    "reports a redacted and bounded %s failure",
    async (failure) => {
      const { wait, ports } = fixture();
      const error = new Error("synthetic failure");
      ports.errorMessage = vi.fn(
        () => `access_token=synthetic-value ${"detail ".repeat(900)}`
      );
      const callback = vi.fn(() => {
        throw error;
      });
      const pending = retryDeploymentDelivery(callback, 500, ports);
      if (failure === "delay") wait.reject(error);
      else wait.resolve();
      await expect(pending).resolves.toBeUndefined();
      expect(ports.errorMessage).toHaveBeenCalledExactlyOnceWith(error);
      expect(ports.reportError).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("[REDACTED]")
      );
      expect(ports.reportError).toHaveBeenCalledWith(
        expect.not.stringContaining("synthetic-value")
      );
      expect(ports.reportError).toHaveBeenCalledWith(
        expect.stringMatching(/^[\s\S]{4000}$/)
      );
      expect(callback).toHaveBeenCalledTimes(failure === "callback" ? 1 : 0);
    }
  );

  it.each(["errorMessage", "reportError"] as const)(
    "does not leak or reject background work when %s throws",
    async (method) => {
      const { wait, ports } = fixture();
      ports[method] = () => {
        throw new Error("private diagnostic");
      };
      const report = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const pending = retryDeploymentDelivery(() => {}, 500, ports);
        wait.reject(new Error("private original failure"));
        await expect(pending).resolves.toBeUndefined();
        expect(report).toHaveBeenCalledExactlyOnceWith(
          "[radius deployment] Could not report a delivery retry failure."
        );
      } finally {
        report.mockRestore();
      }
    }
  );
});
