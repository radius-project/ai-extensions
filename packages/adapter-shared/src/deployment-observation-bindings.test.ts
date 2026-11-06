import { ChildProcess } from "node:child_process";
import {
  createWorkflowReadSession,
  readWorkflowRun,
  type WorkflowRunner
} from "@radius-project/adapter-shared";
import { observeWorkflowRun, redactCredentials } from "@radius-project/core";
import { workflowObservationCases } from "@radius-project/adapter-shared/test-support/workflow-observation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSelectedGhAuthorizationError } from "./workflow-reads.js";
import {
  createDeploymentObservationBindings,
  type DeploymentObservationExecutor,
  type DeploymentSelectedWorkflowExecutor
} from "./deployment-observation-bindings.js";

const gh: { cliExec: DeploymentObservationExecutor } = {
  cliExec: () => {
    throw new Error("Unexpected ambient CLI invocation");
  }
};
const {
  findWorkflowRun,
  fetchRunLog,
  ghJson,
  getRunDetail,
  latestWorkflowRunId
} = createDeploymentObservationBindings({
  execute: (...args) => gh.cliExec(...args),
  redactDiagnostic: redactCredentials
});

function successfulSelectedGhExecutor(options: {
  login?: string;
  run: WorkflowRunner;
}): DeploymentSelectedWorkflowExecutor {
  return {
    login: options.login ?? "octocat",
    run: options.run,
    verifyIdentity: async () => {},
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  };
}

