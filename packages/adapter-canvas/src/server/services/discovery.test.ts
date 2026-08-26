import { describe, expect, it } from "vitest";
import { isUuid } from "../../azure-oidc.js";
import { discoverResources, type DiscoveryDependencies } from "./discovery.js";

describe("discovery service (SU-08)", () => {
  const temporaryKubeconfig: Pick<
    DiscoveryDependencies,
    "createTemporaryKubeconfigPath" | "removeTemporaryKubeconfig"
  > = {
    createTemporaryKubeconfigPath: () => "/tmp/radius-kubeconfig-test",
    removeTemporaryKubeconfig: () => {}
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
      namespaces: ["default"],
      vpcs: [],
      subnets: []
    });
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
      createTemporaryKubeconfigPath: () =>
        `/tmp/radius-kubeconfig-${++kubeconfigNumber}`,
      removeTemporaryKubeconfig: (path) => {
        removed.push(path);
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
});
