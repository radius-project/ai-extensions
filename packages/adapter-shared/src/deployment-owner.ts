import type { DeploymentTarget } from "@radius-project/core";
export type { DeploymentTarget } from "@radius-project/core";

export interface DeploymentReservation {
  readonly target: Readonly<Pick<DeploymentTarget, "repo" | "environment">>;
  readonly kind: "deploy" | "delete" | "abandon";
  readonly expiresAt: number;
}

export interface DeploymentInvocation<State> {
  readonly target: Readonly<DeploymentTarget>;
  readonly attemptId: string;
  readonly observationId: string;
  readonly generation: number;
  readonly state: State;
  readonly signal: AbortSignal;
}

export interface DeploymentOwnerPorts {
  now(): number;
  id(): string;
  reportError(error: unknown): void;
}

export type DeploymentLookup<State> =
  | { kind: "found"; invocation: DeploymentInvocation<State> }
  | { kind: "missing" | "ambiguous" | "invalid" };

const RESERVATION_MS = 30 * 60 * 1000;

function key(target: Pick<DeploymentTarget, "repo" | "environment">): string {
  return JSON.stringify([
    target.repo.toLowerCase(),
    target.environment.toLowerCase()
  ]);
}

function sameTarget(left: DeploymentTarget, right: DeploymentTarget): boolean {
  return (
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.environment === right.environment &&
    left.branch === right.branch &&
    left.provider === right.provider &&
    left.appFile === right.appFile
  );
}

