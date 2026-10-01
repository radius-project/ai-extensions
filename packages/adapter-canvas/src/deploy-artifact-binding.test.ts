import { existsSync, writeFileSync } from "node:fs";
import { ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliExec } from "./gh.js";
import {
  createDeployStatusReader,
  DEPLOY_STATUS_FILES
} from "./deploy-artifacts.js";

vi.mock("./gh.js", () => ({ cliExec: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe("Canvas artifact execution binding", () => {
  it.each([
    { allowApplicationFallback: undefined, status: "ok" },
    { allowApplicationFallback: false, status: "missing" }
  ] as const)(
    "applies Canvas repo-wide guessed-name policy: $allowApplicationFallback / $status",
    async ({ allowApplicationFallback, status }) => {
      const reader = createDeployStatusReader({
        repo: "org/app",
        environment: "dev",
        application: "guessed-from-repo",
        ...(allowApplicationFallback === undefined ?
          {}
        : { allowApplicationFallback }),
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

  it("binds local argv and temporary cleanup to the core reader with the ambient executor", async () => {
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
});
