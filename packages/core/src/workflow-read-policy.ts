import type { WorkflowResponseMetadata } from "./workflow-read-metadata.js";

export const WORKFLOW_READ_LIMITS = {
  attempts: 3,
  additionalGets: 2,
  cooldowns: 32,
  runMs: 15000,
  verificationMs: 45000,
  deleteConflictMs: 80000,
  artifactPageMs: 20000,
  artifactRunMs: 560000,
  artifactRepositoryMs: 640000,
  monitorMs: 575000,
  terminalMs: 2840000,
  observationMs: 2855000
} as const;

export type WorkflowReadReason =
  | "attempts"
  | "elapsed"
  | "cancelled"
  | "capacity"
  | "not-before"
  | "missing-deadline"
  | "invalid-deadline"
  | "unavailable-server-date"
  | "ineligible";

export type WorkflowReadDecision =
  | { state: "ready" }
  | { state: "deferred"; reason: "not-before"; notBefore: number }
  | {
      state: "deferred" | "exhausted" | "stopped";
      reason: Exclude<WorkflowReadReason, "not-before">;
    };

export interface WorkflowReadClock {
  monotonic(): number;
  wall(): number;
  sleep(
    milliseconds: number,
    cancellation?: Pick<WorkflowReadContextOptions, "stopped" | "onStop">
  ): Promise<void>;
  jitter(): number;
}

interface Restriction {
  active: number;
  until: number;
  reason?: Exclude<WorkflowReadReason, "not-before">;
}

/** Retained by an observer, independently of its payload cache or poll cycle. */
export function createWorkflowReadCooldowns(now: () => number) {
  const restrictions = new Map<string, Restriction>();

  function prune(): void {
    for (const [key, entry] of restrictions) {
      if (!entry.active && !entry.reason && entry.until <= now())
        restrictions.delete(key);
    }
  }

  function check(key: string): WorkflowReadDecision {
    const entry = restrictions.get(key);
    if (entry?.reason) return { state: "deferred", reason: entry.reason };
    if (entry && entry.until > now())
      return {
        state: "deferred",
        reason: "not-before",
        notBefore: entry.until
      };
    return { state: "ready" };
  }

  return {
    check,
    acquire(key: string): WorkflowReadDecision {
      prune();
      const decision = check(key);
      if (decision.state !== "ready") return decision;
      const entry = restrictions.get(key);
      if (entry) entry.active++;
      else {
        if (restrictions.size >= WORKFLOW_READ_LIMITS.cooldowns)
          return { state: "deferred", reason: "capacity" };
        restrictions.set(key, { active: 1, until: 0 });
      }
      return { state: "ready" };
    },
    release(key: string): void {
      const entry = restrictions.get(key);
      if (entry) entry.active--;
      prune();
    },
    restrict(
      key: string,
      until: number,
      reason?: Exclude<WorkflowReadReason, "not-before">
    ): void {
      const entry = restrictions.get(key);
      if (!entry)
        throw new Error("Workflow read restriction was not admitted.");
      entry.until = Math.max(entry.until, until);
      entry.reason ??= reason;
    }
  };
}

export type WorkflowReadCooldowns = ReturnType<
  typeof createWorkflowReadCooldowns
>;

export function isSecondaryWorkflowRateLimitMessage(message: string): boolean {
  return /secondary rate limit/i.test(message);
}

function serverDelay(
  metadata: Extract<WorkflowResponseMetadata, { source: "gh-api-include" }>,
  secondaryRateLimit: boolean
):
  | { milliseconds: number }
  | { reason: Exclude<WorkflowReadReason, "not-before"> } {
  const constraints = [metadata.retryAfter];
  if (
    (metadata.classification === "rate-limit" && !secondaryRateLimit) ||
    metadata.rateLimitRemaining === 0
  )
    constraints.push(metadata.rateLimitReset);
  if (constraints.some((value) => value.state === "invalid"))
    return { reason: "invalid-deadline" };
  if (
    metadata.classification === "rate-limit" &&
    (constraints.every((value) => value.state === "absent") ||
      (secondaryRateLimit && metadata.retryAfter.state === "absent"))
  )
    return { reason: "missing-deadline" };
  let milliseconds = 0;
  for (const value of constraints) {
    if (value.state === "delay") {
      milliseconds = Math.max(milliseconds, value.milliseconds);
    } else if (value.state === "deadline") {
      if (metadata.serverDate.state !== "deadline")
        return { reason: "unavailable-server-date" };
      milliseconds = Math.max(
        milliseconds,
        value.epochMilliseconds - metadata.receivedAtEpochMilliseconds,
        value.epochMilliseconds - metadata.serverDate.epochMilliseconds + 1000
      );
    }
  }
  return { milliseconds };
}

