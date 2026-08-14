import type { DeployProgress } from "../../deploy-artifacts.js";
import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import type { DeployDispatchService } from "./deploy-dispatch.js";
import type {
  DeployOutcomeService,
  DeployRunStep,
  DeployOutcomeStatusReader
} from "./deploy-outcome.js";
import type { PlannedGraphRecoveryService } from "./deploy-planned-graph.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";

// The background half of a deploy: recover the planned graph if the request
// started without one, dispatch the workflow, find the run it created, and
// follow that run until it settles.
//
// Deliberately backgrounded by the request service, which means every failure
// here has to become canvas state — nothing above it is still listening. The
// three failure shapes are preserved exactly: a confirmed workflow failure, a
// branch that was never pushed, and a run whose outcome was never confirmed
// (no run found, monitoring timed out, monitor crashed), which is the only one
// an automatic repair may never act on.

export interface DeployMonitorInstanceEntry {
  state: CanvasState;
}

export interface DeployRunDetail {
  status?: string;
  conclusion?: string | null;
  steps: DeployRunStep[];
}

export interface DeployMonitorStatusReader extends DeployOutcomeStatusReader {
  progress(): Promise<DeployProgress | null>;
}

export type DeployResourceStatus = NonNullable<
  CanvasGraphResource["deployStatus"]
>;

export interface DeployStatusChange {
  name?: string;
  from: DeployResourceStatus;
  to: DeployResourceStatus;
}

