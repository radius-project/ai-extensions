import { describe, expect, it, vi } from "vitest";
import {
  createStateSaveFailureReader,
  describeStateSaveFailure,
  normalizeRunAttempt,
  parseStateSaveFailureArtifact,
  stateSaveFailureArtifactName,
  STATE_SAVE_FAILURE_ARTIFACT,
  STATE_SAVE_FAILURE_FILE
} from "./state-save-diagnostics.js";
import type { WorkflowArtifact } from "./deploy-artifacts.js";

function payloadFor(runAttempt: unknown, overrides: object = {}): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    outcome: "state_save_failed",
    attempts: 3,
    runId: "42",
    runAttempt,
    error: "rad shutdown: connection refused",
    ...overrides
  });
}

const failurePayload = payloadFor("1");

function artifact(overrides: Partial<WorkflowArtifact> = {}): WorkflowArtifact {
  return { id: 7, name: stateSaveFailureArtifactName(1), ...overrides };
}

describe("stateSaveFailureArtifactName", () => {
  it("scopes the artifact name to the run attempt", () => {
    expect(stateSaveFailureArtifactName(1)).toBe(
      `${STATE_SAVE_FAILURE_ARTIFACT}-attempt-1`
    );
    expect(stateSaveFailureArtifactName(2)).toBe(
      `${STATE_SAVE_FAILURE_ARTIFACT}-attempt-2`
    );
  });
});

describe("normalizeRunAttempt", () => {
  it.each([
    ["a number", 2, 2],
    ["a numeric string", "3", 3],
    ["a fractional value", 2.7, 2],
    ["the first attempt", 1, 1]
  ])("accepts %s", (_label, value, expected) => {
    expect(normalizeRunAttempt(value)).toBe(expected);
  });

  it.each([
    ["zero", 0],
    ["a negative attempt", -1],
    ["an empty string", "   "],
    ["a non-numeric string", "second"],
    ["null", null],
    ["undefined", undefined],
    ["NaN", Number.NaN]
  ])("rejects %s", (_label, value) => {
    expect(normalizeRunAttempt(value)).toBeNull();
  });
});

describe("parseStateSaveFailureArtifact", () => {
  it("reads the attempt count and the last error", () => {
    expect(parseStateSaveFailureArtifact(failurePayload, 1)).toEqual({
      attempts: 3,
      runAttempt: 1,
      error: "rad shutdown: connection refused"
    });
  });

  it("defaults missing detail rather than failing the read", () => {
    expect(
      parseStateSaveFailureArtifact(
        JSON.stringify({ outcome: "state_save_failed", runAttempt: 1 }),
        1
      )
    ).toEqual({ attempts: 0, runAttempt: 1, error: "" });
  });

  it("normalizes a non-integer or negative attempt count", () => {
    expect(
      parseStateSaveFailureArtifact(payloadFor("1", { attempts: 2.9 }), 1)
        ?.attempts
    ).toBe(2);
    expect(
      parseStateSaveFailureArtifact(payloadFor("1", { attempts: -4 }), 1)
        ?.attempts
    ).toBe(0);
    expect(
      parseStateSaveFailureArtifact(payloadFor("1", { attempts: Infinity }), 1)
        ?.attempts
    ).toBe(0);
  });

  it("refuses a diagnostic that belongs to another run attempt", () => {
    expect(parseStateSaveFailureArtifact(payloadFor("1"), 2)).toBeNull();
    expect(parseStateSaveFailureArtifact(payloadFor("2"), 2)).not.toBeNull();
  });

  it("refuses a diagnostic with no usable run attempt", () => {
    expect(parseStateSaveFailureArtifact(payloadFor(null), 1)).toBeNull();
    expect(parseStateSaveFailureArtifact(payloadFor("nope"), 1)).toBeNull();
  });

  it.each([
    ["empty text", ""],
    ["absent text", null],
    ["malformed json", "{"],
    ["a json array", "[]"],
    ["a json scalar", '"state_save_failed"'],
    ["another outcome", JSON.stringify({ outcome: "succeeded" })],
    ["a missing outcome", JSON.stringify({ attempts: 3, runAttempt: 1 })]
  ])("reports no failure for %s", (_label, text) => {
    expect(parseStateSaveFailureArtifact(text, 1)).toBeNull();
  });
});

describe("describeStateSaveFailure", () => {
  it("names the attempt count and the error", () => {
    expect(
      describeStateSaveFailure({ attempts: 3, runAttempt: 1, error: "boom" })
    ).toBe("rad shutdown failed after 3 attempts.\nboom");
  });

  it("uses the singular form for one attempt", () => {
    expect(
      describeStateSaveFailure({ attempts: 1, runAttempt: 1, error: "" })
    ).toBe("rad shutdown failed after 1 attempt.");
  });

  it("returns an empty detail when nothing was recorded", () => {
    expect(
      describeStateSaveFailure({ attempts: 0, runAttempt: 1, error: "" })
    ).toBe("");
  });
});

