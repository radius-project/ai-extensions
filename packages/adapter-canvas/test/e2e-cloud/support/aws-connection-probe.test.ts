import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAIN } from "../../support/aws/cleanup-scenario.js";
import {
  connectionProbeJob,
  describeService,
  parseProbeOutcome,
  type ProbeOutcome,
  probeJobName,
  PROBE_SCRIPT,
  runConnectionCheck,
  type AwsProbeKubernetes,
  type ConnectionProbeJob,
  type ManagedServiceEndpoint,
  type ProbePool
} from "./aws-connection-probe.js";
import { selectLeakedClusterWorkloads } from "./cloud-cleanup.js";

const IMAGE = `ghcr.io/radius-project/mirror/alpine@sha256:${"a".repeat(64)}`;
const NAMESPACE = "default";
const APPLICATION = "cloud-e2e";
const ENVIRONMENT = "radtest-aws-run1-main";
const DB: ManagedServiceEndpoint = {
  type: "Radius.Data/mySqlDatabases",
  name: "db",
  host: "mysql-run1.abc.us-east-2.rds.amazonaws.com",
  port: 3306
};
const DB_TEXT = `Radius.Data/mySqlDatabases db at ${DB.host}:3306`;

interface ProbeCluster {
  readonly jobs: Map<string, ConnectionProbeJob>;
  readonly deleted: string[];
  // Pools with Ready nodes.
  pools: Set<string>;
  // What a connect from each pool does when it is not a timeout.
  connects: Partial<Record<ProbePool, "connected" | "refused">>;
  image: "pulls" | "fails";
  podless: boolean;
  // A pod that never leaves Pending, or a listing kubectl can't explain.
  stuck: "creating" | "bare" | "malformed" | null;
  // Reads before a started pod finishes; Infinity keeps it Running.
  runningReads: number;
  log: ((pool: ProbePool) => string) | null;
  failCreate: boolean;
  failList: boolean;
  failDelete: boolean;
  readonly now: { value: number };
  ports: {
    kubernetes: AwsProbeKubernetes;
    sleep(milliseconds: number): Promise<void>;
    now(): number;
  };
}

function pool(job: ConnectionProbeJob): ProbePool {
  return job.metadata.labels["radius-e2e/probe"] === "isolated" ?
      "isolated"
    : "default";
}

