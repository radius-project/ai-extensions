import type { CanvasGraphResource, CanvasState } from "../../shared.js";
import type { DeployMonitorService } from "./deploy-monitor.js";
import { assertDeployDependencies } from "./deploy-service-dependencies.js";

// Admission half of `POST /api/deploy`: everything that must settle before the
// route can answer. It resolves the repair loop, refuses every request that
// must not start a workflow, reserves the repo/environment, opens the deploy
// attempt, and launches the background monitor.
//
// The ordering here is the contract, not an implementation detail:
//   * the repair-loop check runs before any mutation, lookup or reservation, so
//     a refusal costs no state change and no Actions run;
//   * the canvas-local checks run before the persisted GitHub check, so the
//     immediate double-click race is closed without a network round trip;
//   * branch resolution is awaited *before* `beginDeployAttempt`, because that
//     call must be synchronous — a previous attempt's handoff settling in the
//     gap would still see itself as current and could mark this deploy as
//     already repairing;
//   * the 200 is written immediately after the monitor is launched, and the
//     monitor owns the reservation from that moment on.

export interface DeployRequestInstanceEntry {
  state: CanvasState;
}

export interface DeploymentReservation {
  repo: string;
  environment: string;
  kind: "deploy" | "delete";
  expiresAt: number;
  attemptId?: string;
}

export interface DeployRepairLoopResolution {
  repairLoop: boolean;
  attemptId: string;
  repairAttempt: number;
  error?: string;
}

export interface DeploymentRow {
  status: string;
}

// The request body as the deploy tool and the canvas page send it. Every field
// is optional and read defensively, exactly as the legacy arm did.
export interface DeployRequestData {
  attemptId?: unknown;
  targetRepo?: string;
  environment?: unknown;
  branch?: string;
  provider?: string;
  appFile?: string;
}

export interface DeployRequestDependencies {
  readInstanceEntry(instanceId: string): DeployRequestInstanceEntry | undefined;
  resolveDeployRepairLoop(
    state: CanvasState,
    requestedAttemptId: unknown
  ): DeployRepairLoopResolution;
  resolveDeploymentEnvironment(
    state: CanvasState,
    requestedEnvironment: unknown
  ): string;
  activeDeploymentMutation(
    state: CanvasState
  ): DeploymentReservation | undefined;
  localDeploymentBlocksMutation(state: CanvasState): boolean;
  reserveDeploymentMutation(
    state: CanvasState,
    reservation: { repo: string; environment: string; kind: "deploy" }
  ): DeploymentReservation | null;
  releaseDeploymentMutation(
    state: CanvasState,
    reservation: DeploymentReservation
  ): void;
  deploymentStatusBlocksMutation(status: unknown): boolean;
  // Rejects on a GitHub failure, so an unverifiable environment fails closed
  // with a 503 rather than being treated as "nothing deployed".
  resolveEnvDeployment(
    repo: string,
    environment: string,
    appName: string
  ): Promise<DeploymentRow | null>;
  // The subprocess runner used for the default-branch lookup. Rejects on
  // failure; the fallback to "main" is applied here so it stays testable.
  runCommand(command: string, args: string[]): Promise<string>;
  canvasGraphResources(values: unknown[]): CanvasGraphResource[];
  beginDeployAttempt(
    state: CanvasState,
    input: {
      repo: string;
      branch: string;
      provider: string;
      environment: string;
      appFile: string;
      repairLoop: boolean;
      attemptId?: string;
    }
  ): void;
  triggerDeployRepairHandoff(
    entry: DeployRequestInstanceEntry,
    instanceId: string
  ): boolean;
  monitor: DeployMonitorService;
  unconfirmedRunKind: CanvasState["deployErrorKind"];
  repairAttemptCap: number;
  errorMessage(error: unknown): string;
}

export interface DeployRequestResult {
  status: number;
  body: unknown;
}

export interface DeployRequestService {
  deploy(input: {
    instanceId: string;
    body: string;
  }): Promise<DeployRequestResult>;
}

const REQUIRED_DEPENDENCIES: readonly (keyof DeployRequestDependencies)[] = [
  "readInstanceEntry",
  "resolveDeployRepairLoop",
  "resolveDeploymentEnvironment",
  "activeDeploymentMutation",
  "localDeploymentBlocksMutation",
  "reserveDeploymentMutation",
  "releaseDeploymentMutation",
  "deploymentStatusBlocksMutation",
  "resolveEnvDeployment",
  "runCommand",
  "canvasGraphResources",
  "beginDeployAttempt",
  "triggerDeployRepairHandoff",
  "errorMessage"
];

