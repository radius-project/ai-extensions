import { describe, expect, it } from "vitest";
import {
  honorSetupStop,
  saveSetupCheckpoint,
  saveSetupOperation,
  type SetupCheckpointOperation,
  type SetupStopPorts
} from "./setup-boundary.js";

describe("setup persistence policy", () => {
  it("reports a successful save without a transport response", async () => {
    let saves = 0;
    await expect(
      saveSetupOperation(async () => {
        saves += 1;
      })
    ).resolves.toEqual({ outcome: "saved" });
    expect(saves).toBe(1);
  });

  it.each([new Error("disk full"), "offline", null])(
    "retains a save rejection for the adapter to report: %s",
    async (error) => {
      let saves = 0;
      const result = await saveSetupOperation(async () => {
        saves += 1;
        throw error;
      });
      expect(result).toEqual({ outcome: "persistence-failed", error });
      expect(saves).toBe(1);
    }
  );

  it.each([
    null,
    {},
    { providerRecovery: null },
    { providerRecovery: "legacy" },
    { providerRecovery: [] },
    { providerRecovery: {} },
    { providerRecovery: { state: null } },
    { providerRecovery: { state: "reconciling" } }
  ])(
    "allows a saved checkpoint without pending rollback: %j",
    async (operation) => {
      await expect(
        saveSetupCheckpoint({ operation, persist: async () => {} })
      ).resolves.toEqual({ outcome: "saved" });
    }
  );

  it("gives persistence failure precedence over a pending rollback", async () => {
    const error = new Error("disk full");
    await expect(
      saveSetupCheckpoint({
        operation: { providerRecovery: { state: "rollback_pending" } },
        persist: async () => {
          throw error;
        }
      })
    ).resolves.toEqual({ outcome: "persistence-failed", error });
  });

  it("checks the live rollback decision after saving, before another write", async () => {
    const operation: SetupCheckpointOperation = {
      providerRecovery: { state: "reconciling" }
    };
    const events: string[] = [];
    const result = await saveSetupCheckpoint({
      operation,
      persist: async () => {
        events.push("persist");
        operation.providerRecovery = { state: "rollback_pending" };
      }
    });
    if (result.outcome === "saved") events.push("next-mutation");
    expect(result).toEqual({ outcome: "rollback-pending" });
    expect(events).toEqual(["persist"]);
  });
});

function stopPorts({
  requested = true,
  unsettled = false,
  saveError,
  publishError
}: {
  requested?: boolean;
  unsettled?: boolean;
  saveError?: Error;
  publishError?: Error;
} = {}) {
  const events: string[] = [];
  const errors: unknown[] = [];
  const ports: SetupStopPorts = {
    isStopRequested: () => {
      events.push("check-stop");
      return requested;
    },
    hasUnsettledMutation: () => {
      events.push("check-mutations");
      return unsettled;
    },
    beforePersist: () => {
      events.push("finish-command");
    },
    transitionToStopped: (boundary) => {
      events.push(`stop:${boundary}`);
    },
    persist: async () => {
      events.push("persist");
      if (saveError) throw saveError;
    },
    publishStopped: () => {
      events.push("publish");
      if (publishError) throw publishError;
    },
    reportPersistenceFailure: (error) => {
      errors.push(error);
    }
  };
  return { ports, events, errors };
}

describe("setup safe-stop policy", () => {
  it("does not inspect mutations or write when no stop is requested", async () => {
    const test = stopPorts({ requested: false });
    await expect(honorSetupStop("before-write", test.ports)).resolves.toBe(
      true
    );
    expect(test.events).toEqual(["check-stop"]);
  });

  it("leaves an uncertain provider mutation owned by reconciliation", async () => {
    const test = stopPorts({ unsettled: true });
    await expect(honorSetupStop("after-write", test.ports)).resolves.toBe(true);
    expect(test.events).toEqual(["check-stop", "check-mutations"]);
  });

  it("finishes the command, stops, saves and only then publishes cancellation", async () => {
    const test = stopPorts();
    await expect(honorSetupStop("after-write", test.ports)).resolves.toBe(
      false
    );
    expect(test.events).toEqual([
      "check-stop",
      "check-mutations",
      "finish-command",
      "stop:after-write",
      "persist",
      "publish"
    ]);
    expect(test.errors).toEqual([]);
  });

  it("supports a caller without command-finalization work", async () => {
    const test = stopPorts();
    delete test.ports.beforePersist;
    await expect(honorSetupStop("before-write", test.ports)).resolves.toBe(
      false
    );
    expect(test.events).not.toContain("finish-command");
    expect(test.events.slice(-3)).toEqual([
      "stop:before-write",
      "persist",
      "publish"
    ]);
  });

  it("does not announce an unsaved stop or allow another mutation", async () => {
    const error = new Error("disk full");
    const test = stopPorts({ saveError: error });
    await expect(honorSetupStop("after-write", test.ports)).resolves.toBe(
      false
    );
    expect(test.events).not.toContain("publish");
    expect(test.errors).toEqual([error]);
  });

  it("retains the existing reporting boundary when terminal publication throws", async () => {
    const error = new Error("notification unavailable");
    const test = stopPorts({ publishError: error });
    await expect(honorSetupStop("after-write", test.ports)).resolves.toBe(
      false
    );
    expect(test.errors).toEqual([error]);
  });

  it.each(["beforePersist", "transitionToStopped"] as const)(
    "propagates %s failure without pretending the stop was saved",
    async (port) => {
      const error = new Error("transition unavailable");
      const test = stopPorts();
      test.ports[port] = () => {
        throw error;
      };
      await expect(honorSetupStop("after-write", test.ports)).rejects.toBe(
        error
      );
      expect(test.events).not.toContain("persist");
      expect(test.errors).toEqual([]);
    }
  );

  it("propagates diagnostic delivery failure", async () => {
    const test = stopPorts({ saveError: new Error("disk full") });
    const error = new Error("diagnostic unavailable");
    test.ports.reportPersistenceFailure = () => {
      throw error;
    };
    await expect(honorSetupStop("after-write", test.ports)).rejects.toBe(error);
  });
});
