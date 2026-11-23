import path from "node:path";
import type { AwsCleanupCluster } from "./aws-cloud-cleanup.js";
import type {
  CommandResult,
  CommandRunner
} from "./aws-cloud-cleanup-ports.js";
import type { AwsProbeKubernetes } from "./aws-connection-probe.js";
import type { AwsNodeKubernetes } from "./aws-node-groups.js";

// The journey's Kubernetes port over `kubectl`: the nodes the node groups
// start, and the connection probes' Jobs. It signs in to each cluster with
// `aws eks update-kubeconfig` into its own file, as the cleanup's port does,
// so an inherited KUBECONFIG never points it at another cluster.

export interface KubectlJourneyOptions {
  readonly run: CommandRunner;
  // A directory for kubeconfig files and probe manifests.
  directory(): Promise<string>;
  writeFile(file: string, contents: string): Promise<void>;
}

function detail(result: CommandResult): string {
  return (result.stderr || result.stdout).trim() || `exit ${result.code}`;
}

function json(result: CommandResult, what: string): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${what} did not return JSON.`);
  }
}

export function createKubectlJourneyKubernetes(
  options: KubectlJourneyOptions
): AwsNodeKubernetes & AwsProbeKubernetes {
  const configs = new Map<string, Promise<string>>();

  function kubeconfig(cluster: AwsCleanupCluster): Promise<string> {
    const key = `${cluster.region}/${cluster.name}`;
    let config = configs.get(key);
    if (!config) {
      config = (async () => {
        const file = path.join(
          await options.directory(),
          `${cluster.region}-${cluster.name}-journey.kubeconfig`
        );
        const result = await options.run("aws", [
          "eks",
          "update-kubeconfig",
          "--region",
          cluster.region,
          "--name",
          cluster.name,
          "--kubeconfig",
          file
        ]);
        if (result.code !== 0)
          throw new Error(
            `Could not sign in to cluster ${cluster.name}: ${detail(result)}`
          );
        return file;
      })();
      // A failed sign-in is tried again by the next call.
      config.catch(() => configs.delete(key));
      configs.set(key, config);
    }
    return config;
  }

  async function kubectl(
    cluster: AwsCleanupCluster,
    what: string,
    args: readonly string[]
  ): Promise<CommandResult> {
    const result = await options.run("kubectl", [
      "--kubeconfig",
      await kubeconfig(cluster),
      ...args,
      "--request-timeout=60s"
    ]);
    if (result.code !== 0)
      throw new Error(`${what} on ${cluster.name}: ${detail(result)}`);
    return result;
  }

  return {
    async listNodes(cluster, selector) {
      return json(
        await kubectl(cluster, "Listing nodes", [
          "get",
          "nodes",
          "--selector",
          selector,
          "--output",
          "json"
        ]),
        "kubectl get nodes"
      );
    },

    async createJob(cluster, job) {
      const file = path.join(
        await options.directory(),
        `${job.metadata.name}.json`
      );
      await options.writeFile(file, JSON.stringify(job));
      await kubectl(cluster, `Creating Job ${job.metadata.name}`, [
        "create",
        "--filename",
        file
      ]);
    },

    async listJobPods(cluster, namespace, job) {
      return json(
        await kubectl(cluster, `Listing the pods of Job ${job}`, [
          "get",
          "pods",
          "--namespace",
          namespace,
          "--selector",
          `batch.kubernetes.io/job-name=${job}`,
          "--output",
          "json"
        ]),
        "kubectl get pods"
      );
    },

    async readPodLog(cluster, namespace, pod) {
      return (
        await kubectl(cluster, `Reading the log of pod ${pod}`, [
          "logs",
          pod,
          "--namespace",
          namespace
        ])
      ).stdout;
    },

    async deleteJob(cluster, namespace, job) {
      await kubectl(cluster, `Deleting Job ${job}`, [
        "delete",
        "job",
        job,
        "--namespace",
        namespace,
        "--cascade=background",
        "--ignore-not-found",
        "--wait=false"
      ]);
    }
  };
}
