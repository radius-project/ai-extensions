import { vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  createDeploymentExecutionOwner,
  type DeploymentTarget,
  type DeploymentExecutionOwner
} from "../../../src/runtime/deployment-execution-owner.js";
import { createProductionDeploymentController } from "../../../src/runtime/production-deployment-controller.js";
import { createWorkflowObservationScope } from "../../../src/server/services/workflow-observation-scope.js";
import type { DeployMonitorRequest } from "../../../src/server/services/deploy-monitor.js";
import type { CanvasState } from "../../../src/shared.js";
import type { DeploymentAccountResolver } from "../../../src/runtime/deployment-account.js";
import type { SelectedGhExecutor } from "../../../src/gh.js";
import { successfulSelectedGhExecutor } from "../server/selected-gh.js";
import { generateDeployWorkflow } from "../../../src/infra.js";

export function createDeploymentControllerHarness(
  options: {
    owner?: DeploymentExecutionOwner;
    run?: SelectedGhExecutor["run"];
  } = {}
) {
  let nextId = 0;
  const reportError = vi.fn();
  const owner =
    options.owner ??
    createDeploymentExecutionOwner({
      now: () => 1700000000000,
      newAttemptId: () => `attempt-${++nextId}`,
      reportError,
      createObservation: () =>
        createWorkflowObservationScope(() => {
          throw new Error("Artifact read not scripted.");
        })
    });
  const run = vi.fn<SelectedGhExecutor["run"]>(
    options.run ??
      (async (args) => {
        if (
          args[0] === "api" &&
          (args[1].includes("/variables?") || args[1].includes("/deployments?"))
        )
          return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "repo" && args[1] === "view")
          return { code: 0, stdout: "trunk", stderr: "" };
        throw new Error(`Unscripted GitHub command: ${JSON.stringify(args)}`);
      })
  );
  const executor = successfulSelectedGhExecutor({ login: "fixture-user", run });
  const account = vi.fn<DeploymentAccountResolver>(async () => ({
    state: "selected",
    login: executor.login,
    executor
  }));
  const monitor = vi.fn(async (request: DeployMonitorRequest) => {
    request.entry.state.deployStatus = "complete";
    request.entry.state.deployFinishedAt = 1700000060000;
  });
  const controller = createProductionDeploymentController({
    owner,
    account,
    reportError,
    monitorFor: () => ({ run: monitor })
  });
  const notify = vi.fn();
  const target: DeploymentTarget = {
    repo: "fixture/app",
    environment: "dev",
    branch: "feature/model",
    provider: "azure",
    appFile: ".radius/app.bicep",
    githubLogin: executor.login
  };
  function seed(
    state: CanvasState = {},
    overrides: Partial<DeploymentTarget> = {}
  ) {
    const selected = { ...target, ...overrides };
    const reservation = owner.reserve(selected, "deploy");
    if (!reservation) throw new Error("Could not reserve fixture target.");
    const begun = owner.begin({
      target: selected,
      executor,
      reservation,
      state: {
        deployStatus: "complete",
        envName: selected.environment,
        deployParams: {
          targetRepo: selected.repo,
          environment: selected.environment,
          branch: selected.branch,
          provider: selected.provider,
          appFile: selected.appFile
        },
        ...state
      }
    });
    owner.release(reservation);
    if (begun.kind !== "resolved") throw new Error(begun.kind);
    const execution = owner.execution(begun.invocation);
    if (!execution) throw new Error("Missing fixture execution.");
    return execution;
  }
  return {
    owner,
    run,
    executor,
    account,
    monitor,
    controller,
    notify,
    reportError,
    target,
    seed
  };
}

