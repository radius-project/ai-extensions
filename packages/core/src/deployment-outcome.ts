import {
  collectWorkflowFailure,
  type WorkflowFailure,
  type WorkflowFailureReads
} from "./workflow-diagnostics.js";
import {
  confirmedWorkflowConclusion,
  type WorkflowTarget
} from "./workflow-observation.js";
import {
  WorkflowReadInterruptedError,
  type WorkflowReadContext,
  type WorkflowReadDecision
} from "./workflow-read-policy.js";
import type { DeploymentRunDetail } from "./deployment-monitor.js";

export interface DeploymentGraphRead {
  graph: unknown | null;
  status: string;
  error?: unknown;
}

export interface DeploymentGraphEvidence<Graph> {
  deployed: Graph | null;
  graphStatus: string | null;
  note?: string;
}

export interface DeploymentOutcomePorts<Graph> extends WorkflowFailureReads {
  isCurrent(): boolean;
  context?: WorkflowReadContext;
  readGraph(context?: WorkflowReadContext): Promise<DeploymentGraphRead>;
  projectGraph(graph: unknown): Graph;
  readDecision(error: unknown): WorkflowReadDecision | undefined;
  onGraph(evidence: DeploymentGraphEvidence<Graph>): Promise<void>;
}

export type DeploymentOutcomeResult<Graph> = {
  graph: DeploymentGraphEvidence<Graph>;
} & (
  | { kind: "success"; conclusion: "success" }
  | { kind: "failure"; conclusion: string; failure: WorkflowFailure }
);

function assertCurrent<Graph>(ports: DeploymentOutcomePorts<Graph>): void {
  if (!ports.isCurrent() || ports.context?.check().state === "stopped")
    throw new WorkflowReadInterruptedError("cancelled");
}

function waitWithin(
  context: WorkflowReadContext,
  milliseconds: number
): Promise<void> {
  return context.wait(
    context.clock.sleep(milliseconds, {
      stopped: () => context.check().state === "stopped",
      onStop: context.onStop
    })
  );
}

async function readDeploymentGraph<Graph>(
  ports: DeploymentOutcomePorts<Graph>
): Promise<DeploymentGraphEvidence<Graph>> {
  const unavailable = (error: unknown): DeploymentGraphEvidence<Graph> => {
    const decision =
      error instanceof WorkflowReadInterruptedError ?
        error.decision
      : ports.readDecision(error);
    return {
      deployed: null,
      graphStatus: "unavailable",
      ...(decision && decision.state !== "ready" ?
        { note: `Artifact evidence ${decision.state}: ${decision.reason}.` }
      : {})
    };
  };
  let graphStatus: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    assertCurrent(ports);
    let read: DeploymentGraphRead;
    try {
      read = await ports.readGraph(ports.context);
    } catch (error) {
      assertCurrent(ports);
      if (
        error instanceof WorkflowReadInterruptedError &&
        error.reason === "cancelled"
      )
        throw error;
      return unavailable(error);
    }
    assertCurrent(ports);
    graphStatus = read.status;
    if (read.status === "error") return unavailable(read.error);
    if (read.status === "auth" || read.status === "malformed") break;
    if (read.graph) {
      try {
        return { deployed: ports.projectGraph(read.graph), graphStatus };
      } catch {
        return { deployed: null, graphStatus: "malformed" };
      }
    }
    if (attempt < 2) {
      if (ports.context) {
        if (ports.context.remaining() <= 5000) break;
        try {
          await waitWithin(ports.context, 5000);
        } catch (error) {
          assertCurrent(ports);
          if (
            !(error instanceof WorkflowReadInterruptedError) ||
            error.reason !== "elapsed"
          )
            throw error;
          return unavailable(error);
        }
      } else await ports.sleep(5000);
      assertCurrent(ports);
    }
  }
  return { deployed: null, graphStatus };
}

/** Collects secondary evidence without replacing a confirmed workflow outcome. */
export async function collectDeploymentOutcome<Graph>(
  target: WorkflowTarget,
  run: DeploymentRunDetail,
  context: { provider: string; resourcesTouched: boolean },
  ports: DeploymentOutcomePorts<Graph>
): Promise<DeploymentOutcomeResult<Graph>> {
  assertCurrent(ports);
  const selected = { ...target };
  const detail: DeploymentRunDetail = {
    ...run,
    steps: run.steps.map((step) => ({ ...step })),
    jobs: run.jobs?.map((job) => ({
      ...job,
      steps: job.steps?.map((step) => ({ ...step }))
    }))
  };
  const failureContext = { ...context };
  const conclusion = confirmedWorkflowConclusion(detail);
  if (!conclusion)
    throw new Error("The workflow outcome could not be confirmed.");
  const graph = await readDeploymentGraph(ports);
  assertCurrent(ports);
  await ports.onGraph(graph);
  assertCurrent(ports);
  if (conclusion === "success") return { kind: "success", conclusion, graph };
  const failure = await collectWorkflowFailure(
    selected,
    detail,
    failureContext,
    {
      redactDiagnostic: ports.redactDiagnostic,
      readLog: (repo, runId) => {
        assertCurrent(ports);
        return ports.readLog(repo, runId);
      },
      readControlPlaneLog: () => {
        assertCurrent(ports);
        return ports.readControlPlaneLog();
      },
      sleep: (milliseconds) => {
        assertCurrent(ports);
        if (!ports.context) return ports.sleep(milliseconds);
        if (ports.context.remaining() <= milliseconds)
          return Promise.reject(new WorkflowReadInterruptedError("elapsed"));
        return waitWithin(ports.context, milliseconds);
      }
    }
  );
  assertCurrent(ports);
  return { kind: "failure", conclusion, graph, failure };
}
