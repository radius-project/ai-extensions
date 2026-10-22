import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExecFileException } from "node:child_process";
import { successfulSelectedGhExecutor } from "../test/support/server/selected-gh.js";
import { coordinateDeploymentDispatch } from "@radius-project/core";

// The ./gh.ts stub records the args each `gh` invocation would run and replies
// with whatever the active handler returns, so ghJson, findWorkflowRun, and
// latestWorkflowRunId can be exercised without spawning the CLI. `vi.hoisted`
// runs before the module factory so the mock can close over the shared handler.
const { ghMock } = vi.hoisted(() => {
  return {
    ghMock: {
      calls: [] as string[][],
      options: [] as Array<{ timeout?: number }>,
      handler: (
        _args: string[]
      ): {
        error?: ExecFileException | null;
        stdout?: string;
      } => ({ stdout: "[]" })
    }
  };
});

vi.mock("./gh.js", () => ({
  cliExec: (
    _cmd: string,
    args: string[],
    opts: { timeout?: number },
    cb: (
      error: ExecFileException | null,
      stdout: string,
      stderr: string
    ) => void
  ) => {
    ghMock.calls.push(args);
    ghMock.options.push(opts);
    const result = ghMock.handler(args);
    cb(result.error ?? null, result.stdout ?? "", "");
  }
}));

const { findWorkflowRun, ghJson, latestWorkflowRunId } =
  await import("./deploy.js");

interface RunListEntry {
  databaseId?: number;
  createdAt?: string;
}

function replyWith(runs: RunListEntry[] | string): void {
  ghMock.handler = () => ({
    stdout: typeof runs === "string" ? runs : JSON.stringify(runs)
  });
}

const DISPATCH_AT = 1_700_000_000_000;

beforeEach(() => {
  ghMock.calls = [];
  ghMock.options = [];
  ghMock.handler = () => ({ stdout: "[]" });
});

describe("ghJson ambient CLI reads", () => {
  it("parses JSON and forwards the requested timeout", async () => {
    replyWith('[{"databaseId":41}]');

    await expect(ghJson(["run", "list"], null, 3210)).resolves.toEqual([
      { databaseId: 41 }
    ]);
    expect(ghMock.calls).toEqual([["run", "list"]]);
    expect(ghMock.options).toEqual([{ timeout: 3210 }]);
  });

  it("returns the caller-provided fallback when the command fails", async () => {
    const fallback: unknown[] = [];
    ghMock.handler = () => ({
      error: Object.assign(new Error("gh failed"), { code: 1 })
    });

    await expect(ghJson(["run", "list"], fallback)).resolves.toBe(fallback);
    expect(ghMock.options).toEqual([{ timeout: 15000 }]);
  });

  it("prefers a command failure over parseable stdout", async () => {
    const fallback: unknown[] = [];
    ghMock.handler = () => ({
      error: Object.assign(new Error("gh failed"), { code: 1 }),
      stdout: '[{"databaseId":41}]'
    });

    await expect(ghJson(["run", "list"], fallback)).resolves.toBe(fallback);
  });

  it("returns null by default when the command fails", async () => {
    ghMock.handler = () => ({
      error: Object.assign(new Error("gh failed"), { code: 1 })
    });

    await expect(ghJson(["run", "list"])).resolves.toBeNull();
  });

  it("returns the caller-provided fallback for malformed JSON", async () => {
    const fallback = { unavailable: true };
    replyWith("not json");

    await expect(ghJson(["run", "list"], fallback)).resolves.toBe(fallback);
  });
});

describe("findWorkflowRun known-id shortcut", () => {
  it("returns a known run id without listing runs", async () => {
    const result = await findWorkflowRun("acme/widgets", "run.yml", 0, 42);

    expect(result).toBe(42);
    expect(ghMock.calls).toHaveLength(0);
  });
});

