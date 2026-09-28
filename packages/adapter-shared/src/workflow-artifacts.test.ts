import fs, { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_PAGE_SIZE,
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

const artifact = {
  id: 12,
  name: "radius-deploy-status-dev-app",
  workflow_run: { id: 41 }
};
afterEach(() => vi.restoreAllMocks());
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
        stdout: JSON.stringify({ artifacts }),
        stderr: ""
      }));
      const reads = createWorkflowArtifactReads(run);
      expect(await reads.listWorkflowArtifacts("org/app", 41)).toHaveLength(
        artifacts.length
      );
      expect(run).toHaveBeenCalledExactlyOnceWith(
        ["api", "/repos/org/app/actions/runs/41/artifacts?per_page=100"],
        { timeout: 20000 }
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
          stdout,
          stderr: ""
        })
      );
      const result = await reader.read();
      expect(result.status).toBe("malformed");
      expect(result.error).toMatchObject({ code: "GH_ARTIFACT_MALFORMED" });
      expect(await reader.graph()).toEqual({
        graph: null,
        status: "malformed",
        artifact: null
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
        stdout: JSON.stringify({
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
        stdout: '{"artifacts":[]}'
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
        if (args[0] === "api")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({ artifacts: [artifact] })
          };
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
            args[3] === "--log" ?
              "deploy\tRun rad commands\t2026-01-01 Error: { primary quota }"
            : JSON.stringify({
                status: "completed",
                conclusion: "failure",
                jobs: [
                  {
                    name: "deploy",
                    steps: [{ name: "Run rad commands", conclusion: "failure" }]
                  }
                ]
              })
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
