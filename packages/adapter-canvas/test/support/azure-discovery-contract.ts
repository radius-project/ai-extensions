import type { DiscoveryItem } from "../../src/server/services/discovery.js";

// The argument vectors `discoverResources` issues for the Azure provider, in
// the order it issues them. Every suite that fakes those commands — unit,
// route, HTTP integration, Chromium end-to-end, and visual — builds them from
// here, so a change to the CLI contract in
// `src/server/services/discovery.ts` breaks one place instead of drifting past
// whichever suite was not updated with it (issue #579).

/**
 * A cluster as `az aks list` reports it. Discovery parses the response into
 * `DiscoveryItem`, whose resource group is optional because the resource-group
 * listing omits it; every cluster carries one.
 */
export type AzureDiscoveryCluster = DiscoveryItem & { resourceGroup: string };

/** The path the `createTemporaryKubeconfig` double below hands to discovery. */
export const TEST_KUBECONFIG_PATH = "/tmp/radius-kubeconfig-test";

export interface AzureDiscoveryTarget {
  subscriptionId?: string;
  /**
   * Discovery only fetches credentials and namespaces when both a cluster and
   * its resource group are selected, so both are optional here and the last two
   * invocations are absent without them.
   */
  cluster?: string;
  resourceGroup?: string;
  kubeconfigPath?: string;
}

export interface AzureDiscoveryInvocation {
  tool: string;
  args: string[];
}

export interface AzureDiscoveryContract {
  /** Absent when no subscription is supplied: discovery skips the context call. */
  accountSet?: AzureDiscoveryInvocation;
  aksList: AzureDiscoveryInvocation;
  groupList: AzureDiscoveryInvocation;
  /** Absent unless both `cluster` and `resourceGroup` are selected. */
  getCredentials?: AzureDiscoveryInvocation;
  namespaces?: AzureDiscoveryInvocation;
}

export function azureDiscoveryContract(
  target: AzureDiscoveryTarget = {}
): AzureDiscoveryContract {
  const kubeconfigPath = target.kubeconfigPath ?? TEST_KUBECONFIG_PATH;
  const subArgs =
    target.subscriptionId ? ["--subscription", target.subscriptionId] : [];
  const contract: AzureDiscoveryContract = {
    aksList: {
      tool: "az",
      args: [
        "aks",
        "list",
        "--query",
        "[].{id:name, name:name, resourceGroup:resourceGroup}",
        "-o",
        "json",
        ...subArgs
      ]
    },
    groupList: {
      tool: "az",
      args: [
        "group",
        "list",
        "--query",
        "[].{id:name, name:name}",
        "-o",
        "json",
        ...subArgs
      ]
    }
  };
  if (target.subscriptionId) {
    contract.accountSet = {
      tool: "az",
      args: ["account", "set", "--subscription", target.subscriptionId]
    };
  }
  if (target.cluster && target.resourceGroup) {
    contract.getCredentials = {
      tool: "az",
      args: [
        "aks",
        "get-credentials",
        "--name",
        target.cluster,
        "--resource-group",
        target.resourceGroup,
        "--file",
        kubeconfigPath,
        "--overwrite-existing",
        ...subArgs
      ]
    };
    contract.namespaces = {
      tool: "kubectl",
      args: [
        "--kubeconfig",
        kubeconfigPath,
        "get",
        "namespaces",
        "-o",
        "jsonpath={.items[*].metadata.name}"
      ]
    };
  }
  return contract;
}

/** The joined command line the string-keyed CLI doubles script themselves on. */
export function commandLine(invocation: AzureDiscoveryInvocation): string {
  return [invocation.tool, ...invocation.args].join(" ");
}

/** The `createTemporaryKubeconfig` double paired with `TEST_KUBECONFIG_PATH`. */
export function temporaryKubeconfigDouble(
  kubeconfigPath: string = TEST_KUBECONFIG_PATH
): { readonly path: string; remove: () => void } {
  return { path: kubeconfigPath, remove: () => {} };
}
