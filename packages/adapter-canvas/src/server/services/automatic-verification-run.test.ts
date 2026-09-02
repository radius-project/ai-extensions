import { describe, expect, it } from "vitest";
import { verificationRunTitle } from "../../verification-run-identity.js";
import { discoverAutomaticVerificationRun } from "./automatic-verification-run.js";

const STARTED_AT = Date.parse("2026-09-01T18:00:00Z");
const identity = {
  repo: "octo/app",
  workflow: "radius-verify-credentials.yml",
  ref: "radius/setup-dev-workflows-abc",
  environment: "dev",
  operationMarker: "op_abc",
  startedAt: STARTED_AT
};

function run(overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 41,
    createdAt: new Date(STARTED_AT + 1000).toISOString(),
    displayTitle: verificationRunTitle("dev", "op_abc"),
    event: "push",
    headBranch: identity.ref,
    ...overrides
  };
}

function result(value: unknown) {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

describe("automatic verification run discovery", () => {
  it("waits for delayed registration and returns the exact push run", async () => {
    const responses = [result([]), result([run()])];
    const sleeps: number[] = [];

    const outcome = await discoverAutomaticVerificationRun({
      identity,
      listRuns: async () => responses.shift() ?? result([]),
      stopBoundary: async () => true,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    });

    expect(outcome).toEqual({
      state: "discovered",
      runId: "41",
      runUrl: "https://github.com/octo/app/actions/runs/41"
    });
    expect(sleeps).toEqual([5000]);
  });

  it("never adopts a plausible run without the exact marker", async () => {
    const outcome = await discoverAutomaticVerificationRun({
      identity,
      listRuns: async () => result([run({ displayTitle: "Verify dev" })]),
      stopBoundary: async () => true,
      sleep: async () => {}
    });

    expect(outcome).toMatchObject({ state: "manual_required" });
    expect(
      outcome.state === "manual_required" ? outcome.guidance : ""
    ).toContain("without the exact operation marker");
  });

  it.each([
    {
      name: "another branch",
      unrelated: run({ headBranch: "feature/unrelated" })
    },
    {
      name: "before automatic verification started",
      unrelated: run({
        createdAt: new Date(STARTED_AT - 1).toISOString(),
        displayTitle: "Verify dev"
      })
    }
  ])(
    "ignores a run from $name while waiting for the exact run",
    async ({ unrelated }) => {
      const responses = [result([unrelated]), result([run()])];
      const sleeps: number[] = [];

      const outcome = await discoverAutomaticVerificationRun({
        identity,
        listRuns: async () => responses.shift() ?? result([]),
        stopBoundary: async () => true,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        }
      });

      expect(outcome).toMatchObject({ state: "discovered", runId: "41" });
      expect(sleeps).toEqual([5000]);
    }
  );

  it("fails closed when multiple exact runs exist", async () => {
    const outcome = await discoverAutomaticVerificationRun({
      identity,
      listRuns: async () => result([run(), run({ databaseId: 42 })]),
      stopBoundary: async () => true,
      sleep: async () => {}
    });

    expect(outcome).toMatchObject({ state: "manual_required" });
  });

  it.each([
    {
      name: "GitHub refuses the listing with stderr",
      list: async () => ({ code: 1, stdout: "", stderr: "HTTP 403" })
    },
    {
      name: "GitHub refuses the listing with stdout",
      list: async () => ({ code: 1, stdout: "HTTP 403", stderr: "" })
    },
    {
      name: "GitHub refuses the listing without diagnostics",
      list: async () => ({ code: 1, stdout: "", stderr: "" })
    },
    {
      name: "GitHub returns malformed JSON",
      list: async () => ({ code: 0, stdout: "<html>", stderr: "" })
    }
  ])("fails closed when $name", async ({ list }) => {
    const outcome = await discoverAutomaticVerificationRun({
      identity,
      listRuns: list,
      stopBoundary: async () => true,
      sleep: async () => {}
    });

    expect(outcome).toMatchObject({ state: "manual_required" });
  });

  it("propagates an authorization failure thrown by the selected account", async () => {
    const authorizationError = new Error("selected account forbidden");
    await expect(
      discoverAutomaticVerificationRun({
        identity,
        listRuns: async () => {
          throw authorizationError;
        },
        stopBoundary: async () => true,
        sleep: async () => {}
      })
    ).rejects.toBe(authorizationError);
  });

  it("hands off after the bounded registration window", async () => {
    let listings = 0;
    const outcome = await discoverAutomaticVerificationRun({
      identity,
      listRuns: async () => {
        listings += 1;
        return result([]);
      },
      stopBoundary: async () => true,
      sleep: async () => {}
    });

    expect(listings).toBe(25);
    expect(outcome).toMatchObject({ state: "manual_required" });
  });

  it("accepts an exact run on the final bounded attempt", async () => {
    const responses = Array.from({ length: 24 }, () => result([]));
    responses.push(result([run()]));
    const sleeps: number[] = [];

    const outcome = await discoverAutomaticVerificationRun({
      identity,
      listRuns: async () => responses.shift() ?? result([]),
      stopBoundary: async () => true,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    });

    expect(outcome).toMatchObject({ state: "discovered", runId: "41" });
    expect(sleeps).toHaveLength(24);
    expect(sleeps.every((milliseconds) => milliseconds === 5000)).toBe(true);
  });

  it("cancels after waiting without starting another listing", async () => {
    let listings = 0;
    let stopped = false;
    const outcome = await discoverAutomaticVerificationRun({
      identity,
      listRuns: async () => {
        listings += 1;
        return result([]);
      },
      stopBoundary: async () => !stopped,
      sleep: async () => {
        stopped = true;
      }
    });

    expect(outcome).toEqual({ state: "cancelled" });
    expect(listings).toBe(1);
  });

  it("cancels before listing another run", async () => {
    let listings = 0;
    const outcome = await discoverAutomaticVerificationRun({
      identity,
      listRuns: async () => {
        listings += 1;
        return result([]);
      },
      stopBoundary: async () => false,
      sleep: async () => {}
    });

    expect(outcome).toEqual({ state: "cancelled" });
    expect(listings).toBe(0);
  });
});
