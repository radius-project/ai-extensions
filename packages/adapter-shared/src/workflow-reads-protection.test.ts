import { afterEach, describe, expect, it, vi } from "vitest";
import { observeWorkflowRun } from "@radius-project/core";
import {
  pendingEnvironment,
  workflowObservationCases
} from "../test/fixtures/workflow-observation.js";
import { createWorkflowReadSession } from "./workflow-read-budget.js";
import {
  readWorkflowRun,
  readWorkflowRunWithMetadata,
  SelectedGhAuthorizationError,
  type WorkflowExecution,
  type WorkflowRunner,
  type WorkflowCommandResult
} from "./workflow-reads.js";

const endpoint = "repos/org/app/actions/runs/41";
const argsFor = (path: string) => ["api", path, "--include", "--method", "GET"];
const runArgs = argsFor(endpoint);
const jobsArgs = argsFor(`${endpoint}/jobs?per_page=100&page=1`);
const protectionArgs = argsFor(`${endpoint}/pending_deployments`);
function response(
  value: unknown,
  status = 200,
  headers = ""
): WorkflowCommandResult {
  return {
    code: status === 200 ? 0 : 1,
    stderr: "",
    stdout: `HTTP/2 ${status}\n${headers}\n${JSON.stringify(value)}`
  };
}
function execution(
  mode: "ambient" | "selected",
  run: WorkflowRunner
): WorkflowExecution {
  return mode === "ambient" ?
      { mode, run }
    : {
        mode,
        executor: {
          login: "fixture-account",
          run,
          errorMessage: (error) =>
            error instanceof Error ? error.message : String(error)
        }
      };
}
function fixtureClock() {
  let now = 0;
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    clock: {
      monotonic: () => now,
      wall: () => 1_700_000_000_000 + now,
      jitter: () => 0,
      sleep: async (milliseconds: number) => {
        now += milliseconds;
      }
    }
  };
}
afterEach(() => vi.useRealTimers());

it.each(["cancelled", "timeout"] as const)(
  "does not start enrichment after primary completion consumes observation admission (%s)",
  async (reason) => {
    const { clock, advance } = fixtureClock();
    const controller = new AbortController();
    let decisions = 0;
    const run = vi
      .fn<WorkflowRunner>()
      .mockResolvedValueOnce(response({ status: "waiting" }))
      .mockResolvedValueOnce(response({ jobs: [], total_count: 0 }));
    const result = await readWorkflowRunWithMetadata(
      execution("ambient", run),
      "org/app",
      41,
      {
        context: createWorkflowReadSession(clock).observe(
          15000,
          controller.signal
        ),
        identity: "ambient",
        onDecision: () => {
          if (++decisions === 2) {
            if (reason === "cancelled") controller.abort();
            else advance(15000);
          }
        }
      },
      { includeProtection: true }
    );
    expect(result).toMatchObject({
      completeness: "complete",
      value: { protection: { state: "unavailable", reason } }
    });
    expect(run.mock.calls.map(([args]) => args)).toEqual([runArgs, jobsArgs]);
    expect(decisions).toBe(2);
  }
);

it.each([
  {
    result: { code: 0, stdout: "HTTP/2 200\n\n{", stderr: "" },
    reason: "invalid-data"
  },
  {
    result: { code: 1, stdout: "", stderr: "HTTP 403 Forbidden" },
    reason: "authorization"
  },
  {
    result: { code: 1, stdout: "", stderr: "HTTP 401 Unauthorized" },
    reason: "authorization"
  },
  {
    result: {
      code: 1,
      stdout: "",
      stderr: "Resource protected by organization SAML enforcement"
    },
    reason: "authorization"
  },
  {
    result: {
      code: 1,
      stdout: "",
      stderr: "HTTP 403 Forbidden: API rate limit exceeded"
    },
    reason: "read-failed"
  },
  {
    result: { code: 1, stdout: "", stderr: "CLI unavailable" },
    reason: "read-failed"
  }
])(
  "keeps optional unframed or malformed output explicit ($reason)",
  async ({ result, reason }) => {
    const run = vi
      .fn<WorkflowRunner>()
      .mockResolvedValueOnce(response({ status: "waiting" }))
      .mockResolvedValueOnce(response({ jobs: [], total_count: 0 }))
      .mockResolvedValueOnce(result);
    const observed = await readWorkflowRunWithMetadata(
      execution("selected", run),
      "org/app",
      41,
      undefined,
      { includeProtection: true }
    );
    expect(observed).toMatchObject({
      completeness: "complete",
      value: { protection: { state: "unavailable", reason } }
    });
    expect(run).toHaveBeenCalledTimes(3);
  }
);

