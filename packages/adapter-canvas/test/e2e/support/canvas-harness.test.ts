import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import {
  discoverResources,
  type DiscoveryDependencies
} from "../../../src/server/services/discovery.js";
import { isUuid } from "../../../src/azure-oidc.js";
import {
  azureDiscoveryContract,
  temporaryKubeconfigDouble,
  TEST_KUBECONFIG_PATH
} from "../../support/azure-discovery-contract.js";
import {
  applyHarnessProcessPlan,
  assertCloudWorkspaceClone,
  assertFakeModeAvailable,
  azureDiscoveryCommands,
  CREDENTIAL_STORE_PATH,
  E2E_TMP_ROOT,
  fakeCliArgsMatch,
  FAKE_CLI_TOOLS,
  PLACEHOLDER_SECRET,
  planHarnessProcess,
  removeDirectoryWithRetries,
  replaceSharedCredentials,
  resolveHarnessWorkspace,
  stopHarnessServer,
  unwindHarnessConstruction,
  type FakeCliCommand,
  type HarnessProcessPlanInput
} from "./canvas-harness.js";

describe("fake CLI isolation", () => {
  it("intercepts every cloud command used by environment discovery", () => {
    expect(FAKE_CLI_TOOLS).toEqual(["gh", "rad", "az", "aws", "kubectl"]);
  });
});

describe("fakeCliArgsMatch", () => {
  it("requires an exact list when one is given", () => {
    expect(fakeCliArgsMatch({ args: ["a", "b"] }, ["a", "b"])).toBe(true);
    expect(fakeCliArgsMatch({ args: ["a", "b"] }, ["a", "b", "c"])).toBe(false);
  });

  it("anchors both ends around an unpredictable span", () => {
    const command = { argsPrefix: ["--file"], argsSuffix: ["--overwrite"] };

    expect(fakeCliArgsMatch(command, ["--file", "/tmp/x", "--overwrite"])).toBe(
      true
    );
    expect(fakeCliArgsMatch(command, ["--file", "/tmp/x", "--other"])).toBe(
      false
    );
  });

  it("rejects a list too short to satisfy both ends without overlapping", () => {
    expect(
      fakeCliArgsMatch({ argsPrefix: ["get"], argsSuffix: ["get"] }, ["get"])
    ).toBe(false);
  });

  it("still matches a prefix-only stub and an argument-free command", () => {
    expect(fakeCliArgsMatch({ argsPrefix: ["app"] }, ["app", "graph"])).toBe(
      true
    );
    expect(fakeCliArgsMatch({}, [])).toBe(true);
    expect(fakeCliArgsMatch({}, ["version"])).toBe(false);
  });
});

