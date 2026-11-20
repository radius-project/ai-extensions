import type { AwsCleanupCluster } from "./aws-cloud-cleanup.js";
import { deploymentNamespace } from "./deploy-journey.js";
import {
  asRecord,
  list,
  text,
  type AwsJourneyPorts
} from "./aws-journey-support.js";
import { describeError } from "./cloud-command-port.js";
import { NODE_POOL_LABEL } from "./aws-node-groups.js";
import {
  AWS_PROBE_CONNECT_TIMEOUT_SECONDS,
  AWS_PROBE_POLL_MS,
  AWS_PROBE_RUN_TIMEOUT_MS,
  AWS_PROBE_START_TIMEOUT_MS
} from "./aws-timeout-budget.js";

// The connection check: a probe pod on the default nodes must reach each
// managed service the app uses, and the same probe on the isolated node, which
// is outside the cluster security group, must time out. A probe is a
// Kubernetes Job in the app's namespace with the app's Radius labels, so the
// cleanup's label rule removes one a run leaves. It resolves names with the
// node's resolver (`dnsPolicy: Default`), because the isolated node can't
// reach CoreDNS, so only the TCP connect is what times out.
//
// A probe that can't start, or a refused connection where a timeout is
// expected, fails the check: neither shows the network rule is missing.

export type ProbePool = "default" | "isolated";

export const ISOLATED_TAINT_KEY = "radius-e2e/isolated";
export const PROBE_RESULT_MARKER = "RADIUS_PROBE";

// Reasons a pod waits that mean it will never start on its own.
const CANNOT_START = new Set([
  "ErrImagePull",
  "ImagePullBackOff",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError"
]);
// What the API server answers `kubectl logs` for a container that never ran.
const NEVER_STARTED = /container "[^"]*" in pod "[^"]*" is waiting to start.*/;
const IMAGE_DIGEST_PATTERN = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const PROBE_TTL_SECONDS = 600;

// The probe's shell script. The host, port, and timeout arrive as positional
// arguments, never in the script text. It reports "untested" when it can't try
// the connect: the image lacks a tool, or the node's resolver can't resolve the
// name (a slow lookup that fails must never read as a TCP timeout). It
// resolves to an IPv4 address, as the IPv4 cluster reaches it (`getent hosts`
// may answer an IPv6 one), then connects to the address and tells a timeout
// from a refusal by how long the connect took, so it works with any `nc` that
// has `-z` and `-w`.
export const PROBE_SCRIPT = [
  'host="$1"; port="$2"; wait="$3"',
  "for tool in getent nc date; do",
  '  command -v "$tool" >/dev/null 2>&1 ||',
  `    { echo "${PROBE_RESULT_MARKER} untested: the probe image has no $tool"; exit 0; }`,
  "done",
  'address=$(getent ahostsv4 "$host" </dev/null)',
  'address="${address%%[[:space:]]*}"',
  'if [ -z "$address" ]; then',
  `  echo "${PROBE_RESULT_MARKER} untested: could not resolve $host"; exit 0`,
  "fi",
  "start=$(date +%s)",
  'error=$(nc -z -w "$wait" "$address" "$port" 2>&1 </dev/null)',
  "code=$?",
  "took=$(( $(date +%s) - start ))",
  `if [ "$code" -eq 0 ]; then echo "${PROBE_RESULT_MARKER} connected";`,
  `elif [ "$took" -ge "$wait" ]; then echo "${PROBE_RESULT_MARKER} timeout after \${took}s";`,
  `else echo "${PROBE_RESULT_MARKER} failed: exit $code after \${took}s: $error"; fi`
].join("\n");

/** One managed service the app reaches, as one row of the check. */
export interface ManagedServiceEndpoint {
  // The Radius resource type, such as Radius.Data/mySqlDatabases.
  readonly type: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
}

export interface ConnectionProbeJob {
  readonly apiVersion: "batch/v1";
  readonly kind: "Job";
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly spec: Readonly<Record<string, unknown>>;
}

export interface AwsProbeKubernetes {
  createJob(cluster: AwsCleanupCluster, job: ConnectionProbeJob): Promise<void>;
  // `kubectl get pods --selector batch.kubernetes.io/job-name=<job> -o json`.
  listJobPods(
    cluster: AwsCleanupCluster,
    namespace: string,
    job: string
  ): Promise<unknown>;
  readPodLog(
    cluster: AwsCleanupCluster,
    namespace: string,
    pod: string
  ): Promise<string>;
  // Deletes the Job and, in the background, its pods.
  deleteJob(
    cluster: AwsCleanupCluster,
    namespace: string,
    job: string
  ): Promise<void>;
}

export interface ConnectionProbeInput {
  readonly cluster: AwsCleanupCluster;
  // The environment's namespace, where Radius renders the app.
  readonly namespace: string;
  readonly application: string;
  readonly environment: string;
  // Pinned by digest. It needs `getent` with `ahostsv4` (glibc or musl, as in
  // Alpine; BusyBox has none), `nc` with `-z` and `-w`, and `date`.
  readonly image: string;
  // Makes the Job names unique to the run.
  readonly runId: string;
  readonly services: readonly ManagedServiceEndpoint[];
}

export type ProbeOutcome =
  | { readonly kind: "connected" }
  | { readonly kind: "timeout"; readonly detail: string }
  | { readonly kind: "failed"; readonly detail: string }
  // The probe ran but never tried the connect.
  | { readonly kind: "untested"; readonly detail: string }
  | { readonly kind: "cannot-start"; readonly detail: string };

export interface ConnectionRow {
  readonly service: string;
  readonly pool: ProbePool;
  readonly outcome: ProbeOutcome["kind"];
  readonly passed: boolean;
  readonly message: string;
}

export interface ConnectionCheck {
  readonly rows: ConnectionRow[];
  // Empty when every row passed and every probe was deleted.
  readonly failures: string[];
}

export function describeService(service: ManagedServiceEndpoint): string {
  return `${service.type} ${service.name} at ${service.host}:${service.port}`;
}

/** A Job name Kubernetes accepts: lowercase, at most 63 characters. */
export function probeJobName(
  runId: string,
  pool: ProbePool,
  index: number
): string {
  const id = runId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!id) throw new Error("A probe needs a run ID with a letter or digit.");
  return `radius-probe-${pool}-${index}-${id}`.slice(0, 63);
}

