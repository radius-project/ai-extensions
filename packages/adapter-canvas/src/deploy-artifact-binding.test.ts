import { existsSync, writeFileSync } from "node:fs";
import { ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliExec } from "./gh.js";
import {
  createDeployStatusReader,
  DEPLOY_STATUS_FILES,
  listWorkflowArtifacts,
  downloadWorkflowArtifact
} from "./deploy-artifacts.js";
import { probeDeleteConflict } from "./server/services/delete-conflict.js";

vi.mock("./gh.js", () => ({ cliExec: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe("Canvas artifact execution binding", () => {
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

  it("retains force-delete conflict proof through the real generic artifact binding", async () => {
    let directory = "";
    vi.mocked(cliExec).mockImplementation((_file, args, _options, callback) => {
      if (args[0] === "api") {
        callback(
          null,
          JSON.stringify({
            artifacts: [
              {
                id: 1,
                name: "rad-delete-result",
                workflow_run: { id: 41 },
                created_at: null
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
          "rad-delete-result",
          "--dir"
        ]);
        directory = args[6];
        writeFileSync(
          path.join(directory, "rad-delete-result.json"),
          JSON.stringify({
            outcome: "failed",
            output: "in progress state: Updating",
            forced: false
          })
        );
        callback(null, "", "");
      }
      return new ChildProcess();
    });
    expect(
      await probeDeleteConflict(
        {
          repo: "org/app",
          environment: "dev",
          application: "app"
        },
        {
          resolveEnvDeployment: async () => ({
            app: "app",
            environment: "dev",
            provider: "azure",
            status: "delete-failed",
            deploymentId: "7",
            runUrl: "https://github.com/org/app/actions/runs/41"
          }),
          listArtifacts: listWorkflowArtifacts,
          downloadArtifact: downloadWorkflowArtifact
        }
      )
    ).toEqual({ state: "conflict", resourceState: "Updating", forced: false });
    expect(existsSync(directory)).toBe(false);
  });

  it("uses shared argv, validation and temporary cleanup with the ambient executor", async () => {
    let directory = "";
    vi.mocked(cliExec).mockImplementation((file, args, options, callback) => {
      expect(file).toBe("gh");
      if (args[0] === "api") {
        expect(args).toEqual([
          "api",
          "/repos/org/app/actions/runs/41/artifacts?per_page=100"
        ]);
        expect(options).toEqual({ timeout: 20000 });
        callback(
          null,
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
        expect(options).toEqual({ timeout: 60000 });
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