export interface WorkflowPolicyResponse {
  ok: boolean;
  metadata: WorkflowResponseMetadata;
}

export type WorkflowPolicyResult<T> =
  | { response: T; decision: WorkflowReadDecision }
  | {
      response: null;
      decision: Exclude<WorkflowReadDecision, { state: "ready" }>;
    };

export interface WorkflowReadContextOptions {
  clock: WorkflowReadClock;
  cooldowns: WorkflowReadCooldowns;
  timeout: number;
  stopped(): boolean;
  onStop?(listener: () => void): () => void;
}

export class WorkflowReadInterruptedError extends Error {
  readonly decision: Exclude<WorkflowReadDecision, { state: "ready" }>;

  constructor(readonly reason: "cancelled" | "elapsed" | "attempts") {
    super(`Workflow observation ${reason}.`);
    this.decision =
      reason === "cancelled" ?
        { state: "stopped", reason }
      : { state: "exhausted", reason };
  }
}

export interface WorkflowReadContext {
  readonly observation: object;
  clock: WorkflowReadClock;
  deadline: number;
  onStop?: WorkflowReadContextOptions["onStop"];
  check(phaseDeadline?: number): WorkflowReadDecision;
  remaining(phaseDeadline?: number): number;
  limit(milliseconds: number): WorkflowReadContext;
  withRetryMeter(meter: { extraGets: number }): WorkflowReadContext;
  chargeRetries(count: number): boolean;
  withCancellation(
    cancellation: Pick<WorkflowReadContextOptions, "stopped" | "onStop">
  ): WorkflowReadContext;
  wait<T>(work: Promise<T>): Promise<T>;
  read<T extends WorkflowPolicyResponse>(
    key: string,
    phaseDeadline: number,
    read: () => Promise<T>,
    secondaryRateLimit?: (response: T) => boolean
  ): Promise<WorkflowPolicyResult<T>>;
}

/** One observation ledger; phases cannot replenish its time or GET credits. */
export function createWorkflowReadContext(
  options: WorkflowReadContextOptions
): WorkflowReadContext {
  if (!Number.isFinite(options.timeout) || options.timeout <= 0)
    throw new Error(
      "Workflow observation timeout must be positive and finite."
    );
  return contextFor(options, {
    observation: {},
    deadline: options.clock.monotonic() + options.timeout,
    extraGets: 0
  });
}

