import { describe, expect, it, vi } from "vitest";
import {
  monitorSetupVerification,
  type SetupVerificationMonitorPorts
} from "./setup-verification-monitor.js";

function fixture(overrides: Partial<SetupVerificationMonitorPorts> = {}) {
  let now = 0;
  const ports: SetupVerificationMonitorPorts = {
    current: () => ({ active: true, stopRequested: false }),
    observe: vi.fn(async () => ({ state: "pending" })),
    stop: vi.fn(async () => {}),
    expire: vi.fn(async () => {}),
    now: () => now,
    sleep: vi.fn(async (milliseconds) => {
      now += milliseconds;
    }),
    jitter: () => 250,
    ...overrides
  };
  return ports;
}

describe("operation-bound setup verification monitoring", () => {
  it.each(["success", "failed"])(
    "finishes on %s without sleeping",
    async (state) => {
      const ports = fixture({ observe: vi.fn(async () => ({ state })) });
      await monitorSetupVerification(100_000, ports);
      expect(ports.observe).toHaveBeenCalledOnce();
      expect(ports.sleep).not.toHaveBeenCalled();
      expect(ports.expire).not.toHaveBeenCalled();
    }
  );

  it.each([undefined, { active: false, stopRequested: false }])(
    "does not observe a missing or inactive operation: %j",
    async (operation) => {
      const ports = fixture({ current: () => operation });
      await monitorSetupVerification(100_000, ports);
      expect(ports.observe).not.toHaveBeenCalled();
    }
  );

  it("awaits the Stop boundary before doing any further reads", async () => {
    const ports = fixture({
      current: () => ({ active: true, stopRequested: true })
    });
    await monitorSetupVerification(100_000, ports);
    expect(ports.stop).toHaveBeenCalledOnce();
    expect(ports.observe).not.toHaveBeenCalled();
  });

  it.each([
    { state: "expired", error: "Saved dispatch is no longer tracked." },
    { state: "pending", terminal: true }
  ])("persists a terminal tracking refusal: %j", async (result) => {
    const ports = fixture({ observe: async () => result });
    await monitorSetupVerification(100_000, ports);
    expect(ports.expire).toHaveBeenCalledExactlyOnceWith(
      result.error || "Credential verification is no longer being tracked."
    );
    expect(ports.sleep).not.toHaveBeenCalled();
  });

  it("does not overwrite an operation terminalized during the read", async () => {
    let active = true;
    const ports = fixture({
      current: () => ({ active, stopRequested: false }),
      observe: async () => {
        active = false;
        return { state: "expired" };
      }
    });
    await monitorSetupVerification(100_000, ports);
    expect(ports.expire).not.toHaveBeenCalled();
  });

  it.each(["pending", "unknown"])(
    "caps backoff and jitter for %s evidence at the saved deadline",
    async (state) => {
      const ports = fixture({ observe: async () => ({ state }) });
      await expect(monitorSetupVerification(60_000, ports)).rejects.toThrow(
        "Credential verification did not complete within 45 minutes."
      );
      expect(ports.sleep).toHaveBeenNthCalledWith(1, 5250);
      expect(ports.sleep).toHaveBeenNthCalledWith(2, 7750);
      expect(ports.sleep).toHaveBeenNthCalledWith(3, 11500);
      expect(ports.sleep).toHaveBeenNthCalledWith(4, 15250);
      expect(ports.sleep).toHaveBeenNthCalledWith(5, 15250);
      expect(ports.sleep).toHaveBeenNthCalledWith(6, 15250);
    }
  );

  it.each(["observe", "stop", "expire", "sleep"] as const)(
    "propagates %s failure without another observation or retry",
    async (stage) => {
      const failure = new Error(`${stage} failed`);
      const ports = fixture({
        current: () => ({ active: true, stopRequested: stage === "stop" }),
        observe: vi.fn(async () => ({
          state: stage === "expire" ? "expired" : "pending"
        })),
        [stage]: vi.fn(async () => {
          throw failure;
        })
      });
      await expect(monitorSetupVerification(100_000, ports)).rejects.toBe(
        failure
      );
      if (stage !== "stop") expect(ports.observe).toHaveBeenCalledOnce();
    }
  );
});