// A cluster that schedules, pulls, and connects the way the main cluster
// does: the isolated node is tainted, outside the cluster security group, and
// can't reach CoreDNS.
function probeCluster(): ProbeCluster {
  const reads = new Map<string, number>();
  const now = { value: Date.parse("2026-11-17T05:00:00Z") };
  const cluster: ProbeCluster = {
    jobs: new Map(),
    deleted: [],
    pools: new Set(["default", "isolated"]),
    connects: { default: "connected" },
    image: "pulls",
    podless: false,
    stuck: null,
    runningReads: 1,
    log: null,
    failCreate: false,
    failList: false,
    failDelete: false,
    now,
    ports: {
      sleep: async (milliseconds) => {
        now.value += milliseconds;
      },
      now: () => now.value,
      kubernetes: {
        createJob: async (target, job) => {
          expect(target).toEqual(MAIN);
          if (cluster.failCreate) throw new Error("admission webhook denied");
          cluster.jobs.set(job.metadata.name, job);
        },
        listJobPods: async (_target, namespace, name) => {
          if (cluster.failList) throw new Error("kubectl: connection refused");
          const job = cluster.jobs.get(name);
          if (!job || job.metadata.namespace !== namespace)
            throw new Error(`No Job ${namespace}/${name}`);
          if (cluster.podless) return { items: [] };
          if (cluster.stuck === "malformed") return {};
          const spec = (job.spec.template as { spec: Record<string, any> })
            .spec;
          const tolerated = (spec.tolerations as any[]).some(
            (item) =>
              item.key === "radius-e2e/isolated" && item.effect === "NoSchedule"
          );
          const wanted = spec.nodeSelector["radius-e2e/pool"];
          const pod = (status: Record<string, unknown>) => ({
            items: [{ metadata: { name: `${name}-pod` }, status }]
          });
          if (
            !cluster.pools.has(wanted) ||
            (wanted === "isolated" && !tolerated)
          )
            return pod({
              phase: "Pending",
              conditions: [
                {
                  type: "PodScheduled",
                  status: "False",
                  reason: "Unschedulable",
                  message: "0/2 nodes are available"
                }
              ]
            });
          if (cluster.image === "fails")
            return pod({
              phase: "Pending",
              containerStatuses: [
                {
                  state: {
                    waiting: {
                      reason: "ErrImagePull",
                      message: "manifest unknown"
                    }
                  }
                }
              ]
            });
          if (cluster.stuck === "bare") return pod({ phase: "Pending" });
          const count =
            cluster.stuck === "creating" ? 0 : (reads.get(name) ?? 0);
          reads.set(name, count + 1);
          if (count === 0)
            return pod({
              phase: "Pending",
              containerStatuses: [
                { state: { waiting: { reason: "ContainerCreating" } } }
              ]
            });
          if (count <= cluster.runningReads) return pod({ phase: "Running" });
          return pod({ phase: "Succeeded" });
        },
        readPodLog: async (_target, _namespace, podName) => {
          const job = cluster.jobs.get(podName.replace(/-pod$/, ""));
          if (!job) throw new Error(`No pod ${podName}`);
          const from = pool(job);
          if (cluster.log) return cluster.log(from);
          const spec = (job.spec.template as { spec: Record<string, any> })
            .spec;
          if (from === "isolated" && spec.dnsPolicy !== "Default")
            return `RADIUS_PROBE failed: exit 1 after 0s: nc: bad address '${DB.host}'`;
          const connect = cluster.connects[from];
          return (
            connect === "connected" ? "RADIUS_PROBE connected\n"
            : connect === "refused" ?
              "RADIUS_PROBE failed: exit 1 after 0s: Connection refused\n"
            : "RADIUS_PROBE timeout after 10s\n"
          );
        },
        deleteJob: async (_target, namespace, name) => {
          if (cluster.failDelete) throw new Error("forbidden");
          cluster.deleted.push(`${namespace}/${name}`);
        }
      }
    }
  };
  return cluster;
}

function check(
  cluster: ProbeCluster,
  services: readonly ManagedServiceEndpoint[] = [DB],
  image = IMAGE
) {
  return runConnectionCheck(cluster.ports, {
    cluster: MAIN,
    namespace: NAMESPACE,
    application: APPLICATION,
    environment: ENVIRONMENT,
    image,
    runId: "Run-1",
    services
  });
}

function job(pool: ProbePool) {
  return connectionProbeJob({
    name: probeJobName("run1", pool, 0),
    namespace: NAMESPACE,
    application: APPLICATION,
    environment: ENVIRONMENT,
    pool,
    image: IMAGE,
    service: DB
  });
}

