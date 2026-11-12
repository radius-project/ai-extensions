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

function context(state: CanvasState): string {
  return JSON.stringify([
    (
      state.contextRepo ||
      state.workspaceRepo ||
      state.plannedRepo ||
      ""
    ).toLowerCase(),
    state.contextBranch || state.workspaceBranch || state.plannedBranch || ""
  ]);
}

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
      context: string;
    }
  >();
  const resetViews = new WeakMap<CanvasState, string>();
  const lifetimes = new Map<string, CanvasState>();
  const projectedDefaults = new WeakMap<
    CanvasState,
    Pick<CanvasState, "envName" | "deployProvider" | "appFile">
  >();
  const contextDefaults = new WeakMap<
    CanvasState,
    Pick<CanvasState, "envName" | "deployProvider" | "appFile">
  >();
  const leases = new WeakMap<DeploymentViewReservation, OwnedReservation>();

  function project(state: CanvasState, invocation: Invocation): void {
    contextDefaults.set(state, defaults(state));
    const snapshot = structuredClone(invocation.state);
    for (const key of PROJECTION_KEYS) {
      delete state[key];
      if (snapshot[key] !== undefined)
        Object.assign(state, { [key]: snapshot[key] });
    }
    state.envName = invocation.target.environment;
    state.deployProvider = invocation.target.provider;
    state.appFile = invocation.target.appFile;
    projectedDefaults.set(state, {
      envName: state.envName,
      deployProvider: state.deployProvider,
      appFile: state.appFile
    });
  }

  function defaults(
    state: CanvasState
  ): Pick<CanvasState, "envName" | "deployProvider" | "appFile"> {
    const projected = projectedDefaults.get(state);
    const selected = contextDefaults.get(state);
    return Object.fromEntries(
      (["envName", "deployProvider", "appFile"] as const).map((key) => [
        key,
        projected && state[key] === projected[key] ?
          selected?.[key]
        : state[key]
      ])
    );
  }

  function unsubscribe(instanceId: string): void {
    views.get(instanceId)?.unsubscribe();
    views.delete(instanceId);
  }

  function detach(instanceId: string, state: CanvasState): void {
    if (lifetimes.get(instanceId) !== state) return;
    unsubscribe(instanceId);
    lifetimes.delete(instanceId);
    resetViews.delete(state);
  }

  function clearProjection(state: CanvasState): void {
    for (const key of PROJECTION_KEYS) delete state[key];
    delete state.deployResult;
    const projected = projectedDefaults.get(state);
    if (projected)
      for (const key of ["envName", "deployProvider", "appFile"] as const)
        if (state[key] === projected[key]) delete state[key];
    projectedDefaults.delete(state);
    contextDefaults.delete(state);
  }

  function attach(
    instanceId: string,
    state: CanvasState,
    invocation: Invocation
  ): void {
    unsubscribe(instanceId);
    lifetimes.set(instanceId, state);
    resetViews.delete(state);
    const attachedContext = context(state);
    remembered.set(instanceId, {
      attemptId: invocation.attemptId,
      target: {
        repo: invocation.target.repo,
        environment: invocation.target.environment
      },
      context: attachedContext
    });
    project(state, invocation);
    const stop = runtime.owner.subscribe(invocation, (current) => {
      if (context(state) === attachedContext) project(state, current);
    });
    views.set(instanceId, { state, invocation, unsubscribe: stop });
  }

  function refresh(instanceId: string, state: CanvasState): void {
    const resetContext = resetViews.get(state);
    if (resetContext !== undefined) {
      if (resetContext === context(state)) return;
      resetViews.delete(state);
    }
    if (lifetimes.get(instanceId) !== state) {
      unsubscribe(instanceId);
      lifetimes.set(instanceId, state);
    }
    const repo = state.contextRepo || state.workspaceRepo || state.plannedRepo;
    let previous = remembered.get(instanceId);
    if (previous && context(state) !== previous.context) {
      unsubscribe(instanceId);
      remembered.delete(instanceId);
      previous = undefined;
      clearProjection(state);
    }
    const environment = state.envName;
    let selected =
      previous ? runtime.owner.lookup({ attemptId: previous.attemptId })
      : repo && environment ? runtime.owner.lookupTarget({ repo, environment })
      : repo ? runtime.owner.lookupRepository(repo)
      : runtime.owner.lookup();
    if (previous && selected.kind === "missing")
      selected = runtime.owner.lookupTarget(previous.target);
    if (selected.kind !== "found") return;
    if (
      (!previous &&
        repo &&
        repo.toLowerCase() !== selected.invocation.target.repo.toLowerCase()) ||
      (!previous &&
        environment &&
        environment.toLowerCase() !==
          selected.invocation.target.environment.toLowerCase())
    ) {
      unsubscribe(instanceId);
      clearProjection(state);
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
    unsubscribe(instanceId);
    remembered.delete(instanceId);
    resetViews.set(state, context(state));
    clearProjection(state);
  }

  function retire(invocation: Invocation): boolean {
    if (!runtime.owner.retire(invocation)) return false;
    for (const [id, view] of views) {
      if (view.invocation !== invocation) continue;
      unsubscribe(id);
      resetViews.set(view.state, context(view.state));
      clearProjection(view.state);
    }
    for (const [id, reference] of remembered) {
      if (reference.attemptId !== invocation.attemptId) continue;
      remembered.delete(id);
      const state = lifetimes.get(id);
      if (state) resetViews.set(state, context(state));
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
        unsubscribe(id);
        clearProjection(view.state);
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
    defaults,
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
