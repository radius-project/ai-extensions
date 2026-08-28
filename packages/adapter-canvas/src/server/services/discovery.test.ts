import { describe, expect, it } from "vitest";
import { isUuid } from "../../azure-oidc.js";
import {
  azureDiscoveryContract,
  temporaryKubeconfigDouble,
  TEST_KUBECONFIG_PATH
} from "../../../test/support/azure-discovery-contract.js";
import { discoverResources, type DiscoveryDependencies } from "./discovery.js";

describe("discovery service (SU-08)", () => {
  const temporaryKubeconfig: Pick<
    DiscoveryDependencies,
    "createTemporaryKubeconfig"
  > = {
    createTemporaryKubeconfig: () => temporaryKubeconfigDouble()
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
    expect(calls).toContainEqual(
      azureDiscoveryContract({ cluster, resourceGroup }).getCredentials?.args
    );
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
    const contract = azureDiscoveryContract({
      cluster: "aks-selected",
      resourceGroup: "rg-selected"
    });
    expect(calls.at(-2)).toEqual({
      command: contract.getCredentials?.tool,
      args: contract.getCredentials?.args
    });
    expect(calls.at(-1)).toEqual({
      command: contract.namespaces?.tool,
      args: contract.namespaces?.args
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
        path: TEST_KUBECONFIG_PATH,
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
});
