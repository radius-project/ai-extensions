import type { CanvasGraphResource, CanvasState } from "../shared.js";
import { admitDeployment, redactCredentials } from "@radius-project/core";
import type { DeployMonitorService } from "../server/services/deploy-monitor.js";
import { assertDeployDependencies } from "../server/services/deploy-service-dependencies.js";
import type { SelectedGhExecutor } from "../gh.js";
import type {
  DeploymentExecution,
  DeploymentExecutionOwner
} from "./deployment-execution-owner.js";

// Both transport adapters enter here with captured context. Repair admission
// precedes reservation and I/O; the shared owner retains the reservation until
// its one background monitor actually settles.

export interface DeployRequestInstanceEntry {
  state: CanvasState;
  observation?: import("../server/services/workflow-observation-scope.js").WorkflowObservationScope;
}

export interface DeploymentReservation {
  repo: string;
  environment: string;
  kind: "deploy" | "delete" | "abandon";
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

export interface DeploymentControllerDependencies {
  owner: DeploymentExecutionOwner;
  account(input: {
    target: { repo: string; environment: string };
    savedLogin?: string;
    isCurrent(): boolean;
  }): Promise<SelectedGhExecutor>;
  reportError(error: unknown): void;
  resolveDeployRepairLoop(
    state: CanvasState,
    requestedAttemptId: unknown
  ): DeployRepairLoopResolution;
  resolveDeploymentEnvironment(
    state: CanvasState,
    requestedEnvironment: unknown
  ): string;
  activeDeploymentMutation(
    state: CanvasState,
    target: { repo: string; environment: string }
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
    appName: string,
    executor: SelectedGhExecutor
  ): Promise<DeploymentRow | null>;
  // The subprocess runner used for the default-branch lookup. Rejects on
  // failure; an unresolved branch must not admit a deployment.
  runCommand(
    command: string,
    args: string[],
    executor: SelectedGhExecutor
  ): Promise<string>;
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
  monitorFor(execution: DeploymentExecution): DeployMonitorService;
  unconfirmedRunKind: CanvasState["deployErrorKind"];
  repairAttemptCap: number;
  errorMessage(error: unknown): string;
}

export type DeploymentStartResult =
  | {
      kind: "refused";
      reason: "conflict" | "unavailable" | "invalid";
      message: string;
    }
  | {
      kind: "started";
      execution: DeploymentExecution;
      repairAttempt?: number;
      repairAttemptCap?: number;
    };

export interface DeploymentStartInput {
  data: DeployRequestData;
  source: CanvasState;
  isCurrent(): boolean;
  present(execution: DeploymentExecution): void;
  notifications: readonly ((execution: DeploymentExecution) => unknown)[];
}

const REQUIRED_DEPENDENCIES: readonly (keyof DeploymentControllerDependencies)[] =
  [
    "account",
    "reportError",
    "monitorFor",
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
    "errorMessage"
  ];

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

export function createDeploymentController(
  dependencies: DeploymentControllerDependencies
) {
  assertDeployDependencies(
    "createDeploymentController",
    dependencies,
    REQUIRED_DEPENDENCIES
  );
  if (!dependencies.owner) {
    throw new Error(
      "createDeploymentController is missing required dependencies: owner"
    );
  }
  if (typeof dependencies.repairAttemptCap !== "number") {
    throw new Error(
      "createDeploymentController is missing required dependencies: repairAttemptCap"
    );
  }
  // Not function-typed, so the shared assert cannot reach it. The monitor-crash
  // path below marks the run unconfirmed precisely so a repair redeploy refuses
  // rather than racing a run whose outcome is unknown; an absent marking would
  // turn that fail-closed guarantee into a fail-open one.
  if (!dependencies.unconfirmedRunKind) {
    throw new Error(
      "createDeploymentController is missing required dependencies: unconfirmedRunKind"
    );
  }
  const report = (error: unknown, executor: SelectedGhExecutor): void => {
    try {
      dependencies.reportError(
        new Error(redactCredentials(executor.errorMessage(error)))
      );
    } catch {
      console.error(
        "[radius deploy] Could not report a deployment callback failure."
      );
    }
  };

  return {
    async start(input: DeploymentStartInput): Promise<DeploymentStartResult> {
      let reservation: DeploymentReservation | null = null;
      let reservationOwner: CanvasState | null = null;
      const releaseReservation = (): void => {
        if (reservation && reservationOwner)
          dependencies.releaseDeploymentMutation(reservationOwner, reservation);
        reservation = null;
        reservationOwner = null;
      };
      try {
        const data = { ...input.data };
        const notifications = [...input.notifications];
        const source = input.source;
        const requestedAttempt =
          typeof data.attemptId === "string" ? data.attemptId : "";
        const prior =
          requestedAttempt ?
            dependencies.owner.resolve({ attemptId: requestedAttempt })
          : undefined;
        const previous =
          prior?.kind === "resolved" ?
            dependencies.owner.execution(prior.invocation)
          : undefined;
        const sourceState = previous?.state ?? source;
        // Re-validate the repair-loop attempt before touching any state: the
        // tool checked it before sending, but a newer deploy may have started
        // since, and a stale repair must not clobber it.
        const loop = dependencies.resolveDeployRepairLoop(
          sourceState,
          data.attemptId
        );
        if (loop.error)
          return { kind: "refused", reason: "conflict", message: loop.error };
        if (prior && prior.kind !== "resolved")
          return {
            kind: "refused",
            reason: "conflict",
            message: "The requested deployment attempt is no longer available."
          };

        const repo =
          data.targetRepo ||
          previous?.invocation.target.repo ||
          source.plannedRepo ||
          source.contextRepo ||
          "";
        const environment = dependencies.resolveDeploymentEnvironment(
          source,
          data.environment || previous?.invocation.target.environment
        );
        if (!repo || !environment) {
          throw new Error("targetRepo and environment are required.");
        }
        if (
          previous &&
          (previous.invocation.target.repo !== repo ||
            previous.invocation.target.environment !== environment ||
            (data.branch &&
              data.branch !== previous.invocation.target.branch) ||
            (data.provider &&
              data.provider !== previous.invocation.target.provider) ||
            (data.appFile &&
              data.appFile !== previous.invocation.target.appFile))
        )
          return {
            kind: "refused",
            reason: "conflict",
            message: "A repair cannot change the deployment target."
          };
        const activeMutation = dependencies.activeDeploymentMutation(source, {
          repo,
          environment
        });
        if (
          dependencies.localDeploymentBlocksMutation(source) ||
          activeMutation
        ) {
          const activeRepo =
            activeMutation?.repo ||
            source.deployAttempt?.targetRepo ||
            source.deployingRepo ||
            repo;
          const activeEnvironment =
            activeMutation?.environment ||
            source.deployAttempt?.environment ||
            source.envName ||
            environment;
          const operation = activeMutation?.kind || "deploy";
          return {
            kind: "refused",
            reason: "conflict",
            message: `A ${operation} operation for ${activeRepo} in environment ${activeEnvironment} is already in progress. Wait for it to finish before starting another operation.`
          };
        }

        const admissionCurrent = (lease: DeploymentReservation) =>
          !dependencies.owner.stopped &&
          input.isCurrent() &&
          dependencies.owner.activeReservation({ repo, environment }) ===
            lease &&
          (!previous ||
            dependencies.owner.execution(previous.invocation) === previous);
        const admission = await admitDeployment(
          {
            repo,
            environment,
            branch: data.branch || previous?.invocation.target.branch,
            savedLogin: previous?.invocation.target.githubLogin
          },
          {
            reserve: () => {
              const lease = dependencies.reserveDeploymentMutation(source, {
                repo,
                environment,
                kind: "deploy"
              });
              if (!lease) return undefined;
              reservation = lease;
              reservationOwner = source;
              return lease;
            },
            release: releaseReservation,
            isCurrent: admissionCurrent,
            selectAccount: dependencies.account,
            readDeployment: (executor) =>
              dependencies.resolveEnvDeployment(
                repo,
                environment,
                repo.split("/").pop() || repo,
                executor
              ),
            blocksMutation: dependencies.deploymentStatusBlocksMutation,
            readDefaultBranch: (executor) =>
              dependencies.runCommand(
                "gh",
                [
                  "repo",
                  "view",
                  repo,
                  "--json",
                  "defaultBranchRef",
                  "--jq",
                  ".defaultBranchRef.name"
                ],
                executor
              )
          }
        );
        if (admission.kind === "refused") {
          return {
            kind: "refused",
            reason:
              admission.reason === "unavailable" ? "unavailable" : "conflict",
            message: admission.message
          };
        }
        const { executor, reservation: lease, branch } = admission;
        if (!admissionCurrent(lease))
          throw new Error("The deployment context changed during admission.");
        const entry = { state: structuredClone(sourceState) };
        delete entry.state.deploymentMutation;
        const provider =
          data.provider || previous?.invocation.target.provider || "azure";
        const appFile =
          data.appFile ||
          previous?.invocation.target.appFile ||
          ".radius/app.bicep";
        entry.state.deployParams = {
          ...data,
          targetRepo: repo,
          branch,
          provider,
          environment,
          appFile
        };
        entry.state.envName = environment;
        entry.state.deployProvider = provider;
        entry.state.deployingRepo = repo;
        entry.state.appFile = appFile;

        // Snapshot the planned graph (nodes start as pending). If the planned
        // graph has not been resolved yet, it is built on the fly inside the
        // monitor so the deploying page always shows it.
        const cloned: unknown = JSON.parse(
          JSON.stringify(entry.state.plannedResources || [])
        );
        let resources = dependencies.canvasGraphResources(
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
        dependencies.beginDeployAttempt(entry.state, {
          repo,
          branch,
          provider,
          environment,
          appFile,
          repairLoop: loop.repairLoop,
          attemptId: loop.attemptId
        });
        const begun = dependencies.owner.begin({
          reservation: lease,
          target: {
            repo,
            branch,
            provider,
            environment,
            appFile,
            githubLogin: executor.login
          },
          executor,
          state: entry.state,
          previous: previous?.invocation,
          repair: loop.repairLoop
        });
        if (begun.kind !== "resolved")
          throw new Error(
            `The deployment attempt could not start (${begun.kind}).`
          );
        const execution = dependencies.owner.execution(begun.invocation);
        if (!execution)
          throw new Error("The deployment runtime stopped during admission.");
        resources = execution.state.deployingResources;
        lease.attemptId = begun.invocation.attemptId;
        const isCurrent = () =>
          dependencies.owner.execution(begun.invocation) === execution &&
          !execution.observation.stopped;
        const addLog = (msg: string): void => {
          if (!isCurrent()) return;
          dependencies.owner.appendLog(begun.invocation, msg);
        };
        try {
          input.present(execution);
        } catch (error) {
          report(error, executor);
        }
        if (!isCurrent())
          throw new Error(
            "The deployment runtime stopped before its monitor could start."
          );

        // Deliberately backgrounded: the response below must not wait for the
        // workflow. The monitor owns every terminal transition of this deploy.
        void dependencies.owner
          .run(
            begun.invocation,
            async () => {
              try {
                await dependencies.monitorFor(execution).run({
                  entry: execution,
                  repo,
                  branch,
                  provider,
                  requestedEnvironment: environment,
                  resources,
                  log: addLog,
                  isCurrent
                });
              } catch (monErr) {
                if (!isCurrent()) return;
                // Never let the background monitor die silently (which would leave
                // the page stuck polling an 'in_progress' that never resolves).
                // Surface the error and settle the status.
                execution.state.deployErrorKind =
                  dependencies.unconfirmedRunKind;
                execution.state.deployStatus = "failed";
                const primaryError = execution.state.deployError;
                if (!primaryError)
                  execution.state.deployError =
                    "Deploy monitoring stopped unexpectedly.";
                const reason = redactCredentials(
                  executor.redact(monitorFailureText(monErr))
                ).slice(0, 4000);
                addLog("❌ Deploy monitor stopped unexpectedly: " + reason);
                if (!primaryError)
                  execution.state.deployError =
                    "Deploy monitoring stopped unexpectedly: " + reason;
                // Same reasoning as the monitor's timeout: the monitor died, so
                // the workflow's real outcome is unknown and a repair redeploy
                // must not assume the run is over.
              } finally {
                // The monitor owns every terminal transition of this deploy, so
                // firing here makes the repair loop independent of the webview.
                // The /api/deploy-status route keeps its own call as a fallback,
                // and triggerDeployRepairHandoff is idempotent per repair loop.
                for (const notify of notifications) {
                  if (!isCurrent()) break;
                  try {
                    await notify(execution);
                  } catch (error) {
                    report(error, executor);
                  }
                }
                // Same reasoning for the informational notice: a run-unconfirmed
                // failure is relayed once from here regardless of whether the panel
                // is still polling. Idempotent per attempt, like the handoff.
                // Hold the repo/environment reservation for the whole deploy, not
                // merely until the background monitor starts.
                if (isCurrent()) dependencies.owner.publish(begun.invocation);
              }
            },
            releaseReservation
          )
          .catch((error: unknown) => {
            releaseReservation();
            report(error, executor);
          });

        // Report the loop's position back so the agent sees its remaining
        // budget on every redeploy, instead of having to remember the cap from
        // the single handoff that opened the loop.
        return {
          kind: "started",
          execution,
          ...(loop.repairLoop ?
            {
              repairAttempt: loop.repairAttempt,
              repairAttemptCap: dependencies.repairAttemptCap
            }
          : {})
        };
      } catch (e) {
        releaseReservation();
        return {
          kind: "refused",
          reason: "invalid",
          message: dependencies.errorMessage(e)
        };
      }
    }
  };
}