// Bounded ring buffer: a verbose deploy can stream tens of thousands of
// recipe/terraform log lines. Keeping them all in memory (and re-serializing
// the whole array to every 1.5s status poll) grew unbounded and got the
// extension process OOM-killed mid-deploy. Cap the buffer and track how many
// lines were dropped so the client can still page through new lines by
// absolute offset.
const DEPLOY_LOG_CAP = 4000;

// The legacy monitor's catch read `monErr.message` off whatever was thrown, so
// a thrown non-Error still produced its own text rather than "[object Object]"
// when it carried a message.
function monitorFailureText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error !== null && typeof error === "object" && "message" in error) {
    const { message } = error;
    if (message) return String(message);
  }
  return String(error);
}

export function createDeployRequestService(
  dependencies: DeployRequestDependencies
): DeployRequestService {
  assertDeployDependencies(
    "createDeployRequestService",
    dependencies,
    REQUIRED_DEPENDENCIES
  );
  if (!dependencies.monitor) {
    throw new Error(
      "createDeployRequestService is missing required dependencies: monitor"
    );
  }
  if (typeof dependencies.repairAttemptCap !== "number") {
    throw new Error(
      "createDeployRequestService is missing required dependencies: repairAttemptCap"
    );
  }
  // Not function-typed, so the shared assert cannot reach it. The monitor-crash
  // path below marks the run unconfirmed precisely so a repair redeploy refuses
  // rather than racing a run whose outcome is unknown; an absent marking would
  // turn that fail-closed guarantee into a fail-open one.
  if (!dependencies.unconfirmedRunKind) {
    throw new Error(
      "createDeployRequestService is missing required dependencies: unconfirmedRunKind"
    );
  }

  return {
    async deploy({ instanceId, body }) {
      let reservation: DeploymentReservation | null = null;
      let reservationOwner: CanvasState | null = null;
      const releaseReservation = (): void => {
        if (reservation && reservationOwner)
          dependencies.releaseDeploymentMutation(reservationOwner, reservation);
        reservation = null;
        reservationOwner = null;
      };
      try {
        const data: DeployRequestData = JSON.parse(body);
        const entry = dependencies.readInstanceEntry(instanceId);
        if (!entry) throw new Error("Canvas server state is unavailable.");
        // Re-validate the repair-loop attempt before touching any state: the
        // tool checked it before sending, but a newer deploy may have started
        // since, and a stale repair must not clobber it.
        const loop = dependencies.resolveDeployRepairLoop(
          entry.state,
          data.attemptId
        );
        if (loop.error) return { status: 409, body: { error: loop.error } };

        const repo =
          data.targetRepo ||
          entry.state.plannedRepo ||
          entry.state.contextRepo ||
          "";
        const environment = dependencies.resolveDeploymentEnvironment(
          entry.state,
          data.environment
        );
        if (!repo || !environment) {
          throw new Error("targetRepo and environment are required.");
        }
        const activeMutation = dependencies.activeDeploymentMutation(
          entry.state
        );
        if (
          dependencies.localDeploymentBlocksMutation(entry.state) ||
          activeMutation
        ) {
          const activeRepo =
            activeMutation?.repo ||
            entry.state.deployAttempt?.targetRepo ||
            entry.state.deployingRepo ||
            repo;
          const activeEnvironment =
            activeMutation?.environment ||
            entry.state.deployAttempt?.environment ||
            entry.state.envName ||
            environment;
          const operation = activeMutation?.kind || "deploy";
          return {
            status: 409,
            body: {
              error: `A ${operation} operation for ${activeRepo} in environment ${activeEnvironment} is already in progress. Wait for it to finish before starting another operation.`
            }
          };
        }

        // The lease is bound to a local first so the attempt id can be written
        // onto it without re-narrowing: `reservation` is nulled from the
        // release closure, so its type stays nullable for the rest of the flow.
        const lease = dependencies.reserveDeploymentMutation(entry.state, {
          repo,
          environment,
          kind: "deploy"
        });
        if (!lease) {
          return {
            status: 409,
            body: { error: "Another deployment operation is already starting." }
          };
        }
        reservation = lease;
        reservationOwner = entry.state;

        // The canvas-local state closes the immediate double-click race; the
        // persisted GitHub status closes the same race across sessions.
        let current: DeploymentRow | null;
        try {
          current = await dependencies.resolveEnvDeployment(
            repo,
            environment,
            repo.split("/").pop() || repo
          );
        } catch {
          releaseReservation();
          return {
            status: 503,
            body: {
              error:
                "Could not verify whether this environment already has an operation in progress. Check your GitHub connection and try again."
            }
          };
        }
        if (
          current &&
          dependencies.deploymentStatusBlocksMutation(current.status)
        ) {
          releaseReservation();
          return {
            status: 409,
            body: {
              error:
                current.status === "deleting" ?
                  "This deployment is currently being deleted. Wait for it to finish before deploying again."
                : "A deployment to this environment is already in progress."
            }
          };
        }
        // Resolve the branch to deploy. When the client does not specify one,
        // fall back to the repo's real default branch (which may be
        // master/develop, not main) so the dispatch --ref and the
        // "branch not pushed" guard target a branch that exists. Resolved up
        // front, before any state is touched: `beginDeployAttempt` has to run
        // without an await in front of it.
        let branch = data.branch || "";
        if (!branch) {
          const detectedDefault = (
            (await dependencies
              .runCommand("gh", [
                "repo",
                "view",
                repo,
                "--json",
                "defaultBranchRef",
                "--jq",
                ".defaultBranchRef.name"
              ])
              .catch(() => "")) || ""
          ).trim();
          branch = detectedDefault || "main";
        }
        entry.state.deployParams = { ...data, environment };
        entry.state.envName = environment;
        entry.state.deployProvider = data.provider;
        entry.state.deployingRepo = repo;
        entry.state.appFile = data.appFile;

        // Snapshot the planned graph (nodes start as pending). If the planned
        // graph has not been resolved yet, it is built on the fly inside the
        // monitor so the deploying page always shows it.
        const cloned: unknown = JSON.parse(
          JSON.stringify(entry.state.plannedResources || [])
        );
        const resources = dependencies.canvasGraphResources(
          Array.isArray(cloned) ? cloned : []
        );
        resources.forEach((r) => {
          r.deployStatus = "pending";
          if (r.outputResources)
            r.outputResources.forEach((o) => {
              o.deployStatus = "pending";
            });
        });
        entry.state.deployingResources = resources;
        entry.state.deployLogs = [];
        entry.state.deployLogBase = 0;
        const provider = data.provider || "azure";
        dependencies.beginDeployAttempt(entry.state, {
          repo,
          branch,
          provider,
          environment,
          appFile: data.appFile || ".radius/app.bicep",
          repairLoop: loop.repairLoop,
          attemptId: loop.attemptId
        });
        lease.attemptId = entry.state.deployAttempt?.id;
        const addLog = (msg: string): void => {
          const dl = entry.state.deployLogs || [];
          entry.state.deployLogs = dl;
          dl.push(msg);
          if (dl.length > DEPLOY_LOG_CAP) {
            const drop = dl.length - DEPLOY_LOG_CAP;
            dl.splice(0, drop);
            entry.state.deployLogBase = (entry.state.deployLogBase || 0) + drop;
          }
        };

        // Deliberately backgrounded: the response below must not wait for the
        // workflow. The monitor owns every terminal transition of this deploy.
        void dependencies.monitor
          .run({
            entry,
            repo,
            branch,
            provider,
            requestedEnvironment: data.environment,
            resources,
            log: addLog
          })
          .catch((monErr: unknown) => {
            // Never let the background monitor die silently (which would leave
            // the page stuck polling an 'in_progress' that never resolves).
            // Surface the error and settle the status.
            try {
              const reason = monitorFailureText(monErr);
              addLog("❌ Deploy monitor stopped unexpectedly: " + reason);
              if (!entry.state.deployError)
                entry.state.deployError =
                  "Deploy monitoring stopped unexpectedly: " + reason;
              // Same reasoning as the monitor's timeout: the monitor died, so
              // the workflow's real outcome is unknown and a repair redeploy
              // must not assume the run is over.
              entry.state.deployErrorKind = dependencies.unconfirmedRunKind;
              entry.state.deployStatus = "failed";
            } catch {
              /* ignore */
            }
          })
          .finally(() => {
            // The monitor owns every terminal transition of this deploy, so
            // firing here makes the repair loop independent of the webview.
            // The /api/deploy-status route keeps its own call as a fallback,
            // and triggerDeployRepairHandoff is idempotent per repair loop.
            dependencies.triggerDeployRepairHandoff(entry, instanceId);
            // Hold the repo/environment reservation for the whole deploy, not
            // merely until the background monitor starts.
            releaseReservation();
          });

        // Report the loop's position back so the agent sees its remaining
        // budget on every redeploy, instead of having to remember the cap from
        // the single handoff that opened the loop.
        return {
          status: 200,
          body: {
            ok: true,
            ...(loop.repairLoop ?
              {
                repairAttempt: loop.repairAttempt,
                repairAttemptCap: dependencies.repairAttemptCap
              }
            : {})
          }
        };
      } catch (e) {
        releaseReservation();
        return { status: 400, body: { error: dependencies.errorMessage(e) } };
      }
    }
  };
}
