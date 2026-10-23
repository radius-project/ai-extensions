import { redactCredentials } from "@radius-project/core";
import type { SelectedGhExecutor } from "../gh.js";
import type { CanvasState } from "../shared.js";
import type { WorkflowObservationScope } from "../server/services/workflow-observation-scope.js";

export interface DeploymentTarget {
  readonly repo: string;
  readonly environment: string;
  readonly branch: string;
  readonly provider: string;
  readonly appFile: string;
  readonly githubLogin: string;
}

export interface DeploymentInvocation {
  readonly attemptId: string;
  readonly generation: number;
  readonly target: DeploymentTarget;
}

export interface DeploymentReservation {
  readonly repo: string;
  readonly environment: string;
  readonly kind: "deploy" | "delete" | "abandon";
  readonly expiresAt: number;
  attemptId?: string;
}

export interface DeploymentExecution {
  readonly invocation: DeploymentInvocation;
  readonly executor: SelectedGhExecutor;
  readonly state: CanvasState;
  readonly observation: WorkflowObservationScope;
}

export type DeploymentResolution =
  | { kind: "resolved"; invocation: DeploymentInvocation }
  | { kind: "missing" | "stale" | "retargeted" | "shutdown" }
  | { kind: "ambiguous"; choices: readonly DeploymentInvocation[] };

export interface DeploymentExecutionOwnerPorts {
  now(): number;
  newAttemptId(): string;
  createObservation(executor: SelectedGhExecutor): WorkflowObservationScope;
  reportError(error: unknown): void;
}

interface OwnedExecution extends DeploymentExecution {
  task?: Promise<void>;
  subscribers: Set<(state: CanvasState) => void>;
}

const RESERVATION_MS = 30 * 60 * 1000;

function mutationKey(target: Pick<DeploymentTarget, "repo" | "environment">) {
  return JSON.stringify([
    target.repo.toLowerCase(),
    target.environment.toLowerCase()
  ]);
}

function contextKey(target: DeploymentTarget) {
  return JSON.stringify([
    target.repo.toLowerCase(),
    target.environment,
    target.branch,
    target.provider,
    target.appFile
  ]);
}

