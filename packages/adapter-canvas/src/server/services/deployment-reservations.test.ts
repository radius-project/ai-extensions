import { describe, expect, it } from "vitest";
import { createDeploymentExecutionOwner } from "../../runtime/deployment-execution-owner.js";
import type { CanvasState } from "../../shared.js";
import { createDeploymentReservationBindings } from "./deployment-reservations.js";

function fixture() {
  let now = 0;
  const owner = createDeploymentExecutionOwner({
    now: () => now,
    newAttemptId: () => {
      throw new Error("Unexpected attempt creation");
    },
    createObservation: () => {
      throw new Error("Unexpected observation");
    },
    reportError: (error) => {
      throw error;
    }
  });
  return {
    owner,
    bindings: createDeploymentReservationBindings(owner),
    advance: (milliseconds: number) => {
      now += milliseconds;
    }
  };
}

const TARGET = {
  repo: "fixture/app",
  environment: "dev",
  kind: "deploy" as const
};

describe("shared deployment reservation binding", () => {
  it.each([
    { contextRepo: TARGET.repo, envName: TARGET.environment },
    { deployingRepo: TARGET.repo, envName: TARGET.environment },
    {
      deployAttempt: {
        id: "attempt",
        targetRepo: TARGET.repo,
        environment: TARGET.environment
      }
    }
  ])(
    "checks the requested target rather than remembered selection %j",
    (state) => {
      const { bindings } = fixture();
      const first: CanvasState = {};
      const reservation = bindings.reserve(first, TARGET);
      expect(reservation).not.toBeNull();
      expect(bindings.active(first)).toBe(reservation);
      expect(bindings.active(state, TARGET)).toBe(reservation);
      expect(bindings.active(state)).toBeUndefined();
      const otherTarget = { ...TARGET, environment: "staging" };
      expect(bindings.active(state, otherTarget)).toBeUndefined();
      expect(bindings.active(first, otherTarget)).toBeUndefined();
      const independent = bindings.reserve(state, otherTarget);
      expect(independent).not.toBeNull();
      if (!independent) throw new Error("Expected independent reservation");
      bindings.release(state, independent);
      expect(bindings.reserve(state, TARGET)).toBeNull();
      if (!reservation) throw new Error("Expected reservation");
      bindings.release(first, reservation);
      expect(first.deploymentMutation).toBeUndefined();
      expect(bindings.active(state)).toBeUndefined();
    }
  );

  it("does not guess a target from an empty or partial view", () => {
    const { bindings } = fixture();
    bindings.reserve({}, TARGET);
    expect(bindings.active({})).toBeUndefined();
    expect(bindings.active({ contextRepo: TARGET.repo })).toBeUndefined();
  });

  it("drops expired mirrors without clearing a replacement reservation", () => {
    const { bindings, owner, advance } = fixture();
    const state: CanvasState = {
      contextRepo: TARGET.repo,
      envName: TARGET.environment
    };
    const old = bindings.reserve(state, { ...TARGET, kind: "delete" });
    if (!old) throw new Error("Expected reservation");
    advance(30 * 60 * 1000);
    const replacement = bindings.reserve({}, TARGET);
    expect(bindings.active(state, TARGET)).toBe(replacement);
    expect(state.deploymentMutation).toBeUndefined();
    bindings.release(state, old);
    expect(bindings.active(state)).toBeUndefined();
    expect(owner.activeReservation(TARGET)).toBe(replacement);
  });

  it("refuses shutdown admission and identity-checks mirror cleanup", () => {
    const { bindings, owner } = fixture();
    const state: CanvasState = {};
    const reservation = bindings.reserve(state, TARGET);
    if (!reservation) throw new Error("Expected reservation");
    bindings.release(state, { ...reservation });
    expect(bindings.active(state)).toBe(reservation);
    owner.shutdown();
    expect(
      bindings.reserve({}, { ...TARGET, environment: "another" })
    ).toBeNull();
    bindings.release(state, reservation);
    expect(bindings.active(state)).toBeUndefined();
  });
});