describe("findWorkflowRun with a monotonic baseline", () => {
  it("returns the first run above the baseline when a later run is also visible", async () => {
    replyWith([
      { databaseId: 106, createdAt: "2026-08-19T00:00:40Z" },
      { databaseId: 105, createdAt: "2026-08-19T00:00:30Z" },
      { databaseId: 100, createdAt: "2026-08-19T00:00:10Z" },
      { databaseId: 90, createdAt: "2026-08-18T00:00:00Z" }
    ]);

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT,
      null,
      undefined,
      100
    );

    expect(result).toBe(105);
  });

  it("ignores the creation-time window so a stale prior run is never matched", async () => {
    // The only run predates dispatch by hours, but its id exceeds the baseline,
    // so it is the run this dispatch created and must be returned regardless of
    // the time window.
    replyWith([{ databaseId: 200, createdAt: "2000-01-01T00:00:00Z" }]);

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT,
      null,
      undefined,
      150
    );

    expect(result).toBe(200);
  });

  it("returns null when no run exceeds the baseline yet", async () => {
    replyWith([
      { databaseId: 100, createdAt: "2026-08-19T00:00:10Z" },
      { databaseId: 99, createdAt: "2026-08-19T00:00:05Z" }
    ]);

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT,
      null,
      undefined,
      100
    );

    expect(result).toBeNull();
  });

  it("skips entries without a numeric run id while honoring the baseline", async () => {
    replyWith([
      { createdAt: "2026-08-19T00:00:30Z" },
      { databaseId: 101, createdAt: "2026-08-19T00:00:20Z" }
    ]);

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT,
      null,
      undefined,
      100
    );

    expect(result).toBe(101);
  });

  it("coerces a string baseline to a number", async () => {
    replyWith([{ databaseId: 101, createdAt: "2026-08-19T00:00:20Z" }]);

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT,
      null,
      undefined,
      "100"
    );

    expect(result).toBe(101);
  });

  it("treats a zero baseline as a real baseline rather than a missing one", async () => {
    replyWith([{ databaseId: 1, createdAt: "2000-01-01T00:00:00Z" }]);

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT,
      null,
      undefined,
      0
    );

    expect(result).toBe(1);
  });
});

describe("findWorkflowRun time-window fallback", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["a non-numeric string", "abc"],
    ["a non-finite number", Number.POSITIVE_INFINITY]
  ] as const)(
    "uses the creation window when the baseline is %s",
    async (_label, baseline) => {
      replyWith([
        { databaseId: 300, createdAt: new Date(DISPATCH_AT).toISOString() }
      ]);

      const result = await findWorkflowRun(
        "acme/widgets",
        "run.yml",
        DISPATCH_AT,
        null,
        undefined,
        baseline
      );

      expect(result).toBe(300);
    }
  );

  it("accepts a run created within the ~60s skew tolerance before dispatch", async () => {
    replyWith([
      {
        databaseId: 301,
        createdAt: new Date(DISPATCH_AT - 30_000).toISOString()
      }
    ]);

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT
    );

    expect(result).toBe(301);
  });

  it("rejects a run created before the tolerance window", async () => {
    replyWith([
      {
        databaseId: 302,
        createdAt: new Date(DISPATCH_AT - 120_000).toISOString()
      }
    ]);

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT
    );

    expect(result).toBeNull();
  });

  it("treats an unparseable creation time as epoch and accepts it when dispatch is unknown", async () => {
    replyWith([{ databaseId: 303, createdAt: "not-a-date" }]);

    const result = await findWorkflowRun("acme/widgets", "run.yml", 0);

    expect(result).toBe(303);
  });

  it("skips a windowed run that has no numeric id", async () => {
    replyWith([
      { createdAt: new Date(DISPATCH_AT).toISOString() },
      { databaseId: 304, createdAt: new Date(DISPATCH_AT).toISOString() }
    ]);

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT
    );

    expect(result).toBe(304);
  });

  it("returns null when the run list is not an array", async () => {
    replyWith("not json");

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT
    );

    expect(result).toBeNull();
  });
});

