import type { AppSourceEvaluation } from "../../modeling/index.js";
import type { AppModelStatus } from "./model-status.js";
import { graphSourceBranch } from "./model-status.js";
import type { GraphSource } from "./pipeline.js";

export const MODELING_GRACE_WINDOW_MS = 15_000;
export const MODELING_GRACE_POLL_MS = 1_000;

export interface AuthoringClaim {
  readonly target: string;
  readonly key: string;
}

export interface AuthoringClaims {
  current(target: string): AuthoringClaim | null;
  claim(
    target: string,
    key: string,
    deadlineAtMs?: number
  ): AuthoringClaim | null;
  owns(claim: AuthoringClaim): boolean;
  release(claim: AuthoringClaim): void;
  markDelivered(claim: AuthoringClaim): void;
}

export type ModelInteraction =
  | { kind: "author"; sources: readonly GraphSource[]; attemptToken?: string }
  | { kind: "confirm-refresh"; status: AppModelStatus }
  | { kind: "refresh"; status: AppModelStatus };

export type AuthoringResult =
  | { kind: "interaction-requested"; interaction: ModelInteraction }
  | {
      kind:
        | "unsupported"
        | "stale"
        | "already-claimed"
        | "model-present"
        | "unchanged";
    };

export interface AuthoringReservation {
  has(key: string): boolean;
  reserve(key: string): void;
  owns(key: string): boolean;
  release(key: string): void;
  beginAttempt(sources: readonly GraphSource[]): string | undefined;
  releaseAttempt(sources: readonly GraphSource[], token: string): void;
}

export interface ModelAuthoringPorts {
  resolveStatus(source: GraphSource): Promise<AppModelStatus>;
  evaluateSource(source: GraphSource): Promise<AppSourceEvaluation>;
  modelingInFlight(
    sources: readonly GraphSource[],
    waitStartedAtMs?: number
  ): Promise<boolean>;
  wait(ms: number): Promise<void>;
  requestInteraction(interaction: ModelInteraction): Promise<void>;
  staleNotice(status: AppModelStatus): void;
  refreshKey(status: AppModelStatus): string;
  shouldRequestRefresh(key: string): boolean;
  releaseRefreshMemo(key: string): void;
  claims: AuthoringClaims;
  reservation: AuthoringReservation;
}

export function modelAuthoringTarget(
  repo: string,
  branches: readonly string[]
): string {
  return `${repo}::${branches.join(":")}`;
}

export function appModelHandoffKey(
  repo: string,
  branches: ReadonlyArray<string>,
  statuses: ReadonlyArray<AppModelStatus>
): string {
  return [
    repo,
    branches.join(","),
    ...statuses.map((status) => {
      const origin = status.freshness.origin;
      return [
        status.branch,
        status.freshness.status,
        status.refreshable ? "local" : "remote",
        origin?.sourceCommit ?? "",
        origin?.skillVersion ?? "",
        origin ? "" : status.freshness.appBicepHash,
        status.freshness.requiresConfirmation ? "confirm" : "auto"
      ].join("/");
    })
  ].join("::");
}

/** Explicitly opting into this policy permits an agent request, never a write. */
export async function requestModelAuthoring(
  request: {
    repo: string;
    sources: readonly GraphSource[];
    waitStartedAtMs?: number;
    recoveryDeadlineAtMs?: number;
    isCurrent?: () => boolean;
  },
  ports: ModelAuthoringPorts
): Promise<AuthoringResult> {
  const { repo, sources } = request;
  if (!repo || sources.length === 0) return { kind: "unchanged" };
  const stillCurrent = (): boolean => request.isCurrent?.() ?? true;
  const target = modelAuthoringTarget(repo, sources.map(graphSourceBranch));
  const observedClaim = ports.claims.current(target);
  const statuses = await Promise.all(
    sources.map((source) => ports.resolveStatus(source))
  );
  const key = appModelHandoffKey(
    repo,
    sources.map(graphSourceBranch),
    statuses
  );
  if (!stillCurrent()) return { kind: "stale" };
  if (ports.reservation.has(key)) return { kind: "unchanged" };
  const present = statuses.filter(
    (status) => status.freshness.status !== "missing"
  );
  if (!present.length) {
    const claim = ports.claims.claim(target, key, request.recoveryDeadlineAtMs);
    if (!claim) return { kind: "already-claimed" };
    ports.reservation.reserve(key);
    const owns = (): boolean =>
      ports.reservation.owns(key) && ports.claims.owns(claim) && stillCurrent();
    const release = (): void => {
      ports.reservation.release(key);
      ports.claims.release(claim);
    };
    try {
      const evaluations = await Promise.all(
        sources.map((source) => ports.evaluateSource(source))
      );
      if (evaluations.every((source) => source.status === "none")) {
        release();
        return { kind: "unsupported" };
      }
      if (!owns()) {
        release();
        return { kind: "stale" };
      }
      for (let waitedMs = 0; ; waitedMs += MODELING_GRACE_POLL_MS) {
        if (await ports.modelingInFlight(sources, request.waitStartedAtMs)) {
          release();
          return { kind: "already-claimed" };
        }
        if (!owns()) {
          release();
          return { kind: "stale" };
        }
        if (waitedMs >= MODELING_GRACE_WINDOW_MS) break;
        await ports.wait(MODELING_GRACE_POLL_MS);
      }
      const settled = await Promise.all(
        sources.map((source) => ports.resolveStatus(source))
      );
      if (!owns()) {
        release();
        return { kind: "stale" };
      }
      if (settled.some((status) => status.freshness.status !== "missing")) {
        release();
        return { kind: "model-present" };
      }
      const attemptToken = ports.reservation.beginAttempt(sources);
      const interaction: ModelInteraction = {
        kind: "author",
        sources,
        attemptToken
      };
      try {
        await ports.requestInteraction(interaction);
      } catch (error) {
        if (attemptToken)
          ports.reservation.releaseAttempt(sources, attemptToken);
        throw error;
      }
      ports.claims.markDelivered(claim);
      ports.reservation.release(key);
      return { kind: "interaction-requested", interaction };
    } catch (error) {
      release();
      throw error;
    }
  }

  if (observedClaim) ports.claims.release(observedClaim);
  ports.reservation.reserve(key);
  const unverified = present.find(
    (status) => status.refreshable && status.freshness.requiresConfirmation
  );
  const outdated = present.find(
    (status) => status.refreshable && status.freshness.stale
  );
  const refresh = unverified ?? outdated;
  if (refresh) {
    const refreshKey = ports.refreshKey(refresh);
    if (!ports.shouldRequestRefresh(refreshKey)) {
      ports.reservation.release(key);
      return { kind: "unchanged" };
    }
    const interaction: ModelInteraction =
      unverified ?
        { kind: "confirm-refresh", status: refresh }
      : { kind: "refresh", status: refresh };
    try {
      await ports.requestInteraction(interaction);
    } catch (error) {
      ports.reservation.release(key);
      ports.releaseRefreshMemo(refreshKey);
      throw error;
    }
    return { kind: "interaction-requested", interaction };
  }
  for (const status of present) {
    if (!status.refreshable && status.freshness.stale)
      ports.staleNotice(status);
  }
  return { kind: "unchanged" };
}