describe.each(["ambient", "selected"] as const)(
  "%s protection enrichment",
  (mode) => {
    it.each(workflowObservationCases)(
      "observes $name without mutations",
      async (scenario) => {
        const run = vi.fn<WorkflowRunner>(async (args) => {
          if (JSON.stringify(args) === JSON.stringify(runArgs))
            return response({
              status: scenario.status,
              conclusion: scenario.conclusion
            });
          if (JSON.stringify(args) === JSON.stringify(jobsArgs))
            return response({
              total_count: scenario.jobsTotal ?? scenario.jobs.length,
              jobs: scenario.jobs
            });
          if (JSON.stringify(args) === JSON.stringify(protectionArgs))
            return response(scenario.pending, scenario.protectionStatus);
          throw new Error("Unexpected command");
        });
        const observed = await observeWorkflowRun(
          { repo: "org/app", runId: 41 },
          {
            readRun: (repo, runId) =>
              readWorkflowRun(execution(mode, run), repo, runId, undefined, {
                includeProtection: true
              })
          }
        );
        expect(observed).toMatchObject({
          status: scenario.status,
          conclusion: scenario.conclusion ?? "",
          jobs: scenario.jobs
        });
        expect(observed?.protection?.state).toBe(scenario.protectionState);
        expect(run.mock.calls.map(([args]) => args)).toEqual([
          runArgs,
          jobsArgs,
          ...((
            scenario.status === "waiting" && scenario.jobsTotal === undefined
          ) ?
            [protectionArgs]
          : [])
        ]);
      }
    );

    it.each([
      "queued",
      "pending",
      "in_progress",
      "completed",
      "",
      undefined,
      "future"
    ])("does not enrich status %s", async (status) => {
      const run = vi
        .fn<WorkflowRunner>()
        .mockResolvedValueOnce(response({ status }))
        .mockResolvedValueOnce(response({ total_count: 0, jobs: [] }));
      const result = await readWorkflowRunWithMetadata(
        execution(mode, run),
        "org/app",
        41,
        undefined,
        { includeProtection: true }
      );
      expect(result.value).not.toHaveProperty("protection");
      expect(run.mock.calls.map(([args]) => args)).toEqual([runArgs, jobsArgs]);
    });

    it("keeps legacy waiting reads opt-out", async () => {
      const run = vi
        .fn<WorkflowRunner>()
        .mockResolvedValueOnce(response({ status: "waiting" }))
        .mockResolvedValueOnce(response({ total_count: 0, jobs: [] }));
      const result = await readWorkflowRun(execution(mode, run), "org/app", 41);
      expect(result).not.toHaveProperty("protection");
      expect(run).toHaveBeenCalledTimes(2);
    });

    it.each([401, 403, 404, 500])(
      "keeps complete primary evidence after optional HTTP %s without probing",
      async (status) => {
        const run = vi
          .fn<WorkflowRunner>()
          .mockResolvedValueOnce(response({ status: "waiting" }))
          .mockResolvedValueOnce(response({ total_count: 0, jobs: [] }))
          .mockResolvedValueOnce(response({ message: "Unavailable" }, status));
        const result = await readWorkflowRunWithMetadata(
          execution(mode, run),
          "org/app",
          41,
          undefined,
          { includeProtection: true }
        );
        expect(result).toMatchObject({
          completeness: "complete",
          value: {
            includeJobs: true,
            protection: {
              state: "unavailable",
              reason:
                status === 401 || status === 403 || status === 404 ?
                  "authorization"
                : "read-failed"
            }
          }
        });
        expect(result.reason).toBeUndefined();
        expect(result.evidence.map((item) => item.phase)).toEqual([
          "run",
          "jobs",
          "protection"
        ]);
        expect(run.mock.calls.map(([args]) => args)).toEqual([
          runArgs,
          jobsArgs,
          protectionArgs
        ]);
      }
    );

    it.each([
      ["framed", false],
      ["framed", true],
      ["unframed", false],
      ["unframed", true],
      ["thrown", false],
      ["thrown", true]
    ] as const)(
      "keeps optional %s HTTP 404 isolated from primary evidence (observation: %s)",
      async (format, observation) => {
        const { clock } = fixtureClock();
        const onDecision = vi.fn();
        const error = new Error("gh: Not Found (HTTP 404)");
        const run = vi.fn<WorkflowRunner>(async (args) => {
          if (JSON.stringify(args) === JSON.stringify(runArgs))
            return response({ status: "waiting", conclusion: null });
          if (JSON.stringify(args) === JSON.stringify(jobsArgs))
            return response({ total_count: 0, jobs: [] });
          if (JSON.stringify(args) === JSON.stringify(protectionArgs)) {
            if (format === "thrown") throw error;
            return format === "framed" ?
                response({ message: "Not Found" }, 404)
              : { code: 1, stdout: "", stderr: error.message };
          }
          throw new Error("Unexpected command");
        });
        const result = readWorkflowRunWithMetadata(
          execution(mode, run),
          "org/app",
          41,
          observation ?
            {
              context: createWorkflowReadSession(clock).observe(30000),
              identity: mode,
              onDecision
            }
          : undefined,
          { includeProtection: true }
        );
        if (format === "thrown" && mode === "ambient") {
          await expect(result).rejects.toBe(error);
        } else {
          const observed = await result;
          expect(observed).toMatchObject({
            completeness: "complete",
            value: {
              data: { status: "waiting", conclusion: "", jobs: [] },
              includeJobs: true,
              protection: { state: "unavailable", reason: "authorization" }
            }
          });
          expect(observed.reason).toBeUndefined();
          expect(observed.decision).toBeUndefined();
          expect(observed.evidence.slice(0, 2)).toMatchObject([
            {
              phase: "run",
              response: { source: "gh-api-include", status: 200 }
            },
            {
              phase: "jobs",
              response: { source: "gh-api-include", status: 200 }
            }
          ]);
          expect(observed.evidence.map(({ phase }) => phase)).toEqual([
            "run",
            "jobs",
            ...(format === "thrown" ? [] : ["protection"])
          ]);
          if (format === "thrown") {
            expect(observed.value?.protection?.response).toBeUndefined();
          } else {
            expect(observed.value?.protection?.response).toMatchObject(
              format === "framed" ?
                {
                  source: "gh-api-include",
                  status: 404,
                  classification: "other"
                }
              : { source: "unavailable" }
            );
          }
        }
        expect(
          onDecision.mock.calls.map(([decision]) => decision.state)
        ).toEqual(observation ? ["ready", "ready"] : []);
        expect(run.mock.calls.map(([args]) => args)).toEqual([
          runArgs,
          jobsArgs,
          protectionArgs
        ]);
      }
    );

    it.each(["no observation", "retry exhaustion"] as const)(
      "trusts framed rate-limit evidence over HTTP 403 stderr with %s",
      async (policy) => {
        const { clock } = fixtureClock();
        const onDecision = vi.fn();
        const request =
          policy === "retry exhaustion" ?
            {
              context: createWorkflowReadSession(clock).observe(30000),
              identity: mode,
              onDecision
            }
          : undefined;
        const run = vi.fn<WorkflowRunner>(async (args) => {
          if (JSON.stringify(args) === JSON.stringify(runArgs))
            return response({ status: "waiting", conclusion: null });
          if (JSON.stringify(args) === JSON.stringify(jobsArgs))
            return response({ total_count: 0, jobs: [] });
          if (JSON.stringify(args) === JSON.stringify(protectionArgs))
            return {
              ...response({}, 403, "retry-after: 0\n"),
              stderr: "gh: Forbidden (HTTP 403)"
            };
          throw new Error("Unexpected command");
        });
        const result = await readWorkflowRunWithMetadata(
          execution(mode, run),
          "org/app",
          41,
          request,
          { includeProtection: true }
        );
        expect(result).toMatchObject({
          completeness: "complete",
          value: {
            data: { status: "waiting", conclusion: "", jobs: [] },
            includeJobs: true,
            protection: {
              state: "unavailable",
              reason: "read-failed",
              response: {
                source: "gh-api-include",
                status: 403,
                classification: "rate-limit"
              }
            }
          }
        });
        expect(result.reason).toBeUndefined();
        expect(result.decision).toBeUndefined();
        expect(result.value?.protection?.decision).toEqual(
          request ? { state: "exhausted", reason: "attempts" } : undefined
        );
        expect(
          onDecision.mock.calls.map(([decision]) => decision.state)
        ).toEqual(request ? ["ready", "ready"] : []);
        expect(run.mock.calls.map(([args]) => args)).toEqual([
          runArgs,
          jobsArgs,
          protectionArgs,
          ...(request ? [protectionArgs, protectionArgs] : [])
        ]);
      }
    );

    it("does not read protection after incomplete primary jobs", async () => {
      const run = vi
        .fn<WorkflowRunner>()
        .mockResolvedValueOnce(response({ status: "waiting" }))
        .mockResolvedValueOnce(response({ total_count: 1, jobs: [] }));
      const result = await readWorkflowRunWithMetadata(
        execution(mode, run),
        "org/app",
        41,
        undefined,
        { includeProtection: true }
      );
      expect(result).toMatchObject({
        completeness: "status-only",
        reason: "pagination",
        value: {
          protection: { state: "unavailable", reason: "primary-incomplete" }
        }
      });
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("retains primary decisions when protection is deferred and honors cooldown across polls", async () => {
      const { clock, advance } = fixtureClock();
      const session = createWorkflowReadSession(clock);
      const onDecision = vi.fn();
      const run = vi.fn<WorkflowRunner>(async (args) => {
        if (args[1] === endpoint) return response({ status: "waiting" });
        if (args[1].includes("/jobs"))
          return response({ total_count: 0, jobs: [] });
        if (args[1].endsWith("/pending_deployments"))
          return response(
            { message: "rate limited" },
            429,
            "retry-after: 60\n"
          );
        throw new Error("Unexpected command");
      });
      const read = () =>
        readWorkflowRunWithMetadata(
          execution(mode, run),
          "org/app",
          41,
          {
            context: session.observe(30000),
            identity: mode,
            onDecision
          },
          { includeProtection: true }
        );
      const first = await read();
      expect(first).toMatchObject({
        completeness: "complete",
        value: {
          protection: {
            state: "unavailable",
            reason: "deferred",
            decision: { state: "deferred" }
          }
        }
      });
      expect(first.decision).toBeUndefined();
      expect(onDecision.mock.calls.map(([decision]) => decision.state)).toEqual(
        ["ready", "ready"]
      );
      advance(5000);
      const second = await read();
      expect(second.value?.protection).toMatchObject({
        state: "unavailable",
        reason: "deferred"
      });
      expect(run.mock.calls.map(([args]) => args)).toEqual([
        runArgs,
        jobsArgs,
        protectionArgs,
        runArgs,
        jobsArgs
      ]);
    });

    it("shares two extra GETs across primary reads and enrichment", async () => {
      const { clock } = fixtureClock();
      const run = vi
        .fn<WorkflowRunner>()
        .mockResolvedValueOnce(response({}, 503))
        .mockResolvedValueOnce(response({ status: "waiting" }))
        .mockResolvedValueOnce(response({}, 503))
        .mockResolvedValueOnce(response({ total_count: 0, jobs: [] }))
        .mockResolvedValueOnce(response({}, 503));
      const result = await readWorkflowRunWithMetadata(
        execution(mode, run),
        "org/app",
        41,
        {
          context: createWorkflowReadSession(clock).observe(30000),
          identity: mode
        },
        { includeProtection: true }
      );
      expect(result.completeness).toBe("complete");
      expect(result.value?.protection).toMatchObject({
        state: "unavailable",
        decision: { state: "exhausted" }
      });
      expect(run.mock.calls.map(([args]) => args)).toEqual([
        runArgs,
        runArgs,
        jobsArgs,
        jobsArgs,
        protectionArgs
      ]);
    });

    it("retries optional transient reads through the shared ledger", async () => {
      const { clock } = fixtureClock();
      const run = vi
        .fn<WorkflowRunner>()
        .mockResolvedValueOnce(response({ status: "waiting" }))
        .mockResolvedValueOnce(response({ total_count: 0, jobs: [] }))
        .mockResolvedValueOnce(response({}, 502))
        .mockResolvedValueOnce(response([pendingEnvironment]));
      const result = await readWorkflowRunWithMetadata(
        execution(mode, run),
        "org/app",
        41,
        {
          context: createWorkflowReadSession(clock).observe(30000),
          identity: mode
        },
        { includeProtection: true }
      );
      expect(result.value?.protection).toMatchObject({
        state: "observed",
        decision: { state: "ready" }
      });
      expect(run.mock.calls.map(([args]) => args)).toEqual([
        runArgs,
        jobsArgs,
        protectionArgs,
        protectionArgs
      ]);
    });

    it.each(["timeout", "output-limit", "cancelled"] as const)(
      "keeps primary evidence and cleans up after optional %s",
      async (reason) => {
        vi.useFakeTimers();
        const { clock, advance } = fixtureClock();
        const controller = new AbortController();
        const run = vi
          .fn<WorkflowRunner>()
          .mockResolvedValueOnce(response({ status: "waiting" }))
          .mockResolvedValueOnce(response({ total_count: 0, jobs: [] }))
          .mockImplementationOnce(async () => {
            if (reason === "cancelled") controller.abort();
            if (reason === "timeout") advance(15000);
            return reason === "output-limit" ?
                {
                  code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
                  stdout: "",
                  stderr: ""
                }
              : response([]);
          });
        const result = await readWorkflowRunWithMetadata(
          execution(mode, run),
          "org/app",
          41,
          {
            context: createWorkflowReadSession(clock).observe(
              30000,
              controller.signal
            ),
            identity: mode
          },
          { includeProtection: true }
        );
        expect(result).toMatchObject({
          completeness: "complete",
          value: { protection: { state: "unavailable", reason } }
        });
        expect(result.reason).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      }
    );

    it("passes only the remaining transport time and output allowance to enrichment", async () => {
      const { clock, advance } = fixtureClock();
      const runResponse = response({ status: "waiting" });
      const jobsResponse = response({ total_count: 0, jobs: [] });
      const run = vi
        .fn<WorkflowRunner>()
        .mockImplementationOnce(async () => {
          advance(1000);
          return runResponse;
        })
        .mockImplementationOnce(async () => {
          advance(1000);
          return jobsResponse;
        })
        .mockResolvedValueOnce(response([]));
      await readWorkflowRunWithMetadata(
        execution(mode, run),
        "org/app",
        41,
        {
          context: createWorkflowReadSession(clock).observe(30000),
          identity: mode
        },
        { includeProtection: true }
      );
      expect(run.mock.calls[2][1]).toMatchObject({
        timeout: 13000,
        maxBuffer:
          10 * 1024 * 1024 -
          Buffer.byteLength(runResponse.stdout) -
          Buffer.byteLength(jobsResponse.stdout)
      });
    });

    it("propagates unexpected executor rejection rather than inventing unknown success", async () => {
      const error = new Error("unexpected fixture failure");
      const run = vi
        .fn<WorkflowRunner>()
        .mockResolvedValueOnce(response({ status: "waiting" }))
        .mockResolvedValueOnce(response({ total_count: 0, jobs: [] }))
        .mockRejectedValueOnce(error);
      await expect(
        readWorkflowRunWithMetadata(
          execution(mode, run),
          "org/app",
          41,
          undefined,
          { includeProtection: true }
        )
      ).rejects.toBe(error);
      expect(run).toHaveBeenCalledTimes(3);
    });
  }
);

it.each([
  new SelectedGhAuthorizationError("fixture", 403, "redacted"),
  new Error("HTTP 401"),
  new Error("HTTP 404")
])(
  "retains primary evidence for rejected optional selected authorization (%s)",
  async (error) => {
    const run = vi
      .fn<WorkflowRunner>()
      .mockResolvedValueOnce(response({ status: "waiting" }))
      .mockResolvedValueOnce(response({ total_count: 0, jobs: [] }))
      .mockRejectedValueOnce(error);
    const result = await readWorkflowRunWithMetadata(
      execution("selected", run),
      "org/app",
      41,
      undefined,
      { includeProtection: true }
    );
    expect(result).toMatchObject({
      completeness: "complete",
      value: { protection: { state: "unavailable", reason: "authorization" } }
    });
    expect(JSON.stringify(result)).not.toContain("redacted");
    expect(run).toHaveBeenCalledTimes(3);
  }
);
