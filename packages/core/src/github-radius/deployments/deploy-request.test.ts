import { describe, expect, it, vi } from "vitest";
import { createDeployRequestService } from "./deploy-request.js";
import {
  createDeployDispatchService,
  type DeployCommandResult
} from "./deploy-dispatch.js";
import { createDeployMonitorService } from "./deploy-monitor.js";
import { createDeployOutcomeService } from "./deploy-outcome.js";
import {
  applyDeployMessages,
  applyDeployStatusToResources,
  buildDeployMessageMap,
  buildDeployStatusMap,
  createDeployStatusReader,
  settleDeployStatuses
} from "./deploy-artifacts.js";
import {
  activeDeploymentMutation,
  reserveDeploymentMutation,
  releaseDeploymentMutation,
  localDeploymentBlocksMutation,
  deploymentStatusBlocksMutation
} from "./mutation.js";
import {
  beginDeploymentAttempt,
  requestDeploymentRepair,
  resolveDeploymentRepair
} from "../repair/index.js";
import { observeDeployment } from "./observation.js";
import type { DeploymentResource, DeploymentState } from "./types.js";

function caller(
  options: {
    conclusion?: string;
    dispatch?: DeployCommandResult;
    runReadFailure?: boolean;
    state?: DeploymentState;
    cleanupFailure?: boolean;
    supersede?: boolean;
  } = {}
) {
  const state: DeploymentState = options.state || {
    plannedResources: [{ name: "app", type: "Applications.Core/containers" }]
  };
  const commands: string[][] = [];
  const events: string[] = [];
  const redact = (text: string) =>
    text.replaceAll("opaque-value", "[REDACTED]");
  let complete = () => {};
  const settled = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const dispatch = createDeployDispatchService({
    deployWorkflowFile: "deploy.yml",
    deployWorkflowFiles: ["deploy.yml", "deploy-aws.yml"],
    branchNotPushedKind: "branch-not-pushed",
    oidcSubjectMissingKind: "oidc-subject-missing",
    oidcSubjectCaseMismatchKind: "oidc-subject-case-mismatch",
    getBranchHeadSha: async () => "committed-source",
    getDefaultBranch: async () => {
      throw new Error("Unexpected default branch read");
    },
    runGh: async (args) => {
      commands.push(args);
      return options.dispatch || { code: 0, stdout: "", stderr: "" };
    },
    runGhWithStdin: async () => {
      throw new Error("Unexpected secret write");
    },
    runAz: async () => {
      throw new Error("Unexpected Azure access");
    },
    runGitHubJson: async () => {
      throw new Error("Unexpected OIDC read");
    },
    readProcessEnv: () => ({}),
    ghCredentialSource: () => "keyring",
    fetchFileForSelection: async () =>
      "resource app 'Applications.Core/applications@2023-10-01-preview' = { name: 'app' }",
    appParams: () => [],
    resolveDeployParams: () => ({}),
    partitionParams: () => ({ public: {}, secret: {} }),
    extractAppName: () => "app",
    buildDeployRadCommand: (_file, environment) =>
      "rad deploy --environment " + environment,
    buildAppGraphRadCommand: () => "rad app graph app",
    ensureDeployWorkflowsOnBranch: async () => {
      events.push("publish");
    },
    ensureWorkflowsCurrent: async () => {
      events.push("sync");
    },
    latestWorkflowRunId: async () => 10,
    classifyDeployDispatchFailure: () => "run-unconfirmed",
    uncommittedGeneratedPaths: async () => [],
    invalidateDeployListCache: () => {
      events.push("invalidate");
    },
    errorMessage: String,
    now: () => 100
  });
  const outcome = createDeployOutcomeService({
    settleDeployStatuses,
    fetchRunLog: async () => "recipe failed opaque-value",
    redactDiagnostics: redact,
    extractGitHubActionsStepLog: () => "",
    explainOidcEnterpriseClaim: () => "",
    extractRadDeployError: (log) => log || "",
    classifyDeployCloudAuthDrift: () => "",
    cloudAuthDriftKind: "cloud-auth-drift",
    sleep: async () => {},
    now: () => 200
  });
  const monitor = createDeployMonitorService({
    plannedGraph: {
      recover: async () => {
        throw new Error("Unexpected graph authoring");
      }
    },
    dispatch,
    outcome,
    deployRadCommandsStep: "Run rad commands",
    unconfirmedRunKind: "run-unconfirmed",
    findWorkflowRun: async (_repo, _workflow, _since, _known, after) => {
      expect(after).toBe(10);
      events.push("discover");
      return 11;
    },
    getRunDetail: async () => {
      if (options.supersede) {
        state.deployAttempt = { id: "replacement" };
        state.deployGeneration = 2;
        state.deployLogs = ["new attempt"];
        state.deployStatus = "in_progress";
      }
      if (options.runReadFailure) throw new Error("read failed opaque-value");
      return {
        status: "completed",
        conclusion: options.conclusion || "success",
        steps: []
      };
    },
    createStatusReader: async () =>
      createDeployStatusReader({
        repo: "acme/app",
        environment: "dev",
        application: "app",
        runId: 11,
        listArtifacts: async () => [],
        downloadArtifact: async () => {
          throw new Error("Unexpected download");
        },
        now: () => 100
      }),
    buildDeployStatusMap,
    buildDeployMessageMap,
    applyDeployMessages,
    applyDeployStatusToResources,
    settleDeployStatuses,
    generatePortalUrl: () => "",
    redactDiagnostics: redact,
    optionalString: (value) => (typeof value === "string" ? value : ""),
    errorMessage: String,
    sleep: async () => {},
    now: () => 100
  });
  const onSettled = vi.fn(() => {
    complete();
    if (options.cleanupFailure) throw new Error("follow-up failed");
  });
  const service = createDeployRequestService({
    resolveDeployRepairLoop: (record, id) =>
      resolveDeploymentRepair(record, id, 5),
    activeDeploymentMutation: (record) => activeDeploymentMutation(record, 100),
    localDeploymentBlocksMutation: (record) =>
      localDeploymentBlocksMutation(record, 100),
    reserveDeploymentMutation: (record, target) =>
      reserveDeploymentMutation(record, target, 100),
    releaseDeploymentMutation,
    deploymentStatusBlocksMutation,
    resolveEnvDeployment: async () => null,
    runCommand: async () => {
      throw new Error("An explicit branch must not read the default");
    },
    canvasGraphResources: (values) =>
      values.filter(
        (value): value is DeploymentResource =>
          typeof value === "object" && value !== null
      ),
    beginDeployAttempt: (record, input) =>
      beginDeploymentAttempt(record, input, () => "attempt-1"),
    onSettled,
    monitor: {
      async run(request) {
        try {
          await monitor.run(request);
        } finally {
          request.log("monitor complete");
        }
      }
    },
    unconfirmedRunKind: "run-unconfirmed",
    repairAttemptCap: 5,
    errorMessage: String,
    redactDiagnostics: redact
  });
  const input = {
    state,
    target: { repo: "acme/app", environment: "dev", provider: "aws" },
    source: {
      repo: "acme/app",
      branch: "feature",
      appFile: ".radius/app.bicep"
    }
  };
  return { state, service, input, settled, events, commands, onSettled };
}

