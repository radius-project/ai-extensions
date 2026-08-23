import { describe, expect, it } from "vitest";
import {
  readRecoveredVerificationIdentity,
  recoverVerificationRun,
  verificationActionsUrl,
  type RecoveredVerificationIdentity,
  type RecoveredVerificationRunOutcome,
  type VerificationRunListResult
} from "./recovered-verification-run.js";
import { verificationRunTitle } from "../../verification-run-identity.js";

const REPO = "octo/app";
const WORKFLOW = "radius-verify-credentials.yml";
const ENVIRONMENT = "dev";
const MARKER = "op_abc123";
const REF = "main";
const DISPATCHED_AT = Date.parse("2026-03-01T10:00:00.000Z");

function identity(
  overrides: Partial<RecoveredVerificationIdentity> = {}
): RecoveredVerificationIdentity {
  return {
    repo: REPO,
    workflow: WORKFLOW,
    ref: REF,
    environment: ENVIRONMENT,
    operationMarker: MARKER,
    dispatchedAt: DISPATCHED_AT,
    baselineRunId: 100,
    ...overrides
  };
}

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    databaseId: 101,
    createdAt: new Date(DISPATCHED_AT + 1000).toISOString(),
    displayTitle: verificationRunTitle(ENVIRONMENT, MARKER),
    event: "workflow_dispatch",
    headBranch: REF,
    ...overrides
  };
}

function listed(
  runs: unknown,
  overrides: Partial<VerificationRunListResult> = {}
): VerificationRunListResult {
  return {
    code: 0,
    stdout: JSON.stringify(runs),
    stderr: "",
    ...overrides
  };
}

// A hand-off carries no run, so asking for its guidance is only valid once the
// outcome has been shown not to be a discovery.
function guidanceOf(outcome: RecoveredVerificationRunOutcome): string {
  if (outcome.state !== "hand_off") {
    throw new Error(`expected a hand-off, got ${outcome.state}`);
  }
  return outcome.guidance;
}

describe("reading a restarted verification's dispatch identity", () => {
  it("takes the exact workflow, ref, environment, marker and baseline saved before dispatch", () => {
    expect(
      readRecoveredVerificationIdentity(
        {
          repo: REPO,
          environment: "requested-name",
          verification: {
            workflow: WORKFLOW,
            ref: REF,
            environment: ENVIRONMENT,
            operationMarker: MARKER,
            dispatchedAt: DISPATCHED_AT,
            baselineRunId: 100
          }
        },
        "fallback.yml"
      )
    ).toEqual(identity());
  });

  it("falls back to the operation's own environment and the default workflow", () => {
    expect(
      readRecoveredVerificationIdentity(
        { repo: REPO, environment: ENVIRONMENT, verification: null },
        "fallback.yml"
      )
    ).toEqual({
      repo: REPO,
      workflow: "fallback.yml",
      ref: "",
      environment: ENVIRONMENT,
      operationMarker: "",
      dispatchedAt: Number.NaN,
      baselineRunId: null
    });
  });

  it("treats an unreadable baseline as no baseline rather than a number", () => {
    const read = readRecoveredVerificationIdentity(
      { repo: REPO, verification: { baselineRunId: "not-a-run" } },
      WORKFLOW
    );

    expect(read.baselineRunId).toBeNull();
  });
});