export function createDeploymentPipelineRunner(
  conclusion: "success" | "failure" | "uncertain",
  options: { existingEnvironment?: boolean } = {}
) {
  const templates = new Map(
    [
      "verify-aws.yml",
      "run-rad-commands.yml",
      "run-rad-commands-azure.yml",
      "delete-application.yml",
      "delete-azure.yml",
      "delete-environment.yml",
      "delete-environment-azure.yml"
    ].map((file) => [
      file,
      readFileSync(
        new URL(`../../../../../.github/extension/${file}`, import.meta.url),
        "utf8"
      )
    ])
  );
  let dispatched = false;
  let secretWritten = false;
  const unexpected: string[][] = [];
  const ok = (value: unknown) => ({
    code: 0,
    stdout: JSON.stringify(value),
    stderr: ""
  });
  const http = (value: unknown) => ({
    code: 0,
    stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(value)}`,
    stderr: ""
  });
  const run = vi.fn<SelectedGhExecutor["run"]>(async (args, commandOptions) => {
    if (
      args[0] === "api" &&
      args[1].startsWith(
        "/repos/radius-project/ai-extensions/contents/.github/extension/"
      )
    ) {
      const name = new URL(args[1], "https://api.github.test").pathname
        .split("/")
        .pop();
      const template = name && templates.get(name);
      if (!template) throw new Error(`Unscripted template ${name}`);
      return {
        code: 0,
        stdout: Buffer.from(template).toString("base64"),
        stderr: ""
      };
    }
    if (
      args[0] === "api" &&
      args[1].includes("/contents/") &&
      args[1].includes("recipe")
    )
      return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
    if (
      args[0] === "api" &&
      args[1] === "--method" &&
      args[2] === "PUT" &&
      args[3].startsWith("/repos/fixture/app/contents/")
    )
      if (options.existingEnvironment)
        throw new Error(
          "Existing-environment fixture forbids workflow writes."
        );
      else return ok({});
    const path = args[1];
    if (
      args[0] === "api" &&
      (path.startsWith("/repos/fixture/app/") ||
        path.startsWith("repos/fixture/app/"))
    ) {
      if (path.includes("/variables?") || path.includes("/deployments?"))
        return { code: 0, stdout: "", stderr: "" };
      if (path.includes("/git/ref/heads/"))
        return ok({ object: { sha: "a".repeat(40) } });
      if (path.includes("/contents/")) {
        const content =
          path.includes(".bicep?") ?
            (conclusion === "success" && !options.existingEnvironment ?
              "@secure()\nparam password string\n"
            : "") +
            "param environment string\n" +
            (conclusion !== "failure" ?
              "resource app 'Radius.Core/applications@2025-08-01' = { name: 'app' }"
            : "")
          : options.existingEnvironment ?
            (
              await generateDeployWorkflow(
                "dev",
                ".radius/app.bicep",
                {},
                async (name) => {
                  const template = templates.get(name);
                  if (!template) throw new Error(`Unscripted template ${name}`);
                  return template;
                }
              )
            )[
              new URL(path, "https://fixture.invalid").pathname
                .split("/")
                .at(-1) ?? ""
            ]
          : "name: Fixture workflow\non:\n  workflow_dispatch:\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps: []\n";
        if (!content) throw new Error(`Unscripted workflow ${path}`);
        return ok({
          type: "file",
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
          sha: "b".repeat(40)
        });
      }
      if (path.endsWith("/secrets")) {
        if (options.existingEnvironment)
          throw new Error("Existing-environment fixture forbids secret reads.");
        return ok([
          { secrets: secretWritten ? [{ name: "RADIUS_DEPLOY_PARAMS" }] : [] }
        ]);
      }
      if (path.includes("/artifacts?"))
        return args.includes("--include") ?
            http({ artifacts: [] })
          : ok({ artifacts: [] });
    }
    if (args[0] === "api" && path === "/repos/fixture/app")
      return ok({ default_branch: "trunk" });
    if (args[0] === "api" && path === "repos/fixture/app/actions/runs/42")
      return http({ id: 42, status: "completed", conclusion });
    if (
      args[0] === "api" &&
      path === "repos/fixture/app/actions/runs/42/jobs?per_page=100&page=1"
    )
      return http({
        total_count: 1,
        jobs: [
          {
            name: "Deploy",
            steps: [
              { name: "Run rad commands", status: "completed", conclusion }
            ]
          }
        ]
      });
    if (args.includes("fixture/app")) {
      if (args[0] === "secret" && args[1] === "set" && commandOptions?.stdin) {
        if (options.existingEnvironment)
          throw new Error(
            "Existing-environment fixture forbids secret writes."
          );
        secretWritten = true;
        return ok({});
      }
      if (args[0] === "workflow" && args[1] === "run") {
        dispatched = true;
        return conclusion === "uncertain" ?
            { code: 1, stdout: "", stderr: "request timed out" }
          : ok({});
      }
      if (args[0] === "run" && args[1] === "list")
        return ok(
          dispatched ?
            [
              {
                databaseId: 42,
                status: "completed",
                conclusion,
                createdAt: new Date().toISOString()
              }
            ]
          : []
        );
      if (args[0] === "run" && args[1] === "view" && args.includes("--log"))
        return {
          code: 0,
          stdout: "Run rad commands\tError: deployment failed",
          stderr: ""
        };
    }
    unexpected.push(args);
    throw new Error(`Unexpected command ${JSON.stringify(args)}`);
  });
  return { run, unexpected };
}
