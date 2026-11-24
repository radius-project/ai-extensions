import { describe, expect, it, vi } from "vitest";
import {
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_GUARD_STEP_NAME
} from "@radius-project/core";
import {
  dispatchSelectedEnvironmentWorkflow,
  findSelectedEnvironmentDispatch,
  proveSelectedEnvironmentGuard,
  readEnvironmentDispatchAttempts,
  selectedEnvironmentDispatchAllowsRetry,
  type EnvironmentDispatchAttempt
} from "./environment-dispatch-evidence.js";

const target = { repo: "octo/shop", environment: "dev", owner: "octocat" };
const updatedAt = "2026-01-02T03:04:06Z";
const attempt: EnvironmentDispatchAttempt = {
  operationAttempt: 0,
  dispatchedAt: Date.parse("2026-01-02T03:04:05.321Z"),
  correlationId: "del-test-fixture",
  branch: "main",
  head: "a".repeat(40),
  state: "unresolved"
};
const runInfo = {
  id: 21,
  display_title: `Radius - Delete Environment dev ${attempt.correlationId}`,
  event: "workflow_dispatch",
  path: `.github/workflows/${DELETE_ENV_DISPATCHER_FILE}`,
  head_branch: "main",
  head_sha: attempt.head,
  actor: { login: "Octocat" },
  created_at: "2026-01-02T03:04:05Z",
  status: "completed",
  conclusion: "failure",
  run_attempt: 2,
  updated_at: updatedAt
};
const step = (name: string, conclusion: string) => ({
  name,
  conclusion,
  status: "completed"
});
const azureJob = {
  name: "Azure / Delete with Radius",
  run_id: 21,
  run_attempt: 2,
  status: "completed",
  conclusion: "failure",
  steps: [
    step(DELETE_ENV_GUARD_STEP_NAME, "failure"),
    step("Delete Radius resource", "skipped"),
    step("Teardown", "success")
  ]
};
function fixture({
  runs = { total_count: 1, workflow_runs: [runInfo] } as unknown,
  jobs = { total_count: 1, jobs: [azureJob] } as unknown,
  latest = runInfo as unknown
} = {}) {
  return vi.fn(async (_args: string[]) => {
    const endpoint = _args[3];
    const payload =
      endpoint.includes("/workflows/") ? runs
      : endpoint.endsWith("/attempts/2/jobs?per_page=100") ? jobs
      : endpoint.endsWith("/actions/runs/21") ? latest
      : undefined;
    if (payload === undefined) throw new Error(`Unexpected read: ${endpoint}`);
    return { code: 0, stdout: JSON.stringify(payload), stderr: "" };
  });
}

