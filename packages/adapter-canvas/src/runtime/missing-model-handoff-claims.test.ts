import { describe, expect, it } from "vitest";
import {
  createMissingModelHandoffClaims,
  MISSING_MODEL_HANDOFF_CLAIM_TTL_MS
} from "./missing-model-handoff-claims.js";

function harness() {
  let nowMs = 1_000_000;
  const claims = createMissingModelHandoffClaims(() => nowMs);
  return {
    claims,
    advance(ms: number) {
      nowMs += ms;
    }
  };
}

describe("createMissingModelHandoffClaims", () => {
  it("allows only one active owner for the same target and situation", () => {
    const { claims } = harness();
    const owner = claims.claim("a/b::feat", "missing");

    expect(owner).not.toBeNull();
    expect(claims.claim("a/b::feat", "missing")).toBeNull();
    expect(owner && claims.owns(owner)).toBe(true);
    expect(claims.current("a/b::feat")).toBe(owner);
  });

  it("lets changed evidence supersede an older owner without letting the older owner release it", () => {
    const { claims } = harness();
    const oldOwner = claims.claim("a/b::feat", "missing");
    const newOwner = claims.claim("a/b::feat", "different");
    if (!oldOwner || !newOwner) throw new Error("expected both claims");

    claims.release(oldOwner);

    expect(claims.owns(oldOwner)).toBe(false);
    expect(claims.owns(newOwner)).toBe(true);
  });

  it("expires before the graph idle timeout so a queued handoff that never runs can be retried", () => {
    const { claims, advance } = harness();
    const owner = claims.claim("a/b::feat", "missing");
    if (!owner) throw new Error("expected claim");

    advance(MISSING_MODEL_HANDOFF_CLAIM_TTL_MS - 1);
    expect(claims.owns(owner)).toBe(true);
    advance(1);

    expect(claims.owns(owner)).toBe(false);
    expect(claims.claim("a/b::feat", "missing")).not.toBeNull();
  });

  it("restarts the expiry window when delivery completes", () => {
    const { claims, advance } = harness();
    const owner = claims.claim("a/b::feat", "missing");
    if (!owner) throw new Error("expected claim");
    advance(MISSING_MODEL_HANDOFF_CLAIM_TTL_MS - 1);

    claims.markDelivered(owner);
    advance(MISSING_MODEL_HANDOFF_CLAIM_TTL_MS - 1);

    expect(claims.owns(owner)).toBe(true);
  });

  it("does not let delivered protection outlive the graph's absolute recovery deadline", () => {
    const { claims, advance } = harness();
    const owner = claims.claim("a/b::feat", "missing", 1_001_000);
    if (!owner) throw new Error("expected claim");

    claims.markDelivered(owner);
    advance(1_000);

    expect(claims.current("a/b::feat")).toBeNull();
  });

  // A deadline in the past cannot leave room for a retry, and honouring it
  // would expire the claim on delivery. The wait it belongs to may still have
  // 26 minutes to run once staging activity is observed, so every render in
  // that span would re-send.
  it("re-arms a delivered claim whose recovery deadline has already passed", () => {
    const { claims, advance } = harness();
    const owner = claims.claim("a/b::feat", "missing", 1_001_000);
    if (!owner) throw new Error("expected claim");
    advance(2_000);

    claims.markDelivered(owner);

    expect(claims.owns(owner)).toBe(true);
    advance(MISSING_MODEL_HANDOFF_CLAIM_TTL_MS - 1);
    expect(claims.owns(owner)).toBe(true);
    advance(1);
    expect(claims.owns(owner)).toBe(false);
  });

  it("ignores delivery from an owner that was already superseded", () => {
    const { claims, advance } = harness();
    const oldOwner = claims.claim("a/b::feat", "missing");
    const newOwner = claims.claim("a/b::feat", "different");
    if (!oldOwner || !newOwner) throw new Error("expected both claims");

    claims.markDelivered(oldOwner);
    advance(MISSING_MODEL_HANDOFF_CLAIM_TTL_MS - 1);

    expect(claims.owns(newOwner)).toBe(true);
  });

  it("releases every claim covering a branch, including the two-branch diff claim", () => {
    const { claims } = harness();
    const single = claims.claim("a/b::feat", "missing");
    const diff = claims.claim("a/b::main,feat", "missing");
    const unrelated = claims.claim("a/b::release", "missing");
    const otherRepo = claims.claim("c/d::feat", "missing");
    if (!single || !diff || !unrelated || !otherRepo) {
      throw new Error("expected every claim");
    }

    claims.releaseForBranch("a/b", "feat");

    expect(claims.current("a/b::feat")).toBeNull();
    expect(claims.current("a/b::main,feat")).toBeNull();
    expect(claims.current("a/b::release")).toBe(unrelated);
    expect(claims.current("c/d::feat")).toBe(otherRepo);
  });

  it("does not release a claim whose branch merely shares a prefix", () => {
    const { claims } = harness();
    const owner = claims.claim("a/b::feature-x", "missing");
    if (!owner) throw new Error("expected claim");

    claims.releaseForBranch("a/b", "feature");

    expect(claims.current("a/b::feature-x")).toBe(owner);
  });

  it("keeps the claim store bounded while preserving the newest targets", () => {
    const { claims } = harness();
    for (let index = 0; index < 101; index += 1) {
      claims.claim(`a/b::feat-${index}`, "missing");
    }

    expect(claims.claim("a/b::feat-0", "missing")).not.toBeNull();
    expect(claims.claim("a/b::feat-100", "missing")).toBeNull();
  });
});