function contextFor(
  options: WorkflowReadContextOptions,
  budget: { observation: object; deadline: number; extraGets: number },
  phaseDeadline = budget.deadline,
  meters: { extraGets: number }[] = []
): WorkflowReadContext {
  const { clock, cooldowns, stopped } = options;
  const deadline = Math.min(budget.deadline, phaseDeadline);

  function check(phaseDeadline = deadline): WorkflowReadDecision {
    if (stopped()) return { state: "stopped", reason: "cancelled" };
    if (clock.monotonic() >= Math.min(deadline, phaseDeadline))
      return { state: "exhausted", reason: "elapsed" };
    return { state: "ready" };
  }

  return {
    observation: budget.observation,
    clock,
    deadline,
    check,
    onStop: options.onStop,
    limit(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0)
        throw new Error(
          "Workflow phase timeout must be nonnegative and finite."
        );
      return contextFor(
        options,
        budget,
        Math.min(deadline, clock.monotonic() + milliseconds),
        meters
      );
    },
    withCancellation: (cancellation) =>
      contextFor({ ...options, ...cancellation }, budget, deadline, meters),
    withRetryMeter: (meter) =>
      contextFor(options, budget, deadline, [...meters, meter]),
    chargeRetries(count) {
      if (!Number.isSafeInteger(count) || count < 0)
        throw new Error("Workflow retry usage must be a nonnegative integer.");
      const total = budget.extraGets + count;
      budget.extraGets = Math.min(WORKFLOW_READ_LIMITS.additionalGets, total);
      return total <= WORKFLOW_READ_LIMITS.additionalGets;
    },
    async wait<T>(work: Promise<T>): Promise<T> {
      let detach = () => {};
      let stopTimer = () => {};
      let ended = false;
      try {
        const result = await Promise.race([
          work,
          clock
            .sleep(Math.max(0, deadline - clock.monotonic()), {
              stopped: () => ended,
              onStop: (listener) => {
                stopTimer = listener;
                return () => {};
              }
            })
            .then(() => {
              throw new WorkflowReadInterruptedError("elapsed");
            }),
          new Promise<never>((_, reject) => {
            const stop = () =>
              reject(new WorkflowReadInterruptedError("cancelled"));
            detach = options.onStop?.(stop) ?? (() => {});
            if (stopped()) stop();
          })
        ]);
        if (stopped()) throw new WorkflowReadInterruptedError("cancelled");
        if (clock.monotonic() >= deadline)
          throw new WorkflowReadInterruptedError("elapsed");
        return result;
      } finally {
        ended = true;
        stopTimer();
        detach();
      }
    },
    remaining(phaseDeadline = deadline): number {
      return Math.max(0, Math.min(deadline, phaseDeadline) - clock.monotonic());
    },
    async read<T extends WorkflowPolicyResponse>(
      key: string,
      phaseDeadline: number,
      read: () => Promise<T>,
      secondaryRateLimit?: (response: T) => boolean
    ): Promise<WorkflowPolicyResult<T>> {
      let decision = check(phaseDeadline);
      if (decision.state !== "ready") return { response: null, decision };
      decision = cooldowns.acquire(key);
      if (decision.state !== "ready") return { response: null, decision };
      try {
        for (let attempt = 1; ; attempt++) {
          decision = check(phaseDeadline);
          if (decision.state !== "ready") return { response: null, decision };
          const response = await read();
          decision = check(phaseDeadline);
          if (decision.state !== "ready") return { response: null, decision };
          const metadata = response.metadata;
          if (
            metadata.source !== "gh-api-include" ||
            metadata.classification === "authorization" ||
            (!response.ok &&
              metadata.classification !== "rate-limit" &&
              ![500, 502, 503, 504].includes(metadata.status))
          )
            return {
              response,
              decision: { state: "exhausted", reason: "ineligible" }
            };
          const timing = serverDelay(
            metadata,
            (metadata.status === 403 || metadata.status === 429) &&
              (secondaryRateLimit?.(response) ?? false)
          );
          const received = clock.monotonic();
          if ("reason" in timing) {
            cooldowns.restrict(key, 0, timing.reason);
            return {
              response,
              decision: { state: "deferred", reason: timing.reason }
            };
          }
          const serverNotBefore = received + timing.milliseconds;
          cooldowns.restrict(key, serverNotBefore);
          if (response.ok) return { response, decision: { state: "ready" } };
          if (
            attempt >= WORKFLOW_READ_LIMITS.attempts ||
            budget.extraGets >= WORKFLOW_READ_LIMITS.additionalGets
          )
            return {
              response,
              decision: { state: "exhausted", reason: "attempts" }
            };
          const jitter = clock.jitter();
          if (!Number.isInteger(jitter) || jitter < 0 || jitter > 250)
            throw new Error(
              "Workflow read jitter must be an integer from 0 to 250."
            );
          const retryAt =
            Math.max(received + (attempt === 1 ? 500 : 1000), serverNotBefore) +
            jitter;
          if (retryAt >= Math.min(deadline, phaseDeadline))
            return {
              response,
              decision: {
                state: "deferred",
                reason: "not-before",
                notBefore: retryAt
              }
            };
          // Reserve before yielding: concurrent reads share these two credits.
          budget.extraGets++;
          for (const meter of meters) meter.extraGets++;
          for (;;) {
            decision = check(phaseDeadline);
            if (decision.state !== "ready") return { response, decision };
            const restriction = cooldowns.check(key);
            if (
              restriction.state !== "ready" &&
              restriction.reason !== "not-before"
            )
              return { response, decision: restriction };
            const until = Math.max(
              retryAt,
              restriction.state === "ready" ? 0 : restriction.notBefore
            );
            if (until >= Math.min(deadline, phaseDeadline))
              return {
                response,
                decision: {
                  state: "deferred",
                  reason: "not-before",
                  notBefore: until
                }
              };
            const wait = until - clock.monotonic();
            if (wait <= 0) break;
            await clock.sleep(wait, { stopped, onStop: options.onStop });
          }
        }
      } finally {
        cooldowns.release(key);
      }
    }
  };
}