describe("independent deployment caller conformance", () => {
  it.each([
    "repository",
    "environment",
    "branch",
    "provider",
    "appFile"
  ] as const)(
    "refuses a repair redirected to a different %s",
    async (field) => {
      const run = caller({ conclusion: "failure" });
      await run.service.deploy(run.input);
      await run.settled;
      const next = {
        ...run.input,
        target: { ...run.input.target },
        source: { ...run.input.source },
        attemptId: "attempt-1"
      };
      if (field === "repository") {
        next.target.repo = "different/repo";
        next.source.repo = "different/repo";
      }
      if (field === "environment") next.target.environment = "different";
      if (field === "branch") next.source.branch = "different";
      if (field === "provider") next.target.provider = "azure";
      if (field === "appFile") next.source.appFile = "different.bicep";
      expect(await run.service.deploy(next)).toMatchObject({
        status: 409,
        body: { error: expect.stringContaining("bound to its original") }
      });
      expect(run.commands).toHaveLength(1);
    }
  );
  it.each([false, true])(
    "drops late monitor completion or failure after replacement (failure: %s)",
    async (runReadFailure) => {
      const run = caller({ supersede: true, runReadFailure });
      await run.service.deploy(run.input);
      await vi.waitFor(() =>
        expect(run.state.deploymentMutation).toBeUndefined()
      );
      expect(run.state).toMatchObject({
        deployAttempt: { id: "replacement" },
        deployStatus: "in_progress",
        deployLogs: ["new attempt"]
      });
      expect(run.onSettled).not.toHaveBeenCalled();
      expect(run.state.deployError).toBeNull();
    }
  );
  it("executes real admission, dispatch, observation and outcome without an HTTP server or instance registry", async () => {
    const run = caller();
    expect(await run.service.deploy(run.input)).toEqual({
      status: 200,
      body: { ok: true }
    });
    await run.settled;
    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]).toContain("feature");
    expect(run.events).toEqual(["publish", "sync", "invalidate", "discover"]);
    expect(observeDeployment(run.state)).toMatchObject({
      status: "complete",
      deployRunUrl: "https://github.com/acme/app/actions/runs/11",
      attempt: { id: "attempt-1", branch: "feature" }
    });
    expect(run.state.deploymentMutation).toBeUndefined();
  });

  it("keeps confirmed failure separate from explicit repair and redacts diagnostic evidence", async () => {
    const run = caller({ conclusion: "failure" });
    await run.service.deploy(run.input);
    await run.settled;
    const observation = observeDeployment(run.state);
    expect(observation).toMatchObject({ status: "failed", repairing: false });
    expect(observation.error).toContain("[REDACTED]");
    expect(JSON.stringify(observation)).not.toContain("opaque-value");
    const deliver = vi.fn(() => {});
    expect(
      requestDeploymentRepair(run.state, "acme/app", {
        deliver,
        scheduleRetry: () => {},
        reportError: () => {}
      })
    ).toBe(true);
    await Promise.resolve();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: "attempt-1", branch: "feature" })
    );
    expect(run.state.deployRepairing).toBe(true);
    expect(resolveDeploymentRepair(run.state, "attempt-1", 5)).toMatchObject({
      repairLoop: true,
      repairAttempt: 1
    });
  });

  it.each([
    { dispatch: { code: 1, stdout: "", stderr: "timeout", timedOut: true } },
    { runReadFailure: true }
  ])(
    "never starts repair or replays a mutation after uncertain execution: %j",
    async (options) => {
      const run = caller(options);
      await run.service.deploy(run.input);
      await run.settled;
      expect(run.state).toMatchObject({
        deployStatus: "failed",
        deployErrorKind: "run-unconfirmed"
      });
      expect(run.commands).toHaveLength(1);
      const again = await run.service.deploy({
        ...run.input,
        attemptId: "attempt-1"
      });
      expect(again.status).toBe(409);
      expect(run.commands).toHaveLength(1);
      expect(
        requestDeploymentRepair(run.state, "acme/app", {
          deliver: () => {
            throw new Error("Must not repair uncertainty");
          },
          scheduleRetry: () => {},
          reportError: () => {}
        })
      ).toBe(false);
    }
  );

  it("refuses mismatched source repositories and stale attempts before side effects", async () => {
    const run = caller();
    expect(
      (
        await run.service.deploy({
          ...run.input,
          source: { ...run.input.source, repo: "other/app" }
        })
      ).status
    ).toBe(400);
    expect(
      (await run.service.deploy({ ...run.input, attemptId: "superseded" }))
        .status
    ).toBe(409);
    expect(run.commands).toEqual([]);
    expect(run.state.deploymentMutation).toBeUndefined();
  });

  it("retains the deployment outcome and releases its reservation when host follow-up fails", async () => {
    const run = caller({ conclusion: "failure", cleanupFailure: true });
    await run.service.deploy(run.input);
    await run.settled;
    await Promise.resolve();
    await Promise.resolve();
    expect(run.state.deploymentMutation).toBeUndefined();
    expect(run.state.deployError).toContain("recipe failed");
    expect(run.state.deployLogs?.join("\n")).toContain(
      "Deployment follow-up failed"
    );
  });
});
