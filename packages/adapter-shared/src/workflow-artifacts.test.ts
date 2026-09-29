import fs, { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_PAGE_SIZE,
  createDeployStatusReader,
  DEPLOY_STATUS_FILES,
  collectWorkflowFailure,
  confirmedWorkflowConclusion,
  observeWorkflowRun
} from "@radius-project/core";
import {
  createWorkflowArtifactReader,
  createWorkflowArtifactReads,
  MAX_ARTIFACT_FILE_BYTES
} from "./workflow-artifacts.js";
import {
  readWorkflowRun,
  readWorkflowLog,
  type WorkflowRunner
} from "./workflow-reads.js";
import { createWorkflowReadSession } from "./workflow-read-budget.js";

const artifact = {
  id: 12,
  name: "radius-deploy-status-dev-app",
  workflow_run: { id: 41 }
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const progress = {
  schemaVersion: 1,
  application: "app",
  environment: "dev",
  runId: 41,
  sequence: 1,
  resources: [
    { name: "api", type: "Radius.Compute/containers", status: "failed" }
  ]
};

function deferred() {
  let complete: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve() {
      if (!complete) throw new Error("Deferred promise not initialized");
      complete();
    }
  };
}

function downloadRunner(populate: (directory: string) => void | Promise<void>) {
  let directory = "";
  const run = vi.fn<WorkflowRunner>(async (args, options) => {
    expect(args.slice(0, 6)).toEqual([
      "run",
      "download",
      "41",
      "--name",
      artifact.name,
      "--dir"
    ]);
    expect(args.slice(7)).toEqual(["--repo", "org/app"]);
    expect(options).toEqual({ timeout: 60000 });
    directory = args[6];
    expect(existsSync(directory)).toBe(true);
    await populate(directory);
    return { code: 0, stdout: "", stderr: "" };
  });
  return { run, directory: () => directory };
}