export function connectionProbeJob(input: {
  readonly name: string;
  readonly namespace: string;
  readonly application: string;
  readonly environment: string;
  readonly pool: ProbePool;
  readonly image: string;
  readonly service: ManagedServiceEndpoint;
}): ConnectionProbeJob {
  if (!IMAGE_DIGEST_PATTERN.test(input.image))
    throw new Error(
      `The probe image must be pinned by digest (name@sha256:<64 hex>); got "${input.image}".`
    );
  const { port } = input.service;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`${describeService(input.service)} has no valid port.`);
  const labels = {
    "radapp.io/application": input.application,
    "radapp.io/environment": input.environment,
    "radius-e2e/probe": input.pool
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: input.name,
      namespace: deploymentNamespace(input.namespace),
      labels
    },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds:
        (AWS_PROBE_START_TIMEOUT_MS + AWS_PROBE_RUN_TIMEOUT_MS) / 1000,
      ttlSecondsAfterFinished: PROBE_TTL_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          dnsPolicy: "Default",
          automountServiceAccountToken: false,
          nodeSelector: { [NODE_POOL_LABEL]: input.pool },
          tolerations:
            input.pool === "isolated" ?
              [
                {
                  key: ISOLATED_TAINT_KEY,
                  operator: "Equal",
                  value: "true",
                  effect: "NoSchedule"
                }
              ]
            : [],
          containers: [
            {
              name: "probe",
              image: input.image,
              command: [
                "/bin/sh",
                "-c",
                PROBE_SCRIPT,
                "probe",
                input.service.host,
                String(port),
                String(AWS_PROBE_CONNECT_TIMEOUT_SECONDS)
              ],
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                runAsNonRoot: true,
                runAsUser: 65534,
                capabilities: { drop: ["ALL"] }
              },
              resources: {
                requests: { cpu: "10m", memory: "16Mi" },
                limits: { memory: "64Mi" }
              }
            }
          ]
        }
      }
    }
  };
}

