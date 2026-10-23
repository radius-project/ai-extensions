import {
  confirmedWorkflowConclusion,
  type WorkflowRunDetail,
  type WorkflowTarget
} from "./workflow-observation.js";
import { WorkflowReadInterruptedError } from "./workflow-read-policy.js";

export type DeploymentRunDetail = Pick<
  WorkflowRunDetail,
  "status" | "conclusion" | "steps"
> &
  Partial<Pick<WorkflowRunDetail, "jobs" | "protection">>;

interface DeploymentMonitorLifetime {
  isCurrent(): boolean;
  sleep(milliseconds: number): Promise<void>;
}

export interface DeploymentDiscoveryTarget {
  readonly repo: string;
  readonly workflowFile: string;
  readonly dispatchedAt: number;
  readonly baselineRunId: number | string | null;
}

export interface DeploymentDiscoveryPorts extends DeploymentMonitorLifetime {
  findRun(target: DeploymentDiscoveryTarget): Promise<number | string | null>;
}

export interface DeploymentMonitorPorts extends DeploymentMonitorLifetime {
  readRun(target: WorkflowTarget): Promise<DeploymentRunDetail | null>;
  onObservation(detail: DeploymentRunDetail | null): void;
  onProgress(detail: DeploymentRunDetail): Promise<void>;
}

export type DeploymentMonitorResult =
  | { readonly kind: "completed"; readonly detail: DeploymentRunDetail }
  | {
      readonly kind: "unconfirmed";
      readonly reason: "unsupported-conclusion" | "poll-limit";
      readonly completionObserved: boolean;
    };

const POLL_INTERVAL_MS = 5000;
const RUN_DISCOVERY_ATTEMPTS = 24;
const RUN_POLL_ATTEMPTS = 240;

function assertCurrent(ports: DeploymentMonitorLifetime): void {
  if (!ports.isCurrent()) throw new WorkflowReadInterruptedError("cancelled");
}

export async function discoverDeploymentRun(
  target: DeploymentDiscoveryTarget,
  ports: DeploymentDiscoveryPorts
): Promise<number | string | null> {
  const selected = { ...target };
  for (let attempt = 0; attempt < RUN_DISCOVERY_ATTEMPTS; attempt++) {
    assertCurrent(ports);
    const runId = await ports.findRun(selected);
    assertCurrent(ports);
    if (runId !== null) return runId;
    await ports.sleep(POLL_INTERVAL_MS);
    assertCurrent(ports);
  }
  return null;
}

/** Reads an already selected run; never dispatches, publishes, or repairs. */
export async function monitorDeploymentRun(
  target: WorkflowTarget,
  ports: DeploymentMonitorPorts
): Promise<DeploymentMonitorResult> {
  const selected = { ...target };
  let completionObserved = false;
  for (let attempt = 0; attempt < RUN_POLL_ATTEMPTS; attempt++) {
    assertCurrent(ports);
    const detail = await ports.readRun(selected);
    assertCurrent(ports);
    ports.onObservation(detail);
    assertCurrent(ports);
    if (detail?.status === "completed") {
      completionObserved = true;
      if (
        typeof detail.conclusion === "string" &&
        detail.conclusion.trim() !== "" &&
        !confirmedWorkflowConclusion(detail)
      ) {
        return {
          kind: "unconfirmed",
          reason: "unsupported-conclusion",
          completionObserved: true
        };
      }
    }
    if (detail) await ports.onProgress(detail);
    assertCurrent(ports);
    if (detail && confirmedWorkflowConclusion(detail)) {
      return { kind: "completed", detail };
    }
    await ports.sleep(POLL_INTERVAL_MS);
    assertCurrent(ports);
  }
  return {
    kind: "unconfirmed",
    reason: "poll-limit",
    completionObserved
  };
}
