import type {
  DeploymentInvocation,
  DeploymentRuntime,
  DeploymentReservation as OwnedReservation
} from "@radius-project/adapter-shared";
import type { DeploymentState, DeploymentTarget } from "@radius-project/core";
import type { CanvasState } from "../../shared.js";
import {
  captureDeployedApplicationState,
  matchesDeployedApplicationState,
  type DeletedDeploymentIdentity
} from "./deployed-view-state.js";

type Invocation = DeploymentInvocation<DeploymentState>;

export interface DeploymentViewReservation {
  repo: string;
  environment: string;
  kind: "deploy" | "delete" | "abandon";
  expiresAt: number;
  attemptId?: string;
}

const PROJECTION_KEYS = [
  "deployParams",
  "deployAttempt",
  "deployGeneration",
  "deployingRepo",
  "deployingBranch",
  "deployingProvider",
  "deployingResources",
  "deployStatus",
  "deployError",
  "deployErrorKind",
  "deployErrorBranch",
  "deployErrorPaths",
  "deployEnvName",
  "deployAppName",
  "deployDispatchedAt",
  "deployRunId",
  "deployRunUrl",
  "deployStartedAt",
  "deployFinishedAt",
  "deployLogs",
  "deployLogBase",
  "deployedGraph",
  "deployedGraphRepo",
  "deployRepairing",
  "deployHandoffState",
  "deployHandoffAttempts",
  "deployNoticeState",
  "deployNoticeAttempts",
  "deployRepairAttempts"
] as const;

/** Subscriber state is a disposable projection, never the deployment authority. */
export function createDeploymentViews(runtime: DeploymentRuntime) {
  const views = new Map<
    string,
    {
      state: CanvasState;
      invocation: Invocation;
      unsubscribe(): void;
    }
  >();
  const remembered = new Map<
    string,
    {
      attemptId: string;
      target: Pick<DeploymentTarget, "repo" | "environment">;
    }
  >();
  const resetViews = new Set<string>();
  const leases = new WeakMap<DeploymentViewReservation, OwnedReservation>();

  function project(state: CanvasState, invocation: Invocation): void {
    const snapshot = structuredClone(invocation.state);
    for (const key of PROJECTION_KEYS) {
      delete state[key];
      if (snapshot[key] !== undefined)
        Object.assign(state, { [key]: snapshot[key] });
    }
    state.envName = invocation.target.environment;
    state.deployProvider = invocation.target.provider;
    state.appFile = invocation.target.appFile;
  }

  function detach(instanceId: string): void {
    views.get(instanceId)?.unsubscribe();
    views.delete(instanceId);
  }

  function attach(
    instanceId: string,
    state: CanvasState,
    invocation: Invocation
  ): void {
    detach(instanceId);
    resetViews.delete(instanceId);
    remembered.set(instanceId, {
      attemptId: invocation.attemptId,
      target: {
        repo: invocation.target.repo,
        environment: invocation.target.environment
      }
    });
    project(state, invocation);
    const unsubscribe = runtime.owner.subscribe(invocation, (current) =>
      project(state, current)
    );
    views.set(instanceId, { state, invocation, unsubscribe });
  }

  function refresh(instanceId: string, state: CanvasState): void {
    if (resetViews.has(instanceId)) return;
    const previous = remembered.get(instanceId);
    const repo = state.contextRepo || state.workspaceRepo || state.plannedRepo;
    const environment = state.envName;
    let selected =
      previous ? runtime.owner.lookup({ attemptId: previous.attemptId })
      : repo && environment ? runtime.owner.lookupTarget({ repo, environment })
      : runtime.owner.lookup();
    if (previous && selected.kind === "missing")
      selected = runtime.owner.lookupTarget(previous.target);
    if (selected.kind !== "found") return;
    if (
      (repo &&
        repo.toLowerCase() !== selected.invocation.target.repo.toLowerCase()) ||
      (!previous &&
        environment &&
        environment.toLowerCase() !==
          selected.invocation.target.environment.toLowerCase())
    ) {
      detach(instanceId);
      for (const key of PROJECTION_KEYS) delete state[key];
      delete state.deployResult;
      return;
    }
    const view = views.get(instanceId);
    if (view?.state !== state || view.invocation !== selected.invocation)
      attach(instanceId, state, selected.invocation);
    else project(state, selected.invocation);
  }

  function reset(state: CanvasState, attemptId: unknown): void {
    const match = [...views].find(([, view]) => view.state === state);
    if (!match) return;
    const [instanceId, view] = match;
    if (attemptId !== view.invocation.attemptId) return;
    const terminal = ["success", "complete", "failed"].includes(
      view.invocation.state.deployStatus || ""
    );
    if (
      terminal &&
      view.invocation.state.deployErrorKind !== "run-unconfirmed" &&
      !runtime.owner.isActive(view.invocation)
    ) {
      retire(view.invocation);
      return;
    }
    detach(instanceId);
    remembered.delete(instanceId);
    resetViews.add(instanceId);
    for (const key of PROJECTION_KEYS) delete state[key];
    delete state.deployResult;
  }

  function retire(invocation: Invocation): boolean {
    if (!runtime.owner.retire(invocation)) return false;
    for (const [id, view] of views) {
      if (view.invocation !== invocation) continue;
      detach(id);
      for (const key of PROJECTION_KEYS) delete view.state[key];
      delete view.state.deployResult;
    }
    for (const [id, reference] of remembered) {
      if (reference.attemptId !== invocation.attemptId) continue;
      remembered.delete(id);
      resetViews.add(id);
    }
    return true;
  }

  function captureDeletion(
    state: CanvasState,
    target: DeletedDeploymentIdentity & { repo: string }
  ): () => void {
    const selected = runtime.owner.lookupTarget(target);
    if (
      selected.kind !== "found" ||
      !matchesDeployedApplicationState(
        {
          deployEnvName: selected.invocation.target.environment,
          deployAppName: selected.invocation.state.deployAppName
        },
        target
      )
    )
      return captureDeployedApplicationState(state, target);
    const invocation = selected.invocation;
    return () => {
      if (!runtime.owner.invalidate(invocation)) return;
      for (const [id, view] of views) {
        if (view.invocation !== invocation) continue;
        detach(id);
        for (const key of PROJECTION_KEYS) delete view.state[key];
        delete view.state.deployResult;
      }
      for (const [id, reference] of remembered) {
        if (reference.attemptId === invocation.attemptId) remembered.delete(id);
      }
    };
  }

  return {
    attach,
    detach,
    refresh,
    reset,
    retire,
    captureDeletion,
    reserve(
      _state: CanvasState,
      input: Pick<DeploymentViewReservation, "repo" | "environment" | "kind">
    ): DeploymentViewReservation | null {
      const owned = runtime.owner.reserve(input, input.kind);
      if (!owned) return null;
      const lease = { ...input, expiresAt: owned.expiresAt };
      leases.set(lease, owned);
      return lease;
    },
    release(_state: CanvasState, lease: DeploymentViewReservation): void {
      const owned = leases.get(lease);
      if (!owned) return;
      runtime.owner.release(owned);
      leases.delete(lease);
    }
  };
}
