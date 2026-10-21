import {
  collectDeploymentOutcome,
  WorkflowReadInterruptedError,
  type DeploymentGraphRead,
  type RadDeployResourceError,
  type WorkflowReadContext,
  type WorkflowRunDetail,
  type WorkflowStep
} from "@radius-project/core";
import {
  WorkflowArtifactReadError,
  type WorkflowReadRequest
} from "@radius-project/adapter-shared";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";

// Final runtime stage of a background deploy: turn a completed workflow run
// into the terminal canvas state — the deployed graph, the settled per-resource
// statuses, and, when the run failed, the readable root cause assembled from
// the run log and the producer's control-plane log.
//
// Separated from the polling loop because it runs exactly once per deploy and
// owns the largest share of the deploy's external reads; the loop above it only
// decides when this runs.

export interface DeployOutcomeInstanceEntry {
  state: CanvasState;
}

export type DeployRunStep = WorkflowStep;

export type DeployGraphRead = DeploymentGraphRead;

// The run-scoped artifact reader. Only the two reads the terminal stage makes
// are declared; the progress read belongs to the polling loop.
export interface DeployOutcomeStatusReader {
  graph(context?: WorkflowReadContext): Promise<DeployGraphRead>;
  controlPlaneLog(context?: WorkflowReadContext): Promise<string | null>;
}

