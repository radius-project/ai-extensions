import { describe, expect, it, vi } from "vitest";
import {
  admitSetupCommand,
  type SetupCommandAdmissionPorts
} from "./setup-command-admission.js";

function fixture(overrides: Partial<SetupCommandAdmissionPorts> = {}) {
  const events: string[] = [];
  const ports: SetupCommandAdmissionPorts = {
    acquire: vi.fn<SetupCommandAdmissionPorts["acquire"]>(() => {
      events.push("acquire");
      return { ok: true };
    }),
    begin: vi.fn(() => {
      events.push("begin");
      return { ok: true, commandId: "saved-command", attempt: 2 };
    }),
    restore: vi.fn(() => {
      events.push("restore");
    }),
    prepare: vi.fn(() => {
      events.push("prepare");
    }),
    persist: vi.fn(async () => {
      events.push("persist");
    }),
    running: vi.fn(() => {
      events.push("running");
    }),
    schedule: vi.fn(() => {
      events.push("schedule");
      return true;
    }),
    publish: vi.fn((result) => {
      events.push(result.state);
    }),
    unscheduled: vi.fn(() => {
      events.push("close");
    }),
    reportPersistenceFailure: vi.fn(),
    ...overrides
  };
  return { ports, events };
}

describe("setup command admission", () => {
  it.each(["before", "persist"] as const)(
    "leaves commands recoverable when shutdown happens at %s",
    async (phase) => {
      let stopped = phase === "before";
      const { ports } = fixture({
        isStopped: () => stopped,
        persist: vi.fn(async () => {
          stopped = true;
        })
      });
      await admitSetupCommand("close-operation", ports);
      expect(ports.publish).toHaveBeenCalledExactlyOnceWith({
        state: "stopped"
      });
      expect(ports.acquire).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
      expect(ports.persist).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
      expect(ports.schedule).not.toHaveBeenCalled();
      expect(ports.running).not.toHaveBeenCalled();
      expect(ports.unscheduled).not.toHaveBeenCalled();
      expect(ports.restore).not.toHaveBeenCalled();
    }
  );

  it.each(["restore-terminal", "close-operation"] as const)(
    "persists the derived command before scheduling with %s semantics",
    async (policy) => {
      const { ports, events } = fixture();
      await admitSetupCommand(policy, ports);
      expect(events).toEqual([
        "acquire",
        "begin",
        "prepare",
        "persist",
        "running",
        ...(policy === "restore-terminal" ?
          ["schedule", "accepted"]
        : ["accepted", "schedule"])
      ]);
      expect(ports.prepare).toHaveBeenCalledExactlyOnceWith("saved-command");
      expect(ports.running).toHaveBeenCalledExactlyOnceWith("saved-command");
      expect(ports.schedule).toHaveBeenCalledExactlyOnceWith("saved-command");
      expect(ports.publish).toHaveBeenCalledExactlyOnceWith({
        state: "accepted",
        commandId: "saved-command",
        attempt: 2
      });
    }
  );

  it("refuses a repository lock conflict before creating a retry attempt", async () => {
    const { ports } = fixture({
      acquire: () => ({ ok: false, operationId: "other-operation" })
    });
    await admitSetupCommand("restore-terminal", ports);
    expect(ports.publish).toHaveBeenCalledExactlyOnceWith({
      state: "conflict",
      operationId: "other-operation"
    });
    expect(ports.begin).not.toHaveBeenCalled();
    expect(ports.persist).not.toHaveBeenCalled();
    expect(ports.schedule).not.toHaveBeenCalled();
  });

  it("restores the retry snapshot when derived identity resolves to an existing command", async () => {
    const { ports, events } = fixture({
      begin: () => ({ ok: false, commandId: "existing-command", attempt: 2 })
    });
    await admitSetupCommand("restore-terminal", ports);
    expect(events).toEqual(["acquire", "restore", "duplicate"]);
    expect(ports.publish).toHaveBeenCalledExactlyOnceWith({
      state: "duplicate",
      commandId: "existing-command"
    });
    expect(ports.prepare).not.toHaveBeenCalled();
    expect(ports.persist).not.toHaveBeenCalled();
  });

  it("restores unpersisted admission without scheduling or announcing success", async () => {
    const error = new Error("store unavailable");
    const { ports } = fixture({
      persist: async () => {
        throw error;
      }
    });
    await admitSetupCommand("close-operation", ports);
    expect(ports.restore).toHaveBeenCalledOnce();
    expect(ports.publish).toHaveBeenCalledExactlyOnceWith({
      state: "persist-failed",
      error
    });
    expect(ports.running).not.toHaveBeenCalled();
    expect(ports.schedule).not.toHaveBeenCalled();
  });

  it.each(["restore-terminal", "close-operation"] as const)(
    "records an unscheduled %s outcome and persists its recovery",
    async (policy) => {
      const { ports, events } = fixture({
        schedule: vi.fn(() => false)
      });
      await admitSetupCommand(policy, ports);
      expect(events).toEqual([
        "acquire",
        "begin",
        "prepare",
        "persist",
        "running",
        ...(policy === "restore-terminal" ?
          ["restore", "unscheduled"]
        : ["accepted", "close"]),
        "persist"
      ]);
      expect(ports.persist).toHaveBeenCalledTimes(2);
      expect(ports.reportPersistenceFailure).not.toHaveBeenCalled();
    }
  );

  it.each(["restore-terminal", "close-operation"] as const)(
    "reports a failed recovery write without replacing the %s outcome",
    async (policy) => {
      const error = new Error("recovery checkpoint failed");
      const { ports } = fixture({
        schedule: () => false,
        persist: vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockRejectedValueOnce(error)
      });
      await admitSetupCommand(policy, ports);
      expect(ports.reportPersistenceFailure).toHaveBeenCalledExactlyOnceWith(
        error
      );
      expect(ports.publish).toHaveBeenCalledOnce();
      expect(ports.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          state: policy === "restore-terminal" ? "unscheduled" : "accepted"
        })
      );
    }
  );

  it("does not treat a rejected scheduling callback as accepted cleanup", async () => {
    const error = new Error("runner threw");
    const { ports } = fixture({
      schedule: () => {
        throw error;
      }
    });
    await expect(admitSetupCommand("restore-terminal", ports)).rejects.toBe(
      error
    );
    expect(ports.publish).not.toHaveBeenCalled();
  });
});