/** The probe's result line, or null when it printed none. */
export function parseProbeOutcome(log: string): ProbeOutcome | null {
  const line = log
    .split(/\r?\n/)
    .reverse()
    .find((item) => item.startsWith(`${PROBE_RESULT_MARKER} `));
  if (!line) return null;
  const result = line.slice(PROBE_RESULT_MARKER.length + 1).trim();
  if (result === "connected") return { kind: "connected" };
  if (result.startsWith("timeout")) return { kind: "timeout", detail: result };
  if (result.startsWith("untested:"))
    return { kind: "untested", detail: result.replace(/^untested:\s*/, "") };
  return { kind: "failed", detail: result.replace(/^failed:\s*/, "") };
}

interface ProbePod {
  readonly name: string;
  readonly phase: string;
  readonly waitingReason: string;
  readonly waiting: string;
  readonly unschedulable: string;
}

function readPods(payload: unknown): ProbePod[] {
  const items = asRecord(payload)?.items;
  if (!Array.isArray(items))
    throw new Error("kubectl get pods did not return an items list.");
  return items.map((entry) => {
    const pod = asRecord(entry);
    const status = asRecord(pod?.status);
    const waiting = list(status?.containerStatuses)
      .map((item) => asRecord(asRecord(asRecord(item)?.state)?.waiting))
      .find((item) => item !== null);
    const scheduled = list(status?.conditions)
      .map(asRecord)
      .find((item) => item?.type === "PodScheduled" && item.status === "False");
    return {
      name: text(asRecord(pod?.metadata)?.name),
      phase: text(status?.phase),
      waitingReason: text(waiting?.reason),
      waiting:
        waiting ?
          [text(waiting.reason), text(waiting.message)]
            .filter(Boolean)
            .join(": ")
        : "",
      unschedulable:
        scheduled ?
          [text(scheduled.reason), text(scheduled.message)]
            .filter(Boolean)
            .join(": ")
        : ""
    };
  });
}

async function waitForProbe(
  ports: Pick<AwsJourneyPorts, "sleep" | "now"> & {
    readonly kubernetes: AwsProbeKubernetes;
  },
  cluster: AwsCleanupCluster,
  namespace: string,
  job: string
): Promise<ProbeOutcome> {
  const startBy = ports.now() + AWS_PROBE_START_TIMEOUT_MS;
  const finishBy = startBy + AWS_PROBE_RUN_TIMEOUT_MS;
  const startMinutes = AWS_PROBE_START_TIMEOUT_MS / 60_000;
  for (;;) {
    const [pod] = readPods(
      await ports.kubernetes.listJobPods(cluster, namespace, job)
    );
    const late = ports.now() >= startBy;
    if (!pod) {
      if (late)
        return {
          kind: "cannot-start",
          detail: `the Job made no pod in ${startMinutes} minutes`
        };
    } else if (pod.phase === "Succeeded" || pod.phase === "Failed") {
      let log: string;
      try {
        log = await ports.kubernetes.readPodLog(cluster, namespace, pod.name);
      } catch (error) {
        // A pod that ended before its container started, such as one the
        // Job's deadline stopped while it pulled the image, has no log.
        const waiting = NEVER_STARTED.exec(describeError(error));
        if (!waiting) throw error;
        return {
          kind: "cannot-start",
          detail: `pod ${pod.name} ${pod.phase.toLowerCase()} before its container started (${waiting[0]})`
        };
      }
      return (
        parseProbeOutcome(log) ?? {
          kind: "untested",
          detail: `the probe ${pod.phase.toLowerCase()} without a result: ${log.trim().slice(-300) || "(no output)"}`
        }
      );
    } else if (pod.phase === "Pending" || pod.phase === "") {
      if (CANNOT_START.has(pod.waitingReason))
        return { kind: "cannot-start", detail: pod.waiting };
      if (late)
        return {
          kind: "cannot-start",
          detail: `pod ${pod.name} was still Pending after ${startMinutes} minutes (${pod.unschedulable || pod.waiting || "no reason given"})`
        };
    } else if (ports.now() >= finishBy) {
      return {
        kind: "untested",
        detail: `pod ${pod.name} was still ${pod.phase} after ${(AWS_PROBE_START_TIMEOUT_MS + AWS_PROBE_RUN_TIMEOUT_MS) / 60_000} minutes`
      };
    }
    await ports.sleep(AWS_PROBE_POLL_MS);
  }
}