describe("connectionProbeJob", () => {
  it("is a one-shot Job on the default pool, with the app's labels and the node's resolver", () => {
    const manifest = job("default");
    expect(manifest.metadata).toEqual({
      name: "radius-probe-default-0-run1",
      namespace: NAMESPACE,
      labels: {
        "radapp.io/application": APPLICATION,
        "radapp.io/environment": ENVIRONMENT,
        "radius-e2e/probe": "default"
      }
    });
    expect(manifest.spec).toMatchObject({
      backoffLimit: 0,
      activeDeadlineSeconds: 300,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: manifest.metadata.labels },
        spec: {
          restartPolicy: "Never",
          dnsPolicy: "Default",
          automountServiceAccountToken: false,
          nodeSelector: { "radius-e2e/pool": "default" },
          tolerations: [],
          containers: [
            {
              image: IMAGE,
              command: [
                "/bin/sh",
                "-c",
                PROBE_SCRIPT,
                "probe",
                DB.host,
                "3306",
                "10"
              ]
            }
          ]
        }
      }
    });
  });

  it("tolerates the isolated taint only on the isolated pool", () => {
    expect(job("isolated").spec).toMatchObject({
      template: {
        spec: {
          nodeSelector: { "radius-e2e/pool": "isolated" },
          tolerations: [
            {
              key: "radius-e2e/isolated",
              operator: "Equal",
              value: "true",
              effect: "NoSchedule"
            }
          ]
        }
      }
    });
  });

  it("carries labels the cleanup's workload rule reclaims", () => {
    const manifest = job("isolated");
    expect(
      selectLeakedClusterWorkloads(
        {
          items: [
            {
              kind: manifest.kind,
              metadata: {
                ...manifest.metadata,
                creationTimestamp: "2026-11-17T05:00:00Z"
              }
            }
          ]
        },
        "radtest-aws-",
        APPLICATION,
        "2026-11-18T00:00:00Z"
      )
    ).toEqual([
      {
        kind: "Job",
        name: manifest.metadata.name,
        namespace: NAMESPACE,
        environment: ENVIRONMENT
      }
    ]);
  });

  it.each([
    ["an image pinned by tag", { image: "busybox:1.36" }, "pinned by digest"],
    ["a port of zero", { service: { ...DB, port: 0 } }, "has no valid port"],
    ["a port above 65535", { service: { ...DB, port: 65536 } }, "port"],
    [
      "a namespace Kubernetes would reject",
      { namespace: "n".repeat(64) },
      "Kubernetes rejects anything longer than 63"
    ]
  ])("refuses %s", (_case, change, message) => {
    expect(() =>
      connectionProbeJob({
        name: "probe",
        namespace: NAMESPACE,
        application: APPLICATION,
        environment: ENVIRONMENT,
        pool: "default",
        image: IMAGE,
        service: DB,
        ...change
      })
    ).toThrow(message);
  });
});

describe("probeJobName", () => {
  it("is lowercase, unique per pool and service, and fits Kubernetes' limit", () => {
    expect(probeJobName("Run_1!", "isolated", 2)).toBe(
      "radius-probe-isolated-2-run1"
    );
    expect(probeJobName("x".repeat(80), "default", 0)).toHaveLength(63);
    expect(() => probeJobName("--", "default", 0)).toThrow(
      "A probe needs a run ID"
    );
  });
});

describe("parseProbeOutcome", () => {
  it.each([
    ["RADIUS_PROBE connected", { kind: "connected" }],
    [
      "noise\nRADIUS_PROBE timeout after 10s\n",
      { kind: "timeout", detail: "timeout after 10s" }
    ],
    [
      "RADIUS_PROBE failed: exit 1 after 0s: Connection refused",
      { kind: "failed", detail: "exit 1 after 0s: Connection refused" }
    ],
    [
      "RADIUS_PROBE untested: could not resolve db.example.internal",
      { kind: "untested", detail: "could not resolve db.example.internal" }
    ],
    [
      "RADIUS_PROBE timeout after 10s\nRADIUS_PROBE connected",
      { kind: "connected" }
    ],
    ["no marker here", null]
  ])("reads %j", (log, outcome) => {
    expect(parseProbeOutcome(log)).toEqual(outcome);
  });
});