describe("azureDiscoveryCommands", () => {
  const SUBSCRIPTION = "22222222-2222-2222-2222-222222222222";
  const first = { id: "aks-first", name: "AKS First", resourceGroup: "rg-1" };
  const selected = {
    id: "aks-selected",
    name: "AKS Selected",
    resourceGroup: "rg-2"
  };

  // Drives the production discovery service and records what it actually ran,
  // so these assertions fail when `discovery.ts` changes rather than restating
  // the factory back to itself.
  async function recordRealInvocations(
    namespaces: string
  ): Promise<Array<{ tool: string; args: string[] }>> {
    const calls: Array<{ tool: string; args: string[] }> = [];
    const dependencies: DiscoveryDependencies = {
      isUuid,
      createTemporaryKubeconfig: () => temporaryKubeconfigDouble(),
      async runCli(tool, args) {
        calls.push({ tool, args });
        if (tool === "kubectl") return namespaces;
        if (args[0] === "aks" && args[1] === "list") {
          return JSON.stringify([first, selected]);
        }
        if (args[0] === "group") return JSON.stringify([]);
        return "";
      }
    };
    await discoverResources(
      {
        provider: "azure",
        subscriptionId: SUBSCRIPTION,
        cluster: selected.id,
        resourceGroup: selected.resourceGroup
      },
      dependencies
    );
    return calls;
  }

  function matching(
    commands: FakeCliCommand[],
    call: { tool: string; args: string[] }
  ): FakeCliCommand[] {
    return commands.filter(
      (command) =>
        command.tool === call.tool && fakeCliArgsMatch(command, call.args)
    );
  }

  it("models every command the discovery service actually issues", async () => {
    const calls = await recordRealInvocations("default selected-team");
    const commands = azureDiscoveryCommands({
      subscriptionId: SUBSCRIPTION,
      clusters: [first, selected],
      selected,
      namespaces: ["default", "selected-team"]
    });

    expect(calls).toHaveLength(commands.length);
    for (const call of calls) {
      expect(
        matching(commands, call),
        `no stub models ${call.tool} ${call.args.join(" ")}`
      ).toHaveLength(1);
    }
  });

  it("stops modeling a namespace command whose output format changed", async () => {
    const calls = await recordRealInvocations("default selected-team");
    const commands = azureDiscoveryCommands({
      subscriptionId: SUBSCRIPTION,
      clusters: [first, selected],
      selected,
      namespaces: ["default"]
    });
    const namespaceCall = calls.at(-1);
    if (!namespaceCall) throw new Error("discovery ran no commands");
    const drifted = {
      ...namespaceCall,
      args: namespaceCall.args.map((value) =>
        value.startsWith("jsonpath=") ? "-o=name" : value
      )
    };

    expect(matching(commands, namespaceCall)).toHaveLength(1);
    expect(matching(commands, drifted)).toHaveLength(0);
  });

  it("stops at the listing steps when no cluster is selected", () => {
    const commands = azureDiscoveryCommands({
      subscriptionId: SUBSCRIPTION,
      clusters: [first, selected]
    });

    expect(commands.map((command) => command.tool)).toEqual(["az", "az", "az"]);
    expect(commands.at(-1)?.args).toEqual(
      azureDiscoveryContract({ subscriptionId: SUBSCRIPTION }).groupList.args
    );
  });

  it("omits the subscription context call when no subscription is given", () => {
    const commands = azureDiscoveryCommands({ clusters: [first] });

    expect(commands[0].args?.slice(0, 2)).toEqual(["aks", "list"]);
    expect(
      commands.every((command) => !command.args?.includes("--subscription"))
    ).toBe(true);
  });

  it("serves the listing the fixture declares and derives its resource groups", () => {
    const commands = azureDiscoveryCommands({
      clusters: [first, selected],
      selected,
      namespaces: ["default"]
    });

    expect(JSON.parse(commands[0].stdout ?? "")).toEqual([first, selected]);
    expect(JSON.parse(commands[1].stdout ?? "")).toEqual([
      { id: "rg-1", name: "rg-1" },
      { id: "rg-2", name: "rg-2" }
    ]);
  });

  it("honors an explicit resource group list", () => {
    const commands = azureDiscoveryCommands({
      clusters: [first],
      resourceGroups: ["rg-only"]
    });

    expect(JSON.parse(commands.at(-1)?.stdout ?? "")).toEqual([
      { id: "rg-only", name: "rg-only" }
    ]);
  });

  it("refuses a selection the cluster listing never offered", () => {
    expect(() =>
      azureDiscoveryCommands({ clusters: [first], selected })
    ).toThrow(/not in the fixture listing/);
  });

  it("leaves the generated kubeconfig path unpinned and everything else pinned", () => {
    const commands = azureDiscoveryCommands({
      clusters: [selected],
      selected,
      namespaces: ["default"]
    });
    const contract = azureDiscoveryContract({
      cluster: selected.id,
      resourceGroup: selected.resourceGroup,
      kubeconfigPath: "/tmp/some-other-path"
    });

    for (const command of commands.slice(-2)) {
      expect(command.argsPrefix).not.toContain(TEST_KUBECONFIG_PATH);
      expect(command.argsSuffix).not.toContain(TEST_KUBECONFIG_PATH);
    }
    expect(
      fakeCliArgsMatch(commands.at(-2)!, contract.getCredentials!.args)
    ).toBe(true);
    expect(fakeCliArgsMatch(commands.at(-1)!, contract.namespaces!.args)).toBe(
      true
    );
  });

  it("returns independent commands so a suite can fail one stub in place", () => {
    const fixture = {
      clusters: [selected],
      selected,
      namespaces: ["default"]
    };
    const first = azureDiscoveryCommands(fixture);
    const second = azureDiscoveryCommands(fixture);

    const credentials = first.at(-2);
    if (!credentials) throw new Error("missing get-credentials stub");
    credentials.exitCode = 1;

    expect(second.at(-2)).not.toHaveProperty("exitCode");
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

const FAKE_PLAN_INPUT: HarnessProcessPlanInput = {
  mode: "fake",
  fakeBin: "/tmp/root/bin",
  ghConfigDir: "/tmp/root/gh-config",
  fakeScript: "/tmp/e2e/fake-cli.mjs",
  scenarioPath: "/tmp/root/scenario.json",
  cliLogPath: "/tmp/root/cli.log",
  pathKey: "PATH",
  currentPath: "/usr/bin",
  isWindows: false
};

const CLOUD_PLAN_INPUT: HarnessProcessPlanInput = {
  mode: "cloud",
  fakeBin: "/tmp/root/bin",
  ghConfigDir: "/tmp/root/gh-config",
  pathKey: "PATH",
  currentPath: "/usr/bin",
  isWindows: false,
  githubToken: "gho_realtoken"
};

describe("planHarnessProcess in fake mode", () => {
  it("prepends the shim directory to both path spellings", () => {
    const plan = planHarnessProcess(FAKE_PLAN_INPUT);

    expect(plan.env.PATH).toBe(`/tmp/root/bin${path.delimiter}/usr/bin`);
    expect(plan.useFakeCli).toBe(true);
    expect(plan.interceptFetch).toBe(true);
  });

  it("writes the platform path variable Windows actually reads", () => {
    const plan = planHarnessProcess({
      ...FAKE_PLAN_INPUT,
      pathKey: "Path",
      isWindows: true
    });

    expect(plan.env.Path).toBe(plan.env.PATH);
    expect(plan.env.RADIUS_RAD_BINARY).toBe(
      path.join("/tmp/root/bin", "rad.exe")
    );
  });

  it("names the extensionless shim off Windows", () => {
    expect(planHarnessProcess(FAKE_PLAN_INPUT).env.RADIUS_RAD_BINARY).toBe(
      path.join("/tmp/root/bin", "rad")
    );
  });

  it("points every fake CLI variable at the generated script", () => {
    const plan = planHarnessProcess(FAKE_PLAN_INPUT);

    expect(plan.env.RADIUS_FAKE_CLI_SCRIPT).toBe("/tmp/e2e/fake-cli.mjs");
    expect(plan.env.RADIUS_FAKE_CLI_SCENARIO).toBe("/tmp/root/scenario.json");
    expect(plan.env.RADIUS_FAKE_CLI_LOG).toBe("/tmp/root/cli.log");
    expect(plan.env.RADIUS_RAD_SKIP_VERSION_CHECK).toBe("1");
  });

  it("uses the placeholder token even when a real one is exported", () => {
    const plan = planHarnessProcess({
      ...FAKE_PLAN_INPUT,
      githubToken: "gho_realtoken"
    });

    expect(plan.env.GH_TOKEN).not.toContain("realtoken");
    expect(plan.env.GH_TOKEN).toBe(plan.env.GITHUB_TOKEN);
  });

  it.each([
    ["fakeScript", { fakeScript: undefined }],
    ["scenarioPath", { scenarioPath: undefined }],
    ["cliLogPath", { cliLogPath: undefined }]
  ])("rejects a plan missing %s", (_name, override) => {
    expect(() =>
      planHarnessProcess({ ...FAKE_PLAN_INPUT, ...override })
    ).toThrow(/Fake mode requires/);
  });
});

describe("planHarnessProcess in cloud mode", () => {
  it("leaves the real tools on PATH and the registry unintercepted", () => {
    const plan = planHarnessProcess(CLOUD_PLAN_INPUT);

    expect(plan.env.PATH).toBeUndefined();
    expect(plan.env.Path).toBeUndefined();
    expect(plan.useFakeCli).toBe(false);
    expect(plan.interceptFetch).toBe(false);
  });

  it("omits every fake CLI variable rather than blanking it", () => {
    const plan = planHarnessProcess(CLOUD_PLAN_INPUT);

    for (const key of [
      "RADIUS_FAKE_CLI_SCRIPT",
      "RADIUS_FAKE_CLI_SCENARIO",
      "RADIUS_FAKE_CLI_LOG",
      "RADIUS_RAD_BINARY",
      "RADIUS_RAD_SKIP_VERSION_CHECK"
    ]) {
      expect(Object.hasOwn(plan.env, key)).toBe(false);
      expect(plan.unsetEnv).toContain(key);
    }
  });

  it("carries the runner token through to both variables", () => {
    const plan = planHarnessProcess(CLOUD_PLAN_INPUT);

    expect(plan.env.GH_TOKEN).toBe("gho_realtoken");
    expect(plan.env.GITHUB_TOKEN).toBe("gho_realtoken");
  });

  it("trims surrounding whitespace from the token", () => {
    const plan = planHarnessProcess({
      ...CLOUD_PLAN_INPUT,
      githubToken: "  gho_realtoken\n"
    });

    expect(plan.env.GH_TOKEN).toBe("gho_realtoken");
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["only whitespace", "   "]
  ])("fails when the token is %s", (_name, githubToken) => {
    expect(() =>
      planHarnessProcess({ ...CLOUD_PLAN_INPUT, githubToken })
    ).toThrow(/Cloud mode requires GH_TOKEN/);
  });

  it("refuses the fake-mode placeholder token", () => {
    expect(() =>
      planHarnessProcess({
        ...CLOUD_PLAN_INPUT,
        githubToken: PLACEHOLDER_SECRET
      })
    ).toThrow(/placeholder token/);
  });

  it("refuses a placeholder token surrounded by whitespace", () => {
    expect(() =>
      planHarnessProcess({
        ...CLOUD_PLAN_INPUT,
        githubToken: ` ${PLACEHOLDER_SECRET}\n`
      })
    ).toThrow(/placeholder token/);
  });
});

describe("applyHarnessProcessPlan", () => {
  it("clears an inherited fake CLI variable in cloud mode", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      RADIUS_FAKE_CLI_SCRIPT: "/stale/fake-cli.mjs",
      RADIUS_RAD_BINARY: "/stale/bin/rad",
      RADIUS_RAD_SKIP_VERSION_CHECK: "1"
    };

    applyHarnessProcessPlan(planHarnessProcess(CLOUD_PLAN_INPUT), env);

    expect(env.RADIUS_FAKE_CLI_SCRIPT).toBeUndefined();
    expect(env.RADIUS_RAD_BINARY).toBeUndefined();
    expect(env.RADIUS_RAD_SKIP_VERSION_CHECK).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GH_TOKEN).toBe("gho_realtoken");
  });

  it("keeps the fake CLI variables it just planned", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

    applyHarnessProcessPlan(planHarnessProcess(FAKE_PLAN_INPUT), env);

    expect(env.RADIUS_FAKE_CLI_SCRIPT).toBe("/tmp/e2e/fake-cli.mjs");
    expect(env.PATH).toBe(`/tmp/root/bin${path.delimiter}/usr/bin`);
  });

  it("defaults to the current process environment", () => {
    const original = process.env.RADIUS_FAKE_CLI_SCRIPT;
    process.env.RADIUS_FAKE_CLI_SCRIPT = "/stale/fake-cli.mjs";
    const originalToken = process.env.GH_TOKEN;
    try {
      applyHarnessProcessPlan({
        env: { GH_TOKEN: "gho_applied" },
        unsetEnv: ["RADIUS_FAKE_CLI_SCRIPT"],
        useFakeCli: false,
        interceptFetch: false
      });

      expect(process.env.RADIUS_FAKE_CLI_SCRIPT).toBeUndefined();
      expect(process.env.GH_TOKEN).toBe("gho_applied");
    } finally {
      if (original === undefined) delete process.env.RADIUS_FAKE_CLI_SCRIPT;
      else process.env.RADIUS_FAKE_CLI_SCRIPT = original;
      if (originalToken === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = originalToken;
    }
  });
});

describe("planHarnessProcess credential isolation", () => {
  it.each([
    ["fake", FAKE_PLAN_INPUT] as const,
    ["cloud", CLOUD_PLAN_INPUT] as const
  ])(
    "keeps the isolated gh config and credential store in %s mode",
    (_name, input) => {
      const plan = planHarnessProcess(input);

      expect(plan.env.GH_CONFIG_DIR).toBe("/tmp/root/gh-config");
      expect(plan.env.RADIUS_CREDENTIALS_FILE).toBe(CREDENTIAL_STORE_PATH);
    }
  );

  it("preserves a credential store the suite already isolated", () => {
    const plan = planHarnessProcess({
      ...FAKE_PLAN_INPUT,
      credentialsFile: "/tmp/e2e/existing-cache.json"
    });

    expect(plan.env.RADIUS_CREDENTIALS_FILE).toBe(
      "/tmp/e2e/existing-cache.json"
    );
  });
});

describe("resolveHarnessWorkspace", () => {
  it("scaffolds a temporary workspace in fake mode", () => {
    const plan = resolveHarnessWorkspace({
      mode: "fake",
      rootDir: path.join("/tmp", "root")
    });

    expect(plan.path).toBe(path.join("/tmp", "root", "workspace"));
    expect(plan.createRadiusDirectory).toBe(true);
    expect(plan.initializeGitRepository).toBe(true);
  });

  it("uses the clone unchanged in cloud mode", () => {
    const clone = path.resolve("fixture-clone");

    const plan = resolveHarnessWorkspace({
      mode: "cloud",
      rootDir: path.join("/tmp", "root"),
      workspacePath: clone
    });

    expect(plan.path).toBe(clone);
    expect(plan.createRadiusDirectory).toBe(false);
    expect(plan.initializeGitRepository).toBe(false);
  });

  it("rejects a workspace path in fake mode", () => {
    expect(() =>
      resolveHarnessWorkspace({
        mode: "fake",
        rootDir: path.join("/tmp", "root"),
        workspacePath: path.resolve("fixture-clone")
      })
    ).toThrow(/only supported in cloud mode/);
  });

  it("rejects cloud mode without a clone", () => {
    expect(() =>
      resolveHarnessWorkspace({
        mode: "cloud",
        rootDir: path.join("/tmp", "root")
      })
    ).toThrow(/requires workspacePath/);
  });

  it("rejects a relative clone path, which would resolve against the runner cwd", () => {
    expect(() =>
      resolveHarnessWorkspace({
        mode: "cloud",
        rootDir: path.join("/tmp", "root"),
        workspacePath: "fixture-clone"
      })
    ).toThrow(/absolute workspacePath/);
  });

  it.each([
    ["the checkout itself", (root: string) => root],
    [
      "a directory inside the checkout",
      (root: string) => path.join(root, "packages", "clone")
    ],
    ["an ancestor of the checkout", (root: string) => path.dirname(root)]
  ])(
    "refuses a cloud workspace that is %s, which a real deploy would mutate",
    (_name, pick) => {
      const repositoryRoot = path.resolve("/repos", "ai-extensions");

      expect(() =>
        resolveHarnessWorkspace({
          mode: "cloud",
          rootDir: path.join("/tmp", "root"),
          workspacePath: pick(repositoryRoot),
          repositoryRoot
        })
      ).toThrow(/overlaps/);
    }
  );

  it("accepts a clone that is a sibling of the checkout", () => {
    const repositoryRoot = path.resolve("/repos", "ai-extensions");
    const clone = path.resolve("/repos", "fixture-clone");

    const plan = resolveHarnessWorkspace({
      mode: "cloud",
      rootDir: path.join("/tmp", "root"),
      workspacePath: clone,
      repositoryRoot
    });

    expect(plan.path).toBe(clone);
  });

  it("normalizes a traversing clone path before comparing it", () => {
    const repositoryRoot = path.resolve("/repos", "ai-extensions");

    expect(() =>
      resolveHarnessWorkspace({
        mode: "cloud",
        rootDir: path.join("/tmp", "root"),
        workspacePath: path.join(repositoryRoot, "..", "ai-extensions", "sub"),
        repositoryRoot
      })
    ).toThrow(/overlaps/);
  });
});

describe("assertCloudWorkspaceClone", () => {
  it("accepts a directory carrying a git entry", async () => {
    const seen: string[] = [];

    await expect(
      assertCloudWorkspaceClone(path.resolve("/repos", "clone"), async (t) => {
        seen.push(t);
      })
    ).resolves.toBeUndefined();
    expect(seen).toEqual([path.join(path.resolve("/repos", "clone"), ".git")]);
  });

  it("refuses a directory that is not a clone", async () => {
    await expect(
      assertCloudWorkspaceClone(path.resolve("/tmp", "empty"), () =>
        Promise.reject(new Error("ENOENT"))
      )
    ).rejects.toThrow(/has no .git entry/);
  });

  it("reports a missing directory through the real filesystem", async () => {
    await expect(
      assertCloudWorkspaceClone(
        path.join(E2E_TMP_ROOT, "definitely-absent-clone")
      )
    ).rejects.toThrow(/requires workspacePath to be a git clone/);
  });
});

describe("assertFakeModeAvailable", () => {
  it("allows a fake-CLI helper in fake mode", () => {
    expect(() => assertFakeModeAvailable("fake", "cliCalls")).not.toThrow();
  });

  it("names the helper and the mode when called against a cloud harness", () => {
    expect(() => assertFakeModeAvailable("cloud", "cliCalls")).toThrow(
      "cliCalls is only available in fake mode; this harness is in cloud mode."
    );
  });
});
