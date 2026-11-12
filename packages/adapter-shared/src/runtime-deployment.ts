import {
  DEPLOY_REPAIR_ATTEMPT_CAP,
  resolveDeployRepairLoop,
  resolveDeploymentTarget,
  type DeploymentStartInput,
  type DeploymentTarget,
  type DeploymentWorkspace,
  type DeploymentResource,
  type DeploymentState
} from "@radius-project/core";
import {
  createDeploymentOwner,
  type DeploymentInvocation,
  type DeploymentOwnerPorts
} from "./deployment-owner.js";
import type {
  DeployMonitorService,
  DeploymentGraphRecovery
} from "./deployment-monitor.js";
import type { WorkflowObservationScope } from "./workflow-observation-scope.js";
import { assertDeployDependencies } from "./deployment-service-dependencies.js";
import {
  createDeploymentRepairCoordinator,
  type DeploymentRepairDependencies
} from "./deployment-repair.js";

export type {
  DeploymentWorkspace,
  DeploymentStartInput
} from "@radius-project/core";

export interface DeploymentStartContext {
  workspace?: DeploymentWorkspace;
  resources?: DeploymentResource[];
  instanceId?: string;
  plannedGraph?: DeploymentGraphRecovery;
  modelSelection?: {
    resolve(target: Readonly<DeploymentTarget>): Promise<string | null>;
    isCurrent(): boolean;
  };
}

export interface DeploymentRuntimePorts extends DeploymentOwnerPorts {
  awsEnabled: boolean;
  resolveDefaultBranch(repo: string): Promise<string>;
  normalizeAppFile(path: string): string;
  resolveDeployment(
    repo: string,
    environment: string,
    compatibilityApplicationName: string
  ): Promise<{ status: string } | null>;
  statusBlocksMutation(status: string): boolean;
  createExecution(
    invocation: DeploymentInvocation<DeploymentState>,
    workspace: DeploymentWorkspace | undefined,
    plannedGraph?: DeploymentGraphRecovery
  ): { monitor: DeployMonitorService; observation: WorkflowObservationScope };
  delivery: Pick<
    DeploymentRepairDependencies,
    "sendRepair" | "sendNotice" | "redactDiagnostic" | "reportDiagnostic"
  >;
}

export type DeploymentStartResult =
  | {
      ok: true;
      invocation: DeploymentInvocation<DeploymentState>;
      repairAttempt?: number;
      repairAttemptCap?: number;
    }
  | { ok: false; status: 400 | 409 | 503; error: string };

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function clonePending(resources: DeploymentResource[]): DeploymentResource[] {
  return resources.map((resource) => ({
    ...resource,
    deployStatus: "pending",
    ...(resource.outputResources ?
      { outputResources: clonePending(resource.outputResources) }
    : {})
  }));
}

