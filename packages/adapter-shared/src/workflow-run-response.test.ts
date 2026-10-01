import { afterEach, describe, expect, it, vi } from "vitest";
import { observeWorkflowRun } from "@radius-project/core";
import {
  readWorkflowRun,
  readWorkflowRunWithMetadata,
  SelectedGhAuthorizationError,
  type WorkflowCommandResult,
  type WorkflowExecution,
  type WorkflowRunner
} from "./workflow-reads.js";

function reply(
  value: unknown,
  status = 200,
  headers = ""
): WorkflowCommandResult {
  return {
    code: status >= 400 ? 1 : 0,
    stdout: `HTTP/2.0 ${status} Response\n${headers}\r\n${JSON.stringify(value)}`,
    stderr: ""
  };
}

const runData = {
  status: "completed",
  conclusion: "failure",
  repository: { id: 7 }
};
const job = {
  name: "deploy",
  steps: [
    { name: "Run rad commands", status: "completed", conclusion: "failure" }
  ]
};
function scripted(
  responses: (WorkflowCommandResult | Error)[],
  selected = false
) {
  let index = 0;
  const run = vi.fn<WorkflowRunner>(async () => {
    const result = responses[index++];
    if (!result) throw new Error("Unscripted workflow read");
    if (result instanceof Error) throw result;
    return result;
  });
  const execution: WorkflowExecution =
    selected ?
      {
        mode: "selected",
        executor: { login: "alice", run, errorMessage: String }
      }
    : { mode: "ambient", run };
  return { execution, run };
}

afterEach(() => vi.useRealTimers());

