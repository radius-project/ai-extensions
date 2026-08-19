import { describe, expect, it, vi } from "vitest";
import {
  removeDirectoryWithRetries,
  replaceSharedCredentials,
  stopHarnessServer,
  unwindHarnessConstruction
} from "./canvas-harness.js";

describe("removeDirectoryWithRetries", () => {
  it("retries transient locks with a bounded increasing delay", async () => {
    const remove = vi
      .fn<(directory: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("locked"))
      .mockRejectedValueOnce(new Error("still locked"))
      .mockResolvedValue();
    const wait = vi.fn<(milliseconds: number) => Promise<void>>(
      async () => undefined
    );

    await removeDirectoryWithRetries("fixture", {
      attempts: 4,
      remove,
      delay: wait
    });

    expect(remove).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[100], [200]]);
  });

  it("propagates the final permanent deletion failure", async () => {
    const failure = new Error("permanently locked");
    const remove = vi
      .fn<(directory: string) => Promise<void>>()
      .mockRejectedValue(failure);
    const wait = vi.fn<(milliseconds: number) => Promise<void>>(
      async () => undefined
    );

    await expect(
      removeDirectoryWithRetries("fixture", {
        attempts: 3,
        remove,
        delay: wait
      })
    ).rejects.toBe(failure);

    expect(remove).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
});

describe("credential state isolation", () => {
  it("replaces every known and unknown persisted field", () => {
    const credentials = {
      azure: { secret: "personal" },
      aws: { secret: "personal" },
      preferredGitHubLogin: "personal",
      profiles: { personal: [] },
      unknownPersistedField: "personal"
    };

    replaceSharedCredentials(credentials, {
      profiles: { fixture: [{ name: "fixture" }] }
    });

    expect(credentials).toEqual({
      profiles: { fixture: [{ name: "fixture" }] }
    });
  });
});

describe("stopHarnessServer", () => {
  it("deregisters after a graceful close", async () => {
    let listening = true;
    const registrations = new Set(["panel"]);
    const forceCalls: boolean[] = [];
    const server = {
      get listening() {
        return listening;
      },
      close(callback?: (error?: Error) => void) {
        listening = false;
        callback?.();
        return server;
      },
      closeAllConnections() {}
    };

    await stopHarnessServer(
      { server },
      "panel",
      {
        servers: registrations,
        async stopServer(instanceId, force = false) {
          forceCalls.push(force);
          registrations.delete(instanceId);
        }
      },
      500
    );

    expect(forceCalls).toEqual([false]);
    expect(registrations.size).toBe(0);
  });

  it("force-closes and deregisters after the graceful deadline", async () => {
    let listening = true;
    const registrations = new Set(["panel"]);
    const forceCalls: boolean[] = [];
    const server = {
      get listening() {
        return listening;
      },
      close() {
        return server;
      },
      closeAllConnections() {
        listening = false;
      }
    };

    await stopHarnessServer(
      { server },
      "panel",
      {
        servers: registrations,
        async stopServer(instanceId, force = false) {
          forceCalls.push(force);
          if (force) server.closeAllConnections();
          registrations.delete(instanceId);
        }
      },
      1,
      async () => undefined
    );

    expect(forceCalls).toEqual([true]);
    expect(registrations.size).toBe(0);
  });

  it("fails cleanup after deregistering when graceful close reports an error", async () => {
    const closeFailure = new Error("close failed");
    const registrations = new Set(["panel"]);
    const forceCalls: boolean[] = [];
    const server = {
      listening: false,
      close(callback?: (error?: Error) => void) {
        callback?.(closeFailure);
        return server;
      },
      closeAllConnections() {}
    };

    await expect(
      stopHarnessServer(
        { server },
        "panel",
        {
          servers: registrations,
          async stopServer(instanceId, force = false) {
            forceCalls.push(force);
            registrations.delete(instanceId);
          }
        },
        500
      )
    ).rejects.toBe(closeFailure);

    expect(forceCalls).toEqual([true]);
    expect(registrations.size).toBe(0);
  });
});

describe("unwindHarnessConstruction", () => {
  it("restores process state and removes resources after partial construction", async () => {
    const key = "RADIUS_E2E_PARTIAL_CONSTRUCTION";
    process.env[key] = "mutated";
    const calls: string[] = [];

    await unwindHarnessConstruction({
      rootDir: "fixture-root",
      originalEnv: { [key]: "original" },
      async stopServer() {
        calls.push("stop");
      },
      resetState() {
        calls.push("reset");
      },
      async removeDirectory(directory) {
        calls.push(`remove:${directory}`);
      }
    });

    expect(calls).toEqual(["stop", "reset", "remove:fixture-root"]);
    expect(process.env[key]).toBe("original");
    delete process.env[key];
  });

  it("continues unwinding and reports every cleanup failure", async () => {
    const key = "RADIUS_E2E_PARTIAL_CONSTRUCTION";
    process.env[key] = "mutated";
    const stopFailure = new Error("stop failed");
    const removeFailure = new Error("remove failed");
    let reset = false;

    const cleanup = unwindHarnessConstruction({
      rootDir: "fixture-root",
      originalEnv: { [key]: undefined },
      async stopServer() {
        throw stopFailure;
      },
      resetState() {
        reset = true;
      },
      async removeDirectory() {
        throw removeFailure;
      }
    });

    await expect(cleanup).rejects.toMatchObject({
      errors: [stopFailure, removeFailure]
    });
    expect(reset).toBe(true);
    expect(process.env[key]).toBeUndefined();
  });
});