function judge(
  service: ManagedServiceEndpoint,
  pool: ProbePool,
  outcome: ProbeOutcome
): ConnectionRow {
  const target = describeService(service);
  const row = (passed: boolean, message: string): ConnectionRow => ({
    service: target,
    pool,
    outcome: outcome.kind,
    passed,
    message
  });
  if (outcome.kind === "cannot-start")
    return row(
      false,
      `The ${pool} probe for ${target} couldn't start: ${outcome.detail}. A probe that never ran proves nothing about the network.`
    );
  if (outcome.kind === "untested")
    return row(
      false,
      `The ${pool} probe for ${target} didn't test the connection: ${outcome.detail}. A probe that never tried to connect proves nothing about the network.`
    );
  if (pool === "default")
    return outcome.kind === "connected" ?
        row(true, `The default nodes connected to ${target}.`)
      : row(
          false,
          `The default nodes couldn't connect to ${target}: ${outcome.detail}. The app's pods can't reach the service either.`
        );
  if (outcome.kind === "timeout")
    return row(
      true,
      `The isolated node timed out connecting to ${target}, as it should.`
    );
  return outcome.kind === "connected" ?
      row(
        false,
        `The isolated node connected to ${target}, so it no longer tests a missing network rule. Check that the isolated node group's launch template keeps its own security group (step 2 of the AWS setup in docs/eng/CLOUD_E2E_RUNBOOK.md).`
      )
    : row(
        false,
        `The isolated node got "${outcome.detail}" from ${target} instead of a timeout, so it didn't test a missing network rule.`
      );
}

/**
 * Probe every managed service from the default nodes and from the isolated
 * node, one Job at a time. Every Job is deleted at the end, also when a probe
 * or a read fails.
 */
export async function runConnectionCheck(
  ports: Pick<AwsJourneyPorts, "sleep" | "now"> & {
    readonly kubernetes: AwsProbeKubernetes;
  },
  input: ConnectionProbeInput
): Promise<ConnectionCheck> {
  if (input.services.length === 0)
    throw new Error("The connection check needs at least one managed service.");
  const namespace = deploymentNamespace(input.namespace);
  // Every manifest is built first, so a bad input creates no Job.
  const probes = input.services.flatMap((service, index) =>
    (["default", "isolated"] as const).map((pool) => ({
      service,
      pool,
      job: connectionProbeJob({
        name: probeJobName(input.runId, pool, index),
        namespace,
        application: input.application,
        environment: input.environment,
        pool,
        image: input.image,
        service
      })
    }))
  );
  const rows: ConnectionRow[] = [];
  const failures: string[] = [];
  const created: string[] = [];
  let thrown: unknown = null;
  try {
    for (const { service, pool, job } of probes) {
      created.push(job.metadata.name);
      // A Job Kubernetes refused is a probe that can't start. A failed read
      // while it runs stops the check.
      const outcome = await ports.kubernetes.createJob(input.cluster, job).then(
        () => waitForProbe(ports, input.cluster, namespace, job.metadata.name),
        (error: unknown): ProbeOutcome => ({
          kind: "cannot-start",
          detail: `creating Job ${job.metadata.name} failed: ${describeError(error)}`
        })
      );
      const row = judge(service, pool, outcome);
      rows.push(row);
      if (!row.passed) failures.push(row.message);
    }
  } catch (error) {
    thrown = error;
  }
  const kept: string[] = [];
  for (const name of created) {
    try {
      await ports.kubernetes.deleteJob(input.cluster, namespace, name);
    } catch (error) {
      kept.push(
        `Deleting probe Job ${namespace}/${name} failed: ${describeError(error)}. The cleanup workflow removes it by its Radius labels.`
      );
    }
  }
  if (thrown !== null)
    throw new Error(
      [`The connection check stopped: ${describeError(thrown)}`, ...kept].join(
        " "
      ),
      { cause: thrown }
    );
  failures.push(...kept);
  return { rows, failures };
}