describe("latestWorkflowRunId", () => {
  it("captures a repository baseline before a newly published workflow is registered", async () => {
    const calls: string[][] = [];
    let dispatches = 0;
    const executor = successfulSelectedGhExecutor({
      login: "fixture",
      run: async (args) => {
        calls.push(args);
        if (args[0] === "run") {
          if (args.some((arg) => arg.startsWith("--workflow"))) {
            return {
              code: 1,
              stdout: "",
              stderr: "could not find any workflows named deploy.yml"
            };
          }
          return { code: 0, stdout: '[{"databaseId":41}]', stderr: "" };
        }
        if (args[0] !== "workflow")
          throw new Error("Unexpected selected operation");
        dispatches++;
        return dispatches === 1 ?
            { code: 1, stdout: "", stderr: "HTTP 404: workflow not found" }
          : { code: 0, stdout: "", stderr: "" };
      }
    });
    const result = await coordinateDeploymentDispatch(
      {
        repo: "acme/widgets",
        branch: "feat",
        environment: "dev",
        workflowFile: "deploy.yml"
      },
      true,
      {
        isCurrent: () => true,
        latestRunId: () =>
          latestWorkflowRunId("acme/widgets", "deploy.yml", executor),
        dispatch: async () => ({
          result: await executor.run([
            "workflow",
            "run",
            "deploy.yml",
            "--repo",
            "acme/widgets",
            "--ref",
            "feat"
          ]),
          credentialSource: executor.credentialSource
        }),
        sleep: async () => {},
        now: () => 123,
        errorMessage: executor.errorMessage
      }
    );
    expect(result).toMatchObject({
      kind: "accepted",
      reference: { baselineRunId: 41 }
    });
    expect(calls.map((args) => args[0])).toEqual([
      "run",
      "workflow",
      "run",
      "workflow"
    ]);
    expect(
      calls
        .filter((args) => args[0] === "run")
        .every((args) => args.every((arg) => !arg.startsWith("--workflow")))
    ).toBe(true);
    expect(ghMock.calls).toEqual([]);
  });

  it.each([
    { stdout: '[{"databaseId":17},{"databaseId":21}]', code: 0, expected: 21 },
    { stdout: "[]", code: 0, expected: null }
  ])(
    "reads the selected account baseline without ambient fallback: %j",
    async ({ stdout, code, expected }) => {
      const run = vi.fn(async () => ({
        code,
        stdout,
        stderr: code ? "temporary read failure" : ""
      }));
      const executor = successfulSelectedGhExecutor({ login: "fixture", run });
      expect(
        await latestWorkflowRunId("acme/widgets", "run.yml", executor)
      ).toBe(expected);
      expect(run).toHaveBeenCalledExactlyOnceWith(
        [
          "run",
          "list",
          "--limit",
          "20",
          "--json",
          "databaseId,createdAt",
          "--repo",
          "acme/widgets"
        ],
        { timeout: 15000 }
      );
      expect(ghMock.calls).toEqual([]);
    }
  );

  it.each([
    { stdout: '{"unexpected":true}', code: 0 },
    { stdout: "not-json", code: 0 },
    { stdout: "", code: 1 },
    { stdout: '[{"databaseId":17},{}]', code: 0 },
    { stdout: "[null]", code: 0 },
    { stdout: '[{"databaseId":0}]', code: 0 },
    { stdout: '[{"databaseId":-2}]', code: 0 },
    { stdout: '[{"databaseId":1.5}]', code: 0 },
    { stdout: '[{"databaseId":9007199254740992}]', code: 0 }
  ])(
    "refuses unavailable or malformed selected baselines: %j",
    async ({ stdout, code }) => {
      const run = vi.fn(async () => ({
        stdout,
        code,
        stderr: "read unavailable"
      }));
      const executor = successfulSelectedGhExecutor({ login: "fixture", run });
      await expect(
        latestWorkflowRunId("acme/widgets", "run.yml", executor)
      ).rejects.toThrow(/baseline/);
      expect(run).toHaveBeenCalledTimes(1);
      expect(ghMock.calls).toEqual([]);
    }
  );

  it("returns the greatest run id regardless of list order", async () => {
    replyWith([
      { databaseId: 100, createdAt: "2026-08-19T00:00:00Z" },
      { databaseId: 130, createdAt: "2026-08-19T00:00:20Z" },
      { databaseId: 120, createdAt: "2026-08-19T00:00:10Z" }
    ]);

    const result = await latestWorkflowRunId("acme/widgets", "run.yml");

    expect(result).toBe(130);
  });

  it("ignores entries without a numeric run id", async () => {
    replyWith([{ createdAt: "2026-08-19T00:00:00Z" }, { databaseId: 7 }]);

    const result = await latestWorkflowRunId("acme/widgets", "run.yml");

    expect(result).toBe(7);
  });

  it("returns null when there are no runs", async () => {
    replyWith([]);

    const result = await latestWorkflowRunId("acme/widgets", "run.yml");

    expect(result).toBeNull();
  });

  it("returns null when the run list is not an array", async () => {
    replyWith("boom");

    const result = await latestWorkflowRunId("acme/widgets", "run.yml");

    expect(result).toBeNull();
  });
});