describe("selected environment dispatch evidence", () => {
  it.each([
    [
      "GitHub refusal",
      1,
      "HTTP/2.0 422 Unprocessable Entity\r\nX-GitHub-Request-Id: ABC:123\r\n\r\n{}",
      false,
      "refused"
    ],
    [
      "timeout with partial output",
      1,
      "HTTP/2.0 422 Unprocessable Entity\r\nX-GitHub-Request-Id: ABC:123\r\n\r\n{}",
      true,
      "unresolved"
    ],
    [
      "gateway failure",
      1,
      "HTTP/2.0 502 Bad Gateway\r\nX-GitHub-Request-Id: ABC:123\r\n\r\n{}",
      false,
      "unresolved"
    ],
    ["CLI not found", 1, "", false, "unresolved"],
    [
      "accepted without run identity",
      0,
      "HTTP/2.0 204 No Content\r\nX-GitHub-Request-Id: ABC:123\r\n\r\n",
      false,
      "unresolved"
    ]
  ])(
    "classifies %s after one selected POST",
    async (_label, code, stdout, timedOut, state) => {
      const run = vi.fn(async () => ({
        code,
        stdout,
        stderr: "gh: not found",
        timedOut
      }));
      await expect(
        dispatchSelectedEnvironmentWorkflow(
          run,
          target.repo,
          target.environment,
          attempt
        )
      ).resolves.toMatchObject({ state });
      expect(run).toHaveBeenCalledExactlyOnceWith([
        "api",
        "--method",
        "POST",
        "--include",
        `/repos/octo/shop/actions/workflows/${DELETE_ENV_DISPATCHER_FILE}/dispatches`,
        "-f",
        "ref=main",
        "-f",
        "inputs[environment]=dev",
        "-f",
        "inputs[correlation_id]=del-test-fixture"
      ]);
    }
  );

  it.each([
    { total_count: 2, workflow_runs: [runInfo] },
    { total_count: 2, workflow_runs: [runInfo, { ...runInfo, id: 22 }] },
    { total_count: 2, workflow_runs: [runInfo, null] },
    { total_count: 1, workflow_runs: [{ ...runInfo, display_title: null }] },
    { total_count: 1, workflow_runs: [{ ...runInfo, actor: null }] },
    { total_count: 1, workflow_runs: [{ ...runInfo, actor: { login: null } }] },
    { total_count: 1, workflow_runs: [{ ...runInfo, head_branch: "other" }] },
    {
      total_count: 1,
      workflow_runs: [{ ...runInfo, actor: { login: "another-user" } }]
    },
    {
      total_count: 1,
      workflow_runs: [{ ...runInfo, head_sha: "b".repeat(40) }]
    },
    {
      total_count: 1,
      workflow_runs: [
        {
          ...runInfo,
          display_title: `Radius - Delete Environment prod ${attempt.correlationId}`
        }
      ]
    },
    {
      total_count: 1,
      workflow_runs: [{ ...runInfo, created_at: "2026-01-02T03:04:04Z" }]
    }
  ])("refuses incomplete or mismatched run evidence %#", async (runs) => {
    await expect(
      findSelectedEnvironmentDispatch(fixture({ runs }), target, attempt)
    ).resolves.toBeNull();
  });

  it("does not correlate a run if GitHub returns truncated JSON", async () => {
    const run = vi.fn(async () => ({
      code: 0,
      stdout: '{"total_count":1,"workflow_runs":[',
      stderr: ""
    }));
    await expect(
      findSelectedEnvironmentDispatch(run, target, attempt)
    ).resolves.toBeNull();
  });

  it("proves the exact latest attempt stopped at the guard without deleting resources", async () => {
    const run = fixture();
    const guarded = {
      ...attempt,
      state: "guarded",
      runId: 21,
      runAttempt: 2,
      updatedAt
    };
    await expect(
      proveSelectedEnvironmentGuard(run, target, attempt)
    ).resolves.toEqual(guarded);
    expect(readEnvironmentDispatchAttempts([guarded])).toEqual([guarded]);
    expect(
      readEnvironmentDispatchAttempts([{ ...guarded, runAttempt: 0 }])
    ).toBeNull();
    expect(
      readEnvironmentDispatchAttempts([{ ...guarded, updatedAt: "invalid" }])
    ).toBeNull();
    expect(run).toHaveBeenNthCalledWith(2, [
      "api",
      "--method",
      "GET",
      "/repos/octo/shop/actions/runs/21/attempts/2/jobs?per_page=100"
    ]);
  });

  it.each([
    {
      runs: {
        total_count: 1,
        workflow_runs: [{ ...runInfo, status: "queued" }]
      }
    },
    { jobs: { total_count: 2, jobs: [azureJob] } },
    { jobs: { total_count: 1, jobs: [{ ...azureJob, name: "Other job" }] } },
    { jobs: { total_count: 2, jobs: [azureJob, azureJob] } },
    { jobs: { total_count: 1, jobs: [{ ...azureJob, run_attempt: 1 }] } },
    { jobs: { total_count: 1, jobs: [{ ...azureJob, steps: null }] } },
    {
      jobs: {
        total_count: 1,
        jobs: [
          {
            ...azureJob,
            steps: [...azureJob.steps.slice(0, 2), step("Teardown", "failure")]
          }
        ]
      }
    },
    {
      jobs: {
        total_count: 1,
        jobs: [
          {
            ...azureJob,
            steps: [
              azureJob.steps[0],
              step("Delete Radius resource", "success"),
              azureJob.steps[2]
            ]
          }
        ]
      }
    },
    { latest: { ...runInfo, run_attempt: 3, status: "in_progress" } }
  ])(
    "refuses incomplete, destructive, or superseded guard evidence %#",
    async (data) => {
      await expect(
        proveSelectedEnvironmentGuard(fixture(data), target, attempt)
      ).resolves.toBeNull();
    }
  );

  it("uses legacy time and correlation to observe a run without manufacturing retry evidence", async () => {
    const { dispatchedAt, correlationId } = attempt;
    await expect(
      findSelectedEnvironmentDispatch(fixture(), target, {
        dispatchedAt,
        correlationId
      })
    ).resolves.toMatchObject({ runId: 21 });
    expect(
      selectedEnvironmentDispatchAllowsRetry({
        selectedDispatchStarted: true,
        selectedDispatchTime: dispatchedAt,
        selectedDispatchCorrelation: correlationId
      })
    ).toBe(false);
  });

  it.each([
    { code: 1, stdout: "", stderr: "access unavailable" },
    { code: 0, stdout: "{invalid", stderr: "" }
  ])("returns no evidence when the GitHub read failed %#", async (result) => {
    await expect(
      findSelectedEnvironmentDispatch(async () => result, target, attempt)
    ).resolves.toBeNull();
  });

  it("preserves prior provably safe generations and blocks unknown or malformed history", () => {
    const refused = { ...attempt, state: "refused" };
    const following = {
      ...attempt,
      operationAttempt: 1,
      correlationId: "del-test-second"
    };
    expect(readEnvironmentDispatchAttempts([refused, following])).toEqual([
      refused,
      following
    ]);
    expect(readEnvironmentDispatchAttempts([attempt, following])).toBeNull();
    expect(readEnvironmentDispatchAttempts([refused, attempt])).toBeNull();
    expect(
      readEnvironmentDispatchAttempts([
        { ...refused, dispatchedAt: Number.MAX_SAFE_INTEGER }
      ])
    ).toBeNull();
    expect(
      selectedEnvironmentDispatchAllowsRetry({
        selectedDispatchAttempts: [refused]
      })
    ).toBe(true);
    expect(
      selectedEnvironmentDispatchAllowsRetry({
        selectedDispatchAttempts: [attempt]
      })
    ).toBe(false);
    expect(
      selectedEnvironmentDispatchAllowsRetry({ selectedDispatchAttempts: null })
    ).toBe(false);
    expect(
      selectedEnvironmentDispatchAllowsRetry({ selectedDispatchStarted: true })
    ).toBe(false);
    expect(
      selectedEnvironmentDispatchAllowsRetry({
        selectedDispatchStarted: false,
        selectedDispatchTime: "bad"
      })
    ).toBe(false);
  });
});