export interface DeployOutcomeDependencies {
  projectSafeGraphResources(graph: unknown): CanvasGraphResource[];
  settleDeployStatuses(
    resources: CanvasGraphResource[],
    conclusion: string | null | undefined,
    radiusError?: string,
    resourceErrors?: readonly RadDeployResourceError[]
  ): void;
  fetchRunLog(
    repo: string,
    runId: number | string,
    request?: WorkflowReadRequest
  ): Promise<string | null>;
  redactDiagnostic(value: string): string;
  // The deployErrorKind stamped on an auth-drift failure so the repair guard
  // leaves it for the user to re-verify rather than auto-redeploying it.
  cloudAuthDriftKind: CanvasState["deployErrorKind"];
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

export interface DeployOutcomeRequest {
  entry: DeployOutcomeInstanceEntry;
  repo: string;
  runId: number | string;
  provider: string;
  resources: CanvasGraphResource[];
  status: WorkflowRunDetail["status"];
  conclusion: string | null | undefined;
  steps: readonly DeployRunStep[];
  jobs?: WorkflowRunDetail["jobs"];
  statusReader: DeployOutcomeStatusReader;
  // 0 when the rad-commands step was never observed running, which is also the
  // signal that no duration line should be logged.
  deployStepStartedAt: number;
  log(message: string): void;
  setStatus(
    resource: CanvasGraphResource,
    status: "pending" | "in_progress" | "success" | "failed"
  ): void;
  pollDeployStatus(force: boolean): Promise<void>;
  observation?: WorkflowReadRequest;
  isCurrent?(): boolean;
}

export interface DeployOutcomeService {
  settle(request: DeployOutcomeRequest): Promise<void>;
}

const REQUIRED_DEPENDENCIES: readonly (keyof DeployOutcomeDependencies)[] = [
  "projectSafeGraphResources",
  "settleDeployStatuses",
  "fetchRunLog",
  "redactDiagnostic",
  "sleep",
  "now"
];

export function createDeployOutcomeService(
  dependencies: DeployOutcomeDependencies
): DeployOutcomeService {
  assertDeployDependencies(
    "createDeployOutcomeService",
    dependencies,
    REQUIRED_DEPENDENCIES
  );
  // assertDeployDependencies only guards function-typed dependencies, so the
  // string-valued cloudAuthDriftKind is validated here: an empty or missing
  // value would silently stamp auth-drift failures with a blank kind and defeat
  // the repair guard that relies on it.
  if (
    typeof dependencies.cloudAuthDriftKind !== "string" ||
    dependencies.cloudAuthDriftKind.trim() === ""
  ) {
    throw new Error(
      "createDeployOutcomeService requires a non-empty cloudAuthDriftKind."
    );
  }
  return {
    async settle(request) {
      const assertCurrent = () => {
        if (
          request.isCurrent?.() === false ||
          request.observation?.context.check().state === "stopped"
        )
          throw new WorkflowReadInterruptedError("cancelled");
      };
      assertCurrent();
      const {
        entry,
        repo,
        provider,
        resources,
        conclusion,
        statusReader,
        deployStepStartedAt,
        log,
        setStatus,
        pollDeployStatus
      } = request;

      const propagate = (): void => {
        for (const resource of resources) {
          if (resource.deployStatus) setStatus(resource, resource.deployStatus);
        }
      };
      let graphReadStarted = false;
      const outcome = await collectDeploymentOutcome(
        { repo, runId: request.runId },
        {
          status: request.status,
          conclusion,
          steps: [...request.steps],
          jobs: request.jobs
        },
        { provider, resourcesTouched: deployStepStartedAt > 0 },
        {
          isCurrent: () => request.isCurrent?.() !== false,
          context: request.observation?.context,
          readGraph: (context) => {
            if (!graphReadStarted) {
              graphReadStarted = true;
              log("🗺  Retrieving deploy status and application graph…");
            }
            return statusReader.graph(context);
          },
          projectGraph: dependencies.projectSafeGraphResources,
          readDecision: (error) =>
            error instanceof WorkflowArtifactReadError ?
              error.decision
            : undefined,
          redactDiagnostic: dependencies.redactDiagnostic,
          readLog: (targetRepo, runId) =>
            dependencies.fetchRunLog(targetRepo, runId, request.observation),
          readControlPlaneLog: () =>
            statusReader.controlPlaneLog(request.observation?.context),
          sleep: dependencies.sleep,
          onGraph: async ({ deployed, graphStatus, note }) => {
            // Final status sweep, forced past the poll interval so the last published
            // state is always folded in.
            await pollDeployStatus(true);
            assertCurrent();

            // Record stop time + duration.
            const finishedAt = dependencies.now();
            entry.state.deployFinishedAt = finishedAt;
            if (deployStepStartedAt) {
              const secs = Math.round(
                (finishedAt - deployStepStartedAt) / 1000
              );
              log(
                "  ⏱ Deployment finished at " +
                  new Date(finishedAt).toISOString() +
                  " (" +
                  secs +
                  "s)"
              );
            }

            // The run's own conclusion is authoritative for the overall outcome: it
            // decides anything the published status left unfinished, without
            // overwriting a resource the producer already reported as terminal.
            //
            // A successful run needs nothing but its conclusion, so settle it now. A
            // non-success run is settled further down instead, once the exact Radius
            // error has been extracted from the run log, because that error is what
            // a red node's message should say (Exception 5.1).
            if (conclusion === "success") {
              dependencies.settleDeployStatuses(resources, conclusion);
              propagate();
            }

            if (deployed) {
              entry.state.deployedGraph = deployed;
              entry.state.deployedGraphRepo = repo;
              log("  ✓ Deployed graph saved (from workflow artifact).");
            } else if (graphStatus === "auth") {
              log(
                "  ⚠ The deploy status artifact could not be read: access denied."
              );
              log(
                "    Check that the active gh account can read Actions artifacts for " +
                  repo +
                  "."
              );
            } else if (graphStatus === "malformed") {
              log(
                "  ⚠ The deploy status artifact was found but could not be parsed. Continuing."
              );
            } else if (graphStatus === "unavailable") {
              log(
                "  ⚠ The deploy status artifact could not be read. The workflow outcome is unchanged."
              );
            } else {
              log(
                "  ⚠ Deployed graph not available (the deploy may not have published one)."
              );
            }
            if (note) log("  " + note);
            if (conclusion !== "success") {
              log("");
              log("❌ Deployment failed. Conclusion: " + conclusion);
            }
          }
        }
      );
      assertCurrent();
      if (outcome.kind === "success") {
        entry.state.deployStatus = "complete";
        log("");
        log(
          "🎉 Deployment complete! Application deployed to " +
            (provider === "aws" ? "AWS" : "Azure") +
            "."
        );
        log(
          "Click on deployed resources to view them in the " +
            (provider === "aws" ? "AWS Console" : "Azure Portal") +
            "."
        );
        return;
      }
      // Complete diagnostic collection before publishing failed: status polling
      // may immediately start a repair handoff using this error and graph.
      const {
        failure,
        graph: { note }
      } = outcome;
      failure.narration.forEach(log);
      entry.state.deployError = failure.message + (note ? "\n\n" + note : "");
      const { radiusError, resourceErrors, authDriftMessage } = failure;
      // Settle the graph now that the exact Radius error is known, so every red
      // node carries its own error from it, or the run-level error, or
      // "Deployment cancelled" / "Deployment timed out" when the run's
      // conclusion, not a resource, decided the outcome (Exception 5.1). A node
      // the producer already explained keeps its own message. Runs before the
      // status flips to "failed" below, so the panel never observes a terminal
      // deploy whose graph is still unsettled.
      dependencies.settleDeployStatuses(
        resources,
        conclusion,
        radiusError,
        resourceErrors
      );
      propagate();
      // Stamp the drift prefix + kind last so it leads the message regardless of
      // which describeFailure path ran. The kind keeps the repair guard from
      // auto-redeploying a failure only the user can fix by re-verifying.
      if (authDriftMessage) {
        entry.state.deployErrorKind = dependencies.cloudAuthDriftKind;
        entry.state.deployError =
          authDriftMessage + "\n\n" + entry.state.deployError;
      }
      entry.state.deployStatus = "failed";
    }
  };
}
