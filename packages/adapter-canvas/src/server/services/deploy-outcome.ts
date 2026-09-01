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

export interface DeployRunStep {
  name?: string;
  status?: string;
  conclusion?: string | null;
}

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
  settleDeployStatuses(
    resources: CanvasGraphResource[],
    conclusion: string | null | undefined
  ): void;
  fetchRunLog(repo: string, runId: number | string): Promise<string | null>;
  extractGitHubActionsStepLog(
    logText: string | null | undefined,
    stepName: string
  ): string;
  explainOidcEnterpriseClaim(logText: string | null | undefined): string;
  extractRadDeployError(logText: string | null | undefined): string;
  // Exception 5.2: classify a deploy that failed at the cloud login/credentials
  // step before any resource was touched as credential drift. Returns the
  // user-facing message, or '' when the failure is not auth drift.
  classifyDeployCloudAuthDrift(input: {
    provider?: string | null;
    resourcesTouched: boolean;
    failedStepNames: readonly (string | undefined)[];
  }): string;
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
  "settleDeployStatuses",
  "fetchRunLog",
  "extractGitHubActionsStepLog",
  "explainOidcEnterpriseClaim",
  "extractRadDeployError",
  "classifyDeployCloudAuthDrift",
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
        deployed = gr.graph;
        break;
      }
      if (g < 2) await dependencies.sleep(5000);
    }
    return { deployed, graphStatus };
  };

  const describeFailure = async (
    request: DeployOutcomeRequest
  ): Promise<string> => {
    const { repo, runId, conclusion, steps, statusReader, log } = request;
    // Build a user-facing error from the failed step(s) + log.
    const failedSteps = steps.filter(
      (s) =>
        s.conclusion && s.conclusion !== "success" && s.conclusion !== "skipped"
    );
    let dErr =
      "Deployment failed" + (conclusion ? " (" + conclusion + ")" : "") + ".";
    if (failedSteps.length)
      dErr +=
        " Failed step: " + failedSteps.map((s) => s.name).join(", ") + ".";
    // Surface the FULL detailed rad deploy failure block (root cause:
    // recipe/terraform/ARM operation errors). The run is complete by now, so
    // its log is readable in full — this is the one signal the artifact
    // transport does not carry.
    const failLog = await dependencies.fetchRunLog(repo, runId);
    // The OIDC "enterprise claim" rejection (AADSTS7002381) happens at the
    // Azure Login step, before rad runs, so scope the check to that step's log
    // rather than the whole run.
    const azureLoginLog = dependencies.extractGitHubActionsStepLog(
      failLog,
      "Azure Login (OIDC)"
    );
    const claimHelp = dependencies.explainOidcEnterpriseClaim(azureLoginLog);
    if (claimHelp) dErr = claimHelp + "\n\n\u2014 raw error \u2014\n" + dErr;
    const detailBlock = dependencies.extractRadDeployError(failLog);
    if (detailBlock) {
      dErr += "\n\n" + detailBlock;
      log("");
      log("──────── failure details ────────");
      detailBlock.split("\n").forEach((l) => log("  " + l));
      log("─────────────────────────────────");
    }
    // The producer ships a dedicated control-plane/recipe log in the status
    // artifact. It carries the precise recipe/terraform failure cause, which
    // the summarized run-log block above can miss, so surface its tail.
    let cpLog: string | null = null;
    try {
      cpLog = await statusReader.controlPlaneLog();
    } catch {
      // Best-effort: a missing/unreadable control-plane log must not mask the
      // run-log failure details above.
    }
    if (cpLog) {
      const cpTail = cpLog
        .replace(/\s+$/, "")
        .split("\n")
        .slice(-40)
        .join("\n");
      if (cpTail.trim()) {
        dErr += "\n\n— control-plane log —\n" + cpTail;
        log("");
        log("──────── control-plane log ────────");
        cpTail.split("\n").forEach((l) => log("  " + l));
        log("───────────────────────────────────");
      }
    }
    dErr +=
      "\n\nView the full run: https://github.com/" +
      repo +
      "/actions/runs/" +
      runId;
    return dErr;
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
      dependencies.settleDeployStatuses(resources, conclusion);
      // Propagate onto output resources and generate portal links.
      for (const resource of resources) {
        if (resource.deployStatus) setStatus(resource, resource.deployStatus);
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
      // Exception 5.2: a redeploy whose cloud login/credentials step failed
      // before "Run rad commands" ever started touched no resource, so classify
      // it as credential drift. `deployStepStartedAt` is 0 until that step is
      // observed running, which is the "no resource touched" signal. Computed
      // here (before the guarded describeFailure read) so the degraded-message
      // path below still gets the drift prefix and kind. Only a genuine
      // "failure" conclusion can be drift: a "cancelled" or "timed_out" run that
      // happened to stop at the cloud-login step must not be stamped as drift.
      const authDriftMessage =
        conclusion === "failure" ?
          dependencies.classifyDeployCloudAuthDrift({
            provider,
            resourcesTouched: deployStepStartedAt > 0,
            failedStepNames: request.steps
              .filter(
                (s) =>
                  s.conclusion &&
                  s.conclusion !== "success" &&
                  s.conclusion !== "skipped"
              )
              .map((s) => s.name)
          })
        : "";
      // Assemble the error BEFORE flipping the status to "failed". The webview's
      // /api/deploy-status poll fires triggerDeployRepairHandoff the instant it
      // observes "failed", and describeFailure awaits network reads (run log +
      // control-plane log) that take seconds. Setting the status first opens a
      // window where a poll relays a handoff with an empty deployError and marks
      // it delivered, permanently locking out the real error — the "flaky error
      // logs" symptom. Publishing the error first closes that window for both
      // the webview trigger and the deploy-request `.finally()` trigger.
      //
      // But describeFailure's run-log read is unguarded, so guard it here: if it
      // throws we must still settle this run as "failed" with a degraded message
      // rather than let settle() reject. A rejection would both leave the panel
      // non-terminal AND reach the monitor's `.catch`, which reclassifies the
      // run as run-unconfirmed — sending a run that actually concluded "failure"
      // down the informational notice path and telling the user it could not be
      // confirmed, instead of down the repair path it belongs to.
      try {
        entry.state.deployError = await describeFailure(request);
      } catch {
        entry.state.deployError =
          "Deployment failed" +
          (conclusion ? " (" + conclusion + ")" : "") +
          ". The failure details could not be read; see the full run: " +
          "https://github.com/" +
          repo +
          "/actions/runs/" +
          request.runId +
          ".";
      }
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
