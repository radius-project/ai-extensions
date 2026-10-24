import type {
  DeploymentExecutionOwner,
  DeploymentInvocation
} from "../../runtime/deployment-execution-owner.js";
import type { CanvasState } from "../../shared.js";

const FIELDS = [
  "deployResult",
  "deployProvider",
  "deployingRepo",
  "deployingBranch",
  "deployingProvider",
  "deployingResources",
  "deployParams",
  "deployAttempt",
  "deployGeneration",
  "deployStartedAt",
  "deployFinishedAt",
  "deployLogs",
  "deployLogBase",
  "deployStatus",
  "deployError",
  "deployEnvName",
  "deployAppName",
  "deployDispatchedAt",
  "deployDispatchReference",
  "deployDispatchEvidence",
  "deployRunId",
  "deployRunUrl",
  "deployErrorKind",
  "deployErrorBranch",
  "deployErrorPaths",
  "deployRepairing",
  "deployHandoffState",
  "deployHandoffAttempts",
  "deployNoticeState",
  "deployNoticeAttempts",
  "deployRepairAttempts",
  "deployedGraph",
  "deployedGraphRepo"
] as const;

function copyField<Key extends (typeof FIELDS)[number]>(
  state: CanvasState,
  snapshot: CanvasState,
  field: Key
): void {
  if (Object.hasOwn(snapshot, field)) state[field] = snapshot[field];
  else delete state[field];
}

interface Attachment {
  state: CanvasState;
  invocation: DeploymentInvocation;
  detach(): void;
  selectionKey?: string;
}

function selectionKey(state: CanvasState): string {
  return JSON.stringify([
    state.plannedRepo,
    state.contextRepo,
    state.plannedEnvironment,
    state.envName,
    state.plannedBranch,
    state.contextBranch,
    state.graphBranch,
    state.plannedProvider,
    state.appFile
  ]);
}

function stillProjected(attachment: Attachment): boolean {
  return (
    attachment.state.deployAttempt?.id === attachment.invocation.attemptId &&
    attachment.state.deployGeneration === attachment.invocation.generation
  );
}

export function createDeploymentPresentation(owner: DeploymentExecutionOwner) {
  const attachments = new Map<string, Attachment>();
  const bindings = new Map<
    string,
    {
      invocation: DeploymentInvocation;
      repo: string;
      branch: string;
    }
  >();
  const detach = (instanceId: string): void => {
    attachments.get(instanceId)?.detach();
    attachments.delete(instanceId);
  };
  const clearSelection = (instanceId: string): void => {
    bindings.delete(instanceId);
    const attachment = attachments.get(instanceId);
    if (attachment && stillProjected(attachment)) {
      for (const field of FIELDS) delete attachment.state[field];
    }
    detach(instanceId);
  };
  const selected = (
    state: CanvasState,
    attachment?: Attachment
  ): DeploymentInvocation | undefined => {
    if (attachment?.selectionKey !== undefined) {
      if (selectionKey(state) !== attachment.selectionKey) return undefined;
      const target = attachment.invocation.target;
      const current = owner.resolve({
        repo: target.repo,
        environment: target.environment,
        branch: target.branch,
        provider: target.provider,
        appFile: target.appFile
      });
      return current.kind === "resolved" ? current.invocation : undefined;
    }
    const repo = state.plannedRepo || state.contextRepo;
    const environment = state.plannedEnvironment || state.envName;
    if (!repo || !environment) return undefined;
    const result = owner.resolve({
      repo,
      environment,
      branch: state.plannedBranch || state.contextBranch || state.graphBranch,
      provider: state.plannedProvider || undefined,
      appFile: state.appFile || undefined
    });
    if (result.kind !== "resolved") return undefined;
    return result.invocation;
  };
  const project = (state: CanvasState, snapshot: CanvasState): void => {
    for (const field of FIELDS) copyField(state, snapshot, field);
  };
  const attach = (
    instanceId: string,
    state: CanvasState,
    invocation: DeploymentInvocation,
    explicit: boolean
  ): void => {
    detach(instanceId);
    const snapshot = owner.snapshot(invocation);
    if (!snapshot || !owner.execution(invocation)) return;
    const binding = {
      invocation,
      repo: state.contextRepo || invocation.target.repo,
      branch: state.contextBranch || invocation.target.branch
    };
    bindings.set(instanceId, binding);
    project(state, snapshot);
    const attachment: Attachment = {
      state,
      invocation,
      detach: () => {},
      ...(explicit ? { selectionKey: selectionKey(state) } : {})
    };
    attachments.set(instanceId, attachment);
    attachment.detach = owner.subscribe(invocation, (snapshot) => {
      if (!stillProjected(attachment)) {
        clearSelection(instanceId);
        return;
      }
      const current = selected(state, attachment);
      if (
        !current ||
        snapshot.deployAttempt?.id !== current.attemptId ||
        snapshot.deployGeneration !== current.generation
      ) {
        clearSelection(instanceId);
        return;
      }
      attachment.invocation = current;
      binding.invocation = current;
      project(state, snapshot);
    });
  };

  return {
    detach,
    attach(
      instanceId: string,
      state: CanvasState,
      invocation: DeploymentInvocation
    ): void {
      attach(instanceId, state, invocation, true);
    },
    owns(state: CanvasState): boolean {
      return [...attachments.values()].some(
        (attachment) => attachment.state === state && stillProjected(attachment)
      );
    },
    dispose(): void {
      for (const instanceId of attachments.keys()) detach(instanceId);
      bindings.clear();
    },
    restore(instanceId: string, state: CanvasState): void {
      const binding = bindings.get(instanceId);
      if (!binding) return;
      const target = binding.invocation.target;
      const resolved = owner.resolve({
        ...target,
        attemptId: binding.invocation.attemptId
      });
      if (
        state.contextRepo !== binding.repo ||
        state.contextBranch !== binding.branch ||
        (state.plannedRepo && state.plannedRepo !== target.repo) ||
        (state.plannedBranch && state.plannedBranch !== target.branch) ||
        ((state.plannedEnvironment || state.envName) &&
          (state.plannedEnvironment || state.envName) !== target.environment) ||
        (state.plannedProvider && state.plannedProvider !== target.provider) ||
        (state.appFile && state.appFile !== target.appFile) ||
        resolved.kind !== "resolved" ||
        resolved.invocation.target.githubLogin !== target.githubLogin ||
        resolved.invocation.generation < binding.invocation.generation ||
        (state.deployAttempt &&
          (state.deployAttempt.id !== resolved.invocation.attemptId ||
            state.deployGeneration !== resolved.invocation.generation))
      ) {
        clearSelection(instanceId);
        return;
      }
      state.envName = target.environment;
      state.appFile = target.appFile;
      attach(instanceId, state, resolved.invocation, true);
    },
    synchronize(instanceId: string, state: CanvasState): void {
      const existing = attachments.get(instanceId);
      if (existing?.state === state && !stillProjected(existing)) {
        clearSelection(instanceId);
        return;
      }
      const invocation = selected(state, existing);
      if (!invocation) {
        clearSelection(instanceId);
        return;
      }
      if (
        existing?.state !== state &&
        state.deployAttempt &&
        (state.deployAttempt.id !== invocation.attemptId ||
          state.deployGeneration !== invocation.generation)
      ) {
        detach(instanceId);
        return;
      }
      if (existing?.state === state && existing.invocation === invocation) {
        owner.publish(invocation);
        return;
      }
      attach(
        instanceId,
        state,
        invocation,
        existing?.selectionKey !== undefined
      );
    }
  };
}
