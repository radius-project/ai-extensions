import { describe, expect, it, vi } from "vitest";
import {
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_GUARD_STEP_NAME
} from "@radius-project/core";
import type { GhCommandResult } from "./gh-command-result.js";
import type { EnvironmentDispatchAttempt } from "./environment-dispatch-evidence.js";
import {
  createRadiusEnvironmentWorkflowDeletion,
  type RadiusEnvironmentWorkflowDeletionDependencies
} from "./radius-environment-workflow-deletion.js";

const REPO = "octo/shop";
const HEAD = "a".repeat(40);
const FILES = [
  "delete-environment.yml",
  "delete-environment-azure.yml",
  "delete-environment-aws.yml"
];
const TEMPLATES = Object.fromEntries(
  FILES.map((file) => [file, `body of ${file}`])
);
const ok = (stdout = ""): GhCommandResult => ({ code: 0, stdout, stderr: "" });
const failed = (stderr: string, timedOut = false): GhCommandResult => ({
  code: 1,
  stdout: "",
  stderr,
  ...(timedOut ? { timedOut: true } : {})
});

// A repository whose default branch already holds every workflow, a dispatch
// GitHub accepts, a run it finds, and a run that completes successfully.
function harness(
  overrides: Partial<
    Omit<
      RadiusEnvironmentWorkflowDeletionDependencies,
      | "readIdentity"
      | "getBranchHead"
      | "beforeDispatch"
      | "recoverDispatch"
      | "selectedAttempts"
    >
  > = {},
  options: {
    dispatch?: GhCommandResult[];
    runs?: Array<string | null>;
    selected?: Pick<
      Extract<
        RadiusEnvironmentWorkflowDeletionDependencies,
        { readIdentity: "selected" }
      >,
      | "getBranchHead"
      | "beforeDispatch"
      | "recoverDispatch"
      | "selectedAttempts"
    >;
  } = {}
) {
  let clock = 1_000_000;
  const dispatch = options.dispatch ?? [ok()];
  const runs = options.runs ?? ["99"];
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const base: Omit<
    RadiusEnvironmentWorkflowDeletionDependencies,
    | "readIdentity"
    | "getBranchHead"
    | "beforeDispatch"
    | "recoverDispatch"
    | "selectedAttempts"
  > = {
    workflowFiles: FILES,
    ensureWorkflowsCurrent: vi.fn(async () => ({ created: [] })),
    generateDeleteWorkflow: vi.fn(async () => TEMPLATES),
    getDefaultBranch: vi.fn(async () => "main"),
    fetchFileFromRepo: vi.fn(
      async (_repo: string, path: string) =>
        TEMPLATES[path.split("/").pop() ?? ""] ?? null
    ),
    runGh: vi.fn(async (args: string[]) => {
      calls.push(args);
      return dispatch.length > 1 ? dispatch.shift()! : dispatch[0]!;
    }),
    processEnv: {},
    findWorkflowRun: vi.fn(async () =>
      runs.length > 1 ? runs.shift()! : runs[0]!
    ),
    getRunDetail: vi.fn(async () => ({
      status: "completed",
      conclusion: "success",
      steps: []
    })),
    sleep: vi.fn(async (milliseconds: number) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    }),
    now: () => clock,
    random: () => 0.5,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error),
    ...overrides
  };
  const dependencies: RadiusEnvironmentWorkflowDeletionDependencies =
    options.selected ?
      { ...base, readIdentity: "selected", ...options.selected }
    : base;
  return {
    dependencies,
    calls,
    sleeps,
    run: (onHeartbeat?: () => void | Promise<void>) =>
      createRadiusEnvironmentWorkflowDeletion(dependencies)(
        { repo: REPO, environment: "dev" },
        onHeartbeat
      )
  };
}

