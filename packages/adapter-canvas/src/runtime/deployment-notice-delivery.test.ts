import { afterEach, describe, expect, it, vi } from "vitest";
import { redactCredentials } from "@radius-project/core";
import type { CanvasState } from "../shared.js";
import { createDeferred } from "../../test/support/browser/fakes.js";
import {
  deliverDeploymentNotice,
  type DeploymentNoticeDeliveryPorts
} from "./deployment-notice-delivery.js";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  let current = true;
  const state: CanvasState = {
    deployStatus: "failed",
    deployErrorKind: "run-unconfirmed",
    deployAttempt: { id: "attempt-1" },
    deployGeneration: 1
  };
  const input = {
    repo: "fixture/app",
    branch: "feature/model",
    error: "Run unavailable",
    deployRunUrl: "",
    instanceId: ""
  };
  const retries: (() => void)[] = [];
  const ports = {
    isCurrent: () => current,
    send: vi.fn<DeploymentNoticeDeliveryPorts["send"]>(async () => {}),
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
    deliver: () => deliverDeploymentNotice(state, input, ports)
  };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("informational deployment notice delivery", () => {
  it.each(["run-unconfirmed", "dispatch-refused"] as const)(
    "claims one %s notice without claiming repair ownership",
    async (kind) => {
      const f = fixture();
      f.state.deployErrorKind = kind;
      const sent = createDeferred<void>();
      f.ports.send.mockReturnValue(sent.promise);
      expect(f.deliver()).toBe(true);
      expect(f.deliver()).toBe(false);
      expect(f.state.deployNoticeState).toBe("pending");
      sent.resolve();
      await settle();
      expect(f.state.deployNoticeState).toBe("delivered");
      expect(f.state.deployRepairing).toBeUndefined();
      expect(f.ports.send).toHaveBeenCalledOnce();
      expect(f.ports.publish).toHaveBeenCalledOnce();
      expect(f.deliver()).toBe(false);
    }
  );

  it.each([
    { deployStatus: "complete" },
    { deployErrorKind: null },
    { deployNoticeState: "pending" },
    { deployNoticeState: "delivered" },
    { deployNoticeState: "failed" },
    { deployNoticeAttempts: 3 }
  ] satisfies Partial<CanvasState>[])(
    "refuses ineligible state %j without sending",
    (patch) => {
      const f = fixture();
      Object.assign(f.state, patch);
      expect(f.deliver()).toBe(false);
      expect(f.ports.send).not.toHaveBeenCalled();
    }
  );

  it("supports legacy attempt-less states and captures input before asynchronous delivery", async () => {
    const f = fixture();
    delete f.state.deployAttempt;
    delete f.state.deployGeneration;
    expect(f.deliver()).toBe(true);
    f.input.repo = "changed/repo";
    await settle();
    expect(f.ports.send).toHaveBeenCalledWith(
      expect.objectContaining({ repo: "fixture/app" })
    );
    expect(f.state.deployNoticeState).toBe("delivered");
  });

  it.each(["before", "sanitizer"] as const)(
    "refuses retirement at %s",
    (when) => {
      const f = fixture();
      if (when === "before") f.stop();
      else
        f.ports.redactDiagnostic.mockImplementation((value) => {
          f.stop();
          return value;
        });
      expect(f.deliver()).toBe(false);
      expect(f.state.deployNoticeAttempts).toBeUndefined();
      expect(f.ports.send).not.toHaveBeenCalled();
    }
  );

  it.each(["throw", "reject"] as const)(
    "bounds %s delivery to three attempts at two-second intervals",
    async (failure) => {
      const f = fixture();
      const error = new Error("host unavailable");
      if (failure === "throw")
        f.ports.send.mockImplementation(() => {
          throw error;
        });
      else f.ports.send.mockRejectedValue(error);
      expect(f.deliver()).toBe(failure !== "throw");
      await settle();
      expect(f.state.deployNoticeState).toBe("retryable");
      f.retries[0]();
      await settle();
      f.retries[1]();
      await settle();
      expect(f.state.deployNoticeState).toBe("failed");
      expect(f.state.deployNoticeAttempts).toBe(3);
      expect(f.ports.send).toHaveBeenCalledTimes(3);
      expect(f.ports.retry.mock.calls.map(([, delay]) => delay)).toEqual([
        2000, 2000
      ]);
      expect(f.ports.reportError).toHaveBeenCalledTimes(3);
      expect(f.deliver()).toBe(false);
    }
  );

  it.each(["attempt", "generation", "ordinal", "state", "shutdown"] as const)(
    "ignores an acknowledgment after %s changes",
    async (change) => {
      const f = fixture();
      const sent = createDeferred<void>();
      f.ports.send.mockReturnValue(sent.promise);
      f.deliver();
      if (change === "attempt") f.state.deployAttempt = { id: "replacement" };
      if (change === "generation") f.state.deployGeneration = 2;
      if (change === "ordinal") f.state.deployNoticeAttempts = 2;
      if (change === "state") f.state.deployNoticeState = "idle";
      if (change === "shutdown") f.stop();
      sent.resolve();
      await settle();
      expect(f.ports.publish).not.toHaveBeenCalled();
      expect(f.state.deployNoticeState).not.toBe("delivered");
    }
  );

  it("invalidates an older timer when polling claims another delivery", async () => {
    const f = fixture();
    f.ports.send.mockRejectedValueOnce(new Error("host unavailable"));
    f.deliver();
    await settle();
    const retry = f.retries[0];
    expect(f.deliver()).toBe(true);
    await settle();
    retry();
    expect(f.ports.send).toHaveBeenCalledTimes(2);
    expect(f.state.deployNoticeState).toBe("delivered");
  });

  it("fences retries after shutdown and reporting-driven retirement", async () => {
    const f = fixture();
    f.ports.send.mockRejectedValue(new Error("unavailable"));
    f.deliver();
    await settle();
    f.stop();
    f.retries[0]();
    expect(f.ports.send).toHaveBeenCalledOnce();
    const g = fixture();
    g.ports.send.mockRejectedValue(new Error("unavailable"));
    g.ports.reportError.mockImplementation(g.stop);
    g.deliver();
    await settle();
    expect(g.ports.publish).not.toHaveBeenCalled();
    expect(g.ports.retry).not.toHaveBeenCalled();
  });

  it("sanitizes host-known input and bounds callback errors", async () => {
    const f = fixture();
    f.input.error = "host-private access_token=synthetic-value";
    f.ports.redactDiagnostic.mockImplementation((value) =>
      value.replaceAll("host-private", "[redacted]")
    );
    f.ports.send.mockRejectedValue(
      new Error("host-private access_token=synthetic-value " + "x".repeat(5000))
    );
    f.deliver();
    await settle();
    expect(JSON.stringify(f.ports.send.mock.calls)).not.toMatch(
      /host-private|synthetic-value/
    );
    const error: unknown = f.ports.reportError.mock.calls[0][0];
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected safe Error");
    expect(error.message.length).toBe(4000);
    expect(error.message).not.toMatch(/host-private|synthetic-value/);
  });

  it.each(["publish", "retry", "report", "redactor"] as const)(
    "contains a %s callback failure without an unhandled rejection",
    async (failure) => {
      const f = fixture();
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      f.ports.send.mockRejectedValue(new Error("host unavailable"));
      if (failure === "publish")
        f.ports.publish.mockImplementation(() => {
          throw new Error("publish unavailable");
        });
      if (failure === "retry")
        f.ports.retry.mockImplementation(() => {
          throw new Error("scheduler unavailable");
        });
      if (failure === "report")
        f.ports.reportError.mockImplementation(() => {
          throw new Error("sink unavailable");
        });
      if (failure === "redactor")
        f.ports.redactDiagnostic
          .mockImplementationOnce((value) => value)
          .mockImplementation(() => {
            throw new Error("redactor unavailable");
          });
      f.deliver();
      await settle();
      expect(f.state.deployNoticeState).toBe("retryable");
      if (failure === "report" || failure === "redactor")
        expect(consoleError).toHaveBeenCalled();
      else expect(f.ports.reportError).toHaveBeenCalledTimes(2);
    }
  );

  it("reports a sanitizer failure in a scheduled retry", async () => {
    const f = fixture();
    f.ports.send.mockRejectedValueOnce(new Error("host unavailable"));
    f.deliver();
    await settle();
    f.ports.redactDiagnostic.mockImplementationOnce(() => {
      throw new Error("retry sanitization failed");
    });
    f.retries[0]();
    expect(f.ports.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "retry sanitization failed" })
    );
    expect(f.ports.send).toHaveBeenCalledOnce();
  });
});
