import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ExecFileException } from "node:child_process";

// The ./gh.ts stub records the args each `gh` invocation would run and replies
// with whatever the active handler returns, so findWorkflowRun/latestWorkflowRunId
// can be exercised without spawning the CLI. `vi.hoisted` runs before the module
// factory so the mock can close over the shared handler.
const { ghMock } = vi.hoisted(() => {
  return {
    ghMock: {
      calls: [] as string[][],
      handler: (_args: string[]): {
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
    _opts: unknown,
    cb: (
      error: ExecFileException | null,
      stdout: string,
      stderr: string
    ) => void
  ) => {
    ghMock.calls.push(args);
    const result = ghMock.handler(args);
    cb(result.error ?? null, result.stdout ?? "", "");
  }
}));

const { findWorkflowRun, latestWorkflowRunId } = await import("./deploy.js");

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
  ghMock.handler = () => ({ stdout: "[]" });
});

describe("findWorkflowRun known-id shortcut", () => {
  it("returns a known run id without listing runs", async () => {
    const result = await findWorkflowRun("acme/widgets", "run.yml", 0, 42);

    expect(result).toBe(42);
    expect(ghMock.calls).toHaveLength(0);
  });
});

describe("findWorkflowRun with a monotonic baseline", () => {
  it("returns the newest run whose id exceeds the baseline", async () => {
    replyWith([
      { databaseId: 105, createdAt: "2026-08-19T00:00:30Z" },
      { databaseId: 100, createdAt: "2026-08-19T00:00:10Z" },
      { databaseId: 90, createdAt: "2026-08-18T00:00:00Z" }
    ]);

    const result = await findWorkflowRun(
      "acme/widgets",
      "run.yml",
      DISPATCH_AT,
      null,
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
        baseline
      );

      expect(result).toBe(300);
    }
  );

  it("accepts a run created within the ~60s skew tolerance before dispatch", async () => {
    replyWith([
      { databaseId: 301, createdAt: new Date(DISPATCH_AT - 30_000).toISOString() }
    ]);

    const result = await findWorkflowRun("acme/widgets", "run.yml", DISPATCH_AT);

    expect(result).toBe(301);
  });

  it("rejects a run created before the tolerance window", async () => {
    replyWith([
      {
        databaseId: 302,
        createdAt: new Date(DISPATCH_AT - 120_000).toISOString()
      }
    ]);

    const result = await findWorkflowRun("acme/widgets", "run.yml", DISPATCH_AT);

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

    const result = await findWorkflowRun("acme/widgets", "run.yml", DISPATCH_AT);

    expect(result).toBe(304);
  });

  it("returns null when the run list is not an array", async () => {
    replyWith("not json");

    const result = await findWorkflowRun("acme/widgets", "run.yml", DISPATCH_AT);

    expect(result).toBeNull();
  });
});

describe("latestWorkflowRunId", () => {
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