describe("deleting a Radius environment through its workflow", () => {
  it("does not redispatch after restart if a refusal was saved before that operation attempt finished", async () => {
    const attempt: EnvironmentDispatchAttempt = {
      state: "refused",
      operationAttempt: 1,
      dispatchedAt: 1_000_000,
      correlationId: "del-test-fixture",
      branch: "main",
      head: HEAD
    };
    const runGh = vi.fn(async () => {
      throw new Error("Unexpected GitHub request");
    });
    const h = harness(
      { runGh },
      {
        selected: {
          getBranchHead: async () => HEAD,
          beforeDispatch: async () => {
            throw new Error("Unexpected legacy dispatch");
          },
          selectedAttempts: {
            owner: "octocat",
            operationAttempt: () => 1,
            latest: () => attempt,
            begin: async () => {
              throw new Error("Unexpected new attempt");
            },
            record: async () => {
              throw new Error("Unexpected outcome");
            }
          }
        }
      }
    );
    await expect(h.run()).resolves.toMatchObject({
      outcome: "failed",
      detail: expect.stringContaining("Confirm a retry")
    });
    expect(runGh).not.toHaveBeenCalled();
  });

  it("persists one selected dispatch before POST and stops on a definitive refusal", async () => {
    const calls: string[] = [];
    const begin = vi.fn(async (_attempt: EnvironmentDispatchAttempt) => {
      calls.push("claim");
    });
    const record = vi.fn(async (_attempt: EnvironmentDispatchAttempt) => {
      calls.push("record");
    });
    const runGh = vi.fn(async (args: string[]) => {
      expect(args.slice(0, 3)).toEqual(["api", "--method", "POST"]);
      calls.push("post");
      return {
        code: 1,
        stderr: "gh: not found",
        stdout:
          "HTTP/2.0 404 Not Found\r\nX-GitHub-Request-Id: ABC:123\r\n\r\n{}"
      };
    });
    const h = harness(
      { runGh, ensureWorkflowsCurrent: async () => ({ created: FILES }) },
      {
        selected: {
          getBranchHead: async () => HEAD,
          beforeDispatch: async () => {
            throw new Error("Legacy dispatch bypass");
          },
          selectedAttempts: {
            owner: "octocat",
            operationAttempt: () => 0,
            latest: () => undefined,
            begin,
            record
          }
        }
      }
    );
    expect(await h.run()).toMatchObject({ outcome: "failed" });
    expect(calls).toEqual(["claim", "post", "record"]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ state: "refused" })
    );
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it("does not POST when the selected dispatch claim cannot be persisted", async () => {
    const runGh = vi.fn(async () => {
      throw new Error("Unexpected GitHub request");
    });
    const h = harness(
      { runGh },
      {
        selected: {
          getBranchHead: async () => HEAD,
          beforeDispatch: async () => {
            throw new Error("Legacy dispatch bypass");
          },
          selectedAttempts: {
            owner: "octocat",
            operationAttempt: () => 0,
            latest: () => undefined,
            begin: async () => {
              throw new Error("Durable claim failed");
            },
            record: async () => {
              throw new Error("Unexpected saved outcome");
            }
          }
        }
      }
    );
    await expect(h.run()).rejects.toThrow("Durable claim failed");
    expect(runGh).not.toHaveBeenCalled();
  });

  it("observes an unresolved saved attempt without sending a second request", async () => {
    const attempt: EnvironmentDispatchAttempt = {
      operationAttempt: 0,
      dispatchedAt: 1_000_000,
      correlationId: "del-test-fixture",
      branch: "main",
      head: HEAD,
      state: "unresolved"
    };
    const runGh = vi.fn(async (args: string[]) => {
      expect(args.slice(0, 3)).toEqual(["api", "--method", "GET"]);
      return ok(
        JSON.stringify({
          total_count: 1,
          workflow_runs: [
            {
              id: 21,
              display_title: `Radius - Delete Environment dev ${attempt.correlationId}`,
              event: "workflow_dispatch",
              path: `.github/workflows/${DELETE_ENV_DISPATCHER_FILE}`,
              head_branch: "main",
              head_sha: HEAD,
              actor: { login: "octocat" },
              created_at: new Date(attempt.dispatchedAt).toISOString(),
              updated_at: new Date(attempt.dispatchedAt + 5000).toISOString(),
              run_attempt: 1,
              status: "completed",
              conclusion: "success"
            }
          ]
        })
      );
    });
    const record = vi.fn(async (_attempt: EnvironmentDispatchAttempt) => {});
    const h = harness(
      { runGh },
      {
        selected: {
          getBranchHead: async () => HEAD,
          beforeDispatch: async () => {
            throw new Error("Legacy dispatch bypass");
          },
          selectedAttempts: {
            owner: "octocat",
            operationAttempt: () => 0,
            latest: () => attempt,
            begin: async () => {
              throw new Error("Unexpected new attempt");
            },
            record
          }
        }
      }
    );
    expect(await h.run()).toEqual({ outcome: "deleted" });
    expect(runGh).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      ...attempt,
      state: "correlated",
      runId: 21
    });
  });

  it("observes only the saved dispatch after a restart", async () => {
    const beforeDispatch = vi.fn(async () => {});
    const h = harness(
      {},
      {
        selected: {
          getBranchHead: async () => HEAD,
          beforeDispatch,
          recoverDispatch: () => ({
            dispatchedAt: 1234,
            correlationId: "del-ya-fixture"
          })
        }
      }
    );
    expect(await h.run()).toEqual({ outcome: "deleted" });
    expect(h.dependencies.findWorkflowRun).toHaveBeenCalledExactlyOnceWith(
      REPO,
      DELETE_ENV_DISPATCHER_FILE,
      1234,
      null,
      undefined,
      undefined,
      "del-ya-fixture"
    );
    expect(h.dependencies.getRunDetail).toHaveBeenCalledWith(
      REPO,
      "99",
      undefined,
      expect.objectContaining({ identity: "selected" })
    );
    expect(h.dependencies.ensureWorkflowsCurrent).not.toHaveBeenCalled();
    expect(h.dependencies.runGh).not.toHaveBeenCalled();
    expect(beforeDispatch).not.toHaveBeenCalled();
  });

  it("commits and verifies every workflow it was given, then dispatches the run it can identify", async () => {
    const h = harness();

    expect(await h.run()).toEqual({ outcome: "deleted" });

    expect(h.dependencies.ensureWorkflowsCurrent).toHaveBeenCalledWith(
      REPO,
      "dev",
      "",
      FILES
    );
    expect(h.dependencies.generateDeleteWorkflow).toHaveBeenCalledWith("dev");
    expect(
      vi
        .mocked(h.dependencies.fetchFileFromRepo)
        .mock.calls.map(([, path, branch]) => `${branch}:${path}`)
    ).toEqual(FILES.map((file) => `main:.github/workflows/${file}`));
    const correlation = `del-${(1_000_000).toString(36)}-${(0.5).toString(36).slice(2, 10)}`;
    expect(h.calls).toEqual([
      [
        "workflow",
        "run",
        DELETE_ENV_DISPATCHER_FILE,
        "-f",
        "environment=dev",
        "-f",
        `correlation_id=${correlation}`,
        "--repo",
        REPO
      ]
    ]);
    expect(h.dependencies.findWorkflowRun).toHaveBeenCalledWith(
      REPO,
      DELETE_ENV_DISPATCHER_FILE,
      1_000_000,
      null,
      undefined,
      undefined,
      correlation
    );
    expect(h.dependencies.getRunDetail).toHaveBeenCalledWith(
      REPO,
      "99",
      undefined,
      expect.objectContaining({ identity: "ambient" })
    );
    expect(h.sleeps).toEqual([]);
  });

  it("stops before dispatching when the templates cannot be built", async () => {
    const h = harness({
      generateDeleteWorkflow: vi.fn(async () => {
        throw new Error("template fetch failed");
      })
    });
    expect(await h.run()).toEqual({
      outcome: "failed",
      detail:
        "Could not build the delete-environment workflow templates to verify them: template fetch failed"
    });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ["missing", null, 'is not present on the "main" branch'],
    [
      "stale",
      "old body",
      'on the "main" branch does not match the packaged Radius workflow template'
    ]
  ])(
    "stops before dispatching when a provider workflow is %s",
    async (_label, content, reason) => {
      const h = harness({
        fetchFileFromRepo: vi.fn(async (_repo: string, path: string) =>
          path.endsWith("delete-environment-aws.yml") ? content : (
            (TEMPLATES[path.split("/").pop() ?? ""] ?? null)
          )
        )
      });
      const result = await h.run();
      expect(result.outcome).toBe("failed");
      expect(result.detail).toContain(`delete-environment-aws.yml ${reason}`);
      expect(result.detail).toContain(
        `Radius did not start the deletion of "dev" in ${REPO}.`
      );
      expect(h.calls).toEqual([]);
    }
  );

  it("treats a workflow with no packaged template as stale", async () => {
    const { ["delete-environment-aws.yml"]: _omitted, ...withoutAws } =
      TEMPLATES;
    const h = harness({
      generateDeleteWorkflow: vi.fn(async () => withoutAws)
    });
    const result = await h.run();
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain(
      'delete-environment-aws.yml on the "main" branch does not match the packaged Radius workflow template'
    );
    expect(h.calls).toEqual([]);
  });

  it("verifies against an empty default branch name as unreadable", async () => {
    const h = harness({ getDefaultBranch: vi.fn(async () => null) });
    const result = await h.run();
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain(
      "Could not determine the repository's default branch"
    );
  });

  it("waits for GitHub to register a just-created dispatcher and retries a 404", async () => {
    const h = harness(
      {
        ensureWorkflowsCurrent: vi.fn(async () => ({
          created: [`.github/workflows/${DELETE_ENV_DISPATCHER_FILE}`]
        }))
      },
      { dispatch: [failed("HTTP 404: workflow not found"), ok()] }
    );
    expect(await h.run()).toEqual({ outcome: "deleted" });
    expect(h.sleeps).toEqual([3000, 2000]);
    expect(h.calls).toHaveLength(2);
  });

  it("reports a dispatch failure with GitHub's message, or a default one", async () => {
    expect(
      await harness({}, { dispatch: [failed("HTTP 422: bad input\n")] }).run()
    ).toEqual({ outcome: "failed", detail: "HTTP 422: bad input" });
    expect(await harness({}, { dispatch: [failed("")] }).run()).toEqual({
      outcome: "failed",
      detail: `Failed to start ${DELETE_ENV_DISPATCHER_FILE} on ${REPO}.`
    });
  });

  it("retries with the keyring account when an injected token lacks the workflow scope", async () => {
    const h = harness(
      { processEnv: { GH_TOKEN: "injected", GITHUB_TOKEN: "x", PATH: "/bin" } },
      { dispatch: [failed("HTTP 403: missing the workflow scope"), ok()] }
    );
    expect(await h.run()).toEqual({ outcome: "deleted" });
    expect(vi.mocked(h.dependencies.runGh).mock.calls[1]?.[1]).toEqual({
      env: { PATH: "/bin" }
    });
  });

  it("does not reroute a saved-account dispatch on a missing workflow scope", async () => {
    const beforeDispatch = vi.fn(async () => {});
    const h = harness(
      {
        processEnv: { GH_TOKEN: "injected" }
      },
      {
        dispatch: [failed("HTTP 403: missing the workflow scope"), ok()],
        selected: { getBranchHead: async () => HEAD, beforeDispatch }
      }
    );
    expect(await h.run()).toEqual({
      outcome: "failed",
      detail: "HTTP 403: missing the workflow scope"
    });
    expect(beforeDispatch).toHaveBeenCalledTimes(1);
    expect(h.dependencies.runGh).toHaveBeenCalledTimes(1);
  });

  it("verifies all selected deletion workflows at one revision before dispatching the checked branch", async () => {
    const h = harness(
      { getDefaultBranch: async () => "release/next" },
      {
        selected: {
          getBranchHead: async () => HEAD,
          beforeDispatch: async () => {}
        }
      }
    );
    expect(await h.run()).toEqual({ outcome: "deleted" });
    expect(vi.mocked(h.dependencies.fetchFileFromRepo).mock.calls).toEqual(
      FILES.map((file) => [REPO, `.github/workflows/${file}`, HEAD])
    );
    expect(h.calls[0]?.slice(-2)).toEqual(["--ref", "release/next"]);
    expect(h.dependencies.getRunDetail).toHaveBeenCalledWith(
      REPO,
      "99",
      undefined,
      expect.objectContaining({ identity: "selected" })
    );
  });

  it.each([
    { branches: ["main", "other"], heads: [HEAD], detail: "changed" },
    {
      branches: ["main", "main"],
      heads: [HEAD, "b".repeat(40)],
      detail: "changed"
    },
    { branches: ["main"], heads: [""], detail: "Could not verify" },
    { branches: ["main", "main"], heads: [HEAD], detail: "Could not recheck" }
  ])(
    "refuses an unverifiable selected dispatch before recording intent ($detail)",
    async ({ branches, heads, detail }) => {
      const beforeDispatch = vi.fn(async () => {});
      const h = harness(
        { getDefaultBranch: async () => branches.shift() ?? null },
        {
          selected: {
            getBranchHead: async () => {
              const head = heads.shift();
              if (head === undefined) throw new Error("revision unavailable");
              return head;
            },
            beforeDispatch
          }
        }
      );
      expect(await h.run()).toEqual({
        outcome: "failed",
        detail: expect.stringContaining(detail)
      });
      expect(beforeDispatch).not.toHaveBeenCalled();
      expect(h.dependencies.runGh).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["the scope retry also fails", { GH_TOKEN: "t" }, false, 2],
    ["no token was injected", {}, false, 1],
    ["the dispatch timed out", { GITHUB_TOKEN: "t" }, true, 1]
  ])(
    "keeps the first failure when %s",
    async (_label, processEnv, timedOut, attempts) => {
      const first = failed("HTTP 403: missing the workflow scope", timedOut);
      const h = harness(
        { processEnv },
        { dispatch: [first, failed("HTTP 403: other")] }
      );
      expect(await h.run()).toEqual({
        outcome: "failed",
        detail: "HTTP 403: missing the workflow scope"
      });
      expect(h.calls).toHaveLength(attempts);
    }
  );

  it("waits for delayed run visibility without dispatching another deletion", async () => {
    const found = harness({}, { runs: [null, null, null, "7"] });
    expect(await found.run()).toEqual({ outcome: "deleted" });
    expect(found.sleeps).toEqual([5000, 7500, 11250]);
    expect(found.calls).toHaveLength(1);
    const lookups = vi.mocked(found.dependencies.findWorkflowRun).mock.calls;
    expect(lookups).toHaveLength(4);
    expect(
      lookups.every(
        (args) => JSON.stringify(args) === JSON.stringify(lookups[0])
      )
    ).toBe(true);
    expect(found.dependencies.getRunDetail).toHaveBeenCalledWith(
      REPO,
      "7",
      undefined,
      expect.objectContaining({ identity: "ambient" })
    );
  });

  it("reports an undiscovered run at the existing 30-minute deadline", async () => {
    const lost = harness({}, { runs: [null] });
    expect(await lost.run()).toEqual({
      outcome: "failed",
      detail:
        "The delete-environment workflow was dispatched but its run could not be found to confirm completion."
    });
    expect(lost.sleeps.reduce((total, ms) => total + ms, 0)).toBe(
      30 * 60 * 1000
    );
    expect(lost.calls).toHaveLength(1);
    expect(lost.dependencies.getRunDetail).not.toHaveBeenCalled();
  });

  it("keeps the operation active while discovery is pending, even if a heartbeat fails", async () => {
    const heartbeat = vi
      .fn()
      .mockRejectedValueOnce(new Error("heartbeat failed"))
      .mockResolvedValue(undefined);
    const h = harness({}, { runs: [null, null, "7"] });

    expect(await h.run(heartbeat)).toEqual({ outcome: "deleted" });
    expect(heartbeat).toHaveBeenCalledTimes(2);
    expect(h.calls).toHaveLength(1);
  });

  it("propagates a discovery error without repeating the destructive dispatch", async () => {
    const h = harness({
      findWorkflowRun: vi.fn(async () => {
        throw new Error("run listing unavailable");
      })
    });

    await expect(h.run()).rejects.toThrow("run listing unavailable");
    expect(h.calls).toHaveLength(1);
    expect(h.dependencies.getRunDetail).not.toHaveBeenCalled();
    expect(h.sleeps).toEqual([]);
  });

  it("does not give a late-discovered run a new completion budget", async () => {
    let clock = 1_000_000;
    const h = harness({
      now: () => clock,
      findWorkflowRun: vi.fn(async () => {
        clock += 29 * 60 * 1000;
        return "7";
      }),
      sleep: vi.fn(async (milliseconds: number) => {
        clock += milliseconds;
      }),
      getRunDetail: vi.fn(async () => ({
        status: "in_progress",
        conclusion: null
      }))
    });

    expect(await h.run()).toEqual({
      outcome: "failed",
      detail:
        "The delete-environment workflow did not complete within 30 minutes."
    });
    expect(clock).toBe(1_000_000 + 30 * 60 * 1000);
    expect(h.dependencies.findWorkflowRun).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(1);
  });

  it("does not start a status read after discovery consumes the remaining budget", async () => {
    let clock = 1_000_000;
    const h = harness({
      now: () => clock,
      findWorkflowRun: vi.fn(async () => {
        clock += 30 * 60 * 1000;
        return "7";
      })
    });

    expect(await h.run()).toEqual({
      outcome: "failed",
      detail:
        "The delete-environment workflow did not complete within 30 minutes."
    });
    expect(h.dependencies.getRunDetail).not.toHaveBeenCalled();
    expect(h.sleeps).toEqual([]);
  });

  it("polls with backoff and heartbeats until the run completes", async () => {
    const details = [
      null,
      { status: "in_progress", conclusion: null, steps: [] },
      { status: "in_progress", conclusion: null, steps: [] },
      { status: "in_progress", conclusion: null, steps: [] },
      { status: "in_progress", conclusion: null, steps: [] },
      {
        status: "completed",
        conclusion: "failure",
        steps: [{ name: DELETE_ENV_GUARD_STEP_NAME, conclusion: "failure" }]
      }
    ];
    const heartbeat = vi
      .fn()
      .mockRejectedValueOnce(new Error("heartbeat failed"))
      .mockResolvedValue(undefined);
    const h = harness({
      getRunDetail: vi.fn(async () => details.shift() ?? null)
    });

    expect(await h.run(heartbeat)).toMatchObject({ outcome: "apps_present" });
    expect(heartbeat).toHaveBeenCalledTimes(5);
    expect(h.sleeps).toEqual([5000, 7500, 11250, 15000, 15000]);
  });

  it("polls without a heartbeat", async () => {
    const details = [
      { status: "queued", conclusion: null, steps: [] },
      { status: "completed", conclusion: "cancelled" }
    ];
    const h = harness({
      getRunDetail: vi.fn(async () => details.shift() ?? null)
    });
    expect(await h.run()).toEqual({
      outcome: "failed",
      detail:
        'The delete-environment workflow finished with conclusion "cancelled".'
    });
  });

  it("gives up after 30 minutes", async () => {
    const h = harness({
      getRunDetail: vi.fn(async () => ({
        status: "in_progress",
        conclusion: null,
        steps: []
      }))
    });
    expect(await h.run()).toEqual({
      outcome: "failed",
      detail:
        "The delete-environment workflow did not complete within 30 minutes."
    });
    expect(h.sleeps.reduce((total, ms) => total + ms, 0)).toBe(30 * 60 * 1000);
  });
});