describe("runConnectionCheck", () => {
  it("passes when the default nodes connect and the isolated node times out, then deletes both Jobs", async () => {
    const cluster = probeCluster();
    expect(await check(cluster)).toEqual({
      rows: [
        {
          service: DB_TEXT,
          pool: "default",
          outcome: "connected",
          passed: true,
          message: `The default nodes connected to ${DB_TEXT}.`
        },
        {
          service: DB_TEXT,
          pool: "isolated",
          outcome: "timeout",
          passed: true,
          message: `The isolated node timed out connecting to ${DB_TEXT}, as it should.`
        }
      ],
      failures: []
    });
    expect(cluster.deleted).toEqual([
      "default/radius-probe-default-0-run1",
      "default/radius-probe-isolated-0-run1"
    ]);
  });

  it("probes each managed service, one row per service and pool", async () => {
    const cache = { ...DB, type: "Radius.Data/redisCaches", name: "cache" };
    const { rows } = await check(probeCluster(), [DB, cache]);
    expect(rows.map((row) => `${row.pool} ${row.service}`)).toEqual([
      `default ${DB_TEXT}`,
      `isolated ${DB_TEXT}`,
      `default ${describeService(cache)}`,
      `isolated ${describeService(cache)}`
    ]);
  });

  it("fails when the isolated node connects, naming the service", async () => {
    const cluster = probeCluster();
    cluster.connects.isolated = "connected";
    expect((await check(cluster)).failures).toEqual([
      `The isolated node connected to ${DB_TEXT}, so it no longer tests a missing network rule. Check that the isolated node group's launch template keeps its own security group (step 2 of the AWS setup in docs/eng/CLOUD_E2E_RUNBOOK.md).`
    ]);
  });

  it("fails when the isolated node is refused instead of timing out", async () => {
    const cluster = probeCluster();
    cluster.connects.isolated = "refused";
    expect((await check(cluster)).failures).toEqual([
      `The isolated node got "exit 1 after 0s: Connection refused" from ${DB_TEXT} instead of a timeout, so it didn't test a missing network rule.`
    ]);
  });

  it("fails when the default nodes can't connect", async () => {
    const cluster = probeCluster();
    cluster.connects.default = "refused";
    expect((await check(cluster)).failures).toEqual([
      `The default nodes couldn't connect to ${DB_TEXT}: exit 1 after 0s: Connection refused. The app's pods can't reach the service either.`
    ]);
  });

  it("fails a probe whose image can't be pulled, rather than passing it as a timeout", async () => {
    const cluster = probeCluster();
    cluster.image = "fails";
    const { rows, failures } = await check(cluster);
    expect(rows.map((row) => row.outcome)).toEqual([
      "cannot-start",
      "cannot-start"
    ]);
    expect(failures[1]).toBe(
      `The isolated probe for ${DB_TEXT} couldn't start: ErrImagePull: manifest unknown. A probe that never ran proves nothing about the network.`
    );
    expect(cluster.deleted).toHaveLength(2);
  });

  it("fails a probe that stays Pending past its start deadline", async () => {
    const cluster = probeCluster();
    cluster.pools.delete("isolated");
    const start = cluster.now.value;
    const { failures } = await check(cluster);
    expect(failures).toEqual([
      `The isolated probe for ${DB_TEXT} couldn't start: pod radius-probe-isolated-0-run1-pod was still Pending after 3 minutes (Unschedulable: 0/2 nodes are available). A probe that never ran proves nothing about the network.`
    ]);
    expect(cluster.now.value - start).toBeGreaterThanOrEqual(3 * 60_000);
  });

  it.each([
    ["waiting on its container", "creating", "(ContainerCreating)"],
    ["with no reason", "bare", "(no reason given)"]
  ] as const)("fails a pod stuck Pending %s", async (_case, stuck, reason) => {
    const cluster = probeCluster();
    cluster.stuck = stuck;
    expect((await check(cluster)).failures[0]).toContain(
      `was still Pending after 3 minutes ${reason}`
    );
  });

  it("stops when kubectl lists no pods array", async () => {
    const cluster = probeCluster();
    cluster.stuck = "malformed";
    await expect(check(cluster)).rejects.toThrow(
      "The connection check stopped: kubectl get pods did not return an items list."
    );
  });

  it("fails a Job that makes no pod, and one Kubernetes refuses", async () => {
    const podless = probeCluster();
    podless.podless = true;
    expect((await check(podless)).failures[0]).toContain(
      "couldn't start: the Job made no pod in 3 minutes."
    );
    const refused = probeCluster();
    refused.failCreate = true;
    const result = await check(refused);
    expect(result.failures[0]).toContain(
      "couldn't start: creating Job radius-probe-default-0-run1 failed: admission webhook denied."
    );
    expect(refused.deleted).toHaveLength(2);
  });

  it.each(["default", "isolated"] as const)(
    "fails a %s probe that couldn't test the connection without blaming the network",
    async (from) => {
      const cluster = probeCluster();
      cluster.log = (pool) =>
        pool === from ? `RADIUS_PROBE untested: could not resolve ${DB.host}\n`
        : pool === "default" ? "RADIUS_PROBE connected\n"
        : "RADIUS_PROBE timeout after 10s\n";
      const { rows, failures } = await check(cluster);
      expect(rows.find((row) => row.pool === from)?.outcome).toBe("untested");
      expect(failures).toEqual([
        `The ${from} probe for ${DB_TEXT} didn't test the connection: could not resolve ${DB.host}. A probe that never tried to connect proves nothing about the network.`
      ]);
    }
  );

  it("fails a probe that finishes without a result, or never finishes", async () => {
    const silent = probeCluster();
    silent.log = () => "sh: nc: not found\n";
    expect((await check(silent)).failures[0]).toBe(
      `The default probe for ${DB_TEXT} didn't test the connection: the probe succeeded without a result: sh: nc: not found. A probe that never tried to connect proves nothing about the network.`
    );
    const empty = probeCluster();
    empty.log = () => "";
    expect((await check(empty)).failures[0]).toContain(
      "without a result: (no output)"
    );
    const stuck = probeCluster();
    stuck.runningReads = Infinity;
    const result = await check(stuck);
    expect(result.rows[0]?.outcome).toBe("untested");
    expect(result.failures[0]).toContain(
      "pod radius-probe-default-0-run1-pod was still Running after 5 minutes"
    );
  });

  it("reports a Job it couldn't delete", async () => {
    const cluster = probeCluster();
    cluster.failDelete = true;
    expect((await check(cluster)).failures).toEqual([
      "Deleting probe Job default/radius-probe-default-0-run1 failed: forbidden. The cleanup workflow removes it by its Radius labels.",
      "Deleting probe Job default/radius-probe-isolated-0-run1 failed: forbidden. The cleanup workflow removes it by its Radius labels."
    ]);
  });

  it("stops on a failed read, still deleting the Job, and keeps a failed delete in the error", async () => {
    const cluster = probeCluster();
    cluster.failList = true;
    await expect(check(cluster)).rejects.toThrow(
      "The connection check stopped: kubectl: connection refused"
    );
    expect(cluster.deleted).toEqual(["default/radius-probe-default-0-run1"]);
    cluster.failDelete = true;
    await expect(check(cluster)).rejects.toThrow(
      "The connection check stopped: kubectl: connection refused Deleting probe Job default/radius-probe-default-0-run1 failed: forbidden."
    );
  });

  it("refuses a check with no service or an unpinned image before creating any Job", async () => {
    const cluster = probeCluster();
    await expect(check(cluster, [])).rejects.toThrow(
      "The connection check needs at least one managed service."
    );
    await expect(check(cluster, [DB], "busybox:latest")).rejects.toThrow(
      "pinned by digest"
    );
    expect(cluster.jobs.size).toBe(0);
  });
});

