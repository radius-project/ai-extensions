import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPLOY_HANDOFF_RETRY_DELAY_MS,
  redactCredentials,
  type DeploymentRepairState
} from "@radius-project/core";
import {
  deliverDeploymentRepair,
  type DeploymentRepairDeliveryPorts
} from "./deployment-repair-delivery.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  let current = true;
  const state: DeploymentRepairState = {
    deployAttempt: { id: "attempt-1" },
    deployGeneration: 1,
    deployStatus: "failed"
  };
  const input = {
    repo: "acme/app",
    branch: "feature",
    instanceId: "",
    error: "Build failed",
    deployRunUrl: "https://github.com/acme/app/actions/runs/42"
  };
  const retries: (() => void)[] = [];
  const ports = {
    isCurrent: vi.fn(() => current),
    send: vi.fn<DeploymentRepairDeliveryPorts["send"]>(async () => {}),
    redactDiagnostic: vi.fn(redactCredentials),
    publish: vi.fn(),
    retry: vi.fn((callback: () => void, _milliseconds: number) => {
      retries.push(callback);
    }),
    reportError: vi.fn()
  };
  return {
    state,
    input,
    ports,
    retries,
    stop: () => {
      current = false;
    },
    deliver: () => deliverDeploymentRepair(state, input, ports)
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("runtime repair delivery", () => {
  it("claims one delivery for simultaneous consumers and publishes ownership only after acknowledgment", async () => {
    const f = fixture();
    let acknowledge = () => {};
    f.ports.send.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        })
    );
    expect(f.deliver()).toBe(true);
    expect(f.deliver()).toBe(false);
    expect(f.state.deployHandoffState).toBe("pending");
    expect(f.state.deployRepairing).toBeUndefined();
    expect(f.ports.send).toHaveBeenCalledExactlyOnceWith({
      ...f.input,
      attemptId: "attempt-1"
    });
    acknowledge();
    await settle();
    expect(f.state.deployHandoffState).toBe("delivered");
    expect(f.state.deployRepairing).toBe(true);
    expect(f.ports.publish).toHaveBeenCalledTimes(1);
    expect(f.ports.retry).not.toHaveBeenCalled();
  });

  it("does not claim or send after runtime retirement", () => {
    const f = fixture();
    f.stop();
    expect(f.deliver()).toBe(false);
    expect(f.state.deployHandoffState).toBeUndefined();
    expect(f.ports.send).not.toHaveBeenCalled();
  });

  it("supports attempt-less legacy delivery without a server", async () => {
    const f = fixture();
    delete f.state.deployAttempt;
    delete f.state.deployGeneration;
    expect(f.deliver()).toBe(true);
    await settle();
    expect(f.ports.send).toHaveBeenCalledWith({ ...f.input, attemptId: "" });
    expect(f.state.deployHandoffState).toBe("delivered");
  });

  it.each(["rejected", "thrown"] as const)(
    "retries %s delivery exactly twice with the existing backoff and captured target",
    async (failure) => {
      const f = fixture();
      const error = new Error("Host declined the request");
      f.ports.send.mockImplementation(() => {
        if (failure === "thrown") throw error;
        return Promise.reject(error);
      });
      expect(f.deliver()).toBe(failure !== "thrown");
      f.input.repo = "changed/repo";
      await settle();
      expect(f.state.deployHandoffState).toBe("retryable");
      f.retries[0]();
      await settle();
      expect(f.state.deployHandoffState).toBe("retryable");
      f.retries[1]();
      await settle();
      expect(f.state.deployHandoffState).toBe("failed");
      expect(f.state.deployRepairing).toBe(false);
      expect(f.state.deployHandoffAttempts).toBe(3);
      expect(f.ports.send).toHaveBeenCalledTimes(3);
      expect(
        f.ports.send.mock.calls.every(([input]) => input.repo === "acme/app")
      ).toBe(true);
      expect(f.ports.retry.mock.calls.map(([, delay]) => delay)).toEqual([
        DEPLOY_HANDOFF_RETRY_DELAY_MS,
        DEPLOY_HANDOFF_RETRY_DELAY_MS
      ]);
      expect(f.ports.reportError.mock.calls).toEqual([
        [error],
        [error],
        [error]
      ]);
      expect(f.deliver()).toBe(false);
    }
  );

  it.each(["attempt", "generation", "delivery", "shutdown"] as const)(
    "ignores acknowledgment after %s replacement",
    async (replacement) => {
      const f = fixture();
      let acknowledge = () => {};
      f.ports.send.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            acknowledge = resolve;
          })
      );
      f.deliver();
      if (replacement === "attempt") f.state.deployAttempt = { id: "new" };
      if (replacement === "generation") f.state.deployGeneration = 2;
      if (replacement === "delivery") f.state.deployHandoffAttempts = 2;
      if (replacement === "shutdown") f.stop();
      const before = structuredClone(f.state);
      acknowledge();
      await settle();
      expect(f.state).toEqual(before);
      expect(f.ports.publish).not.toHaveBeenCalled();
    }
  );

  it("ignores an obsolete delivery whose pending state was already settled", async () => {
    const f = fixture();
    f.deliver();
    f.state.deployHandoffState = "failed";
    await settle();
    expect(f.state.deployHandoffState).toBe("failed");
    expect(f.ports.publish).not.toHaveBeenCalled();
  });

  it.each(["generation", "state", "new-delivery", "shutdown"] as const)(
    "does not replay a scheduled retry after %s changes",
    async (replacement) => {
      const f = fixture();
      f.ports.send.mockRejectedValueOnce(new Error("Delivery failed"));
      f.deliver();
      await settle();
      if (replacement === "generation") f.state.deployGeneration = 2;
      if (replacement === "state") f.state.deployHandoffState = "delivered";
      if (replacement === "new-delivery") {
        f.deliver();
        await settle();
      }
      if (replacement === "shutdown") f.stop();
      const before = structuredClone(f.state);
      f.retries[0]();
      await settle();
      expect(f.state).toEqual(before);
      expect(f.ports.send).toHaveBeenCalledTimes(
        replacement === "new-delivery" ? 2 : 1
      );
    }
  );

  it.each([true, false])(
    "reports publication failure without losing delivered=%s settlement or retry",
    async (delivered) => {
      const f = fixture();
      const error = new Error("Publication failed");
      f.ports.publish.mockImplementation(() => {
        throw error;
      });
      if (!delivered)
        f.ports.send.mockRejectedValue(new Error("Delivery failed"));
      f.deliver();
      await settle();
      expect(f.state.deployHandoffState).toBe(
        delivered ? "delivered" : "retryable"
      );
      expect(f.ports.reportError).toHaveBeenCalledWith(error);
      expect(f.ports.retry).toHaveBeenCalledTimes(delivered ? 0 : 1);
    }
  );

  it("reports a failed scheduler and leaves the rejected delivery retryable", async () => {
    const f = fixture();
    const error = new Error("Retry clock failed");
    f.ports.send.mockRejectedValue(new Error("Delivery failed"));
    f.ports.retry.mockImplementation(() => {
      throw error;
    });

    f.deliver();
    await settle();
    expect(f.ports.reportError).toHaveBeenCalledWith(error);
    expect(f.state.deployHandoffState).toBe("retryable");
  });

  it("does not schedule another delivery if publication retires the invocation", async () => {
    const f = fixture();
    f.ports.send.mockRejectedValue(new Error("Delivery failed"));
    f.ports.publish.mockImplementation(() => f.stop());
    f.deliver();
    await settle();
    expect(f.state.deployHandoffState).toBe("retryable");
    expect(f.ports.retry).not.toHaveBeenCalled();
  });

  it("sanitizes host-known values and named credentials before handing diagnostics to the host", async () => {
    const f = fixture();
    f.input.error = "opaque-value access_token=synthetic-value";
    f.ports.redactDiagnostic.mockImplementation((text) =>
      text.replaceAll("opaque-value", "[REDACTED]")
    );
    f.deliver();
    await settle();
    const sent = JSON.stringify(f.ports.send.mock.calls);
    expect(sent).not.toContain("opaque-value");
    expect(sent).not.toContain("synthetic-value");
  });

  it("does not claim a delivery when sanitization fails or retires the invocation", () => {
    const f = fixture();
    f.ports.redactDiagnostic.mockImplementationOnce(() => {
      throw new Error("Sanitizer failed");
    });

    expect(() => f.deliver()).toThrow("Sanitizer failed");
    expect(f.state.deployHandoffState).toBeUndefined();
    f.ports.redactDiagnostic.mockImplementation((text) => {
      f.stop();
      return text;
    });
    expect(f.deliver()).toBe(false);
    expect(f.state.deployHandoffState).toBeUndefined();
    expect(f.ports.send).not.toHaveBeenCalled();
  });

  it("redacts and bounds delivery failures before reporting them", async () => {
    const f = fixture();
    f.ports.send.mockRejectedValue(
      new Error("opaque-value access_token=synthetic-value " + "x".repeat(5000))
    );
    f.ports.redactDiagnostic.mockImplementation((text) =>
      text.replaceAll("opaque-value", "[REDACTED]")
    );
    f.deliver();
    await settle();
    const reported: unknown = f.ports.reportError.mock.calls[0][0];
    expect(reported).toBeInstanceOf(Error);
    if (!(reported instanceof Error)) throw new Error("Expected safe error");
    expect(reported.message).toHaveLength(4000);
    expect(reported.message).not.toContain("opaque-value");
    expect(reported.message).not.toContain("synthetic-value");
  });

  it("does not publish or retry when error reporting retires the invocation", async () => {
    const f = fixture();
    f.ports.send.mockRejectedValue(new Error("Delivery failed"));
    f.ports.reportError.mockImplementation(() => f.stop());
    f.deliver();
    await settle();
    expect(f.state.deployHandoffState).toBe("retryable");
    expect(f.ports.publish).not.toHaveBeenCalled();
    expect(f.ports.retry).not.toHaveBeenCalled();
  });

  it("reports a lifetime callback failure after sending without an unhandled rejection", async () => {
    const f = fixture();
    const error = new Error("Lifetime check failed");
    f.deliver();
    f.ports.isCurrent.mockImplementation(() => {
      throw error;
    });
    await settle();
    expect(f.ports.reportError).toHaveBeenCalledWith(error);
    expect(f.state.deployHandoffState).toBe("pending");
  });

  it("reports a lifetime callback failure from a scheduled retry", async () => {
    const f = fixture();
    const error = new Error("Lifetime check failed");
    f.ports.send.mockRejectedValue(new Error("Delivery failed"));
    f.deliver();
    await settle();
    f.ports.isCurrent.mockImplementation(() => {
      throw error;
    });
    expect(() => f.retries[0]()).not.toThrow();
    expect(f.ports.reportError).toHaveBeenCalledWith(error);
    expect(f.ports.send).toHaveBeenCalledTimes(1);
  });

  it("uses a fixed fallback diagnostic if the diagnostic sink fails", async () => {
    const f = fixture();
    const output = vi.spyOn(console, "error").mockImplementation(() => {});
    f.ports.send.mockRejectedValue(new Error("Raw host diagnostic"));
    f.ports.reportError.mockImplementation(() => {
      throw new Error("Sink failed");
    });
    f.deliver();
    await settle();
    expect(output).toHaveBeenCalledExactlyOnceWith(
      "[radius repair] Could not report a handoff failure."
    );
    expect(f.state.deployHandoffState).toBe("retryable");
  });
});