describe("bounded REST workflow detail composition", () => {
  it.each(["run", "repository"] as const)(
    "retains actionable redacted selected %s authorization diagnostics",
    async (phase) => {
      const detail =
        "Resource protected by organization SAML enforcement: grant your OAuth token access. fixture-private";
      const run: WorkflowRunner = async (args) =>
        phase === "repository" && args[1] !== "repos/org/app" ?
          reply({}, 404)
        : { ...reply({}, 403), stderr: detail };
      await expect(
        readWorkflowRunWithMetadata(
          {
            mode: "selected",
            executor: {
              login: "alice",
              run,
              errorMessage: (error) =>
                String(error).replaceAll("fixture-private", "[REDACTED]")
            }
          },
          "org/app",
          41
        )
      ).rejects.toMatchObject({
        status: 403,
        message: expect.stringContaining(
          "grant your OAuth token access. [REDACTED]"
        )
      });
    }
  );

  it("reports truncated jobs as an output limit, not an ordinary HTTP 200 read failure", async () => {
    const run: WorkflowRunner = async (args, options) => {
      if (!args[1].includes("/jobs")) return reply(runData);
      const prefix = 'HTTP/2.0 200 OK\n\r\n{"jobs":[';
      return {
        code: 1,
        stderr: "",
        stdout: prefix.padEnd(options.maxBuffer ?? 0, " ")
      };
    };
    expect(
      await readWorkflowRunWithMetadata({ mode: "ambient", run }, "org/app", 41)
    ).toMatchObject({
      completeness: "status-only",
      reason: "output-limit",
      value: { data: { conclusion: "failure" }, includeJobs: false },
      evidence: [
        { phase: "run" },
        {
          phase: "jobs",
          response: { source: "unavailable", reason: "output-limit" }
        }
      ]
    });
  });
  it.each([
    { code: 1, stdout: "", stderr: "HTTP 401" },
    { code: 1, stdout: "", stderr: "HTTP 403" },
    { code: 1, stdout: "", stderr: "HTTP 404" },
    new Error("HTTP 401"),
    new Error("HTTP 403"),
    new Error("HTTP 404"),
    new SelectedGhAuthorizationError("alice", 404, "denied")
  ])(
    "retains selected auth evidence from an unframed/rejected repository probe",
    async (probe) => {
      const { execution } = scripted([reply({}, 404), probe], true);
      await expect(
        readWorkflowRunWithMetadata(execution, "org/app", 41)
      ).rejects.toBeInstanceOf(SelectedGhAuthorizationError);
    }
  );

  it.each([
    { code: 1, stdout: "", stderr: "ordinary" },
    new Error("ordinary"),
    new Error("HTTP 429"),
    new Error("HTTP 403 Retry-After: 5")
  ])(
    "preserves missing-run uncertainty when the diagnostic probe itself is unavailable",
    async (probe) => {
      const { execution, run } = scripted([new Error("HTTP 404"), probe], true);
      expect(
        await readWorkflowRunWithMetadata(execution, "org/app", 41)
      ).toMatchObject({
        value: null,
        completeness: "unavailable",
        evidence: [{ phase: "repository", response: { source: "unavailable" } }]
      });
      expect(run).toHaveBeenCalledTimes(2);
    }
  );

  it("keeps repository-probe timeout separate from the primary detail deadline", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const run: WorkflowRunner = async (args) =>
      args[1] === "repos/org/app" ? new Promise(() => {}) : reply({}, 404);
    const result = readWorkflowRunWithMetadata(
      {
        mode: "selected",
        executor: { login: "alice", run, errorMessage: String }
      },
      "org/app",
      41
    );
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toMatchObject({
      completeness: "unavailable",
      evidence: [
        { phase: "run" },
        { phase: "repository", response: { reason: "timeout" } }
      ]
    });
  });

  it("does not publish a run that resolves after its deadline", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    let resolve: ((value: WorkflowCommandResult) => void) | undefined;
    const delayed = new Promise<WorkflowCommandResult>((complete) => {
      resolve = complete;
    });
    const run = vi.fn<WorkflowRunner>(() => delayed);
    const result = readWorkflowRunWithMetadata(
      { mode: "ambient", run },
      "org/app",
      41
    );
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toMatchObject({
      completeness: "unavailable",
      reason: "timeout",
      evidence: [{ phase: "run", response: { reason: "timeout" } }]
    });
    if (!resolve) throw new Error("Deferred read not initialized");
    resolve(reply(runData));
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects an unproven numeric-repository continuation", async () => {
    const { execution } = scripted([
      reply({ status: "completed", conclusion: "failure" }),
      reply(
        { total_count: 2, jobs: [job] },
        200,
        'Link: <https://api.github.com/repositories/7/actions/runs/41/jobs?per_page=100&page=2>; rel="next"\r\n'
      )
    ]);
    expect(
      await readWorkflowRunWithMetadata(execution, "org/app", 41)
    ).toMatchObject({ completeness: "status-only", reason: "pagination" });
  });
  it.each([false, true])(
    "normalizes complete run/jobs without Canvas (selected=%s)",
    async (selected) => {
      const { execution, run } = scripted(
        [reply(runData), reply({ jobs: [job], total_count: 1 })],
        selected
      );
      const result = await readWorkflowRunWithMetadata(
        execution,
        "org/app",
        41
      );
      expect(result).toMatchObject({
        completeness: "complete",
        value: {
          data: { status: "completed", conclusion: "failure", jobs: [job] },
          includeJobs: true
        },
        evidence: [
          { phase: "run", response: { status: 200 } },
          { phase: "jobs", response: { status: 200 } }
        ]
      });
      expect(run.mock.calls.map(([args]) => args)).toEqual([
        [
          "api",
          "repos/org/app/actions/runs/41",
          "--include",
          "--method",
          "GET"
        ],
        [
          "api",
          "repos/org/app/actions/runs/41/jobs?per_page=100&page=1",
          "--include",
          "--method",
          "GET"
        ]
      ]);
      expect(run.mock.calls[1][1].maxBuffer).toBeLessThan(
        run.mock.calls[0][1].maxBuffer ?? 0
      );
    }
  );

  it("matches gh's null-conclusion export while leaving unsupported outcomes unconfirmed", async () => {
    const { execution } = scripted([
      reply({ status: "in_progress", conclusion: null }),
      reply({ total_count: 1, jobs: [{ steps: [{ conclusion: null }, {}] }] })
    ]);
    expect(
      await observeWorkflowRun(
        { repo: "org/app", runId: 41 },
        {
          readRun: (repo, runId) => readWorkflowRun(execution, repo, runId)
        }
      )
    ).toEqual({
      status: "in_progress",
      conclusion: "",
      jobs: [
        {
          name: undefined,
          steps: [
            { name: undefined, status: undefined, conclusion: "" },
            { name: undefined, status: undefined, conclusion: undefined }
          ]
        }
      ],
      steps: [
        { name: undefined, status: undefined, conclusion: "" },
        { name: undefined, status: undefined, conclusion: undefined }
      ]
    });
  });

  it.each([null, [], 3])(
    "rejects a non-object run without a second GET: %j",
    async (value) => {
      const { execution, run } = scripted([reply(value)]);
      expect(
        await readWorkflowRunWithMetadata(execution, "org/app", 41)
      ).toMatchObject({
        value: null,
        completeness: "unavailable",
        reason: "invalid-data"
      });
      expect(run).toHaveBeenCalledTimes(1);
    }
  );

  it.each([403, 429, 503])(
    "does not retry a failed run GET (HTTP %i)",
    async (status) => {
      const { execution, run } = scripted([
        reply({}, status, "Retry-After: 60\r\n")
      ]);
      expect(
        await readWorkflowRunWithMetadata(execution, "org/app", 41)
      ).toMatchObject({
        value: null,
        completeness: "unavailable",
        evidence: [{ response: { status } }]
      });
      expect(run).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ["api.github.com/repos/org/app", false],
    ["api.github.com/repositories/7", false],
    ["github.example.test/api/v3/repositories/7", true]
  ])(
    "uses %s pagination only to rebuild the target relative page",
    async (prefix, selected) => {
      const { execution, run } = scripted(
        [
          reply(runData),
          reply(
            { total_count: 2, jobs: [job] },
            200,
            `Link: <https://${prefix}/actions/runs/41/jobs?per_page=100&page=2>; rel="next"\r\n`
          ),
          reply({ total_count: 2, jobs: [{ name: "second" }] })
        ],
        selected
      );
      const result = await readWorkflowRunWithMetadata(
        execution,
        "org/app",
        41
      );
      expect(result.completeness).toBe("complete");
      expect(result.value?.data.jobs).toEqual([
        job,
        { name: "second", steps: [] }
      ]);
      expect(run.mock.calls[2][0][1]).toBe(
        "repos/org/app/actions/runs/41/jobs?per_page=100&page=2"
      );
    }
  );

  it.each([
    'garbage; rel="next"',
    '<not a url>; rel="next"',
    '<http://api.github.com/repos/org/app/actions/runs/41/jobs?per_page=100&page=2>; rel="next"',
    '<https://user:private@api.github.com/repos/org/app/actions/runs/41/jobs?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repos/other/app/actions/runs/41/jobs?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repositories/8/actions/runs/41/jobs?per_page=100&page=2>; rel="next"',
    '<https://api.github.com/repos/org/app/actions/runs/41/jobs?per_page=100&page=1>; rel="next"',
    '<https://api.github.com/repos/org/app/actions/runs/41/jobs?per_page=100&page=2#fragment>; rel="next"',
    '<https://api.github.com/repos/org/app/actions/runs/41/jobs?per_page=100&page=2&extra=value>; rel="next"',
    '<https://api.github.com/repos/org/app/actions/runs/41/jobs?per_page=100&page=2&page=3>; rel="next"',
    '<https://api.github.com/repos/org/app/actions/runs/41/jobs?page=2>; rel="next"',
    '<https://api.github.com/repos/org/app/actions/runs/41/jobs?per_page=1&page=2>; rel="next"',
    '<https://api.github.com/repos/org/app/actions/runs/41/jobs?per_page=100&page=2>; rel="next", <https://example.test>; rel="next"',
    '<https://api.github.com/repos/org/app/actions/runs/41/jobs?per_page=100&page=2>; rel="last"'
  ])("never treats unsafe/missing pagination as complete: %s", async (link) => {
    const { execution, run } = scripted([
      reply(runData),
      reply({ total_count: 2, jobs: [job] }, 200, `Link: ${link}\r\n`)
    ]);
    expect(
      await readWorkflowRunWithMetadata(execution, "org/app", 41)
    ).toMatchObject({
      completeness: "status-only",
      reason: "pagination",
      value: { includeJobs: false }
    });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    null,
    [],
    { jobs: [], total_count: -1 },
    { jobs: [], total_count: 1.1 },
    { jobs: [] },
    { total_count: 0 },
    { jobs: [null], total_count: 1 },
    { jobs: [{ steps: {} }], total_count: 1 },
    { jobs: [{ steps: [null] }], total_count: 1 },
    { jobs: Array.from({ length: 101 }, () => job), total_count: 101 }
  ])("preserves a confirmed run when jobs are invalid: %j", async (jobs) => {
    const { execution } = scripted([reply(runData), reply(jobs)]);
    expect(
      await readWorkflowRunWithMetadata(execution, "org/app", 41)
    ).toMatchObject({
      completeness: "status-only",
      reason: "invalid-data",
      value: { data: { conclusion: "failure" }, includeJobs: false }
    });
  });

  it.each([false, true])(
    "retains jobs failure metadata without downgrading the known run (selected=%s)",
    async (selected) => {
      const { execution } = scripted(
        [reply(runData), reply({ message: "secondary rate limit" }, 403)],
        selected
      );
      expect(
        await readWorkflowRunWithMetadata(execution, "org/app", 41)
      ).toMatchObject({
        completeness: "status-only",
        value: { data: { conclusion: "failure" } },
        evidence: [
          { phase: "run" },
          {
            phase: "jobs",
            response: {
              classification: "rate-limit",
              retryAfter: { state: "absent" }
            }
          }
        ]
      });
    }
  );

  it.each([401, 403, 404])(
    "preserves selected authorization on repository probe HTTP %i",
    async (status) => {
      const { execution, run } = scripted(
        [reply({}, 404), reply({}, status)],
        true
      );
      await expect(
        readWorkflowRunWithMetadata(execution, "org/app", 41)
      ).rejects.toMatchObject({
        name: "SelectedGhAuthorizationError",
        login: "alice",
        status
      });
      expect(run.mock.calls[1][0][1]).toBe("repos/org/app");
    }
  );

  it.each([200, 429, 503])(
    "retains selected missing-run uncertainty with repository response %i",
    async (status) => {
      const { execution } = scripted([reply({}, 404), reply({}, status)], true);
      expect(
        await readWorkflowRunWithMetadata(execution, "org/app", 41)
      ).toMatchObject({
        completeness: "unavailable",
        evidence: [{ phase: "run" }, { phase: "repository" }]
      });
    }
  );

  it.each([401, 403])(
    "does not hide selected jobs authorization HTTP %i behind known run",
    async (status) => {
      const { execution } = scripted([reply(runData), reply({}, status)], true);
      await expect(
        readWorkflowRunWithMetadata(execution, "org/app", 41)
      ).rejects.toBeInstanceOf(SelectedGhAuthorizationError);
    }
  );

  it("keeps selected missing jobs status-only after exactly one selected repository probe", async () => {
    const { execution, run } = scripted(
      [reply(runData), reply({}, 404), reply({})],
      true
    );
    expect(
      await readWorkflowRunWithMetadata(execution, "org/app", 41)
    ).toMatchObject({
      completeness: "status-only",
      value: { data: { conclusion: "failure" } },
      evidence: [{ phase: "run" }, { phase: "jobs" }, { phase: "repository" }]
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("bounds page count without returning a partial jobs inventory", async () => {
    const run = vi.fn<WorkflowRunner>(async (args) => {
      if (!args[1].includes("/jobs")) return reply(runData);
      const page = Number(
        new URL(`https://example.test/${args[1]}`).searchParams.get("page")
      );
      return reply(
        { total_count: 101, jobs: [job] },
        200,
        `Link: <https://api.github.com/repos/org/app/actions/runs/41/jobs?per_page=100&page=${page + 1}>; rel="next"\r\n`
      );
    });
    expect(
      await readWorkflowRunWithMetadata({ mode: "ambient", run }, "org/app", 41)
    ).toMatchObject({ completeness: "status-only", reason: "pagination" });
    expect(run).toHaveBeenCalledTimes(101);
  });

  it.each(["timeout", "output-limit"] as const)(
    "surfaces %s without losing an already read run",
    async (reason) => {
      vi.useFakeTimers({
        toFake: ["performance", "setTimeout", "clearTimeout"]
      });
      const run: WorkflowRunner = async (args) => {
        if (!args[1].includes("/jobs")) return reply(runData);
        if (reason === "output-limit")
          return { code: 0, stdout: "x".repeat(10 * 1024 * 1024), stderr: "" };
        return new Promise(() => {});
      };
      const pending = readWorkflowRunWithMetadata(
        { mode: "ambient", run },
        "org/app",
        41
      );
      await vi.advanceTimersByTimeAsync(15000);
      expect(await pending).toMatchObject({
        completeness: "status-only",
        reason,
        evidence: [
          { phase: "run" },
          { phase: "jobs", response: { source: "unavailable", reason } }
        ]
      });
    }
  );

  it("keeps host preflight outside the logical read budget", async () => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const { execution, run } = scripted(
      [reply({}), reply({ total_count: 0, jobs: [] })],
      true
    );
    if (execution.mode !== "selected")
      throw new Error("expected selected fixture");
    execution.prepare = async () => {
      await vi.advanceTimersByTimeAsync(15000);
    };
    expect(
      (await readWorkflowRunWithMetadata(execution, "org/app", 41)).completeness
    ).toBe("complete");
    expect(run.mock.calls[0][1].timeout).toBe(15000);
  });

  it.each([
    new Error("private failure"),
    new SelectedGhAuthorizationError("alice", 403, "denied")
  ])(
    "preserves unexpected or already classified rejection identity",
    async (error) => {
      const { execution } = scripted([error], true);
      await expect(
        readWorkflowRunWithMetadata(execution, "org/app", 41)
      ).rejects.toBe(error);
    }
  );

  it.each([
    ["../app", 41],
    ["org/app?query", 41],
    ["org/app", 0],
    ["org/app", "4?query"],
    ["org/app", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects invalid targets before I/O", async (repo, runId) => {
    const { execution, run } = scripted([]);
    await expect(
      readWorkflowRunWithMetadata(execution, String(repo), runId)
    ).rejects.toThrow("positive workflow run ID");
    expect(run).not.toHaveBeenCalled();
  });
});