describe("createStateSaveFailureReader", () => {
  it("reads the failure the teardown action published for the run attempt", async () => {
    const listArtifacts = vi.fn().mockResolvedValue([artifact()]);
    const downloadArtifact = vi
      .fn()
      .mockResolvedValue({ [STATE_SAVE_FAILURE_FILE]: failurePayload });

    const failure = await createStateSaveFailureReader({
      repo: "acme/app",
      runId: 42,
      runAttempt: 1,
      listArtifacts,
      downloadArtifact
    }).read();

    expect(failure).toEqual({
      attempts: 3,
      runAttempt: 1,
      error: "rad shutdown: connection refused"
    });
    expect(listArtifacts).toHaveBeenCalledWith(
      "acme/app",
      42,
      stateSaveFailureArtifactName(1)
    );
  });

  // The regression this scoping exists for: attempt 1 could not save state and
  // published a diagnostic, then the SAME run was rerun and attempt 2 saved
  // state fine. GitHub still lists attempt 1's artifact for that run id.
  it("does not report a previous attempt's failure after a successful rerun", async () => {
    const artifacts = [
      { id: 7, name: stateSaveFailureArtifactName(1) } as WorkflowArtifact
    ];
    const downloadArtifact = vi.fn().mockResolvedValue({
      [STATE_SAVE_FAILURE_FILE]: payloadFor("1")
    });
    const listArtifacts = vi
      .fn()
      .mockImplementation((_repo: string, _runId: unknown, name: string) =>
        Promise.resolve(artifacts.filter((entry) => entry.name === name))
      );

    const firstAttempt = await createStateSaveFailureReader({
      repo: "acme/app",
      runId: 42,
      runAttempt: 1,
      listArtifacts,
      downloadArtifact
    }).read();
    const rerun = await createStateSaveFailureReader({
      repo: "acme/app",
      runId: 42,
      runAttempt: 2,
      listArtifacts,
      downloadArtifact
    }).read();

    expect(firstAttempt).not.toBeNull();
    expect(rerun).toBeNull();
    expect(listArtifacts).toHaveBeenLastCalledWith(
      "acme/app",
      42,
      stateSaveFailureArtifactName(2)
    );
  });

  // Belt and braces: even if a rerun's artifact were somehow named for this
  // attempt, a payload from another attempt is still refused.
  it("refuses a diagnostic whose payload names a different attempt", async () => {
    const failure = await createStateSaveFailureReader({
      repo: "acme/app",
      runId: 42,
      runAttempt: 2,
      listArtifacts: () =>
        Promise.resolve([artifact({ name: stateSaveFailureArtifactName(2) })]),
      downloadArtifact: () =>
        Promise.resolve({ [STATE_SAVE_FAILURE_FILE]: payloadFor("1") })
    }).read();

    expect(failure).toBeNull();
  });

  it.each([
    ["no repo", { repo: "", runId: 42, runAttempt: 1 }],
    ["a null run", { repo: "acme/app", runId: null, runAttempt: 1 }],
    ["an undefined run", { repo: "acme/app", runId: undefined, runAttempt: 1 }],
    ["an empty run", { repo: "acme/app", runId: "", runAttempt: 1 }],
    ["an unknown attempt", { repo: "acme/app", runId: 42, runAttempt: null }],
    ["a zero attempt", { repo: "acme/app", runId: 42, runAttempt: 0 }]
  ])("makes no request for %s", async (_label, identity) => {
    const listArtifacts = vi.fn();

    const failure = await createStateSaveFailureReader({
      ...identity,
      listArtifacts,
      downloadArtifact: vi.fn()
    }).read();

    expect(failure).toBeNull();
    expect(listArtifacts).not.toHaveBeenCalled();
  });

  it("reports no failure when the run published no diagnostic", async () => {
    const failure = await createStateSaveFailureReader({
      repo: "acme/app",
      runId: 42,
      runAttempt: 1,
      listArtifacts: () => Promise.resolve([artifact({ name: "other" })]),
      downloadArtifact: vi.fn()
    }).read();

    expect(failure).toBeNull();
  });

  it("ignores an expired diagnostic artifact", async () => {
    const downloadArtifact = vi.fn();

    const failure = await createStateSaveFailureReader({
      repo: "acme/app",
      runId: 42,
      runAttempt: 1,
      listArtifacts: () => Promise.resolve([artifact({ expired: true })]),
      downloadArtifact
    }).read();

    expect(failure).toBeNull();
    expect(downloadArtifact).not.toHaveBeenCalled();
  });

  it.each([
    ["the listing fails", { list: true }],
    ["the download fails", { list: false }]
  ])("stays silent when %s", async (_label, mode) => {
    const failure = await createStateSaveFailureReader({
      repo: "acme/app",
      runId: 42,
      runAttempt: 1,
      listArtifacts:
        mode.list ?
          () => Promise.reject(new Error("gh down"))
        : () => Promise.resolve([artifact()]),
      downloadArtifact: () => Promise.reject(new Error("unzip failed"))
    }).read();

    expect(failure).toBeNull();
  });

  it("stays silent when the artifact has no readable payload", async () => {
    const failure = await createStateSaveFailureReader({
      repo: "acme/app",
      runId: 42,
      runAttempt: 1,
      listArtifacts: () => Promise.resolve([artifact()]),
      downloadArtifact: () => Promise.resolve(null)
    }).read();

    expect(failure).toBeNull();
  });

  it("stays silent when the listing resolves to nothing", async () => {
    const failure = await createStateSaveFailureReader({
      repo: "acme/app",
      runId: 42,
      runAttempt: 1,
      listArtifacts: () => Promise.resolve(null as never),
      downloadArtifact: vi.fn()
    }).read();

    expect(failure).toBeNull();
  });
});