// The probe script itself, run by /bin/sh with fake `getent`, `nc`, and
// `date` as the only commands on PATH. Each `date` call is `step` seconds
// after the last, so a test chooses how long each command seems to take. A
// fake can move the clock itself through the file named by $CLOCK.
describe.skipIf(process.platform === "win32")("PROBE_SCRIPT", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  interface Tools {
    readonly getent?: string;
    readonly nc?: string;
    readonly date?: false;
    readonly step: number;
  }

  function runProbe(tools: Tools): {
    result: ProbeOutcome | null;
    nc: string;
  } {
    const directory = mkdtempSync(path.join(tmpdir(), "radius-probe-"));
    directories.push(directory);
    const clock = path.join(directory, "clock");
    const tool = (name: string, body: string) => {
      const file = path.join(directory, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`);
      chmodSync(file, 0o755);
    };
    writeFileSync(clock, "1000");
    if (tools.date !== false)
      tool(
        "date",
        `read now < "$CLOCK"; echo $((now + ${tools.step})) > "$CLOCK"; echo "$now"`
      );
    if (tools.nc !== undefined)
      tool("nc", `echo "$@" > "${directory}/nc-args"\n${tools.nc}`);
    if (tools.getent !== undefined) tool("getent", tools.getent);
    const run = spawnSync(
      "/bin/sh",
      ["-c", PROBE_SCRIPT, "probe", "db.example.internal", "3306", "10"],
      { env: { PATH: directory, CLOCK: clock }, encoding: "utf8" }
    );
    const nc = spawnSync("/bin/sh", ["-c", `cat "${directory}/nc-args"`], {
      encoding: "utf8"
    }).stdout.trim();
    return { result: parseProbeOutcome(run.stdout), nc };
  }

  // Only an IPv4 lookup answers; `getent hosts` may give an IPv6 address
  // first, which the IPv4 cluster can't reach. `getent ahostsv4` prints each
  // address once per socket type, and a name may have several addresses.
  const resolves = [
    '[ "$1" = ahostsv4 ] || exit 2',
    'echo "10.0.1.5        STREAM db.example.internal"',
    'echo "10.0.1.5        DGRAM"',
    'echo "10.0.2.9        STREAM"',
    'echo "10.0.2.9        DGRAM"'
  ].join("\n");

  it("connects to the first address the name resolves to", () => {
    expect(runProbe({ getent: resolves, nc: "exit 0", step: 1 })).toEqual({
      result: { kind: "connected" },
      nc: "-z -w 10 10.0.1.5 3306"
    });
  });

  it("reports a connect that runs out the wait as a timeout", () => {
    expect(
      runProbe({ getent: resolves, nc: "exit 1", step: 10 }).result
    ).toEqual({ kind: "timeout", detail: "timeout after 10s" });
  });

  it("reports a refused connect as a failure, not a timeout", () => {
    expect(
      runProbe({
        getent: resolves,
        nc: 'echo "Connection refused" >&2; exit 1',
        step: 1
      }).result
    ).toEqual({
      kind: "failed",
      detail: "exit 1 after 1s: Connection refused"
    });
  });

  it("leaves a slow lookup out of the connect's time", () => {
    // The lookup takes 30s, more than the 10s wait; only the connect counts.
    expect(
      runProbe({
        getent: `read now < "$CLOCK"; echo $((now + 30)) > "$CLOCK"\n${resolves}`,
        nc: 'echo "Connection refused" >&2; exit 1',
        step: 1
      }).result
    ).toEqual({
      kind: "failed",
      detail: "exit 1 after 1s: Connection refused"
    });
  });

  it("reports a name that doesn't resolve as untested, however long the lookup takes, without connecting", () => {
    // A slow lookup that fails must not read as a TCP timeout.
    expect(runProbe({ getent: "exit 2", nc: "exit 1", step: 30 })).toEqual({
      result: {
        kind: "untested",
        detail: "could not resolve db.example.internal"
      },
      nc: ""
    });
  });

  it.each([
    ["getent", { nc: "exit 0", step: 1 }],
    ["nc", { getent: resolves, step: 1 }],
    ["date", { getent: resolves, nc: "exit 0", date: false, step: 1 }]
  ] as const)(
    "reports an image without %s as untested, without connecting",
    (missing, tools: Tools) => {
      expect(runProbe(tools)).toEqual({
        result: {
          kind: "untested",
          detail: `the probe image has no ${missing}`
        },
        nc: ""
      });
    }
  );
});
