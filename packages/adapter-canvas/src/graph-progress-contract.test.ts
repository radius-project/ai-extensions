import { describe, expect, it } from "vitest";
import {
  evaluateAppBicepWait,
  GRAPH_APP_BICEP_IDLE_TIMEOUT_MS,
  GRAPH_APP_BICEP_MAX_WAIT_MESSAGE,
  GRAPH_APP_BICEP_MAX_WAIT_MS,
  GRAPH_APP_BICEP_STALLED_MESSAGE,
  GRAPH_APP_BICEP_TIMEOUT_MESSAGE
} from "./graph-progress-contract.js";

const START = 1_000;

describe("evaluateAppBicepWait", () => {
  it("waits while the idle budget has not been spent", () => {
    expect(
      evaluateAppBicepWait({
        nowMs: START + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - 1,
        waitStartedAtMs: START,
        lastActivityAtMs: null
      })
    ).toEqual({ status: "waiting" });
  });

  it("gives up on a wait that never saw a modeling run", () => {
    expect(
      evaluateAppBicepWait({
        nowMs: START + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS,
        waitStartedAtMs: START,
        lastActivityAtMs: null
      })
    ).toEqual({
      status: "expired",
      reason: "never-started",
      message: GRAPH_APP_BICEP_TIMEOUT_MESSAGE
    });
  });

  // The regression this contract exists for: modeling a real repository takes
  // longer than the idle budget, and a flat clock reported a live run as a
  // repository the skill could not model.
  it("keeps waiting well past the idle budget while a run stays alive", () => {
    const nowMs = START + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS * 4;
    expect(
      evaluateAppBicepWait({
        nowMs,
        waitStartedAtMs: START,
        lastActivityAtMs: nowMs - 1
      })
    ).toEqual({ status: "waiting" });
  });

  it("renews the idle budget from the last observed activity", () => {
    const lastActivityAtMs = START + 10_000;
    expect(
      evaluateAppBicepWait({
        nowMs: lastActivityAtMs + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS - 1,
        waitStartedAtMs: START,
        lastActivityAtMs
      })
    ).toEqual({ status: "waiting" });
  });

  it("reports a run that started and then stopped as stalled", () => {
    const lastActivityAtMs = START + 10_000;
    expect(
      evaluateAppBicepWait({
        nowMs: lastActivityAtMs + GRAPH_APP_BICEP_IDLE_TIMEOUT_MS,
        waitStartedAtMs: START,
        lastActivityAtMs
      })
    ).toEqual({
      status: "expired",
      reason: "stalled",
      message: GRAPH_APP_BICEP_STALLED_MESSAGE
    });
  });

  // A run that wedges holding its staging directory renews the idle budget on
  // every poll, so only the ceiling can end it.
  it("gives up at the ceiling even while the run still looks alive", () => {
    const nowMs = START + GRAPH_APP_BICEP_MAX_WAIT_MS;
    expect(
      evaluateAppBicepWait({
        nowMs,
        waitStartedAtMs: START,
        lastActivityAtMs: nowMs
      })
    ).toEqual({
      status: "expired",
      reason: "ceiling",
      message: GRAPH_APP_BICEP_MAX_WAIT_MESSAGE
    });
  });

  it("prefers the ceiling over the idle verdict once both are spent", () => {
    expect(
      evaluateAppBicepWait({
        nowMs: START + GRAPH_APP_BICEP_MAX_WAIT_MS,
        waitStartedAtMs: START,
        lastActivityAtMs: null
      })
    ).toMatchObject({ reason: "ceiling" });
  });

  // A host clock that jumps backwards must not manufacture an expiry.
  it("keeps waiting when the clock moves backwards", () => {
    expect(
      evaluateAppBicepWait({
        nowMs: START - 60_000,
        waitStartedAtMs: START,
        lastActivityAtMs: null
      })
    ).toEqual({ status: "waiting" });
  });

  it("distinguishes the three failures by message", () => {
    const messages = new Set([
      GRAPH_APP_BICEP_TIMEOUT_MESSAGE,
      GRAPH_APP_BICEP_STALLED_MESSAGE,
      GRAPH_APP_BICEP_MAX_WAIT_MESSAGE
    ]);
    expect(messages.size).toBe(3);
    expect(GRAPH_APP_BICEP_TIMEOUT_MESSAGE).toContain("5 minutes");
    expect(GRAPH_APP_BICEP_MAX_WAIT_MESSAGE).toContain("30 minutes");
  });
});
