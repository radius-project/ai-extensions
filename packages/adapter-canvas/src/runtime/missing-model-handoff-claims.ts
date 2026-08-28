import { GRAPH_APP_BICEP_IDLE_TIMEOUT_MS } from "../graph-progress-contract.js";

// A delivered handoff may sit behind the current agent turn. Keep its claim
// long enough to cover that queue, but expire before the graph gives up on
// observing any modeling activity so the live page still has time to retry.
export const MISSING_MODEL_HANDOFF_CLAIM_TTL_MS =
  GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - 60_000;

export interface MissingModelHandoffClaim {
  readonly target: string;
  readonly key: string;
}

export interface MissingModelHandoffClaims {
  current(target: string): MissingModelHandoffClaim | null;
  claim(
    target: string,
    key: string,
    deadlineAtMs?: number
  ): MissingModelHandoffClaim | null;
  owns(claim: MissingModelHandoffClaim): boolean;
  markDelivered(claim: MissingModelHandoffClaim): void;
  release(claim: MissingModelHandoffClaim): void;
}

const CLAIM_LIMIT = 100;

interface ClaimEntry {
  claim: MissingModelHandoffClaim;
  expiresAtMs: number;
  deadlineAtMs: number;
}

export function createMissingModelHandoffClaims(
  now: () => number
): MissingModelHandoffClaims {
  const entries = new Map<string, ClaimEntry>();

  const activeEntry = (target: string): ClaimEntry | undefined => {
    const entry = entries.get(target);
    if (entry && entry.expiresAtMs <= now()) {
      entries.delete(target);
      return undefined;
    }
    return entry;
  };

  return {
    current(target) {
      return activeEntry(target)?.claim ?? null;
    },

    claim(target, key, deadlineAtMs = Number.POSITIVE_INFINITY) {
      const existing = activeEntry(target);
      if (existing?.claim.key === key) return null;

      const claim = { target, key };
      entries.delete(target);
      entries.set(target, {
        claim,
        expiresAtMs: now() + MISSING_MODEL_HANDOFF_CLAIM_TTL_MS,
        deadlineAtMs
      });
      while (entries.size > CLAIM_LIMIT) {
        for (const oldest of entries.keys()) {
          entries.delete(oldest);
          break;
        }
      }
      return claim;
    },

    owns(claim) {
      return activeEntry(claim.target)?.claim === claim;
    },

    markDelivered(claim) {
      const entry = activeEntry(claim.target);
      if (entry?.claim !== claim) return;
      entry.expiresAtMs = Math.min(
        entry.deadlineAtMs,
        now() + MISSING_MODEL_HANDOFF_CLAIM_TTL_MS
      );
    },

    release(claim) {
      if (entries.get(claim.target)?.claim === claim) {
        entries.delete(claim.target);
      }
    }
  };
}
