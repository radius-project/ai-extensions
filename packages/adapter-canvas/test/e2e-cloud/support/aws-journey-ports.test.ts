import { describe, expect, it } from "vitest";
import { MAIN, SECOND } from "../../support/aws/cleanup-scenario.js";
import type { CommandResult } from "./aws-cloud-cleanup-ports.js";
import { connectionProbeJob } from "./aws-connection-probe.js";
import { createKubectlJourneyKubernetes } from "./aws-journey-ports.js";

const DIRECTORY = "/work/kube";
const MAIN_CONFIG = `${DIRECTORY}/${MAIN.region}-${MAIN.name}-journey.kubeconfig`;

function harness(
  answer: (
    command: string,
    args: readonly string[]
  ) => Partial<CommandResult> = () => ({})
) {
  const calls: string[] = [];
  const files = new Map<string, string>();
  const port = createKubectlJourneyKubernetes({
    run: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "", ...answer(command, args) };
    },
    directory: async () => DIRECTORY,
    writeFile: async (file, contents) => {
      files.set(file, contents);
    }
  });
  return { calls, files, port };
}

describe("createKubectlJourneyKubernetes", () => {
  it("signs in to each cluster once, into its own kubeconfig, and lists nodes by pool", async () => {
    const { calls, port } = harness((command) =>
      command === "kubectl" ? { stdout: '{"items":[]}' } : {}
    );
    expect(await port.listNodes(MAIN, "radius-e2e/pool=default")).toEqual({
      items: []
    });
    await port.listNodes(MAIN, "radius-e2e/pool=isolated");
    await port.listNodes(SECOND, "radius-e2e/pool=default");
    expect(calls).toEqual([
      `aws eks update-kubeconfig --region ${MAIN.region} --name ${MAIN.name} --kubeconfig ${MAIN_CONFIG}`,
      `kubectl --kubeconfig ${MAIN_CONFIG} get nodes --selector radius-e2e/pool=default --output json --request-timeout=60s`,
      `kubectl --kubeconfig ${MAIN_CONFIG} get nodes --selector radius-e2e/pool=isolated --output json --request-timeout=60s`,
      `aws eks update-kubeconfig --region ${SECOND.region} --name ${SECOND.name} --kubeconfig ${DIRECTORY}/${SECOND.region}-${SECOND.name}-journey.kubeconfig`,
      `kubectl --kubeconfig ${DIRECTORY}/${SECOND.region}-${SECOND.name}-journey.kubeconfig get nodes --selector radius-e2e/pool=default --output json --request-timeout=60s`
    ]);
  });

  it("tries a failed sign-in again on the next call", async () => {
    let attempts = 0;
    const { port } = harness((command) => {
      if (command === "aws" && ++attempts === 1)
        return { code: 255, stderr: "ExpiredToken" };
      return command === "kubectl" ? { stdout: "{}" } : {};
    });
    await expect(port.listNodes(MAIN, "a=b")).rejects.toThrow(
      `Could not sign in to cluster ${MAIN.name}: ExpiredToken`
    );
    expect(await port.listNodes(MAIN, "a=b")).toEqual({});
    expect(attempts).toBe(2);
  });

  it("creates a probe Job from a manifest file, and reads, logs, and deletes it", async () => {
    const { calls, files, port } = harness((command, args) =>
      command !== "kubectl" ? {}
      : args.includes("pods") ? { stdout: '{"items":[]}' }
      : args.includes("logs") ? { stdout: "RADIUS_PROBE connected\n" }
      : {}
    );
    const job = connectionProbeJob({
      name: "radius-probe-default-0-run1",
      namespace: "default",
      application: "cloud-e2e",
      environment: "radtest-aws-run1-main",
      pool: "default",
      image: `busybox@sha256:${"a".repeat(64)}`,
      service: {
        type: "Radius.Data/mySqlDatabases",
        name: "db",
        host: "h",
        port: 3306
      }
    });
    await port.createJob(MAIN, job);
    expect(await port.listJobPods(MAIN, "default", job.metadata.name)).toEqual({
      items: []
    });
    expect(await port.readPodLog(MAIN, "default", "pod-1")).toBe(
      "RADIUS_PROBE connected\n"
    );
    await port.deleteJob(MAIN, "default", job.metadata.name);
    const manifest = `${DIRECTORY}/${job.metadata.name}.json`;
    expect(JSON.parse(files.get(manifest) ?? "")).toEqual(job);
    expect(calls.slice(1)).toEqual([
      `kubectl --kubeconfig ${MAIN_CONFIG} create --filename ${manifest} --request-timeout=60s`,
      `kubectl --kubeconfig ${MAIN_CONFIG} get pods --namespace default --selector batch.kubernetes.io/job-name=${job.metadata.name} --output json --request-timeout=60s`,
      `kubectl --kubeconfig ${MAIN_CONFIG} logs pod-1 --namespace default --request-timeout=60s`,
      `kubectl --kubeconfig ${MAIN_CONFIG} delete job ${job.metadata.name} --namespace default --cascade=background --ignore-not-found --wait=false --request-timeout=60s`
    ]);
  });

  it("throws what kubectl said, or that it didn't answer JSON", async () => {
    const failing = harness((command) =>
      command === "kubectl" ? { code: 1, stderr: "forbidden" } : {}
    ).port;
    await expect(failing.deleteJob(MAIN, "default", "job-1")).rejects.toThrow(
      `Deleting Job job-1 on ${MAIN.name}: forbidden`
    );
    const silent = harness((command) =>
      command === "kubectl" ? { code: 1 } : {}
    ).port;
    await expect(silent.readPodLog(MAIN, "default", "pod-1")).rejects.toThrow(
      `Reading the log of pod pod-1 on ${MAIN.name}: exit 1`
    );
    const garbled = harness((command) =>
      command === "kubectl" ? { stdout: "not json" } : {}
    ).port;
    await expect(garbled.listJobPods(MAIN, "default", "job-1")).rejects.toThrow(
      "kubectl get pods did not return JSON."
    );
  });
});
