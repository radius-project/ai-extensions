import { describe, expect, it, vi } from "vitest";
import {
  DELETE_ENV_DISPATCHER_FILE,
  DELETE_ENV_GUARD_STEP_NAME
} from "@radius-project/core";
import type { GhCommandResult } from "./gh-command-result.js";
import {
  createRadiusEnvironmentWorkflowDeletion,
  type RadiusEnvironmentWorkflowDeletionDependencies
} from "./radius-environment-workflow-deletion.js";

const REPO = "octo/shop";
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
  overrides: Partial<RadiusEnvironmentWorkflowDeletionDependencies> = {},
  options: { dispatch?: GhCommandResult[]; runs?: Array<string | null> } = {}
) {
  let clock = 1_000_000;
  const dispatch = options.dispatch ?? [ok()];
  const runs = options.runs ?? ["99"];
  const calls: string[][] = [];
  const sleeps: number[] = [];
  const dependencies: RadiusEnvironmentWorkflowDeletionDependencies = {
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

  it("looks for the run again before giving up on it", async () => {
    const found = harness({}, { runs: [null, null, "7"] });
    expect(await found.run()).toEqual({ outcome: "deleted" });
    expect(found.sleeps).toEqual([2000, 4000]);

    const lost = harness({}, { runs: [null] });
    expect(await lost.run()).toEqual({
      outcome: "failed",
      detail:
        "The delete-environment workflow was dispatched but its run could not be found to confirm completion."
    });
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
    expect(
      h.sleeps.reduce((total, ms) => total + ms, 0)
    ).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });
});