describe.each(["ambient", "selected"] as const)(
  "%s bound/direct observation parity",
  (mode) => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_700_000_000_000);
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });
    it.each(workflowObservationCases)(
      "preserves $name evidence and exact read effects",
      async (scenario) => {
        const paths = [
          "repos/org/app/actions/runs/41",
          "repos/org/app/actions/runs/41/jobs?per_page=100&page=1",
          ...((
            scenario.status === "waiting" && scenario.jobsTotal === undefined
          ) ?
            ["repos/org/app/actions/runs/41/pending_deployments"]
          : [])
        ];
        function runner() {
          let index = 0;
          return vi.fn<WorkflowRunner>(async (args) => {
            expect(args).toEqual([
              "api",
              paths[index++],
              "--include",
              "--method",
              "GET"
            ]);
            const status =
              args[1].endsWith("pending_deployments") ?
                scenario.protectionStatus
              : 200;
            const value =
              args[1].endsWith("pending_deployments") ? scenario.pending
              : args[1].includes("/jobs") ?
                {
                  total_count: scenario.jobsTotal ?? scenario.jobs.length,
                  jobs: scenario.jobs
                }
              : { status: scenario.status, conclusion: scenario.conclusion };
            return {
              code: status === 200 ? 0 : 1,
              stderr: "",
              stdout: `HTTP/2 ${status}\n\n${JSON.stringify(value)}`
            };
          });
        }
        const directRun = runner();
        const direct = await observeWorkflowRun(
          { repo: "org/app", runId: 41 },
          {
            readRun: (repo, runId) =>
              readWorkflowRun(
                mode === "ambient" ?
                  { mode, run: directRun }
                : {
                    mode,
                    executor: successfulSelectedGhExecutor({ run: directRun })
                  },
                repo,
                runId,
                undefined,
                { includeProtection: true }
              )
          }
        );
        const canvasRun = runner();
        if (mode === "ambient")
          vi.spyOn(gh, "cliExec").mockImplementation(
            (command, args, options, callback) => {
              expect(command).toBe("gh");
              void canvasRun(args, {
                ...options,
                timeout: options.timeout ?? 15000
              }).then((result) =>
                callback(
                  Number(result.code) === 0 ? null : (
                    new Error("HTTP " + scenario.protectionStatus)
                  ),
                  result.stdout,
                  result.stderr
                )
              );
              return new ChildProcess();
            }
          );
        const canvas = await getRunDetail(
          "org/app",
          41,
          mode === "selected" ?
            successfulSelectedGhExecutor({ run: canvasRun })
          : undefined,
          undefined,
          { includeProtection: true }
        );
        expect(canvas).toEqual(direct);
        expect(canvasRun.mock.calls.map(([args]) => args)).toEqual(
          directRun.mock.calls.map(([args]) => args)
        );
        expect(canvasRun).toHaveBeenCalledTimes(paths.length);
        expect(canvas?.protection?.state).toBe(scenario.protectionState);
      }
    );
    it.each(["retry", "cooldown", "cancelled"] as const)(
      "preserves request-bearing %s policy through the shared binding",
      async (scenario) => {
        async function observe(canvas: boolean) {
          let now = 0;
          let pendingReads = 0;
          let decisions = 0;
          const controller = new AbortController();
          const session = createWorkflowReadSession({
            monotonic: () => now,
            wall: () => 1_700_000_000_000 + now,
            sleep: async (milliseconds) => {
              now += milliseconds;
            },
            jitter: () => 0
          });
          const run = vi.fn<WorkflowRunner>(async (args) => {
            expect(args[0]).toBe("api");
            expect(args.slice(2)).toEqual(["--include", "--method", "GET"]);
            let status = 200;
            let headers = "";
            let value: unknown;
            if (args[1].endsWith("/pending_deployments")) {
              pendingReads++;
              status =
                scenario === "cooldown" ? 429
                : pendingReads === 1 ? 503
                : 200;
              headers = status === 429 ? "retry-after: 60\n" : "";
              value = status === 200 ? [] : { message: "Unavailable" };
            } else if (args[1].endsWith("/jobs?per_page=100&page=1")) {
              value = { jobs: [], total_count: 0 };
            } else {
              expect(args[1]).toBe("repos/org/app/actions/runs/41");
              value = { status: "waiting", conclusion: null };
            }
            return {
              code: status === 200 ? 0 : 1,
              stderr: "",
              stdout: `HTTP/2 ${status}\n${headers}\n${JSON.stringify(value)}`
            };
          });
          if (canvas && mode === "ambient")
            vi.spyOn(gh, "cliExec").mockImplementation(
              (_command, args, options, callback) => {
                void run(args, {
                  ...options,
                  timeout: options.timeout ?? 15000
                }).then((result) =>
                  callback(
                    Number(result.code) === 0 ? null : (
                      new Error("Fixture read failed")
                    ),
                    result.stdout,
                    result.stderr
                  )
                );
                return new ChildProcess();
              }
            );
          const executor = successfulSelectedGhExecutor({ run });
          const read = () => {
            const request = {
              identity: mode,
              context: session.observe(30000, controller.signal),
              onDecision: () => {
                if (++decisions === 2 && scenario === "cancelled")
                  controller.abort();
              }
            };
            return canvas ?
                getRunDetail(
                  "org/app",
                  41,
                  mode === "selected" ? executor : undefined,
                  request,
                  { includeProtection: true }
                )
              : observeWorkflowRun(
                  { repo: "org/app", runId: 41 },
                  {
                    readRun: (repo, runId) =>
                      readWorkflowRun(
                        mode === "selected" ?
                          { mode, executor }
                        : { mode, run },
                        repo,
                        runId,
                        request,
                        { includeProtection: true }
                      )
                  }
                );
          };
          const first = await read();
          now += 5000;
          const second = scenario === "cooldown" ? await read() : null;
          return {
            first,
            second,
            calls: run.mock.calls.map(([args]) => args),
            pendingReads
          };
        }
        const direct = await observe(false);
        const canvas = await observe(true);
        expect(canvas).toEqual(direct);
        expect(canvas.pendingReads).toBe(
          scenario === "cancelled" ? 0
          : scenario === "retry" ? 2
          : 1
        );
        expect(canvas.first?.protection).toMatchObject(
          scenario === "retry" ?
            { state: "observed" }
          : {
              state: "unavailable",
              reason: scenario === "cooldown" ? "deferred" : "cancelled"
            }
        );
      }
    );
  }
);