export function createDeploymentOwner<State>(ports: DeploymentOwnerPorts) {
  const attempts = new Map<string, DeploymentInvocation<State>>();
  const observations = new Map<string, DeploymentInvocation<State>>();
  const reservations = new Map<string, DeploymentReservation>();
  const tasks = new Map<DeploymentInvocation<State>, Set<Promise<unknown>>>();
  const admissions = new Map<Promise<unknown>, string>();
  const controllers = new Map<DeploymentInvocation<State>, AbortController>();
  const subscribers = new Map<
    DeploymentInvocation<State>,
    Set<(invocation: DeploymentInvocation<State>) => unknown>
  >();
  const claims = new Map<DeploymentInvocation<State>, Set<string>>();
  const issuedIds = new Set<string>();
  const invalidated = new WeakSet<DeploymentInvocation<State>>();
  let generation = 0;
  let stopped = false;

  function isCurrent(invocation: DeploymentInvocation<State>): boolean {
    return (
      attempts.get(invocation.attemptId) === invocation &&
      !invalidated.has(invocation)
    );
  }

  function isActive(invocation: DeploymentInvocation<State>): boolean {
    return (tasks.get(invocation)?.size ?? 0) > 0;
  }

  function publish(invocation: DeploymentInvocation<State>): void {
    if (stopped || invocation.signal.aborted || !isCurrent(invocation)) return;
    for (const subscriber of subscribers.get(invocation) ?? []) {
      if (stopped || invocation.signal.aborted || !isCurrent(invocation))
        return;
      try {
        void Promise.resolve(subscriber(invocation)).then(
          undefined,
          ports.reportError
        );
      } catch (error) {
        ports.reportError(error);
      }
    }
  }

  function reserve(
    target: Pick<DeploymentTarget, "repo" | "environment">,
    kind: DeploymentReservation["kind"]
  ): DeploymentReservation | null {
    if (stopped) return null;
    if (!target.repo.trim() || !target.environment.trim())
      throw new Error(
        "Deployment reservation requires a repository and environment."
      );
    const targetKey = key(target);
    for (const invocation of attempts.values()) {
      if (key(invocation.target) === targetKey && isActive(invocation))
        return null;
    }
    const previous = reservations.get(targetKey);
    if (previous && previous.expiresAt > ports.now()) return null;
    const reservation: DeploymentReservation = Object.freeze({
      target: Object.freeze({ ...target }),
      kind,
      expiresAt: ports.now() + RESERVATION_MS
    });
    reservations.set(targetKey, reservation);
    return reservation;
  }

  function release(reservation: DeploymentReservation): void {
    const targetKey = key(reservation.target);
    if (reservations.get(targetKey) === reservation)
      reservations.delete(targetKey);
  }

  function begin(
    target: DeploymentTarget,
    state: State,
    reservation: DeploymentReservation,
    attemptId?: string
  ): DeploymentInvocation<State> {
    if (stopped) throw new Error("Deployment runtime is shutting down.");
    if (
      reservation.kind !== "deploy" ||
      reservations.get(key(target)) !== reservation ||
      key(reservation.target) !== key(target) ||
      reservation.expiresAt <= ports.now()
    )
      throw new Error("Deployment admission no longer owns its reservation.");
    for (const current of attempts.values()) {
      if (key(current.target) === key(target) && isActive(current))
        throw new Error("The deployment target is still running.");
    }
    const previous = attemptId ? attempts.get(attemptId) : undefined;
    if (attemptId && !previous)
      throw new Error("The repair attempt is no longer current.");
    if (previous && !sameTarget(previous.target, target))
      throw new Error("The repair target changed.");
    const loopId = attemptId || `attempt:${ports.id()}`;
    const observationId = `observation:${ports.id()}`;
    if ((!attemptId && issuedIds.has(loopId)) || issuedIds.has(observationId))
      throw new Error("Deployment identity generation produced a duplicate.");
    const controller = new AbortController();
    const invocation: DeploymentInvocation<State> = Object.freeze({
      target: Object.freeze({ ...target }),
      attemptId: loopId,
      observationId,
      generation: ++generation,
      state,
      signal: controller.signal
    });
    for (const current of attempts.values())
      if (key(current.target) === key(target)) retire(current);
    attempts.set(loopId, invocation);
    observations.set(observationId, invocation);
    issuedIds.add(loopId);
    issuedIds.add(observationId);
    controllers.set(invocation, controller);
    return invocation;
  }

  function lookup(
    input: {
      attemptId?: string;
      observationId?: string;
    } = {}
  ): DeploymentLookup<State> {
    if (input.attemptId !== undefined && input.observationId !== undefined)
      return { kind: "invalid" };
    let invocation: DeploymentInvocation<State> | undefined;
    if (input.attemptId !== undefined) {
      invocation = attempts.get(input.attemptId);
    } else if (input.observationId !== undefined) {
      invocation = observations.get(input.observationId);
    } else {
      const current = [...attempts.values()].filter(isCurrent);
      if (current.length !== 1)
        return { kind: current.length ? "ambiguous" : "missing" };
      return { kind: "found", invocation: current[0] };
    }
    return invocation && isCurrent(invocation) ?
        { kind: "found", invocation }
      : { kind: "missing" };
  }

  function retire(invocation: DeploymentInvocation<State>): boolean {
    if (
      attempts.get(invocation.attemptId) !== invocation ||
      isActive(invocation)
    )
      return false;
    controllers.get(invocation)?.abort();
    controllers.delete(invocation);
    observations.delete(invocation.observationId);
    attempts.delete(invocation.attemptId);
    subscribers.delete(invocation);
    claims.delete(invocation);
    return true;
  }

  function invalidate(invocation: DeploymentInvocation<State>): boolean {
    if (!isCurrent(invocation)) return false;
    invalidated.add(invocation);
    observations.delete(invocation.observationId);
    subscribers.delete(invocation);
    claims.delete(invocation);
    controllers.get(invocation)?.abort();
    // Keep active tasks in the target map until settlement, even past lease expiry.
    retire(invocation);
    return true;
  }

  function lookupTarget(
    target: Pick<DeploymentTarget, "repo" | "environment">
  ): DeploymentLookup<State> {
    const targetKey = key(target);
    for (const invocation of attempts.values()) {
      if (key(invocation.target) === targetKey && isCurrent(invocation))
        return { kind: "found", invocation };
    }
    return { kind: "missing" };
  }

  function lookupRepository(repo: string): DeploymentLookup<State> {
    const current = [...attempts.values()].filter(
      (invocation) =>
        isCurrent(invocation) &&
        invocation.target.repo.toLowerCase() === repo.toLowerCase()
    );
    return current.length === 1 ?
        { kind: "found", invocation: current[0] }
      : { kind: current.length ? "ambiguous" : "missing" };
  }

  function run<Result>(
    invocation: DeploymentInvocation<State>,
    work: () => Promise<Result>
  ): Promise<Result> {
    if (stopped || !isCurrent(invocation))
      return Promise.reject(
        new Error("Deployment invocation is no longer active.")
      );
    const pending = tasks.get(invocation) ?? new Set<Promise<unknown>>();
    tasks.set(invocation, pending);
    // Register before entering caller code so synchronous callbacks see active work.
    const promise = Promise.resolve().then(() => {
      if (stopped || !isCurrent(invocation))
        throw new Error("Deployment invocation stopped before execution.");
      return work();
    });
    pending.add(promise);
    const settled = promise.finally(() => {
      pending.delete(promise);
      if (!pending.size) {
        tasks.delete(invocation);
        if (invalidated.has(invocation)) retire(invocation);
      }
      publish(invocation);
    });
    return settled;
  }

  function trackAdmission<Result>(
    work: () => Promise<Result>
  ): Promise<Result> {
    if (stopped)
      return Promise.reject(new Error("Deployment runtime is shutting down."));
    const admissionId = `admission:${ports.id()}`;
    const promise = Promise.resolve().then(() => {
      if (stopped) throw new Error("Deployment runtime is shutting down.");
      return work();
    });
    admissions.set(promise, admissionId);
    return promise.finally(() => admissions.delete(promise));
  }

  /** Callbacks run synchronously while current; returned promises are observed, not awaited. */
  function subscribe(
    invocation: DeploymentInvocation<State>,
    subscriber: (current: DeploymentInvocation<State>) => unknown
  ): () => void {
    if (stopped) throw new Error("Deployment runtime is shutting down.");
    if (!isCurrent(invocation))
      throw new Error("Cannot subscribe to a superseded deployment.");
    const listeners =
      subscribers.get(invocation) ??
      new Set<(current: DeploymentInvocation<State>) => unknown>();
    listeners.add(subscriber);
    subscribers.set(invocation, listeners);
    return () => {
      listeners.delete(subscriber);
      if (!listeners.size && subscribers.get(invocation) === listeners)
        subscribers.delete(invocation);
    };
  }

  function claim(
    invocation: DeploymentInvocation<State>,
    name: string
  ): boolean {
    if (stopped || !isCurrent(invocation)) return false;
    const owned = claims.get(invocation) ?? new Set<string>();
    if (owned.has(name)) return false;
    owned.add(name);
    claims.set(invocation, owned);
    return true;
  }

  async function shutdown(timeoutMs: number): Promise<{
    complete: boolean;
    pending: string[];
  }> {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new Error(
        "Deployment shutdown requires a finite non-negative timeout."
      );
    stopped = true;
    for (const controller of controllers.values()) controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([
          ...admissions.keys(),
          ...[...tasks.values()].flatMap((pending) => [...pending])
        ]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    const pending = [
      ...admissions.values(),
      ...[...tasks.keys()].map((invocation) => invocation.observationId)
    ];
    return { complete: pending.length === 0, pending };
  }

  return {
    begin,
    lookup,
    lookupTarget,
    lookupRepository,
    reserve,
    release,
    retire,
    invalidate,
    run,
    trackAdmission,
    subscribe,
    publish,
    claim,
    releaseClaim(invocation: DeploymentInvocation<State>, name: string) {
      if (isCurrent(invocation)) claims.get(invocation)?.delete(name);
    },
    isCurrent,
    isActive,
    hasActiveWork: () => tasks.size > 0 || admissions.size > 0,
    isShuttingDown: () => stopped,
    shutdown
  };
}

export type DeploymentOwner<State> = ReturnType<
  typeof createDeploymentOwner<State>
>;