export function createDeploymentExecutionOwner(
  ports: DeploymentExecutionOwnerPorts
) {
  const attempts = new Map<string, OwnedExecution>();
  const contexts = new Map<string, OwnedExecution>();
  const reservations = new Map<string, DeploymentReservation>();
  const claimedReservations = new WeakSet<DeploymentReservation>();
  const issuedIds = new Set<string>();
  let generation = 0;
  let stopped = false;

  const report = (error: unknown): void => {
    try {
      ports.reportError(error);
    } catch (reportError) {
      console.error(
        "[radius deployment-owner] Diagnostic failed:",
        reportError
      );
    }
  };
  const current = (
    invocation: DeploymentInvocation
  ): OwnedExecution | undefined => {
    const execution = attempts.get(invocation.attemptId);
    return execution?.invocation === invocation ? execution : undefined;
  };
  const notify = (
    subscriber: (state: CanvasState) => void,
    execution: OwnedExecution
  ): void => {
    try {
      subscriber(structuredClone(execution.state));
    } catch (error) {
      report(error);
    }
  };
  const activeReservation = (
    target: Pick<DeploymentTarget, "repo" | "environment">
  ): DeploymentReservation | undefined => {
    const key = mutationKey(target);
    const reservation = reservations.get(key);
    // A locally executing deploy keeps its lease until its real finalizer.
    // Stage 6 record mutations retain their existing bounded reservation.
    if (
      reservation &&
      reservation.kind !== "deploy" &&
      reservation.expiresAt <= ports.now()
    ) {
      reservations.delete(key);
      return undefined;
    }
    return reservation;
  };
  const publish = (invocation: DeploymentInvocation): void => {
    const execution = stopped ? undefined : current(invocation);
    if (!execution) return;
    for (const subscriber of execution.subscribers) {
      if (stopped || current(invocation) !== execution) break;
      notify(subscriber, execution);
    }
  };

  return {
    get stopped() {
      return stopped;
    },
    activeReservation,
    reserve(
      target: Pick<DeploymentTarget, "repo" | "environment">,
      kind: DeploymentReservation["kind"]
    ): DeploymentReservation | undefined {
      if (stopped || activeReservation(target)) return undefined;
      const reservation: DeploymentReservation = {
        repo: target.repo,
        environment: target.environment,
        kind,
        expiresAt: ports.now() + RESERVATION_MS
      };
      reservations.set(mutationKey(target), reservation);
      return reservation;
    },
    release(reservation: DeploymentReservation): void {
      const key = mutationKey(reservation);
      if (reservations.get(key) === reservation) reservations.delete(key);
    },
    begin(input: {
      reservation: DeploymentReservation;
      target: DeploymentTarget;
      executor: SelectedGhExecutor;
      state: CanvasState;
      previous?: DeploymentInvocation;
      repair?: boolean;
    }): DeploymentResolution {
      if (stopped) return { kind: "shutdown" };
      if (
        input.reservation.kind !== "deploy" ||
        claimedReservations.has(input.reservation) ||
        activeReservation(input.target) !== input.reservation
      ) {
        return { kind: "stale" };
      }
      const previous =
        input.previous ?
          current(input.previous)
        : contexts.get(contextKey(input.target));
      if (input.previous && !previous) return { kind: "stale" };
      if (
        input.repair &&
        (!input.previous ||
          !previous ||
          contextKey(previous.invocation.target) !== contextKey(input.target) ||
          previous.invocation.target.githubLogin !== input.target.githubLogin)
      ) {
        return { kind: "retargeted" };
      }
      if (
        !input.target.githubLogin ||
        input.executor.login.toLowerCase() !==
          input.target.githubLogin.toLowerCase()
      ) {
        throw new Error(
          "Deployment executor must match the authorized GitHub account."
        );
      }
      const attemptId =
        input.repair && previous ?
          previous.invocation.attemptId
        : ports.newAttemptId();
      if (!attemptId || (!input.repair && issuedIds.has(attemptId))) {
        throw new Error("Deployment attempt identity must be unique.");
      }
      const state = structuredClone(input.state);
      const target = input.target;
      // Panel graphs do not carry committed application-file provenance.
      // Rebuild rather than treating mutable panel selection as that evidence.
      state.plannedResources = [];
      state.deployingResources = [];
      state.envName = target.environment;
      state.appFile = target.appFile;
      state.deployParams = {
        ...state.deployParams,
        targetRepo: target.repo,
        environment: target.environment,
        branch: target.branch,
        provider: target.provider,
        appFile: target.appFile
      };
      const observation = ports.createObservation(input.executor);
      const invocation = Object.freeze({
        attemptId,
        generation: ++generation,
        target: Object.freeze({ ...input.target })
      });
      state.deployAttempt = {
        id: attemptId,
        targetRepo: input.target.repo,
        branch: input.target.branch,
        environment: input.target.environment,
        provider: input.target.provider,
        appFile: input.target.appFile
      };
      state.deployGeneration = invocation.generation;
      const replaced = new Set(
        [previous, contexts.get(contextKey(input.target))].filter(
          (execution) => execution !== undefined
        )
      );
      const subscribers =
        previous?.subscribers ?? new Set<(state: CanvasState) => void>();
      for (const execution of replaced) {
        execution.observation.stop();
        attempts.delete(execution.invocation.attemptId);
        contexts.delete(contextKey(execution.invocation.target));
        if (execution !== previous) execution.subscribers.clear();
      }
      const execution: OwnedExecution = {
        invocation,
        executor: input.executor,
        state,
        observation,
        subscribers
      };
      issuedIds.add(attemptId);
      claimedReservations.add(input.reservation);
      attempts.set(attemptId, execution);
      contexts.set(contextKey(input.target), execution);
      publish(invocation);
      return { kind: "resolved", invocation };
    },
    resolve(
      selection: {
        attemptId?: string;
        repo?: string;
        environment?: string;
        branch?: string;
        provider?: string;
        appFile?: string;
      } = {}
    ): DeploymentResolution {
      if (stopped) return { kind: "shutdown" };
      const matches = (execution: OwnedExecution): boolean => {
        const target = execution.invocation.target;
        return (
          (selection.repo === undefined ||
            selection.repo.toLowerCase() === target.repo.toLowerCase()) &&
          (selection.environment === undefined ||
            selection.environment === target.environment) &&
          (selection.branch === undefined ||
            selection.branch === target.branch) &&
          (selection.provider === undefined ||
            selection.provider === target.provider) &&
          (selection.appFile === undefined ||
            selection.appFile === target.appFile)
        );
      };
      if (selection.attemptId !== undefined) {
        const execution = attempts.get(selection.attemptId);
        if (!execution) return { kind: "stale" };
        return matches(execution) ?
            { kind: "resolved", invocation: execution.invocation }
          : { kind: "retargeted" };
      }
      const eligible = [...contexts.values()].filter(matches);
      if (eligible.length === 0) return { kind: "missing" };
      if (eligible.length > 1) {
        return {
          kind: "ambiguous",
          choices: eligible.map((execution) => execution.invocation)
        };
      }
      return { kind: "resolved", invocation: eligible[0].invocation };
    },
    execution(
      invocation: DeploymentInvocation
    ): DeploymentExecution | undefined {
      return stopped ? undefined : current(invocation);
    },
    snapshot(invocation: DeploymentInvocation): CanvasState | undefined {
      const execution = current(invocation);
      return execution ? structuredClone(execution.state) : undefined;
    },
    publish,
    appendLog(invocation: DeploymentInvocation, message: string): void {
      const execution = stopped ? undefined : current(invocation);
      if (!execution) return;
      const safeMessage = redactCredentials(
        execution.executor.redact(message)
      ).slice(0, 4000);
      const logs = execution.state.deployLogs ?? [];
      execution.state.deployLogs = logs;
      logs.push(safeMessage);
      const dropped = Math.max(0, logs.length - 4000);
      if (dropped > 0) {
        logs.splice(0, dropped);
        execution.state.deployLogBase =
          (execution.state.deployLogBase ?? 0) + dropped;
      }
      publish(invocation);
    },
    subscribe(
      invocation: DeploymentInvocation,
      subscriber: (state: CanvasState) => void
    ): () => void {
      const execution = stopped ? undefined : current(invocation);
      if (!execution) return () => {};
      const registration = (state: CanvasState) => subscriber(state);
      execution.subscribers.add(registration);
      notify(registration, execution);
      return () => execution.subscribers.delete(registration);
    },
    run(
      invocation: DeploymentInvocation,
      work: (execution: DeploymentExecution) => Promise<void>,
      settled: () => void
    ): Promise<void> {
      const execution = current(invocation);
      if (execution?.task) return execution.task;
      if (stopped || !execution) {
        return Promise.reject(
          new Error("Deployment invocation is no longer active.")
        );
      }
      execution.task = Promise.resolve()
        .then(async () => {
          if (!stopped && current(invocation) === execution)
            await work(execution);
        })
        .finally(() => {
          try {
            settled();
          } catch (error) {
            report(error);
          }
        });
      return execution.task;
    },
    shutdown(): void {
      if (stopped) return;
      stopped = true;
      for (const execution of attempts.values()) {
        execution.observation.stop();
        execution.subscribers.clear();
      }
    }
  };
}

export type DeploymentExecutionOwner = ReturnType<
  typeof createDeploymentExecutionOwner
>;