describe("workflow artifact Node binding", () => {
  it.each([
    [{ artifacts: [null] }, "GitHub returned invalid artifact metadata."],
    [
      { artifacts: [{ ...artifact, workflow_run: { id: -1 } }] },
      "GitHub returned an invalid artifact execution identity."
    ],
    [{ artifacts: null }, "GitHub returned an invalid artifact listing."]
  ])("retains actionable schema diagnostics for %j", async (value, message) => {
    const reads = createWorkflowArtifactReads(async () => ({
      code: 0,
      stderr: "",
      stdout: `HTTP/2.0 200 OK\n\r\n${JSON.stringify(value)}`
    }));
    await expect(
      reads.listWorkflowArtifactsWithMetadata("org/app", 41)
    ).rejects.toMatchObject({
      message,
      code: "GH_ARTIFACT_MALFORMED",
      evidence: [{ response: { status: 200 } }]
    });
  });
  it("bounds actual rate-limit retries without the legacy 403 auth projection", async () => {
    vi.useFakeTimers();
    const reads = createWorkflowArtifactReads(async () => ({
      code: 1,
      stdout:
        'HTTP/2 403\nRetry-After: 12\r\n\r\n{"message":"secondary rate limit"}',
      stderr: ""
    }));
    const result = reads
      .listWorkflowArtifactsWithMetadata("org/app", 41)
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({
      code: "GH_ARTIFACT_TRANSPORT",
      decision: { state: "deferred", reason: "not-before" },
      evidence: [
        { response: { status: 403 } },
        {
          phase: "artifacts",
          response: {
            source: "gh-api-include",
            status: 403,
            classification: "rate-limit",
            retryAfter: { state: "delay", milliseconds: 12000 }
          }
        }
      ]
    });
  });

  it("returns safe explicit failure metadata for framed non-auth transport failures", async () => {
    vi.useFakeTimers();
    const reads = createWorkflowArtifactReads(async () => ({
      code: 1,
      stdout: 'HTTP/2 503\n\n{"message":"fixture-private"}',
      stderr: ""
    }));
    const pending = reads
      .listWorkflowArtifacts("org/app")
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error).toMatchObject({
      code: "GH_ARTIFACT_TRANSPORT",
      evidence: [
        { response: { status: 503 } },
        { response: { status: 503 } },
        { response: { status: 503 } }
      ],
      decision: { state: "exhausted", reason: "attempts" }
    });
    expect(JSON.stringify(error)).not.toContain("fixture-private");
  });
  it.each([
    { label: "empty", artifacts: [] },
    {
      label: "exact page limit",
      artifacts: Array.from({ length: ARTIFACT_PAGE_SIZE }, (_, id) => ({
        ...artifact,
        id: id + 1
      }))
    },
    {
      label: "optional metadata",
      artifacts: [
        {
          ...artifact,
          expired: false,
          created_at: "2026-01-01",
          workflow_run: null
        }
      ]
    },
    { label: "absent execution", artifacts: [{ id: 12, name: artifact.name }] },
    {
      label: "nullable timestamp and absent execution id",
      artifacts: [{ ...artifact, created_at: null, workflow_run: {} }]
    },
    {
      label: "nullable execution id",
      artifacts: [{ ...artifact, workflow_run: { id: null } }]
    }
  ])(
    "accepts $label and preserves bounded run targeting",
    async ({ artifacts }) => {
      const run = vi.fn<WorkflowRunner>(async () => ({
        code: 0,
        stdout: "HTTP/2 200\n\n" + JSON.stringify({ artifacts }),
        stderr: ""
      }));
      const reads = createWorkflowArtifactReads(run);
      expect(await reads.listWorkflowArtifacts("org/app", 41)).toHaveLength(
        artifacts.length
      );
      expect(run).toHaveBeenCalledExactlyOnceWith(
        [
          "api",
          "/repos/org/app/actions/runs/41/artifacts?per_page=100",
          "--include",
          "--method",
          "GET"
        ],
        {
          timeout: expect.any(Number),
          maxBuffer: 10 * 1024 * 1024,
          signal: expect.any(AbortSignal)
        }
      );
    }
  );

  it.each([
    "not json",
    "",
    "null",
    "[]",
    "{}",
    '{"artifacts":{}}',
    JSON.stringify({
      artifacts: Array.from({ length: ARTIFACT_PAGE_SIZE + 1 }, () => artifact)
    }),
    ...[
      null,
      {},
      { ...artifact, id: "12" },
      { ...artifact, id: 0 },
      { ...artifact, id: 1.5 },
      { ...artifact, id: Number.MAX_SAFE_INTEGER + 1 },
      { ...artifact, name: "" },
      { ...artifact, name: 12 },
      { ...artifact, expired: "false" },
      { ...artifact, created_at: 12 },
      { ...artifact, workflow_run: [] },
      { ...artifact, workflow_run: { id: "41" } },
      { ...artifact, workflow_run: { id: 0 } },
      { ...artifact, workflow_run: { id: 1.5 } },
      { ...artifact, workflow_run: { id: Number.MAX_SAFE_INTEGER + 1 } }
    ].map((entry) => JSON.stringify({ artifacts: [entry] }))
  ])(
    "rejects malformed listing %s without calling it absence",
    async (stdout) => {
      const reader = createWorkflowArtifactReader(
        { repo: "org/app" },
        async () => ({
          code: 0,
          stdout: `HTTP/2 200\n\n${stdout}`,
          stderr: ""
        })
      );
      const result = await reader.read();
      expect(result.status).toBe("malformed");
      expect(result.error).toMatchObject({ code: "GH_ARTIFACT_MALFORMED" });
      expect(await reader.graph()).toEqual({
        graph: null,
        status: "malformed",
        artifact: null,
        error: result.error
      });
    }
  );

  it.each([
    ["HTTP 401 rejected", "auth"],
    ["HTTP 403 rejected", "auth"],
    ["Forbidden", "auth"],
    ["connection reset", "error"],
    ["", "error"]
  ])(
    "classifies command stderr %s, never log stdout",
    async (stderr, status) => {
      const reader = createWorkflowArtifactReader(
        { repo: "org/app" },
        async () => ({
          code: 1,
          stdout: "HTTP 401 in untrusted log output",
          stderr
        })
      );
      const result = await reader.read();
      expect(result.status).toBe(status);
      expect(result.error).toBeInstanceOf(Error);
      expect(String(result.error)).not.toContain("untrusted");
    }
  );

  it("retains the original rejected transport error", async () => {
    const error = new Error("transport stopped");
    const reader = createWorkflowArtifactReader(
      { repo: "org/app" },
      async () => {
        throw error;
      }
    );
    expect(await reader.read()).toMatchObject({ status: "error", error });
  });

  it("does not stop repo-wide discovery at expired or live-slot evidence", async () => {
    const run = vi
      .fn<WorkflowRunner>()
      .mockResolvedValueOnce({
        code: 0,
        stderr: "",
        stdout:
          "HTTP/2 200\n\n" +
          JSON.stringify({
            artifacts: Array.from({ length: ARTIFACT_PAGE_SIZE }, (_, id) => ({
              ...artifact,
              id: id + 1,
              expired: true
            }))
          })
      })
      .mockResolvedValueOnce({
        code: 0,
        stderr: "",
        stdout: 'HTTP/2 200\n\n{"artifacts":[]}'
      });
    expect(
      await createWorkflowArtifactReads(run).listWorkflowArtifacts("org/app")
    ).toHaveLength(100);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, { id: 0 }])(
    "avoids downloads without an execution: %s",
    async (workflow_run) => {
      const run = vi.fn<WorkflowRunner>();
      const reads = createWorkflowArtifactReads(run);
      expect(
        await reads.downloadWorkflowArtifact("org/app", {
          ...artifact,
          workflow_run
        })
      ).toBeNull();
      expect(
        await reads.downloadWorkflowArtifact("org/app", {
          ...artifact,
          name: ""
        })
      ).toBeNull();
      expect(run).not.toHaveBeenCalled();
    }
  );

  it.each([0, MAX_ARTIFACT_FILE_BYTES])(
    "reads only bounded known documents of %i bytes and cleans up",
    async (size) => {
      const fixture = downloadRunner((directory) => {
        writeFileSync(
          path.join(directory, DEPLOY_STATUS_FILES.controlPlane),
          "x".repeat(size)
        );
        writeFileSync(path.join(directory, "unrelated.txt"), "not evidence");
      });
      const files = await createWorkflowArtifactReads(
        fixture.run
      ).downloadWorkflowArtifact("org/app", artifact);
      expect(files).toEqual({
        [DEPLOY_STATUS_FILES.controlPlane]: "x".repeat(size)
      });
      expect(existsSync(fixture.directory())).toBe(false);
    }
  );

  it.each(["oversized", "directory", "link"] as const)(
    "rejects %s evidence and removes the temporary directory",
    async (mode) => {
      const fixture = downloadRunner((directory) => {
        const file = path.join(directory, DEPLOY_STATUS_FILES.progress);
        if (mode === "oversized")
          writeFileSync(file, "x".repeat(MAX_ARTIFACT_FILE_BYTES + 1));
        else if (mode === "directory") mkdirSync(file);
        else {
          const target = path.join(directory, "target");
          mkdirSync(target);
          symlinkSync(target, file, "junction");
        }
      });
      await expect(
        createWorkflowArtifactReads(fixture.run).downloadWorkflowArtifact(
          "org/app",
          artifact
        )
      ).rejects.toMatchObject({ code: "GH_ARTIFACT_MALFORMED" });
      expect(existsSync(fixture.directory())).toBe(false);
    }
  );

  it.each(["reject", "auth", "transport"] as const)(
    "cleans temporary files after %s command failure",
    async (mode) => {
      const error = new Error("cancelled by host");
      const fixture = downloadRunner(() => {
        if (mode === "reject") throw error;
      });
      const run: WorkflowRunner = async (args, options) => {
        await fixture.run(args, options);
        return {
          code: 1,
          stdout: "",
          stderr: mode === "auth" ? "HTTP 403" : "download failed"
        };
      };
      const pending = createWorkflowArtifactReads(run).downloadWorkflowArtifact(
        "org/app",
        artifact
      );
      if (mode === "reject") await expect(pending).rejects.toBe(error);
      else
        await expect(pending).rejects.toMatchObject({
          code: mode === "auth" ? "GH_ARTIFACT_AUTH" : "GH_ARTIFACT_TRANSPORT"
        });
      expect(existsSync(fixture.directory())).toBe(false);
    }
  );

  it("isolates concurrent caller workspaces and cleans a late download after another fails", async () => {
    const waiting = deferred();
    const started = deferred();
    const first = downloadRunner(async (directory) => {
      started.resolve();
      await waiting.promise;
      writeFileSync(
        path.join(directory, DEPLOY_STATUS_FILES.progress),
        JSON.stringify(progress)
      );
    });
    const second = downloadRunner(() => {
      throw new Error("second caller stopped");
    });
    const pending = createWorkflowArtifactReads(
      first.run
    ).downloadWorkflowArtifact("org/app", artifact);
    await started.promise;
    await expect(
      createWorkflowArtifactReads(second.run).downloadWorkflowArtifact(
        "org/app",
        artifact
      )
    ).rejects.toThrow("second caller stopped");
    expect(first.directory()).not.toBe(second.directory());
    expect(existsSync(first.directory())).toBe(true);
    expect(existsSync(second.directory())).toBe(false);
    waiting.resolve();
    expect(await pending).toEqual({
      [DEPLOY_STATUS_FILES.progress]: JSON.stringify(progress)
    });
    expect(existsSync(first.directory())).toBe(false);
  });
});