/** One runtime/session authority, shared by panel and direct-tool consumers. */
export function createDeploymentRuntime(ports: DeploymentRuntimePorts) {
  assertDeployDependencies("createDeploymentRuntime", ports, [
    "now",
    "id",
    "reportError",
    "resolveDefaultBranch",
    "normalizeAppFile",
    "resolveDeployment",
    "statusBlocksMutation",
    "createExecution"
  ]);
  if (typeof ports.awsEnabled !== "boolean")
    throw new Error("createDeploymentRuntime requires awsEnabled.");
  const owner = createDeploymentOwner<DeploymentState>(ports);
  async function publishDelivery(
    invocation: DeploymentInvocation<DeploymentState>,
    deliver: () => Promise<unknown>
  ): Promise<void> {
    try {
      const pending = deliver();
      owner.publish(invocation);
      await pending;
    } finally {
      owner.publish(invocation);
    }
  }

  const repair = createDeploymentRepairCoordinator({
    ...ports.delivery,
    scheduleRetry(identity, callback, milliseconds) {
      const current = owner.lookup({ attemptId: identity.attemptId });
      if (
        current.kind !== "found" ||
        current.invocation.generation !== identity.generation
      )
        return;
      const invocation = current.invocation;
      void owner
        .run(invocation, async () => {
          await wait(milliseconds, invocation.signal);
          if (!invocation.signal.aborted && owner.isCurrent(invocation))
            await publishDelivery(invocation, callback);
        })
        .catch(ports.reportError);
    }
  });

  async function admit(
    input: DeploymentStartInput,
    context: DeploymentStartContext
  ): Promise<DeploymentStartResult> {
    const previous = owner.lookup(
      input.attemptId ? { attemptId: input.attemptId } : {}
    );
    if (input.attemptId && previous.kind !== "found")
      return {
        ok: false,
        status: 409,
        error: "The repair attempt is no longer current. Nothing was deployed."
      };
    if (
      previous.kind === "ambiguous" &&
      (!input.repo || !input.environment || !input.branch)
    )
      return {
        ok: false,
        status: 400,
        error:
          "More than one deployment is known. Specify repo, environment and branch."
      };
    const prior = previous.kind === "found" ? previous.invocation : undefined;
    const loop = resolveDeployRepairLoop(prior?.state ?? {}, input.attemptId);
    if (loop.error) return { ok: false, status: 409, error: loop.error };
    let resolved: ReturnType<typeof resolveDeploymentTarget>;
    try {
      resolved = resolveDeploymentTarget(input, {
        previous: prior?.target,
        workspace: context.workspace,
        awsEnabled: ports.awsEnabled,
        normalizeAppFile: ports.normalizeAppFile
      });
    } catch (error) {
      return {
        ok: false,
        status: 400,
        error: ports.delivery.redactDiagnostic(
          `Invalid deployment model: ${error instanceof Error ? error.message : String(error)}`
        )
      };
    }
    if ("error" in resolved) return { ok: false, ...resolved };
    const { target } = resolved;
    const { repo } = target;
    const reservation = owner.reserve(target, "deploy");
    if (!reservation)
      return {
        ok: false,
        status: 409,
        error:
          "Another deployment operation for this repository and environment is in progress."
      };
    try {
      // Preserve the legacy remote lookup; the model application name can differ.
      const compatibilityApplicationName = repo.slice(repo.indexOf("/") + 1);
      let remote: { status: string } | null;
      try {
        remote = await ports.resolveDeployment(
          repo,
          target.environment,
          compatibilityApplicationName
        );
      } catch (error) {
        return {
          ok: false,
          status: 503,
          error: ports.delivery.redactDiagnostic(
            `Could not verify the deployment target: ${error instanceof Error ? error.message : String(error)}`
          )
        };
      }
      if (owner.isShuttingDown() || (prior && !owner.isCurrent(prior)))
        return {
          ok: false,
          status: 409,
          error:
            "The deployment context changed while checking its target. Nothing was deployed."
        };
      if (remote && ports.statusBlocksMutation(remote.status))
        return {
          ok: false,
          status: 409,
          error: "A remote deployment operation is already in progress."
        };
      if (!target.branch) {
        try {
          target.branch = (await ports.resolveDefaultBranch(repo)).trim();
          if (!target.branch)
            throw new Error(
              "GitHub returned no deployment branch. Specify branch explicitly."
            );
        } catch (error) {
          return {
            ok: false,
            status: 503,
            error: ports.delivery.redactDiagnostic(
              `Could not resolve the deployment branch: ${error instanceof Error ? error.message : String(error)}`
            )
          };
        }
      }
      if (owner.isShuttingDown() || (prior && !owner.isCurrent(prior)))
        return {
          ok: false,
          status: 409,
          error:
            "The deployment context changed while checking its branch. Nothing was deployed."
        };
      if (context.modelSelection && !input.appFile && !input.attemptId) {
        const selection = context.modelSelection;
        const current = () =>
          !owner.isShuttingDown() &&
          (!prior || owner.isCurrent(prior)) &&
          selection.isCurrent();
        if (!current())
          return {
            ok: false,
            status: 409,
            error: "The model selection changed. Nothing was deployed."
          };
        let selected: string | null;
        try {
          selected = await selection.resolve(Object.freeze({ ...target }));
        } catch (error) {
          return {
            ok: false,
            status: 503,
            error: ports.delivery.redactDiagnostic(
              `Could not resolve the application model: ${error instanceof Error ? error.message : String(error)}`
            )
          };
        }
        if (!current())
          return {
            ok: false,
            status: 409,
            error: "The model selection changed. Nothing was deployed."
          };
        if (!selected)
          return {
            ok: false,
            status: 400,
            error:
              "No Radius application model was found on the selected branch."
          };
        try {
          target.appFile = ports.normalizeAppFile(selected);
        } catch (error) {
          return {
            ok: false,
            status: 400,
            error: ports.delivery.redactDiagnostic(
              error instanceof Error ? error.message : String(error)
            )
          };
        }
      }
      const state: DeploymentState = {
        envName: target.environment,
        workspaceBranch: context.workspace?.branch,
        deployParams: { ...target, targetRepo: repo },
        deployingRepo: repo,
        deployingBranch: target.branch,
        deployingProvider: target.provider,
        deployingResources: clonePending(context.resources ?? []),
        deployStatus: "in_progress",
        deployError: null,
        deployErrorKind: null,
        deployErrorBranch: null,
        deployErrorPaths: null,
        deployRunUrl: null,
        deployRunId: null,
        deployedGraph: null,
        deployLogs: [],
        deployLogBase: 0,
        deployRepairing: loop.repairLoop,
        deployHandoffState: loop.repairLoop ? "delivered" : "idle",
        deployHandoffAttempts:
          loop.repairLoop ? (prior?.state.deployHandoffAttempts ?? 0) : 0,
        deployRepairAttempts: loop.repairAttempt,
        deployNoticeState: "idle",
        deployNoticeAttempts: 0
      };
      const invocation = owner.begin(
        target,
        state,
        reservation,
        input.attemptId
      );
      state.deployAttempt = { ...state.deployParams, id: invocation.attemptId };
      state.deployGeneration = invocation.generation;
      const isCurrent = () =>
        owner.isCurrent(invocation) && !invocation.signal.aborted;
      const log = (message: string) => {
        if (!isCurrent()) return;
        const logs = state.deployLogs ?? [];
        state.deployLogs = logs;
        logs.push(ports.delivery.redactDiagnostic(message));
        if (logs.length > 4000) {
          const dropped = logs.length - 4000;
          logs.splice(0, dropped);
          state.deployLogBase = (state.deployLogBase ?? 0) + dropped;
        }
        owner.publish(invocation);
      };
      const workspace =
        context.workspace ? Object.freeze({ ...context.workspace }) : undefined;
      void owner
        .run(invocation, async () => {
          let execution:
            ReturnType<DeploymentRuntimePorts["createExecution"]> | undefined;
          try {
            execution = ports.createExecution(
              invocation,
              workspace,
              context.plannedGraph
            );
            invocation.signal.addEventListener(
              "abort",
              execution.observation.stop,
              { once: true }
            );
            await execution.monitor.run({
              entry: { state, observation: execution.observation },
              repo,
              branch: target.branch,
              provider: target.provider,
              requestedEnvironment: target.environment,
              appFile: target.appFile,
              resources: state.deployingResources ?? [],
              log,
              isCurrent
            });
            if (state.deployStatus === "in_progress")
              throw new Error(
                "Monitoring ended without confirming the workflow outcome."
              );
          } catch (error) {
            state.deployStatus = "failed";
            state.deployErrorKind = "run-unconfirmed";
            const reason =
              error instanceof Error ? error.message : String(error);
            state.deployError = ports.delivery.redactDiagnostic(
              `Deploy monitoring stopped unexpectedly: ${reason}`
            );
            log(`\u274c Deploy monitor stopped unexpectedly: ${reason}`);
            ports.reportError(error);
          } finally {
            if (execution) {
              invocation.signal.removeEventListener(
                "abort",
                execution.observation.stop
              );
              execution.observation.stop();
            }
            owner.publish(invocation);
          }
          if (isCurrent())
            await publishDelivery(invocation, () =>
              repair.coordinate({
                appFile: invocation.target.appFile,
                state,
                attemptId: invocation.attemptId,
                generation: invocation.generation,
                repo,
                branch: target.branch,
                instanceId: context.instanceId,
                isCurrent
              })
            );
        })
        .catch(ports.reportError);
      return {
        ok: true,
        invocation,
        ...(loop.repairLoop ?
          {
            repairAttempt: loop.repairAttempt,
            repairAttemptCap: DEPLOY_REPAIR_ATTEMPT_CAP
          }
        : {})
      };
    } finally {
      // Once admitted, the tracked task (not a wall-clock lease) holds the target.
      owner.release(reservation);
    }
  }

  return {
    owner,
    start(input: DeploymentStartInput, context: DeploymentStartContext = {}) {
      const capturedContext: DeploymentStartContext = {
        ...context,
        workspace: context.workspace ? { ...context.workspace } : undefined,
        resources:
          context.resources ? clonePending(context.resources) : undefined
      };
      const capturedInput = { ...input };
      return owner.trackAdmission(() => admit(capturedInput, capturedContext));
    }
  };
}

export type DeploymentRuntime = ReturnType<typeof createDeploymentRuntime>;