describe("ambient workflow callback binding", () => {
  beforeEach(() => {
    vi.spyOn(gh, "cliExec").mockImplementation(() => {
      throw new Error("Unexpected ambient CLI invocation");
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const detailArgs = [
    "api",
    "repos/contoso/store/actions/runs/41",
    "--include",
    "--method",
    "GET"
  ];
  const jobsArgs = [
    "api",
    "repos/contoso/store/actions/runs/41/jobs?per_page=100&page=1",
    "--include",
    "--method",
    "GET"
  ];

  it("propagates jobs cancellation through the callback wrapper without losing the confirmed run", async () => {
    const controller = new AbortController();
    const onDecision = vi.fn();
    vi.mocked(gh.cliExec).mockImplementation((_cmd, args, options, cb) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      queueMicrotask(() => {
        if (args[1].includes("/jobs")) controller.abort();
        cb(
          null,
          'HTTP/2 200\n\n{"status":"completed","conclusion":"failure"}',
          ""
        );
      });
      return new ChildProcess();
    });
    await expect(
      getRunDetail("contoso/store", 41, undefined, {
        context: createWorkflowReadSession().observe(1000, controller.signal),
        identity: "ambient",
        onDecision
      })
    ).resolves.toMatchObject({
      status: "completed",
      conclusion: "failure",
      jobs: []
    });
    expect(onDecision.mock.calls.map(([decision]) => decision)).toEqual([
      { state: "ready" },
      { state: "stopped", reason: "cancelled" }
    ]);
    expect(gh.cliExec).toHaveBeenCalledTimes(2);
    expect(vi.mocked(gh.cliExec).mock.calls[1][2].signal?.aborted).toBe(true);
  });

  it("reads and normalizes ambient run details from callback stdout", async () => {
    const steps = [
      { name: "Deploy", status: "completed", conclusion: "failure" }
    ];
    const jobs = [{ name: "deploy", steps }];
    vi.mocked(gh.cliExec).mockImplementation((_cmd, args, opts, cb) => {
      expect(opts.timeout).toBeGreaterThan(0);
      expect(opts.timeout).toBeLessThanOrEqual(15000);
      queueMicrotask(() =>
        cb(
          null,
          "HTTP/2 200\n\n" +
            JSON.stringify(
              args[1].includes("/jobs") ?
                { jobs, total_count: 1 }
              : { status: "completed", conclusion: "failure" }
            ),
          "diagnostic stderr is not run JSON"
        )
      );
      return new ChildProcess();
    });

    await expect(getRunDetail("contoso/store", 41)).resolves.toEqual({
      status: "completed",
      conclusion: "failure",
      jobs,
      steps
    });
    expect(vi.mocked(gh.cliExec).mock.calls.map((call) => call[1])).toEqual([
      detailArgs,
      jobsArgs
    ]);
  });

  it("preserves the known run without retrying jobs for a legacy caller", async () => {
    vi.mocked(gh.cliExec)
      .mockImplementationOnce((_cmd, _args, _opts, cb) => {
        queueMicrotask(() =>
          cb(
            null,
            'HTTP/2 200\n\n{"status":"in_progress","conclusion":null}',
            ""
          )
        );
        return new ChildProcess();
      })
      .mockImplementation((_cmd, args, _opts, cb) => {
        expect(args).toEqual(jobsArgs);
        queueMicrotask(() =>
          cb(new Error("jobs unavailable"), "HTTP/2 503\n\n{}", "")
        );
        return new ChildProcess();
      });

    await expect(getRunDetail("contoso/store", "41")).resolves.toEqual({
      status: "in_progress",
      conclusion: "",
      jobs: [],
      steps: []
    });
    expect(vi.mocked(gh.cliExec).mock.calls.map((call) => call[1])).toEqual([
      detailArgs,
      jobsArgs
    ]);
  });

  it("returns unavailable detail after one failed callback without retry or selected-account probe", async () => {
    const fail: typeof gh.cliExec = (_cmd, _args, _opts, cb) => {
      queueMicrotask(() =>
        cb(
          new Error("run unavailable"),
          '{"status":"completed","conclusion":"success"}',
          "gh: Not Found (HTTP 404)"
        )
      );
      return new ChildProcess();
    };
    vi.mocked(gh.cliExec)
      .mockImplementationOnce(fail)
      .mockImplementationOnce(fail);

    await expect(getRunDetail("contoso/store", "41")).resolves.toBeNull();
    expect(vi.mocked(gh.cliExec).mock.calls.map((call) => call[1])).toEqual([
      detailArgs
    ]);
  });

  it.each([
    {
      name: "preserves successful log stdout",
      error: null,
      stdout: "  workflow output: HTTP 401\n",
      stderr: "CLI warning",
      expected: "  workflow output: HTTP 401\n"
    },
    {
      name: "returns unavailable for empty stdout",
      error: null,
      stdout: "",
      stderr: "stderr is not workflow output",
      expected: null
    },
    {
      name: "discards partial stdout on callback error",
      error: new Error("log read failed"),
      stdout: "partial workflow output",
      stderr: "gh: Not Found (HTTP 404)",
      expected: null
    }
  ])(
    "$name without a selected-account probe",
    async ({ error, stdout, stderr, expected }) => {
      vi.mocked(gh.cliExec).mockImplementationOnce((_cmd, _args, _opts, cb) => {
        queueMicrotask(() => cb(error, stdout, stderr));
        return new ChildProcess();
      });

      await expect(fetchRunLog("contoso/store", 41)).resolves.toBe(expected);
      expect(gh.cliExec).toHaveBeenCalledExactlyOnceWith(
        "gh",
        ["run", "view", "41", "--log", "--repo", "contoso/store"],
        {
          timeout: expect.any(Number),
          maxBuffer: 20 * 1024 * 1024,
          signal: expect.any(AbortSignal)
        },
        expect.any(Function)
      );
      expect(vi.mocked(gh.cliExec).mock.calls[0][2].timeout).toBeGreaterThan(0);
      expect(
        vi.mocked(gh.cliExec).mock.calls[0][2].timeout
      ).toBeLessThanOrEqual(30000);
    }
  );
});

describe("ambient workflow discovery parsing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses trimmed JSON with the requested timeout", async () => {
    vi.spyOn(gh, "cliExec").mockImplementation(
      (command, args, options, callback) => {
        expect(command).toBe("gh");
        expect(args).toEqual(["run", "list"]);
        expect(options).toEqual({ timeout: 4321 });
        queueMicrotask(() => callback(null, '  {"status":"queued"} \n', ""));
        return new ChildProcess();
      }
    );

    await expect(ghJson(["run", "list"], null, 4321)).resolves.toEqual({
      status: "queued"
    });
  });

  it.each([
    {
      name: "CLI failure",
      error: new Error("gh unavailable"),
      stdout: '{"status":"completed"}'
    },
    {
      name: "malformed JSON",
      error: null,
      stdout: '{"status":'
    }
  ])("returns the caller fallback for $name", async ({ error, stdout }) => {
    vi.spyOn(gh, "cliExec").mockImplementation(
      (_command, _args, _options, callback) => {
        queueMicrotask(() => callback(error, stdout, ""));
        return new ChildProcess();
      }
    );
    const fallback = { status: "unavailable" };

    await expect(ghJson(["run", "list"], fallback)).resolves.toBe(fallback);
  });

  it("finds the greatest numeric run id while ignoring malformed run fields", async () => {
    vi.spyOn(gh, "cliExec").mockImplementation(
      (_command, _args, _options, callback) => {
        queueMicrotask(() =>
          callback(
            null,
            JSON.stringify([
              null,
              [],
              "not-a-run",
              {
                databaseId: "12",
                createdAt: 7,
                status: false,
                conclusion: false,
                displayTitle: 9
              },
              {
                databaseId: 4,
                createdAt: "2026-10-15T12:00:00Z",
                status: "completed",
                conclusion: null,
                displayTitle: "older"
              },
              { databaseId: 11, conclusion: "success" },
              { databaseId: 8 }
            ]),
            ""
          )
        );
        return new ChildProcess();
      }
    );

    await expect(
      latestWorkflowRunId("contoso/store", "deploy.yml")
    ).resolves.toBe(11);
    expect(gh.cliExec).toHaveBeenCalledWith(
      "gh",
      [
        "run",
        "list",
        "--workflow=deploy.yml",
        "--limit",
        "20",
        "--json",
        "databaseId,createdAt",
        "--repo",
        "contoso/store"
      ],
      { timeout: 15000 },
      expect.any(Function)
    );
  });

  it("returns no latest run when GitHub returns a valid non-list payload", async () => {
    vi.spyOn(gh, "cliExec").mockImplementation(
      (_command, _args, _options, callback) => {
        queueMicrotask(() => callback(null, '{"message":"unexpected"}', ""));
        return new ChildProcess();
      }
    );

    await expect(
      latestWorkflowRunId("contoso/store", "deploy.yml")
    ).resolves.toBeNull();
  });

  it("returns a known run id without reading GitHub", async () => {
    const cli = vi.spyOn(gh, "cliExec");

    await expect(
      findWorkflowRun("contoso/store", "deploy.yml", Date.now(), "known-run")
    ).resolves.toBe("known-run");
    expect(cli).not.toHaveBeenCalled();
  });
});

describe("selected-account workflow discovery", () => {
  it.each(["ambient", "selected"] as const)(
    "discovers the correlated run through %s execution without crossing credential sources",
    async (mode) => {
      const payload = JSON.stringify([
        {
          databaseId: 43,
          createdAt: "2026-01-01T00:00:01Z",
          displayTitle: "other request"
        },
        {
          databaseId: 42,
          createdAt: "2026-01-01T00:00:00Z",
          displayTitle: "Radius deploy correlation-42"
        }
      ]);
      const execute = vi.fn<DeploymentObservationExecutor>(
        (_command, _args, _options, callback) => callback(null, payload, "")
      );
      const selectedRun = vi.fn<WorkflowRunner>(async () => ({
        code: 0,
        stdout: payload,
        stderr: ""
      }));
      const bound = createDeploymentObservationBindings({
        execute,
        redactDiagnostic: redactCredentials
      });
      expect(
        await bound.findWorkflowRun(
          "org/app",
          "deploy.yml",
          Date.parse("2026-01-01T00:00:00Z"),
          undefined,
          mode === "selected" ?
            successfulSelectedGhExecutor({ run: selectedRun })
          : undefined,
          undefined,
          "correlation-42"
        )
      ).toBe(42);
      const args = [
        "run",
        "list",
        "--workflow=deploy.yml",
        "--limit",
        "5",
        "--json",
        "databaseId,status,createdAt,displayTitle",
        "--repo",
        "org/app"
      ];
      if (mode === "ambient") {
        expect(execute).toHaveBeenCalledExactlyOnceWith(
          "gh",
          args,
          { timeout: 15000 },
          expect.any(Function)
        );
        expect(selectedRun).not.toHaveBeenCalled();
      } else {
        expect(selectedRun.mock.calls[0][0]).toEqual(args);
        expect(execute).not.toHaveBeenCalled();
      }
    }
  );

  it.each([["run discovery", 401, "gh: Unauthorized (HTTP 401)", "list"]])(
    "surfaces %s HTTP %i instead of degrading to pending",
    async (_label, status, stderr, operation) => {
      const calls: string[][] = [];
      const executor = successfulSelectedGhExecutor({
        login: "alice",
        run: async (args) => {
          calls.push(args);
          return { code: 1, stdout: "", stderr };
        }
      });

      const attempt =
        operation === "list" ?
          findWorkflowRun(
            "contoso/store",
            "verify.yml",
            Date.now(),
            null,
            executor
          )
        : getRunDetail("contoso/store", "41", executor);

      const error = await attempt.catch((reason: unknown) => reason);
      expect(error).toMatchObject({
        name: "SelectedGhAuthorizationError",
        login: "alice",
        status
      });
      expect(isSelectedGhAuthorizationError(error)).toBe(true);
      expect(calls).toHaveLength(1);
    }
  );

  it("keeps transient selected-account run discovery pollable", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "gh: Service Unavailable (HTTP 503)"
      })
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).resolves.toBeNull();
  });

  it.each([
    ["retry-after", "gh: Forbidden (HTTP 403)\nRetry-After: 60"],
    [
      "exhausted primary limit",
      "gh: API rate limit exceeded (HTTP 403)\nX-RateLimit-Remaining: 0"
    ],
    [
      "secondary limit",
      "gh: You have exceeded a secondary rate limit (HTTP 403)"
    ],
    [
      "reset guidance",
      "gh: rate limit reached (HTTP 403); retry when the limit resets"
    ],
    ["too many requests", "gh: Too Many Requests (HTTP 429)"]
  ])("keeps selected-account %s responses pollable", async (_label, stderr) => {
    let calls = 0;
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async () => {
        calls += 1;
        return { code: 1, stdout: "", stderr };
      }
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it("terminalizes a masked private-repository 404 after the selected account loses repository access", async () => {
    const calls: string[][] = [];
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) => {
        calls.push(args);
        return {
          code: 1,
          stdout: "",
          stderr: "gh: Not Found (HTTP 404)"
        };
      }
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).rejects.toMatchObject({
      name: "SelectedGhAuthorizationError",
      login: "alice",
      status: 404
    });
    expect(calls.map((args) => args[0])).toEqual(["run", "api"]);
    expect(calls[1]).toEqual([
      "api",
      "repos/contoso/store",
      "--jq",
      ".full_name"
    ]);
  });

  it("keeps a masked run 404 pending when its repository probe is rate-limited", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: async (args) =>
        args[0] === "api" ?
          {
            code: 1,
            stdout: "",
            stderr:
              "gh: You have exceeded a secondary rate limit (HTTP 403)\nRetry-After: 60"
          }
        : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).resolves.toBeNull();
  });

  it.each([["run discovery", 401, "list"]])(
    "surfaces rejected selected-account %s identity check HTTP %i",
    async (_label, status, operation) => {
      const executor = successfulSelectedGhExecutor({
        login: "alice",
        run: () =>
          Promise.reject(
            new Error(
              `GitHub identity verification failed for @alice: gh: access rejected (HTTP ${status})`
            )
          )
      });

      const attempt =
        operation === "list" ?
          findWorkflowRun(
            "contoso/store",
            "verify.yml",
            Date.now(),
            null,
            executor
          )
        : getRunDetail("contoso/store", "41", executor);
      const error = await attempt.catch((reason: unknown) => reason);

      expect(error).toMatchObject({
        name: "SelectedGhAuthorizationError",
        login: "alice",
        status
      });
    }
  );

  it("leaves a rejected transient selected-account identity check pollable", async () => {
    const executor = successfulSelectedGhExecutor({
      login: "alice",
      run: () =>
        Promise.reject(
          new Error(
            "GitHub identity verification failed for @alice: gh: Service Unavailable (HTTP 503)"
          )
        )
    });

    await expect(
      findWorkflowRun("contoso/store", "verify.yml", Date.now(), null, executor)
    ).rejects.toThrow("HTTP 503");
  });
});