describe("artifact cleanup and compatibility", () => {
  it.each(["cancelled", "elapsed"] as const)(
    "fences an opaque %s download without removing a live worker's directory",
    async (reason) => {
      vi.useFakeTimers();
      const waiting = deferred();
      const started = deferred();
      const controller = new AbortController();
      const context = createWorkflowReadSession().observe(
        100000,
        controller.signal
      );
      let directory = "";
      let signal: AbortSignal | undefined;
      const run = vi.fn<WorkflowRunner>(async (args, options) => {
        directory = args[6];
        signal = options.signal;
        expect(options.timeout).toBe(60000);
        started.resolve();
        await waiting.promise;
        writeFileSync(
          path.join(directory, DEPLOY_STATUS_FILES.progress),
          JSON.stringify(progress)
        );
        return { code: 0, stdout: "", stderr: "" };
      });
      const result = createWorkflowArtifactReads(run)
        .downloadWorkflowArtifact("org/app", artifact, context)
        .catch((error: unknown) => error);
      await started.promise;
      try {
        if (reason === "cancelled") controller.abort();
        else await vi.advanceTimersByTimeAsync(60000);
        expect(await result).toMatchObject({ reason });
        expect(signal?.aborted).toBe(true);
        expect(existsSync(directory)).toBe(true);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        waiting.resolve();
        await vi.runAllTimersAsync();
      }
      expect(existsSync(directory)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
  it("reports a failed opaque download with no stderr without masking cleanup", async () => {
    let directory = "";
    const reads = createWorkflowArtifactReads(async (args) => {
      directory = args[6];
      return { code: 7, stdout: "", stderr: "" };
    });
    await expect(
      reads.downloadWorkflowArtifact("org/app", artifact)
    ).rejects.toThrow("GitHub artifact command failed (7).");
    expect(existsSync(directory)).toBe(false);
  });

  describe("artifact shared-flight policy ownership", () => {
    it("reuses an attempted successful opaque download across repository finalization reads", async () => {
      const context = createWorkflowReadSession().observe(30000);
      const run = vi.fn<WorkflowRunner>(async () => ({
        code: 0,
        stdout: `HTTP/2 200\n\n${JSON.stringify({ artifacts: [artifact] })}`,
        stderr: ""
      }));
      const download = vi.fn(async () => ({
        [DEPLOY_STATUS_FILES.progress]: JSON.stringify(progress)
      }));
      const reader = createDeployStatusReader({
        repo: "org/app",
        ttlMs: 0,
        listArtifacts: createWorkflowArtifactReads(run).listWorkflowArtifacts,
        downloadArtifact: download
      });
      expect(await reader.read(context)).toMatchObject({ status: "ok" });
      expect(await reader.read(context.limit(20000))).toMatchObject({
        status: "stale",
        progress: { sequence: 1 }
      });
      expect(run).toHaveBeenCalledTimes(2);
      expect(download).toHaveBeenCalledTimes(1);
      expect(context.chargeRetries(2)).toBe(true);
    });

    it("starts a fresh flight immediately after the last subscriber leaves and ignores late completion", async () => {
      vi.useFakeTimers();
      const session = createWorkflowReadSession();
      const controller = new AbortController();
      const pending = deferred();
      let calls = 0;
      const reader = createWorkflowArtifactReader(
        { repo: "org/app", runId: 41, session },
        async () => {
          if (++calls === 1) await pending.promise;
          return {
            code: 0,
            stdout: 'HTTP/2 200\n\n{"artifacts":[]}',
            stderr: ""
          };
        }
      );
      const first = reader.read(session.observe(30000, controller.signal));
      const next = first.catch((error: unknown) => {
        expect(error).toMatchObject({ reason: "cancelled" });
        return reader.read(session.observe(30000));
      });
      controller.abort();
      expect(await next).toMatchObject({ status: "missing" });
      pending.resolve();
      expect(await reader.read(session.observe(30000))).toMatchObject({
        status: "missing"
      });
      expect(calls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("refuses an expired reader context before listing", async () => {
      const run = vi.fn<WorkflowRunner>(async () => {
        throw new Error("Unexpected list");
      });
      const reader = createWorkflowArtifactReader(
        { repo: "org/app", runId: 41 },
        run
      );
      const context = createWorkflowReadSession().observe(1000).limit(0);
      await expect(reader.read(context)).rejects.toMatchObject({
        reason: "elapsed"
      });
      expect(run).not.toHaveBeenCalled();
    });

    it.each(["elapsed", "cancelled"] as const)(
      "does not dispatch an opaque download after %s admission",
      async (reason) => {
        const controller = new AbortController();
        const session = createWorkflowReadSession();
        const context = session.observe(30000, controller.signal);
        if (reason === "cancelled") controller.abort();
        const run = vi.fn<WorkflowRunner>(async () => {
          throw new Error("Unexpected download");
        });
        await expect(
          createWorkflowArtifactReads(run).downloadWorkflowArtifact(
            "org/app",
            artifact,
            reason === "elapsed" ? context.limit(0) : context
          )
        ).rejects.toMatchObject({ reason });
        expect(run).not.toHaveBeenCalled();
      }
    );

    it("refuses a late subscriber before waiting without stopping the admitting download", async () => {
      vi.useFakeTimers();
      const session = createWorkflowReadSession();
      const owner = session.observe(30000);
      const joiner = session.observe(30000);
      joiner.chargeRetries(2);
      let calls = 0;
      const run: WorkflowRunner = async () => ({
        code: ++calls < 3 ? 1 : 0,
        stdout:
          calls < 3 ? "HTTP/2 503\n\n{}" : (
            `HTTP/2 200\n\n${JSON.stringify({ artifacts: [artifact] })}`
          ),
        stderr: ""
      });
      const pending = deferred();
      const download = vi.fn(async () => {
        await pending.promise;
        return { [DEPLOY_STATUS_FILES.progress]: JSON.stringify(progress) };
      });
      const reader = createDeployStatusReader({
        repo: "org/app",
        runId: 41,
        listArtifacts: createWorkflowArtifactReads(run).listWorkflowArtifacts,
        downloadArtifact: download
      });
      const admitting = reader.read(owner);
      await vi.advanceTimersByTimeAsync(2000);
      expect(download).toHaveBeenCalledTimes(1);
      expect(await reader.read(joiner)).toMatchObject({
        status: "error",
        error: { reason: "attempts" }
      });
      pending.resolve();
      expect(await admitting).toMatchObject({ status: "ok" });
      expect(await reader.progress(joiner)).toBeNull();
      expect(await reader.graph(joiner)).toMatchObject({
        status: "error",
        graph: null,
        artifact: null
      });
      expect(await reader.controlPlaneLog(joiner)).toBeNull();
      expect(calls).toBe(3);
      expect(download).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      { runId: 41, foreignMalformed: false },
      { runId: null, foreignMalformed: false },
      { runId: null, foreignMalformed: true }
    ])(
      "retains only unretired accepted evidence after refusing a newer flight (run $runId, foreign malformed $foreignMalformed)",
      async ({ runId, foreignMalformed }) => {
        vi.useFakeTimers();
        const session = createWorkflowReadSession();
        const owner = session.observe(120000);
        const joiner = session.observe(120000);
        expect(joiner.chargeRetries(1)).toBe(true);
        let calls = 0;
        const run = vi.fn<WorkflowRunner>(async () => {
          calls++;
          const failure =
            calls === 2 || calls === 3 || calls === 6 || calls === 7;
          return {
            code: failure ? 1 : 0,
            stdout:
              failure ? "HTTP/2 503\n\n{}" : (
                `HTTP/2 200\n${calls === 4 ? "Retry-After: 60\n" : ""}\n${JSON.stringify(
                  {
                    artifacts:
                      calls === 5 ?
                        foreignMalformed ?
                          [
                            {
                              ...artifact,
                              id: 99,
                              name: "radius-deploy-status-dev-other"
                            }
                          ]
                        : []
                      : [
                          {
                            ...artifact,
                            id:
                              calls === 1 ? 12
                              : calls === 8 ? 14
                              : 13
                          }
                        ]
                  }
                )}`
              ),
            stderr: ""
          };
        });
        const reads = createWorkflowArtifactReads(run);
        const download = vi.fn(
          async (_repo: string, candidate: { id: number }) => ({
            [DEPLOY_STATUS_FILES.progress]: JSON.stringify({
              ...progress,
              application: candidate.id === 99 ? "other" : "app",
              sequence: candidate.id - 11
            }),
            [DEPLOY_STATUS_FILES.graph]:
              candidate.id === 99 ?
                "{broken"
              : JSON.stringify({
                  resources: [{ name: `api-${candidate.id}` }]
                }),
            [DEPLOY_STATUS_FILES.controlPlane]: `diagnostic-${candidate.id}`
          })
        );
        const reader = createDeployStatusReader({
          repo: "org/app",
          runId,
          application: "app",
          ttlMs: 100,
          listArtifacts: reads.listWorkflowArtifacts,
          downloadArtifact: download
        });
        expect(await reader.read(joiner)).toMatchObject({
          status: "ok",
          progress: { sequence: 1 }
        });
        await vi.advanceTimersByTimeAsync(101);
        const admitted = reader.read(owner);
        const refused = reader.read(joiner);
        await vi.runAllTimersAsync();
        expect(await admitted).toMatchObject({
          status: "ok",
          progress: { sequence: 2 }
        });
        expect(await refused).toMatchObject({
          status: "error",
          error: { reason: "attempts" }
        });
        expect(await reader.read(joiner.limit(10000))).toMatchObject({
          status: "error",
          error: { reason: "attempts" }
        });
        expect(await reader.progress(joiner)).toMatchObject({ sequence: 1 });
        expect(await reader.controlPlaneLog(joiner)).toBe("diagnostic-12");
        expect(await reader.graph(joiner)).toMatchObject({
          status: "error",
          graph: { resources: [{ name: "api-12" }] }
        });

        const independent = session.observe(30000);
        expect(await reader.read(independent)).toMatchObject({
          status: "ok",
          progress: { sequence: 2 }
        });
        await expect(
          reads.listWorkflowArtifacts("org/app", runId, undefined, independent)
        ).rejects.toMatchObject({
          decision: { state: "deferred", reason: "not-before" }
        });
        expect(run).toHaveBeenCalledTimes(4);
        expect(download).toHaveBeenCalledTimes(2);
        if (runId === null) {
          await vi.advanceTimersByTimeAsync(60100);
          expect(await reader.read(session.observe(30000))).toMatchObject({
            status: "missing"
          });
          expect(reader.sequence).toBe(-1);
          await vi.advanceTimersByTimeAsync(101);
          expect(await reader.graph(joiner)).toMatchObject({
            status: "error",
            graph: null,
            artifact: null
          });
          expect(await reader.progress(joiner)).toBeNull();
          expect(await reader.controlPlaneLog(joiner)).toBeNull();
          expect(run).toHaveBeenCalledTimes(6);
          expect(download).toHaveBeenCalledTimes(foreignMalformed ? 3 : 2);
          await vi.advanceTimersByTimeAsync(101);
          const replacement = reader.read(session.observe(30000));
          const secondRefusal = reader.read(joiner);
          await vi.runAllTimersAsync();
          expect(await replacement).toMatchObject({
            status: "ok",
            progress: { sequence: 3 }
          });
          expect(await secondRefusal).toMatchObject({
            status: "error",
            error: { reason: "attempts" }
          });
          expect(await reader.graph(joiner)).toMatchObject({
            status: "error",
            graph: null,
            artifact: null
          });
          expect(await reader.progress(joiner)).toBeNull();
          expect(await reader.controlPlaneLog(joiner)).toBeNull();
          expect(run).toHaveBeenCalledTimes(8);
          expect(download).toHaveBeenCalledTimes(foreignMalformed ? 4 : 3);
        }
        expect(vi.getTimerCount()).toBe(0);
      }
    );

    it("keeps a joiner's later flight on its own original deadline", async () => {
      vi.useFakeTimers();
      const session = createWorkflowReadSession();
      const timeouts: number[] = [];
      const reader = createWorkflowArtifactReader(
        { repo: "org/app", runId: 41, session, ttlMs: 0 },
        async (_args, options) => {
          timeouts.push(options.timeout);
          return {
            code: 0,
            stdout: 'HTTP/2 200\n\n{"artifacts":[]}',
            stderr: ""
          };
        }
      );
      const owner = session.observe(1000);
      const joiner = session.observe(2000000);
      await Promise.all([reader.read(owner), reader.read(joiner)]);
      await vi.advanceTimersByTimeAsync(1001);
      expect(await reader.read(joiner)).toMatchObject({ status: "missing" });
      expect(timeouts).toEqual([1000, 20000]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("defers a subscriber without credits without cancelling the owner's valid retried result", async () => {
      vi.useFakeTimers();
      const session = createWorkflowReadSession();
      const owner = session.observe(30000);
      const joiner = session.observe(30000);
      expect(joiner.chargeRetries(2)).toBe(true);
      let calls = 0;
      const reader = createWorkflowArtifactReader(
        { repo: "org/app", runId: 41, session, ttlMs: 0 },
        async () => ({
          code: ++calls === 1 ? 1 : 0,
          stdout:
            calls === 1 ? "HTTP/2 503\n\n{}" : 'HTTP/2 200\n\n{"artifacts":[]}',
          stderr: ""
        })
      );
      const first = reader.read(owner);
      const second = reader.read(joiner);
      await vi.runAllTimersAsync();
      expect(await first).toMatchObject({ status: "missing" });
      expect(await second).toMatchObject({
        status: "error",
        error: { decision: { state: "exhausted", reason: "attempts" } }
      });
      expect(calls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("deduplicates shared-flight charges across projections of one observation", async () => {
      vi.useFakeTimers();
      const session = createWorkflowReadSession();
      const owner = session.observe(30000);
      const joiner = session.observe(30000);
      let calls = 0;
      const reader = createWorkflowArtifactReader(
        { repo: "org/app", runId: 41, session, ttlMs: 0 },
        async () => {
          const failure = ++calls % 2 === 1;
          return {
            code: failure ? 1 : 0,
            stdout:
              failure ? "HTTP/2 503\n\n{}" : 'HTTP/2 200\n\n{"artifacts":[]}',
            stderr: ""
          };
        }
      );
      const initial = Promise.all([
        reader.read(owner),
        reader.read(joiner),
        reader.graph(joiner.limit(25000))
      ]);
      await vi.runAllTimersAsync();
      await initial;
      const later = reader.read(joiner);
      await vi.runAllTimersAsync();
      expect(await later).toMatchObject({ status: "missing" });
      expect(calls).toBe(4);
      expect(vi.getTimerCount()).toBe(0);
    });
    it.each(["cancelled", "elapsed"] as const)(
      "detaches a %s subscriber without aborting another observer's flight",
      async (reason) => {
        vi.useFakeTimers();
        const session = createWorkflowReadSession();
        const controller = new AbortController();
        const waiting = deferred();
        const started = deferred();
        let signal: AbortSignal | undefined;
        const run = vi.fn<WorkflowRunner>(async (_args, options) => {
          signal = options.signal;
          started.resolve();
          await waiting.promise;
          return {
            code: 0,
            stdout: 'HTTP/2 200\n\n{"artifacts":[]}',
            stderr: ""
          };
        });
        const reader = createWorkflowArtifactReader(
          { repo: "org/app", runId: 41, session },
          run
        );
        const first = reader.read(session.observe(20000));
        await started.promise;
        const second = reader
          .read(session.observe(10, controller.signal))
          .catch((error: unknown) => error);
        if (reason === "cancelled") controller.abort();
        else await vi.advanceTimersByTimeAsync(10);
        expect(await second).toMatchObject({ reason });
        expect(signal?.aborted).toBe(false);
        waiting.resolve();
        expect(await first).toMatchObject({ status: "missing" });
        expect(run).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      }
    );

    it("does not acquire fresh retry credits when a joining observer later starts a finalization pass", async () => {
      vi.useFakeTimers();
      const session = createWorkflowReadSession();
      const firstContext = session.observe(30000);
      const secondContext = session.observe(30000);
      let calls = 0;
      const run = vi.fn<WorkflowRunner>(async () => {
        calls++;
        return {
          code: calls === 3 ? 0 : 1,
          stdout:
            calls === 3 ? 'HTTP/2 200\n\n{"artifacts":[]}' : "HTTP/2 503\n\n{}",
          stderr: ""
        };
      });
      const reader = createWorkflowArtifactReader(
        { repo: "org/app", runId: 41, session, ttlMs: 0 },
        run
      );
      const first = reader.read(firstContext);
      const joined = reader.read(secondContext);
      await vi.runAllTimersAsync();
      expect(await first).toMatchObject({ status: "missing" });
      expect(await joined).toMatchObject({ status: "missing" });
      const later = await reader.read(secondContext);
      expect(later).toMatchObject({
        status: "error",
        error: { decision: { state: "exhausted", reason: "attempts" } }
      });
      expect(calls).toBe(4);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not repeat a failed opaque candidate through graph/progress/control-plane convenience reads", async () => {
      vi.useFakeTimers();
      const session = createWorkflowReadSession();
      const context = session.observe(30000);
      const download = vi.fn(async () => {
        throw new Error("opaque failure");
      });
      const listing = vi.fn(async () => [artifact]);
      const reader = createWorkflowArtifactReader(
        {
          repo: "org/app",
          runId: 41,
          session,
          ttlMs: 0,
          listArtifacts: listing,
          downloadArtifact: download
        },
        async () => {
          throw new Error("Injected artifact ports own this read");
        }
      );
      expect(await reader.graph(context)).toMatchObject({ status: "error" });
      await reader.progress(context.limit(10000));
      await reader.controlPlaneLog(
        context.withCancellation({ stopped: () => false })
      );
      expect(listing).toHaveBeenCalledTimes(1);
      expect(download).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
  it("marks download metadata unavailable rather than parsing producer diagnostics", async () => {
    const fixture = downloadRunner((directory) => {
      writeFileSync(
        path.join(directory, DEPLOY_STATUS_FILES.controlPlane),
        "HTTP 429\nRetry-After: 1"
      );
    });
    expect(
      await createWorkflowArtifactReads(
        fixture.run
      ).downloadWorkflowArtifactWithMetadata("org/app", artifact)
    ).toEqual({
      value: { [DEPLOY_STATUS_FILES.controlPlane]: "HTTP 429\nRetry-After: 1" },
      metadata: { source: "unavailable", reason: "opaque-command" }
    });
    expect(existsSync(fixture.directory())).toBe(false);
  });
  it.each(["ok", "auth", "transport"] as const)(
    "reports cleanup failure without replacing the %s read outcome",
    async (mode) => {
      let directory = "";
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const cleanupError = Object.assign(new Error("busy file"), {
        code: "EBUSY"
      });
      const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
        throw cleanupError;
      });
      try {
        const reads = createWorkflowArtifactReads(async (args) => {
          directory = args[6];
          writeFileSync(
            path.join(directory, DEPLOY_STATUS_FILES.progress),
            JSON.stringify(progress)
          );
          return {
            code: mode === "ok" ? 0 : 1,
            stdout: "",
            stderr: mode === "auth" ? "HTTP 403" : "connection reset"
          };
        });
        const pending = reads.downloadWorkflowArtifact("org/app", artifact);
        if (mode === "ok")
          await expect(pending).resolves.toMatchObject({
            [DEPLOY_STATUS_FILES.progress]: JSON.stringify(progress)
          });
        else
          await expect(pending).rejects.toMatchObject({
            code: mode === "auth" ? "GH_ARTIFACT_AUTH" : "GH_ARTIFACT_TRANSPORT"
          });
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          "Could not remove temporary workflow artifact directory:",
          directory,
          cleanupError
        );
        expect(existsSync(directory)).toBe(true);
      } finally {
        remove.mockRestore();
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  );

  it("preserves the non-deployment delete-result document through the generic binding", async () => {
    let directory = "";
    const payload =
      '{"outcome":"failed","output":"in progress state: Updating","forced":false}';
    const reads = createWorkflowArtifactReads(async (args) => {
      directory = args[6];
      writeFileSync(path.join(directory, "rad-delete-result.json"), payload);
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(
      await reads.downloadWorkflowArtifact("org/app", {
        ...artifact,
        name: "rad-delete-result"
      })
    ).toEqual({ "rad-delete-result.json": payload });
    expect(existsSync(directory)).toBe(false);
  });
});

describe("direct workflow observer using production artifact binding", () => {
  it.each(["valid", "wrong-run", "wrong-app", "unsupported", "auth"] as const)(
    "preserves the confirmed primary failure with %s secondary evidence",
    async (mode) => {
      const directories: string[] = [];
      const run: WorkflowRunner = async (args) => {
        if (args[0] === "api" && args[1].includes("artifacts"))
          return {
            code: 0,
            stderr: "",
            stdout: "HTTP/2 200\n\n" + JSON.stringify({ artifacts: [artifact] })
          };
        if (args[0] === "api") {
          return {
            code: 0,
            stderr: "",
            stdout:
              "HTTP/2 200\n\n" +
              JSON.stringify(
                args[1].includes("/jobs") ?
                  {
                    total_count: 1,
                    jobs: [
                      {
                        name: "deploy",
                        steps: [
                          { name: "Run rad commands", conclusion: "failure" }
                        ]
                      }
                    ]
                  }
                : { status: "completed", conclusion: "failure" }
              )
          };
        }
        if (args[1] === "download") {
          directories.push(args[6]);
          if (mode === "auth")
            return { code: 1, stdout: "", stderr: "HTTP 403" };
          writeFileSync(
            path.join(args[6], DEPLOY_STATUS_FILES.progress),
            JSON.stringify({
              ...progress,
              runId: mode === "wrong-run" ? 99 : 41,
              application: mode === "wrong-app" ? "another" : "app",
              schemaVersion: mode === "unsupported" ? 2 : 1
            })
          );
          writeFileSync(
            path.join(args[6], DEPLOY_STATUS_FILES.controlPlane),
            "control-plane secondary"
          );
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] !== "run" || args[1] !== "view")
          throw new Error("Unexpected command");
        return {
          code: 0,
          stderr: "",
          stdout:
            "deploy\tRun rad commands\t2026-01-01 Error: { primary quota }"
        };
      };
      const target = { repo: "org/app", runId: 41 };
      const execution = { mode: "ambient" as const, run };
      const observed = await observeWorkflowRun(target, {
        readRun: (repo, runId) => readWorkflowRun(execution, repo, runId)
      });
      if (!observed) throw new Error("Expected observation");
      const reader = createWorkflowArtifactReader(
        { ...target, environment: "dev", application: "app" },
        run
      );
      const failure = await collectWorkflowFailure(
        target,
        observed,
        { resourcesTouched: true },
        {
          readLog: (repo, runId) => readWorkflowLog(execution, repo, runId),
          readControlPlaneLog: () => reader.controlPlaneLog()
        }
      );
      expect(confirmedWorkflowConclusion(observed)).toBe("failure");
      expect(failure.radiusError).toBe("Error: { primary quota }");
      expect(failure.message).toContain("Failed step: Run rad commands.");
      expect(await reader.controlPlaneLog()).toBe(
        mode === "valid" ? "control-plane secondary" : null
      );
      expect(directories).toHaveLength(1);
      expect(directories.every((directory) => !existsSync(directory))).toBe(
        true
      );
    }
  );
});
