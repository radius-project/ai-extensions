import { existsSync, writeFileSync } from "node:fs";
import { ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEPLOY_STATUS_FILES, redactCredentials } from "@radius-project/core";
import { createWorkflowReadSession } from "./workflow-read-budget.js";
import {
  createDeploymentObservationBindings,
  type DeploymentObservationExecutor
} from "./deployment-observation-bindings.js";

const cliExec = vi.fn<DeploymentObservationExecutor>(() => {
  throw new Error("Unexpected artifact command");
});
const {
  createDeployStatusReader,
  listWorkflowArtifacts,
  downloadWorkflowArtifact
} = createDeploymentObservationBindings({
  execute: cliExec,
  redactDiagnostic: (value) => redactCredentials(value, [process.env.GH_TOKEN])
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("deployment artifact execution binding", () => {
  it.each(["success", "unreadable"] as const)(
    "keeps repository/application fallback on the supplied executor when artifact bytes are %s",
    async (outcome) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        throw new Error("Unexpected direct network request");
      });
      vi.stubGlobal("fetch", fetch);
      let directory = "";
      cliExec.mockImplementation((command, args, _options, callback) => {
        expect(command).toBe("gh");
        if (args[0] === "api") {
          expect(args).toEqual([
            "api",
            "/repos/org/app/actions/artifacts?per_page=100&page=1",
            "--include",
            "--method",
            "GET"
          ]);
          callback(
            null,
            "HTTP/2 200\n\n" +
              JSON.stringify({
                artifacts: [
                  {
                    id: 1,
                    name: "radius-deploy-status-dev-actual",
                    workflow_run: { id: 41 }
                  }
                ]
              }),
            ""
          );
          return;
        }
        expect(args.slice(0, 6)).toEqual([
          "run",
          "download",
          "41",
          "--name",
          "radius-deploy-status-dev-actual",
          "--dir"
        ]);
        expect(args.slice(7)).toEqual(["--repo", "org/app"]);
        directory = args[6];
        if (outcome === "unreadable") {
          callback(
            new Error("download unavailable"),
            "",
            "Artifact download failed"
          );
          return;
        }
        writeFileSync(
          path.join(directory, DEPLOY_STATUS_FILES.progress),
          JSON.stringify({
            schemaVersion: 1,
            application: "actual",
            environment: "dev",
            runId: 41,
            sequence: 1,
            resources: []
          })
        );
        callback(null, "", "");
      });
      const reader = createDeployStatusReader({
        repo: "org/app",
        application: "guessed-from-repo",
        environment: "dev"
      });
      expect(await reader.read()).toMatchObject({
        status: outcome === "success" ? "ok" : "error",
        progress:
          outcome === "success" ?
            { application: "actual", environment: "dev", runId: 41 }
          : null
      });
      expect(cliExec).toHaveBeenCalledTimes(2);
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(directory)).toBe(false);
    }
  );

  it("retains caller-owned cooldowns across export calls without sharing them between instances", async () => {
    vi.useFakeTimers();
    const session = createWorkflowReadSession();
    const context = session.observe(30000);
    vi.mocked(cliExec).mockImplementation(
      (_file, _args, _options, callback) => {
        callback(null, 'HTTP/2 200\nRetry-After: 60\n\n{"artifacts":[]}', "");
        return new ChildProcess();
      }
    );
    expect(
      await listWorkflowArtifacts("org/app", 41, undefined, context)
    ).toEqual([]);
    for (const next of [context.limit(10000), session.observe(30000)]) {
      await expect(
        listWorkflowArtifacts("org/app", 41, undefined, next)
      ).rejects.toMatchObject({
        decision: { state: "deferred", reason: "not-before" }
      });
    }
    expect(cliExec).toHaveBeenCalledTimes(1);
    expect(
      await listWorkflowArtifacts(
        "org/app",
        41,
        undefined,
        createWorkflowReadSession().observe(30000)
      )
    ).toEqual([]);
    expect(cliExec).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { label: "omitted", options: {}, status: "ok" },
    {
      label: "explicit false",
      options: { allowApplicationFallback: false },
      status: "missing"
    },
    {
      label: "explicit undefined",
      options: { allowApplicationFallback: undefined },
      status: "ok"
    }
  ] as const)(
    "preserves repo-wide guessed-name policy with $label fallback",
    async ({ options, status }) => {
      const reader = createDeployStatusReader({
        repo: "org/app",
        environment: "dev",
        application: "guessed-from-repo",
        ...options,
        listArtifacts: async () => [
          {
            id: 1,
            name: "radius-deploy-status-dev-actual",
            workflow_run: { id: 41 }
          }
        ],
        downloadArtifact: async () => ({
          [DEPLOY_STATUS_FILES.progress]: JSON.stringify({
            schemaVersion: 1,
            application: "actual",
            environment: "dev",
            runId: 41,
            sequence: 1,
            resources: []
          })
        })
      });

      expect(await reader.read()).toMatchObject({
        status,
        progress:
          status === "ok" ? { application: "actual", environment: "dev" } : null
      });
      expect(cliExec).not.toHaveBeenCalled();
    }
  );

  it("retains useful artifact errors while redacting the host's opaque credential", async () => {
    vi.stubEnv("GH_TOKEN", "fixture-private-credential");
    vi.mocked(cliExec).mockImplementation(
      (_file, _args, _options, callback) => {
        callback(
          new Error("denied"),
          "HTTP/2.0 403 Forbidden\n\r\n{}",
          "SAML enforcement: grant your OAuth token access (fixture-private-credential)"
        );
        return new ChildProcess();
      }
    );
    await expect(listWorkflowArtifacts("org/app", 41)).rejects.toMatchObject({
      message: "SAML enforcement: grant your OAuth token access ([REDACTED])",
      code: "GH_ARTIFACT_AUTH",
      evidence: [{ response: { status: 403, classification: "authorization" } }]
    });
  });
  it("keeps an artifact with no downloadable run unavailable", async () => {
    expect(
      await downloadWorkflowArtifact("org/app", { id: 1, name: "artifact" })
    ).toBeNull();
    expect(cliExec).not.toHaveBeenCalled();
  });

  it("uses shared argv, validation and temporary cleanup with the ambient executor", async () => {
    let directory = "";
    vi.mocked(cliExec).mockImplementation((file, args, options, callback) => {
      expect(file).toBe("gh");
      if (args[0] === "api") {
        expect(args).toEqual([
          "api",
          "/repos/org/app/actions/runs/41/artifacts?per_page=100",
          "--include",
          "--method",
          "GET"
        ]);
        expect(options).toEqual({
          timeout: expect.any(Number),
          maxBuffer: 10 * 1024 * 1024,
          signal: expect.any(AbortSignal)
        });
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThanOrEqual(20000);
        callback(
          null,
          "HTTP/2 200\n\n" +
            JSON.stringify({
              artifacts: [
                {
                  id: 1,
                  name: "radius-deploy-status-dev-app",
                  workflow_run: { id: 41 }
                }
              ]
            }),
          ""
        );
      } else {
        expect(args.slice(0, 6)).toEqual([
          "run",
          "download",
          "41",
          "--name",
          "radius-deploy-status-dev-app",
          "--dir"
        ]);
        expect(args.slice(7)).toEqual(["--repo", "org/app"]);
        expect(options).toEqual({
          timeout: expect.any(Number),
          signal: expect.any(AbortSignal)
        });
        expect(options.timeout).toBeGreaterThan(0);
        expect(options.timeout).toBeLessThanOrEqual(60000);
        directory = args[6];
        writeFileSync(
          path.join(directory, DEPLOY_STATUS_FILES.progress),
          JSON.stringify({
            schemaVersion: 1,
            application: "app",
            environment: "dev",
            runId: 41,
            sequence: 1,
            resources: []
          })
        );
        callback(null, "", "");
      }
      return new ChildProcess();
    });
    const reader = createDeployStatusReader({
      repo: "org/app",
      runId: 41,
      application: "app",
      environment: "dev"
    });
    expect(await reader.read()).toMatchObject({
      status: "ok",
      progress: { runId: 41 }
    });
    expect(existsSync(directory)).toBe(false);
    expect(cliExec).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      error: Object.assign(new Error("original failure"), { code: 7 }),
      stderr: "HTTP 401",
      status: "auth"
    },
    { error: new Error("spawn unavailable"), stderr: "", status: "error" },
    { error: new Error(""), stderr: "", status: "error" }
  ])(
    "preserves ambient callback errors: $status / $stderr",
    async ({ error, stderr, status }) => {
      vi.mocked(cliExec).mockImplementation(
        (_file, _args, _options, callback) => {
          callback(error, "not authentication evidence", stderr);
          return new ChildProcess();
        }
      );
      const reader = createDeployStatusReader({ repo: "org/app" });
      expect(await reader.read()).toMatchObject({ status, progress: null });
    }
  );
});
