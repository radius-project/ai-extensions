import { describe, expect, it, vi } from "vitest";
import {
  azureDiscoveryCommands,
  FAKE_CLI_TOOLS,
  removeDirectoryWithRetries,
  replaceSharedCredentials,
  stopHarnessServer,
  unwindHarnessConstruction
} from "./canvas-harness.js";

describe("fake CLI isolation", () => {
  it("intercepts every cloud command used by environment discovery", () => {
    expect(FAKE_CLI_TOOLS).toEqual(["gh", "rad", "az", "aws", "kubectl"]);
  });
});

describe("azureDiscoveryCommands", () => {
  const fixture = {
    subscriptionId: "sub-1",
    clusters: [
      { id: "aks-first", name: "AKS First", resourceGroup: "rg-first" },
      { id: "aks-selected", name: "AKS Selected", resourceGroup: "rg-selected" }
    ],
    cluster: "aks-selected",
    resourceGroup: "rg-selected",
    namespaces: ["default", "selected-team"]
  };

  it("matches the temporary kubeconfig arguments discovery generates", () => {
    const commands = azureDiscoveryCommands(fixture);

    expect(commands.at(-2)).toEqual({
      tool: "az",
      argsPrefix: [
        "aks",
        "get-credentials",
        "--name",
        "aks-selected",
        "--resource-group",
        "rg-selected",
        "--file"
      ],
      stdout: ""
    });
    expect(commands.at(-1)).toEqual({
      tool: "kubectl",
      argsPrefix: ["--kubeconfig"],
      stdout: "default selected-team"
    });
  });

  it("lists the fixture clusters and derives resource groups from them", () => {
    const commands = azureDiscoveryCommands(fixture);

    expect(commands[0]).toEqual({
      tool: "az",
      args: ["account", "set", "--subscription", "sub-1"],
      stdout: ""
    });
    expect(commands[1].args).toEqual([
      "aks",
      "list",
      "--query",
      "[].{id:name, name:name, resourceGroup:resourceGroup}",
      "-o",
      "json",
      "--subscription",
      "sub-1"
    ]);
    expect(JSON.parse(commands[1].stdout ?? "")).toEqual(fixture.clusters);
    expect(commands[2].args).toEqual([
      "group",
      "list",
      "--query",
      "[].{id:name, name:name}",
      "-o",
      "json",
      "--subscription",
      "sub-1"
    ]);
    expect(JSON.parse(commands[2].stdout ?? "")).toEqual([
      { id: "rg-first", name: "rg-first" },
      { id: "rg-selected", name: "rg-selected" }
    ]);
  });

  it("honors an explicit resource group list", () => {
    const commands = azureDiscoveryCommands({
      ...fixture,
      resourceGroups: ["rg-only"]
    });

    expect(JSON.parse(commands[2].stdout ?? "")).toEqual([
      { id: "rg-only", name: "rg-only" }
    ]);
  });

  it("returns independent commands so a suite can fail one stub in place", () => {
    const first = azureDiscoveryCommands(fixture);
    const second = azureDiscoveryCommands(fixture);

    const credentials = first.at(-2);
    if (!credentials) throw new Error("missing get-credentials stub");
    credentials.exitCode = 1;
    credentials.stderr = "selected cluster unavailable";

    expect(second.at(-2)).not.toHaveProperty("exitCode");
    expect(second.at(-2)?.stderr).toBeUndefined();
  });
});

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