export interface DeployMonitorDependencies {
  plannedGraph: PlannedGraphRecoveryService;
  dispatch: DeployDispatchService;
  outcome: DeployOutcomeService;
  // Name of the step inside the run-rad-commands composite action that runs the
  // `rad` commands. In-flight handling keys on finding a step with this exact
  // name, so a mismatch silently disables all of it.
  deployRadCommandsStep: string;
  unconfirmedRunKind: CanvasState["deployErrorKind"];
  findWorkflowRun(
    repo: string,
    workflowFile: string,
    sinceMs: number,
    knownId: number | string | null
  ): Promise<number | string | null>;
  getRunDetail(
    repo: string,
    runId: number | string
  ): Promise<DeployRunDetail | null>;
  createStatusReader(
    state: CanvasState,
    repo: string,
    branch: string,
    runId: number | string | null
  ): Promise<DeployMonitorStatusReader>;
  buildDeployStatusMap(
    progress: DeployProgress | null
  ): Map<string, DeployResourceStatus>;
  buildDeployMessageMap(progress: DeployProgress | null): Map<string, string>;
  applyDeployMessages(
    resources: CanvasGraphResource[],
    messages: Map<string, string>
  ): void;
  applyDeployStatusToResources(
    resources: CanvasGraphResource[],
    statuses: Map<string, DeployResourceStatus>
  ): DeployStatusChange[];
  generatePortalUrl(
    resourceType: string,
    provider: string,
    state: CanvasState
  ): string;
  optionalString(value: unknown): string;
  errorMessage(error: unknown): string;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

export interface DeployMonitorRequest {
  entry: DeployMonitorInstanceEntry;
  repo: string;
  branch: string;
  provider: string;
  requestedEnvironment: unknown;
  resources: CanvasGraphResource[];
  log(message: string): void;
}

export interface DeployMonitorService {
  run(request: DeployMonitorRequest): Promise<void>;
}

const REQUIRED_DEPENDENCIES: readonly (keyof DeployMonitorDependencies)[] = [
  "findWorkflowRun",
  "getRunDetail",
  "createStatusReader",
  "buildDeployStatusMap",
  "buildDeployMessageMap",
  "applyDeployMessages",
  "applyDeployStatusToResources",
  "generatePortalUrl",
  "optionalString",
  "errorMessage",
  "sleep",
  "now"
];

// Artifact uploads take seconds, so polling faster than this just re-reads the
// same bytes. The step-lifecycle stream and the heartbeat keep the feed moving
// between refreshes.
const STATUS_POLL_MS = 15000;
const RUN_DISCOVERY_ATTEMPTS = 24;
const RUN_POLL_ATTEMPTS = 240;
const POLL_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 30000;
const PENDING_FALLBACK_MS = 25000;

export function createDeployMonitorService(
  dependencies: DeployMonitorDependencies
): DeployMonitorService {
  assertDeployDependencies(
    "createDeployMonitorService",
    dependencies,
    REQUIRED_DEPENDENCIES
  );
  // Neither of the two value seams below is function-typed, so the shared assert
  // cannot reach them. `unconfirmedRunKind` is the load-bearing one: it marks a
  // run whose real outcome is unknown, and an absent marking would let an
  // attempt-bound repair redeploy race an in-flight run instead of refusing.
  for (const name of [
    "plannedGraph",
    "dispatch",
    "outcome",
    "deployRadCommandsStep",
    "unconfirmedRunKind"
  ] as const) {
    if (!dependencies[name]) {
      throw new Error(
        `createDeployMonitorService is missing required dependencies: ${name}`
      );
    }
  }

  return {
    async run(request) {
      const { entry, repo, branch, provider, log } = request;
      let resources = request.resources;

      if (!repo) {
        log("❌ No target repository specified.");
        entry.state.deployError =
          "No target repository was specified for the deployment.";
        entry.state.deployStatus = "failed";
        return;
      }

      // Push each new status down onto the resource's outputs, generating their
      // portal links on success, the same way the rest of the deploy flow does.
      const setStatus = (
        r: CanvasGraphResource,
        s: "pending" | "in_progress" | "success" | "failed"
      ): void => {
        r.deployStatus = s;
        if (r.outputResources)
          r.outputResources.forEach((o) => {
            o.deployStatus = s;
            if (s === "success") {
              const portalUrlKey = dependencies.optionalString(
                provider === "azure" ?
                  o.id || o.type || o.displayType || ""
                : o.type || o.displayType || o.id || ""
              );
              o.portalUrl = dependencies.generatePortalUrl(
                portalUrlKey,
                provider,
                entry.state
              );
            }
          });
      };

      // Build the planned graph if it was not resolved beforehand.
      if (resources.length === 0) {
        const planned = await dependencies.plannedGraph.recover({
          entry,
          repo,
          branch,
          provider,
          log
        });
        if (planned) resources = planned;
      }

      const dispatched = await dependencies.dispatch.prepareAndDispatch({
        entry,
        repo,
        branch,
        provider,
        requestedEnvironment: request.requestedEnvironment,
        log
      });
      if (!dispatched.dispatched) return;
      const { workflowFile, dispatchedAt } = dispatched;

      log("Waiting for the deploy workflow to start...");
      let dRunId: number | string | null = null;
      for (
        let attempt = 0;
        attempt < RUN_DISCOVERY_ATTEMPTS && !dRunId;
        attempt++
      ) {
        dRunId = await dependencies.findWorkflowRun(
          repo,
          workflowFile,
          dispatchedAt,
          null
        );
        if (!dRunId) await dependencies.sleep(POLL_INTERVAL_MS);
      }
      if (!dRunId) {
        log("⚠ No deploy run found for " + workflowFile + ".");
        entry.state.deployError =
          "The run rad commands workflow (" +
          workflowFile +
          ") did not start. Check that the workflow exists on the default branch and that Actions are enabled for " +
          repo +
          ".";
        // The dispatch succeeded, so a run was very likely created — it just
        // never became visible here. Treating that as an ordinary failure would
        // let a repair redeploy race a run that is queued or merely slow to
        // surface.
        entry.state.deployErrorKind = dependencies.unconfirmedRunKind;
        entry.state.deployStatus = "failed";
        return;
      }
      entry.state.deployRunId = dRunId;
      entry.state.deployRunUrl =
        "https://github.com/" + repo + "/actions/runs/" + dRunId;
      log(
        "Tracking deploy run: https://github.com/" +
          repo +
          "/actions/runs/" +
          dRunId
      );
      if (resources.length > 0 && resources[0].deployStatus === "pending")
        setStatus(resources[0], "in_progress");

      const seenD = new Set<string>();
      const startedD = new Set<string>();
      let deployStepStartedAt = 0;
      let beatStep = "";
      let beatStepStartedAt = 0;
      let lastBeatAt = 0;
      let deployStarted = false;

      // Deploy status and the deployed graph are published as a workflow
      // artifact. This reader is scoped to the run being tracked, so it reports
      // this deploy's status rather than the previous one's.
      const statusReader = await dependencies.createStatusReader(
        entry.state,
        repo,
        branch,
        dRunId
      );
      let lastStatusPollAt = 0;
      // Announce only new transitions, not the same status every tick.
      const statusAnnounced = new Set<string>();

      // Fold the newest published status map into the graph. Merging is
      // conservative: a resource missing from the payload keeps its current
      // status, and a failure is never downgraded within the run.
      const pollDeployStatus = async (force = false): Promise<void> => {
        if (resources.length === 0) return;
        if (!force && dependencies.now() - lastStatusPollAt < STATUS_POLL_MS)
          return;
        lastStatusPollAt = dependencies.now();
        let statusMap;
        let messageMap;
        try {
          const progress = await statusReader.progress();
          statusMap = dependencies.buildDeployStatusMap(progress);
          messageMap = dependencies.buildDeployMessageMap(progress);
        } catch (e) {
          log(
            "    ⚠ Could not read deploy status: " +
              dependencies.errorMessage(e)
          );
          return;
        }
        dependencies.applyDeployMessages(resources, messageMap);
        const changes = dependencies.applyDeployStatusToResources(
          resources,
          statusMap
        );
        for (const change of changes) {
          const line =
            (change.to === "failed" ? "✗"
            : change.to === "success" ? "✓"
            : "◐") +
            " " +
            (change.name || "resource") +
            " — " +
            change.to;
          if (statusAnnounced.has(line)) continue;
          statusAnnounced.add(line);
          log("  " + line);
        }
        if (changes.length > 0) {
          for (const resource of resources) {
            if (resource.deployStatus)
              setStatus(resource, resource.deployStatus);
          }
        }
      };

      const DEPLOY_STEP = dependencies.deployRadCommandsStep;

      for (let p = 0; p < RUN_POLL_ATTEMPTS; p++) {
        const detail = await dependencies.getRunDetail(repo, dRunId);
        if (!detail) {
          await dependencies.sleep(POLL_INTERVAL_MS);
          continue;
        }

        // Stream step lifecycle: announce when a step STARTS (in_progress) and
        // again when it COMPLETES so the feed never goes silent during
        // long-running steps.
        for (const s of detail.steps) {
          const stepName = s.name || "";
          if (s.status === "in_progress" && !startedD.has(stepName)) {
            startedD.add(stepName);
            log("  ▶ " + stepName + "…");
          }
          if (s.status === "completed" && !seenD.has(stepName)) {
            seenD.add(stepName);
            log(
              "  " +
                (s.conclusion === "success" ? "✓"
                : s.conclusion ? "✗"
                : "•") +
                " " +
                stepName
            );
          }
        }

        // Heartbeat: emit a "still running" line every ~30s for the currently
        // executing step so the user sees continuous activity even when GitHub
        // provides no intra-step log lines.
        const running = detail.steps.find((s) => s.status === "in_progress");
        if (running) {
          const runningName = running.name || "";
          if (beatStep !== runningName) {
            beatStep = runningName;
            beatStepStartedAt = dependencies.now();
            lastBeatAt = dependencies.now();
          } else if (dependencies.now() - lastBeatAt > HEARTBEAT_MS) {
            lastBeatAt = dependencies.now();
            log(
              "    … " +
                runningName +
                " still running (" +
                Math.round((dependencies.now() - beatStepStartedAt) / 1000) +
                "s)"
            );
          }
        }

        // While the rad-commands step runs, fold in whatever per-resource
        // status the deploy has published.
        const deployStep = detail.steps.find((s) => s.name === DEPLOY_STEP);
        if (
          deployStep &&
          deployStep.status === "in_progress" &&
          resources.length > 0
        ) {
          if (!deployStarted) {
            deployStarted = true;
            deployStepStartedAt = dependencies.now();
            entry.state.deployStartedAt = deployStepStartedAt;
            log("🚀 rad deploy running — provisioning resources...");
            log(
              "  ⏱ Deployment started at " +
                new Date(deployStepStartedAt).toISOString()
            );
            // Leave nodes gray; each flips to yellow when its own
            // recipe/operation actually starts.
          }
          // Nothing arrives mid-run yet: the producer publishes after
          // `rad deploy` returns, because a composite step cannot invoke
          // actions/upload-artifact while it runs. The poll is here regardless
          // so that when the producer starts uploading during the deploy, this
          // lights up unchanged.
          await pollDeployStatus();
          // Fallback: if nothing has advanced past pending ~25s into the
          // deploy, mark all pending nodes in_progress so the graph is not
          // stuck gray for the whole run.
          if (
            dependencies.now() - deployStepStartedAt > PENDING_FALLBACK_MS &&
            !resources.some(
              (r) => r.deployStatus && r.deployStatus !== "pending"
            )
          ) {
            resources.forEach((r) => setStatus(r, "in_progress"));
          }
        }

        if (detail.status === "completed") {
          await dependencies.outcome.settle({
            entry,
            repo,
            runId: dRunId,
            provider,
            resources,
            conclusion: detail.conclusion,
            steps: detail.steps,
            statusReader,
            deployStepStartedAt,
            log,
            setStatus,
            pollDeployStatus
          });
          return;
        }
        await dependencies.sleep(POLL_INTERVAL_MS);
      }
      log("⚠ Timed out waiting for the deploy workflow to complete.");
      entry.state.deployError =
        "Timed out waiting for the deploy workflow to complete. It may still be running — view it at https://github.com/" +
        repo +
        "/actions/runs/" +
        dRunId;
      // Monitoring gave up; the run itself may still be going. Mark it so an
      // attempt-bound repair redeploy is refused rather than racing a second
      // workflow against the same target.
      entry.state.deployErrorKind = dependencies.unconfirmedRunKind;
      entry.state.deployStatus = "failed";
    }
  };
}
