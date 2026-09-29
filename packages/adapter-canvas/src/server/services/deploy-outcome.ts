import {
  collectWorkflowFailure,
  type WorkflowStep
} from "@radius-project/core";
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

export interface DeployGraphRead {
  graph: unknown | null;
  status: string;
}

// The run-scoped artifact reader. Only the two reads the terminal stage makes
// are declared; the progress read belongs to the polling loop.
export interface DeployOutcomeStatusReader {
  graph(): Promise<DeployGraphRead>;
  controlPlaneLog(): Promise<string | null>;
}

export interface DeployOutcomeDependencies {
  projectSafeGraphResources(graph: unknown): CanvasGraphResource[];
  settleDeployStatuses(
    resources: CanvasGraphResource[],
    conclusion: string | null | undefined,
    radiusError?: string
  ): void;
  fetchRunLog(repo: string, runId: number | string): Promise<string | null>;
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
  conclusion: string | null | undefined;
  steps: readonly DeployRunStep[];
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
}

export interface DeployOutcomeService {
  settle(request: DeployOutcomeRequest): Promise<void>;
}

const REQUIRED_DEPENDENCIES: readonly (keyof DeployOutcomeDependencies)[] = [
  "projectSafeGraphResources",
  "settleDeployStatuses",
  "fetchRunLog",
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
  // The producer publishes its artifact from a step that runs after
  // `rad deploy` and before teardown, so by the time the run reports completed
  // the upload has normally landed. Retry a few times anyway to absorb
  // upload-finalization lag, since this read is the whole terminal graph.
  const readDeployedGraph = async (
    statusReader: DeployOutcomeStatusReader
  ): Promise<{ deployed: unknown; graphStatus: string | null }> => {
    let deployed: unknown = null;
    let graphStatus: string | null = null;
    for (let g = 0; g < 3; g++) {
      const gr = await statusReader.graph();
      graphStatus = gr.status;
      // Permission failures will not resolve by retrying.
      if (gr.status === "auth") break;
      if (gr.graph) {
        try {
          deployed = dependencies.projectSafeGraphResources(gr.graph);
          break;
        } catch {
          // Treat an unsafe producer artifact as malformed without retaining or
          // repeating any of its data in shared state or user-facing diagnostics.
          graphStatus = "malformed";
        }
      }
      if (g < 2) await dependencies.sleep(5000);
    }
    return { deployed, graphStatus };
  };

  return {
    async settle(request) {
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

      log("🗺  Retrieving deploy status and application graph…");
      const { deployed, graphStatus } = await readDeployedGraph(statusReader);
      // Final status sweep, forced past the poll interval so the last published
      // state is always folded in.
      await pollDeployStatus(true);

      // Record stop time + duration.
      const finishedAt = dependencies.now();
      entry.state.deployFinishedAt = finishedAt;
      if (deployStepStartedAt) {
        const secs = Math.round((finishedAt - deployStepStartedAt) / 1000);
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
      const propagate = (): void => {
        // Propagate onto output resources and generate portal links.
        for (const resource of resources) {
          if (resource.deployStatus) setStatus(resource, resource.deployStatus);
        }
      };
      if (conclusion === "success") {
        dependencies.settleDeployStatuses(resources, conclusion);
        propagate();
      }

      if (deployed) {
        entry.state.deployedGraph = deployed as CanvasState["deployedGraph"];
        entry.state.deployedGraphRepo = repo;
        log("  ✓ Deployed graph saved (from workflow artifact).");
      } else if (graphStatus === "auth") {
        log("  ⚠ The deploy status artifact could not be read: access denied.");
        log(
          "    Check that the active gh account can read Actions artifacts for " +
            repo +
            "."
        );
      } else if (graphStatus === "malformed") {
        log(
          "  ⚠ The deploy status artifact was found but could not be parsed. Continuing."
        );
      } else {
        log(
          "  ⚠ Deployed graph not available (the deploy may not have published one)."
        );
      }

      if (conclusion === "success") {
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
      log("");
      log("❌ Deployment failed. Conclusion: " + conclusion);
      // Complete diagnostic collection before publishing failed: status polling
      // may immediately start a repair handoff using this error and graph.
      const failure = await collectWorkflowFailure(
        { repo, runId: request.runId },
        { conclusion, steps: [...request.steps] },
        { provider, resourcesTouched: deployStepStartedAt > 0 },
        {
          readLog: dependencies.fetchRunLog,
          readControlPlaneLog: () => statusReader.controlPlaneLog()
        }
      );
      failure.narration.forEach(log);
      entry.state.deployError = failure.message;
      const { radiusError, authDriftMessage } = failure;
      // Settle the graph now that the exact Radius error is known, so every red
      // node carries it — or "Deployment cancelled" / "Deployment timed out"
      // when the run's conclusion, not a resource, decided the outcome
      // (Exception 5.1). A node the producer already explained keeps its own
      // message. Runs before the status flips to "failed" below, so the panel
      // never observes a terminal deploy whose graph is still unsettled.
      dependencies.settleDeployStatuses(resources, conclusion, radiusError);
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
