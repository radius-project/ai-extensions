import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createDeploymentObservationBindings,
  type DeploymentObservationExecutor
} from "@radius-project/adapter-shared";
import { redactCredentials } from "@radius-project/core";
import { probeDeleteConflict } from "./server/services/delete-conflict.js";

it("retains force-delete conflict proof through the real shared artifact binding", async () => {
  let directory = "";
  const execute: DeploymentObservationExecutor = (
    _file,
    args,
    _options,
    callback
  ) => {
    if (args[0] === "api") {
      callback(
        null,
        "HTTP/2 200\n\n" +
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
  };
  const { listWorkflowArtifacts, downloadWorkflowArtifact } =
    createDeploymentObservationBindings({
      execute,
      redactDiagnostic: redactCredentials
    });
  expect(
    await probeDeleteConflict(
      { repo: "org/app", environment: "dev", application: "app" },
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
