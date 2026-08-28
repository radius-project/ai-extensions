import { describe, expect, it } from "vitest";
import { isUuid } from "../../azure-oidc.js";
import { discoverResources, type DiscoveryDependencies } from "./discovery.js";

describe("discovery service (SU-08)", () => {
  const temporaryKubeconfig: Pick<
    DiscoveryDependencies,
    "createTemporaryKubeconfig"
  > = {
    createTemporaryKubeconfig: () => ({
      path: "/tmp/radius-kubeconfig-test",
      remove: () => {}
    })
  };

  it("can reject unsafe subscription input without an HTTP context or CLI call", async () => {
    const dependencies: DiscoveryDependencies = {
      isUuid,
      ...temporaryKubeconfig,
      runCli: () => {
        throw new Error("CLI must not be reached");
      }
    };

    await expect(
      discoverResources(
        { provider: "azure", subscriptionId: "x&calc" },
        dependencies
      )
    ).resolves.toEqual({
      error: 'Invalid subscriptionId "x&calc" (expected a GUID).',
      clusters: [],
      resourceGroups: [],
      namespaces: [],
      vpcs: [],
      subnets: []
    });
  });

  it.each([
    {
      request: {
        provider: "azure",
        resourceGroup: 'rg" & whoami & "',
        cluster: "aks-valid"
      },
      error: "Invalid Azure resource group name.",
      label: "resource group metacharacters"
    },
    {
      request: {
        provider: "azure",
        resourceGroup: "rg-valid",
        cluster: "-aks-option"
      },
      error: "Invalid AKS cluster name.",
      label: "cluster option injection"
    },
    {
      request: {
        provider: "azure",
        resourceGroup: `r${"g".repeat(90)}`,
        cluster: "aks-valid"
      },
      error: "Invalid Azure resource group name.",
      label: "overlong resource group"
    },
    {
      request: {
        provider: "azure",
        resourceGroup: "rg-valid",
        cluster: `a${"k".repeat(63)}`
      },
      error: "Invalid AKS cluster name.",
      label: "overlong cluster"
    },
    {
      request: {
        provider: "azure",
        resourceGroup: "rg-invalid.",
        cluster: "aks-valid"
      },
      error: "Invalid Azure resource group name.",
      label: "resource group ending in a period"
    },
    {
      request: {
        provider: "azure",
        resourceGroup: "rg-valid",
        cluster: "aks-invalid-"
      },
      error: "Invalid AKS cluster name.",
      label: "cluster ending in a hyphen"
    }
  ])(
    "rejects $label before any CLI or file access",
    async ({ request, error }) => {
      const dependencies: DiscoveryDependencies = {
        isUuid,
        createTemporaryKubeconfig: () => {
          throw new Error("temporary kubeconfig must not be created");
        },
        runCli: () => {
          throw new Error("CLI must not be reached");
        }
      };

      await expect(discoverResources(request, dependencies)).resolves.toEqual({
        error,
        clusters: [],
        resourceGroups: [],
        namespaces: [],
        vpcs: [],
        subnets: []
      });
    }
  );

  it("accepts maximum-length Azure resource group and cluster names", async () => {
    const resourceGroup = `_${"g".repeat(89)}`;
    const cluster = `a_${"k".repeat(61)}`;
    const calls: string[][] = [];
    const dependencies: DiscoveryDependencies = {
      isUuid,
      ...temporaryKubeconfig,
      async runCli(_command, args) {
        calls.push(args);
        if (args[0] === "aks" && args[1] === "list") return "[]";
        if (args[0] === "group") return "[]";
        return "";
      }
    };

    await expect(
      discoverResources(
        { provider: "azure", resourceGroup, cluster },
        dependencies
      )
    ).resolves.toMatchObject({ namespaces: [] });
    expect(calls).toContainEqual([
      "aks",
      "get-credentials",
      "--name",
      cluster,
      "--resource-group",
      resourceGroup,
      "--file",
      "/tmp/radius-kubeconfig-test",
      "--overwrite-existing"
    ]);
  });

  it("queries namespaces from the explicitly selected Azure target", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const dependencies: DiscoveryDependencies = {
      isUuid,
      ...temporaryKubeconfig,
      async runCli(command, args) {
        calls.push({ command, args });
        if (command === "kubectl") return "default selected-team";
        if (args[0] === "aks" && args[1] === "list") {
          return JSON.stringify([
            { id: "aks-first", name: "AKS First", resourceGroup: "rg-first" },
            {
              id: "aks-selected",
              name: "AKS Selected",
              resourceGroup: "rg-selected"
            }
          ]);
        }
        if (args[0] === "group") return "[]";
        return "";
      }
    };

    const result = await discoverResources(
      {
        provider: "azure",
        resourceGroup: "rg-selected",
        cluster: "aks-selected"
      },
      dependencies
    );

    expect(result.namespaces).toEqual(["default", "selected-team"]);
    expect(calls.at(-2)).toEqual({
      command: "az",
      args: [
        "aks",
        "get-credentials",
        "--name",
        "aks-selected",
        "--resource-group",
        "rg-selected",
        "--file",
        "/tmp/radius-kubeconfig-test",
        "--overwrite-existing"
      ]
    });
    expect(calls.at(-1)).toEqual({
      command: "kubectl",
      args: [
        "--kubeconfig",
        "/tmp/radius-kubeconfig-test",
        "get",
        "namespaces",
        "-o",
        "jsonpath={.items[*].metadata.name}"
      ]
    });
  });

  it("leaves namespaces empty until both Azure selections are explicit", async () => {
    const commands: string[] = [];
    const dependencies: DiscoveryDependencies = {
      isUuid,
      ...temporaryKubeconfig,
      async runCli(command, args) {
        commands.push(`${command} ${args.join(" ")}`);
        return "[]";
      }
    };

    const result = await discoverResources(
      { provider: "azure", cluster: "aks-selected" },
      dependencies
    );

    expect(result.namespaces).toEqual([]);
    expect(commands).toHaveLength(2);
  });

  it("isolates overlapping Azure namespace lookups with request-local kubeconfigs", async () => {
    const removed: string[] = [];
    let markFirstCredentialsStarted: () => void = () => {};
    const firstCredentialsStarted = new Promise<void>((resolve) => {
      markFirstCredentialsStarted = resolve;
    });
    let releaseFirstCredentials: () => void = () => {};
    const firstCredentialsReleased = new Promise<void>((resolve) => {
      releaseFirstCredentials = resolve;
    });
    let kubeconfigNumber = 0;
    const dependencies: DiscoveryDependencies = {
      isUuid,
      createTemporaryKubeconfig: () => {
        const path = `/tmp/radius-kubeconfig-${++kubeconfigNumber}`;
        return {
          path,
          remove: () => {
            removed.push(path);
          }
        };
      },
      async runCli(command, args) {
        if (command === "kubectl") {
          const kubeconfig = args[1];
          return kubeconfig.endsWith("-1") ? "namespace-one" : "namespace-two";
        }
        if (args[0] === "aks" && args[1] === "get-credentials") {
          const kubeconfig = args[args.indexOf("--file") + 1];
          if (kubeconfig.endsWith("-1")) {
            markFirstCredentialsStarted();
            await firstCredentialsReleased;
          }
          return "";
        }
        return "[]";
      }
    };

    const first = discoverResources(
      { provider: "azure", resourceGroup: "rg-one", cluster: "aks-one" },
      dependencies
    );
    await firstCredentialsStarted;
    const second = await discoverResources(
      { provider: "azure", resourceGroup: "rg-two", cluster: "aks-two" },
      dependencies
    );
    releaseFirstCredentials();

    await expect(first).resolves.toMatchObject({
      namespaces: ["namespace-one"]
    });
    expect(second.namespaces).toEqual(["namespace-two"]);
    expect(removed).toEqual([
      "/tmp/radius-kubeconfig-2",
      "/tmp/radius-kubeconfig-1"
    ]);
  });

  it("surfaces a temporary kubeconfig cleanup failure", async () => {
    const dependencies: DiscoveryDependencies = {
      isUuid,
      createTemporaryKubeconfig: () => ({
        path: "/tmp/radius-kubeconfig-test",
        remove: () => {
          throw new Error("cleanup failed");
        }
      }),
      async runCli(command, args) {
        if (command === "kubectl") return "default";
        if (args[0] === "aks" && args[1] === "list") return "[]";
        if (args[0] === "group") return "[]";
        return "";
      }
    };

    await expect(
      discoverResources(
        { provider: "azure", resourceGroup: "rg-valid", cluster: "aks-valid" },
        dependencies
      )
    ).rejects.toThrow("cleanup failed");
  });

  it("gives every az query the Windows-sized budget and kubectl its own", async () => {
    const budgets: Array<{ line: string; timeout: number }> = [];
    const dependencies: DiscoveryDependencies = {
      isUuid,
      ...temporaryKubeconfig,
      async runCli(command, args, options) {
        budgets.push({
          line: [command, ...args].join(" "),
          timeout: options.timeout
        });
        if (command === "kubectl") return "default";
        if (args[0] === "aks" && args[1] === "list") return "[]";
        if (args[0] === "group") return "[]";
        return "";
      }
    };

    await discoverResources(
      {
        provider: "azure",
        subscriptionId: "5f2b4b31-1a3a-4a1d-9b5e-6c8f9d0e1a2b",
        resourceGroup: "rg-valid",
        cluster: "aks-valid"
      },
      dependencies
    );

    expect(
      budgets.map(({ line, timeout }) => ({
        step: line.split(" ").slice(0, 3).join(" "),
        timeout
      }))
    ).toEqual([
      // Best-effort context switch keeps its own short budget: its failure is
      // already absorbed by the explicit `--subscription` argument below.
      { step: "az account set", timeout: 10000 },
      { step: "az aks list", timeout: 45000 },
      { step: "az group list", timeout: 45000 },
      { step: "az aks get-credentials", timeout: 45000 },
      {
        step: "kubectl --kubeconfig /tmp/radius-kubeconfig-test",
        timeout: 10000
      }
    ]);
  });

  it("reports the credential step and its limit when the az call is killed", async () => {
    const removed: string[] = [];
    const dependencies: DiscoveryDependencies = {
      isUuid,
      createTemporaryKubeconfig: () => ({
        path: "/tmp/radius-kubeconfig-test",
        remove: () => {
          removed.push("/tmp/radius-kubeconfig-test");
        }
      }),
      async runCli(command, args) {
        if (args[0] === "aks" && args[1] === "get-credentials") {
          // A budget kill arrives with empty stdout and stderr, so the runner
          // rejects with nothing but the spawned command line.
          throw new Error(
            'Command failed: cmd.exe /c az "aks" "get-credentials"'
          );
        }
        if (command === "kubectl") {
          throw new Error("kubectl must not run without credentials");
        }
        return "[]";
      }
    };

    const result = await discoverResources(
      { provider: "azure", resourceGroup: "rg-valid", cluster: "aks-valid" },
      dependencies
    );

    expect(result.namespaces).toEqual([]);
    expect(result.errors?.namespaces).toBe(
      'az aks get-credentials failed (45s limit): Command failed: cmd.exe /c az "aks" "get-credentials"'
    );
    expect(removed).toEqual(["/tmp/radius-kubeconfig-test"]);
  });

  it("reports the kubectl step and its limit once credentials are written", async () => {
    const dependencies: DiscoveryDependencies = {
      isUuid,
      ...temporaryKubeconfig,
      async runCli(command, args) {
        if (command === "kubectl") throw new Error("connection refused");
        if (args[0] === "aks" && args[1] === "list") return "[]";
        if (args[0] === "group") return "[]";
        return "";
      }
    };

    const result = await discoverResources(
      { provider: "azure", resourceGroup: "rg-valid", cluster: "aks-valid" },
      dependencies
    );

    expect(result.namespaces).toEqual([]);
    expect(result.errors?.namespaces).toBe(
      "kubectl get namespaces failed (10s limit): connection refused"
    );
  });

  it("truncates a labelled namespace failure to 800 characters", async () => {
    const dependencies: DiscoveryDependencies = {
      isUuid,
      ...temporaryKubeconfig,
      async runCli(_command, args) {
        if (args[0] === "aks" && args[1] === "get-credentials") {
          throw new Error("x".repeat(1000));
        }
        return "[]";
      }
    };

    const result = await discoverResources(
      { provider: "azure", resourceGroup: "rg-valid", cluster: "aks-valid" },
      dependencies
    );

    const label = "az aks get-credentials failed (45s limit): ";
    expect(result.errors?.namespaces).toBe(
      `${label}${"x".repeat(800 - label.length)}`
    );
  });

  it("creates the errors bag for a namespace failure that follows successful facets", async () => {
    const dependencies: DiscoveryDependencies = {
      isUuid,
      ...temporaryKubeconfig,
      async runCli(_command, args) {
        if (args[0] === "aks" && args[1] === "get-credentials") {
          throw "credentials exploded";
        }
        return "[]";
      }
    };

    const result = await discoverResources(
      { provider: "azure", resourceGroup: "rg-valid", cluster: "aks-valid" },
      dependencies
    );

    expect(result.errors).toEqual({
      namespaces:
        "az aks get-credentials failed (45s limit): credentials exploded"
    });
  });
});