describe("recovering a verification run after a restart", () => {
  it("monitors without reading GitHub when the record already names a run", async () => {
    const outcome = await recoverVerificationRun({
      runId: "1234",
      identity: identity(),
      listRuns: async () => {
        throw new Error("a known run must not be rediscovered");
      }
    });

    expect(outcome).toEqual({ state: "monitor" });
  });

  it("discovers the one run carrying this operation's exact marker", async () => {
    let calls = 0;
    const outcome = await recoverVerificationRun({
      runId: null,
      identity: identity(),
      listRuns: async () => {
        calls += 1;
        return listed([run({ databaseId: 999 })]);
      }
    });

    expect(calls).toBe(1);
    expect(outcome).toEqual({
      state: "discovered",
      runId: "999",
      runUrl: `https://github.com/${REPO}/actions/runs/999`
    });
  });

  it("hands off a legacy workflow that cannot expose a marker instead of waiting", async () => {
    const outcome = await recoverVerificationRun({
      runId: null,
      identity: identity({ operationMarker: "" }),
      listRuns: async () => {
        throw new Error("an unmarked workflow must not be listed at all");
      }
    });

    expect(guidanceOf(outcome)).toContain(
      "does not expose an operation-specific run marker"
    );
    expect(guidanceOf(outcome)).toContain(
      verificationActionsUrl(REPO, WORKFLOW)
    );
  });

  it("refuses to choose between runs that both carry the marker", async () => {
    const outcome = await recoverVerificationRun({
      runId: null,
      identity: identity(),
      listRuns: async () =>
        listed([run({ databaseId: 201 }), run({ databaseId: 202 })])
    });

    expect(guidanceOf(outcome)).toContain(
      "more than one run carries this operation's exact marker"
    );
  });

  it("refuses to adopt an unmarked run that merely appeared after the dispatch", async () => {
    const outcome = await recoverVerificationRun({
      runId: null,
      identity: identity(),
      listRuns: async () =>
        listed([run({ databaseId: 300, displayTitle: "Verify credentials" })])
    });

    expect(guidanceOf(outcome)).toContain(
      "no run carries this operation's exact marker"
    );
  });

  it.each([
    ["a run for another branch", { headBranch: "other" }],
    [
      "a run for another environment",
      { displayTitle: "Radius verify prod [op_abc123]" }
    ],
    ["a run from another event", { event: "push" }],
    ["a run at or below the baseline", { databaseId: 100 }],
    [
      "a run created before the dispatch window",
      {
        createdAt: new Date(DISPATCHED_AT - 120000).toISOString()
      }
    ]
  ])("hands off rather than adopting %s", async (_label, overrides) => {
    const outcome = await recoverVerificationRun({
      runId: null,
      identity: identity(),
      listRuns: async () => listed([run(overrides)])
    });

    expect(outcome.state).toBe("hand_off");
  });

  it.each([
    [
      "GitHub refused the read",
      listed([], { code: 1, stdout: "", stderr: "HTTP 403: Forbidden" }),
      "HTTP 403: Forbidden"
    ],
    [
      "GitHub refused the read with no detail",
      listed([], { code: 1, stdout: "", stderr: "" }),
      "the GitHub CLI request failed"
    ],
    [
      "GitHub returned unreadable output",
      listed([], { stdout: "<html>" }),
      "unreadable workflow run list"
    ]
  ])("hands off when %s", async (_label, response, expected) => {
    const outcome = await recoverVerificationRun({
      runId: null,
      identity: identity(),
      listRuns: async () => response
    });

    expect(guidanceOf(outcome)).toContain(expected);
  });

  it("hands off when the run list cannot be reached at all", async () => {
    const outcome = await recoverVerificationRun({
      runId: null,
      identity: identity(),
      listRuns: async () => {
        throw new Error("gh is not installed");
      }
    });

    expect(guidanceOf(outcome)).toContain("gh is not installed");
  });

  it("names a non-Error read failure rather than dropping it", async () => {
    const outcome = await recoverVerificationRun({
      runId: null,
      identity: identity(),
      listRuns: async () => {
        throw "spawn failed";
      }
    });

    expect(guidanceOf(outcome)).toContain("spawn failed");
  });

  it("treats an empty run id string as no run rather than a run named empty", async () => {
    const outcome = await recoverVerificationRun({
      runId: "",
      identity: identity(),
      listRuns: async () => listed([run({ databaseId: 555 })])
    });

    expect(outcome).toMatchObject({ state: "discovered", runId: "555" });
  });

  it("accepts a string-zero exit status from the run list", async () => {
    const outcome = await recoverVerificationRun({
      runId: null,
      identity: identity(),
      listRuns: async () => listed([run({ databaseId: 777 })], { code: "0" })
    });

    expect(outcome).toMatchObject({ state: "discovered", runId: "777" });
  });
});

describe("a record whose dispatch identity is only partly there", () => {
  it("reads an empty repository rather than inventing one", () => {
    expect(
      readRecoveredVerificationIdentity({ verification: {} }, WORKFLOW)
    ).toMatchObject({ repo: "", environment: "" });
  });

  it("still points a hand-off at an Actions URL it can build", async () => {
    const outcome = await recoverVerificationRun({
      runId: null,
      identity: identity({ repo: "", operationMarker: "" }),
      listRuns: async () => {
        throw new Error("an unmarked workflow must not be listed at all");
      }
    });

    expect(guidanceOf(outcome)).toContain(verificationActionsUrl("", WORKFLOW));
  });
});
