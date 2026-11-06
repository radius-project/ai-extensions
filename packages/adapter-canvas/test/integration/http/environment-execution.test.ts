import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createProductionGitHubAccountContext } from "../../../src/runtime/production-github-account-context.js";
import { createEnvironmentAccountContext } from "../../../src/runtime/environment-account-context.js";
import { createGitHubAccountCoordinator } from "../../../src/server/services/github-account-coordinator.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import * as gh from "../../../src/gh.js";
import { createProductionCanvasServerRuntime } from "../../../src/server.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { createFakeDeploymentRuntime } from "../../support/runtime/deployment.js";
import {
  configureOperationStore,
  createOperation,
  fromPersistedOperation,
  toPersistedOperation,
  reconcileRestoredOperation,
  projectOperationActions,
  recordGitHubEnvironment,
  recordAwsRole,
  recordAwsRolePolicy,
  recordCommittedWorkflowFile,
  recordCommitState,
  recordAzureApp,
  requireInput,
  finish,
  pauseForProviderRestart,
  onOperationTerminal,
  operations,
  setContext,
  OPERATION_SCHEMA_VERSION,
  setVerificationWorkflowState,
  STAGE_DELETE_RADIUS_ENV,
  STAGE_AUTHORIZE_IDENTITY,
  STAGE_VERIFY,
  buildStages,
  enterStage,
  setExecutionActive,
  prepareProviderMutation,
  requestStop,
  shouldStop,
  stopAtBoundary,
  STAGE_CONFIGURE_ENVIRONMENT,
  STAGE_DELETE_STATE_PACKAGE
} from "../../../src/operations.js";
import { executeRecoverableMutation } from "../../../src/server/services/provider-mutation-recovery.js";
import {
  disabledOperationStore,
  parseOperationsEnvelope,
  type PersistedOperationsEnvelope
} from "../../../src/operation-store.js";

afterEach(async () => {
  onOperationTerminal(null);
  vi.restoreAllMocks();
  operations.clear();
  await configureOperationStore(disabledOperationStore());
});

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("production environment owner HTTP binding", () => {
  it.each(
    ["coordinator", "configuration"].flatMap((caller) =>
      ["user", "repos/fixture/app"].flatMap((path) =>
        [false, true].map((reject) => ({ caller, path, reject }))
      )
    )
  )(
    "fences $caller preflight after HTTP resume holds $path (reject=$reject)",
    async ({ caller, path, reject }) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = deferred();
      const gate = deferred();
      let activeLogin = "original";
      let preflights = 0;
      const run = vi.fn(async (args: string[]) => {
        const command = args.join(" ");
        if (command === "api user") preflights++;
        if (
          args[0] === "api" &&
          args[1] === path &&
          preflights === (caller === "coordinator" ? 1 : 2)
        ) {
          entered.resolve();
          await gate.promise;
          if (reject) throw new Error("Held preflight read rejected");
        }
        if (command === "api user")
          return { code: 0, stdout: '{"login":"saved-account"}', stderr: "" };
        if (command === "api repos/fixture/app")
          return {
            code: 0,
            stdout: '{"permissions":{"admin":true}}',
            stderr: ""
          };
        if (command === "api /repos/fixture/app/environments/dev")
          return { code: 0, stdout: '{"name":"dev","id":17}', stderr: "" };
        if (
          command.startsWith("api --paginate /repos/fixture/app/environments")
        )
          return { code: 0, stdout: "", stderr: "" };
        throw new Error(`Unexpected subsequent command: ${command}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        run
      });
      const packages = vi.spyOn(executor, "packageCredentials");
      const switchAccount = vi.fn(async (login: string) => {
        activeLogin = login;
        return { ok: true };
      });
      const accounts = createGitHubAccountCoordinator({
        createExecutor: async () => executor,
        getActiveKeyringLogin: async () => activeLogin,
        switchKeyringAccount: switchAccount,
        resetIdentityCache() {}
      });
      const accountContext = createEnvironmentAccountContext(
        "http-preflight",
        accounts
      );
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      const cli = vi.spyOn(gh, "cliExec").mockImplementation(() => {
        throw new Error("Unexpected ambient CLI or mutation");
      });
      const entry = await runtime.getOrCreateServer("preflight", "environment");
      const op = createOperation({
        operationId: "http-preflight",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.context.githubLogin = executor.login;
      op.currentStage = STAGE_AUTHORIZE_IDENTITY;
      op.request = { needsAzureCredentials: false, azure: {}, environment: {} };
      requireInput(op, {
        code: "app-selection-required",
        message: "Choose an app.",
        checkpoint: "azure-app-selection"
      });
      operations.put(op);
      vi.spyOn(operations, "persist").mockResolvedValue(undefined);
      let done = Promise.resolve();
      try {
        const response = await fetch(
          `${entry.baseUrl}/api/operations/${op.operationId}/resume/app-selection-required`,
          {
            method: "POST",
            headers: {
              origin: entry.baseUrl,
              "sec-fetch-site": "same-origin",
              "x-radius-mutation-nonce": String(
                entry.state.browserMutationNonce
              ),
              "content-type": "application/json"
            },
            body: JSON.stringify({
              repo: op.repo,
              environment: op.environment,
              provider: op.provider,
              checkpoint: "azure-app-selection",
              createNew: true
            })
          }
        );
        expect(response.status).toBe(202);
        await entered.promise;
        done = new Promise<void>((resolve) => {
          const stop = owner.onEnvironmentTasksSettled("preflight", () => {
            stop();
            resolve();
          });
        });
        expect(op.failure).toBeNull();
        expect(preflights).toBe(caller === "coordinator" ? 1 : 2);
        expect(accountContext.getExecutor(op.operationId)).toBe(executor);
        const issuedReads = run.mock.calls.length;
        const packageChecks = packages.mock.calls.length;
        owner.shutdown();
        expect(activeLogin).toBe("saved-account");
        expect(switchAccount).toHaveBeenCalledTimes(1);
        gate.resolve();
        await done;
        expect(run).toHaveBeenCalledTimes(issuedReads);
        expect(packages).toHaveBeenCalledTimes(packageChecks);
        expect(cli).not.toHaveBeenCalled();
        expect(op.failure).toBeNull();
        expect(op.endedAt).toBeNull();
        expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
        expect(activeLogin).toBe("original");
        expect(switchAccount.mock.calls).toEqual([
          ["saved-account"],
          ["original"]
        ]);
        await expect(
          accounts.withSelectedAccount(
            "saved-account",
            { ownerKey: "next" },
            async () => "released"
          )
        ).resolves.toMatchObject({
          value: "released",
          restoration: { state: "restored" }
        });
      } finally {
        gate.resolve();
        await done;
        owner.shutdown();
        await runtime.stopServer("preflight", true);
      }
    }
  );

  it("returns unavailable GHCR readiness without a selection handle or scope repair over HTTP", async () => {
    const executor = successfulSelectedGhExecutor({
      requiresKeyringSwitch: false,
      run: async (args) => {
        if (args.join(" ") !== "api repos/fixture/app")
          throw new Error("Unexpected repository command");
        return {
          code: 0,
          stdout: '{"permissions":{"admin":true}}',
          stderr: ""
        };
      }
    });
    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async () => executor,
      getActiveKeyringLogin: async () => executor.login,
      switchKeyringAccount: async () => {
        throw new Error("Unexpected switch");
      },
      resetIdentityCache() {}
    });
    const owner = createEnvironmentExecutionOwner();
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      accountContext: createEnvironmentAccountContext(
        "http-readiness",
        coordinator
      )
    });
    const loopbackFetch = globalThis.fetch;
    const registry = vi.fn(
      async () => new Response("client_secret=fixture-value", { status: 503 })
    );
    vi.stubGlobal(
      "fetch",
      (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).startsWith("https://ghcr.io/")) return registry();
        if (String(input).startsWith("http://127.0.0.1:"))
          return loopbackFetch(input, init);
        throw new Error("Unexpected network destination");
      }
    );
    try {
      const entry = await runtime.getOrCreateServer("readiness", "environment");
      const response = await fetch(`${entry.baseUrl}/api/github-account`, {
        method: "POST",
        headers: {
          origin: entry.baseUrl,
          "sec-fetch-site": "same-origin",
          "x-radius-mutation-nonce": String(entry.state.browserMutationNonce)
        },
        body: JSON.stringify({
          repo: "fixture/app",
          environment: "dev",
          login: executor.login
        })
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
      const body = await response.json();
      expect(body).toMatchObject({
        success: true,
        readiness: {
          ready: false,
          summary: "GitHub access could not be verified",
          checks: {
            packages: {
              state: "error",
              detail: "GitHub Packages authorization could not be verified."
            }
          },
          repair: expect.stringContaining("retry with the same account"),
          repairRemediation: null
        }
      });
      expect(body.selectionHandle).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("fixture-value");
      expect(JSON.stringify(body)).not.toContain("auth refresh");
      expect(registry).toHaveBeenCalledOnce();
    } finally {
      await runtime.stopServer("readiness", true);
      vi.unstubAllGlobals();
    }
  });

  it.each(
    ["shutdown", "changed-run"].flatMap((change) =>
      ["stop", "cancel-workflow"].flatMap((action) =>
        (action === "stop" ? [false, true] : [false]).map((reject) => ({
          change,
          action,
          reject
        }))
      )
    )
  )(
    "refuses $action over HTTP after $change during status read (reject=$reject)",
    async ({ change, action, reject }) => {
      const entered = deferred();
      const gate = deferred();
      const owner = createEnvironmentExecutionOwner();
      const run = vi.fn(async (args: string[]) => {
        if (args[0] !== "run") throw new Error("Unexpected cancellation POST");
        entered.resolve();
        await gate.promise;
        if (reject) throw new Error("late network failure");
        return { code: 0, stdout: '{"status":"in_progress"}', stderr: "" };
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        run
      });
      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async () => executor,
        getActiveKeyringLogin: async () => executor.login,
        switchKeyringAccount: async () => {
          throw new Error("Unexpected account switch");
        },
        resetIdentityCache() {}
      });
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext: createEnvironmentAccountContext(
          "http-cancellation",
          coordinator
        )
      });
      const op = createOperation({
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.context.githubLogin = executor.login;
      op.verification = { runId: "42", workflowState: "active" };
      if (action === "stop") {
        op.resumeRequest = {
          environment: {
            repo: op.repo,
            environment: op.environment,
            provider: "azure"
          }
        };
        op.currentStage = STAGE_VERIFY;
        pauseForProviderRestart(op);
      } else finish(op, "cancelled");
      operations.put(op);
      let pending: Promise<Response> | undefined;
      try {
        const entry = await runtime.getOrCreateServer("cancel", "environment");
        const persist = vi
          .spyOn(operations, "persist")
          .mockResolvedValue(undefined);
        const announce = vi.fn();
        onOperationTerminal(announce);
        pending = fetch(
          `${entry.baseUrl}/api/operations/${op.operationId}/${action}`,
          {
            method: "POST",
            headers: {
              origin: entry.baseUrl,
              "sec-fetch-site": "same-origin",
              "x-radius-mutation-nonce": String(
                entry.state.browserMutationNonce
              )
            }
          }
        );
        await entered.promise;
        if (change === "shutdown") owner.shutdown();
        else op.verification = { runId: "43", workflowState: "active" };
        gate.resolve();
        const response = await pending;
        expect(response.status).toBe(change === "shutdown" ? 503 : 409);
        expect(response.headers.get("content-type")).toContain(
          "application/json"
        );
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(await response.json()).toMatchObject({
          code:
            change === "shutdown" ?
              "operation-shutting-down"
            : "operation-context-changed"
        });
        expect(run).toHaveBeenCalledTimes(1);
        if (action === "stop") {
          expect(op.state).toBe("cancelled");
          expect(persist).toHaveBeenCalledTimes(1);
          expect(announce).not.toHaveBeenCalled();
        }
        expect(op.verification).toEqual({
          runId: change === "shutdown" ? "42" : "43",
          workflowState: "active"
        });
      } finally {
        gate.resolve();
        await pending;
        await runtime.stopServer("cancel", true);
      }
    }
  );

  it.each(["timeout", "confirmed"] as const)(
    "refuses a fresh HTTP retry after shutdown and restored %s dispatch",
    async (acknowledgement) => {
      const owner = createEnvironmentExecutionOwner();
      const entered = deferred();
      const gate = deferred();
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === "run" && args[1] === "list")
          return { code: 0, stdout: "[]", stderr: "" };
        if (args[0] !== "workflow")
          throw new Error(`Unexpected command: ${args.join(" ")}`);
        entered.resolve();
        await gate.promise;
        if (acknowledgement === "confirmed")
          return {
            code: 0,
            stdout: "https://github.com/fixture/app/actions/runs/17",
            stderr: ""
          };
        return { code: 1, stdout: "", stderr: "timeout", timedOut: true };
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        run
      });
      const account = createEnvironmentAccountContext("http-verify", {
        createReadOnlyExecutor: async () => executor,
        withSelectedAccount: async () => {
          throw new Error("Unexpected account switch");
        }
      });
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext: account
      });
      const entry = await runtime.getOrCreateServer("verify", "environment");
      const op = createOperation({
        operationId: "op_http-verify",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.context.githubLogin = executor.login;
      op.currentStage = STAGE_VERIFY;
      recordAzureApp(op, {
        state: "reused",
        appId: "11111111-1111-4111-8111-111111111111"
      });
      recordCommittedWorkflowFile(op, {
        path: ".github/workflows/radius-verify-credentials.yml",
        branch: "main",
        mode: "default_branch",
        commitSha: "c".repeat(40),
        blobSha: "b".repeat(40),
        contentSha256: "d".repeat(64),
        previousBlobSha: null,
        previousBlobKnown: true
      });
      recordCommitState(op, { mode: "default_branch", branch: "main" });
      op.verification = {
        workflow: "radius-verify-credentials.yml",
        ref: "main",
        environment: "dev",
        operationMarker: op.operationId,
        runId: "16"
      };
      finish(op, "failed_partial", {
        failure: {
          code: "verify-run-failed",
          stage: STAGE_VERIFY,
          message: "Failed verification",
          classification: "user-fixable"
        }
      });
      operations.put(op);
      vi.spyOn(operations, "persist").mockResolvedValue(undefined);
      let done = Promise.resolve();
      try {
        const response = await fetch(
          `${entry.baseUrl}/api/operations/${op.operationId}/retry/verification`,
          {
            method: "POST",
            headers: {
              origin: entry.baseUrl,
              "sec-fetch-site": "same-origin",
              "x-radius-mutation-nonce": String(
                entry.state.browserMutationNonce
              )
            }
          }
        );
        expect(response.status, JSON.stringify(await response.json())).toBe(
          202
        );
        done = new Promise<void>((resolve) => {
          const stop = owner.onEnvironmentTasksSettled("verify", () => {
            stop();
            resolve();
          });
        });
        await Promise.race([entered.promise, done]);
        expect(run).toHaveBeenCalledTimes(2);
        owner.shutdown();
        gate.resolve();
        await done;
        expect(run).toHaveBeenCalledTimes(2);
        expect(op.endedAt).toBeNull();
        expect(op.failure).toBeNull();
        expect(op.providerRecovery.mutations.at(-1)?.status).toBe(
          acknowledgement === "confirmed" ? "confirmed" : "outcome_unknown"
        );
        expect(account.getExecutor(op.operationId)).toBeUndefined();
      } finally {
        gate.resolve();
        await done;
        owner.shutdown();
        await runtime.stopServer("verify", true);
      }
      const restored = fromPersistedOperation(toPersistedOperation(op));
      reconcileRestoredOperation(restored);
      operations.put(restored);
      const commandsBeforeRetry = structuredClone(restored.control.commands);
      if (acknowledgement === "confirmed") {
        expect(restored).toMatchObject({
          state: "action_required",
          recoveryState: "provider_restart_decision",
          terminal: { reason: "provider-restart-decision" },
          verification: {
            runId: "17",
            runUrl: "https://github.com/fixture/app/actions/runs/17"
          }
        });
        expect(
          projectOperationActions(restored).map((action) => action.id)
        ).toEqual(["continue-setup", "stop"]);
      }
      const restarted = createTestCanvasServerRuntime({
        executionOwner: createEnvironmentExecutionOwner(),
        accountContext: account
      });
      const restartedEntry = await restarted.getOrCreateServer(
        "restored",
        "environment"
      );
      try {
        const response = await fetch(
          `${restartedEntry.baseUrl}/api/operations/${op.operationId}/retry/verification`,
          {
            method: "POST",
            headers: {
              origin: restartedEntry.baseUrl,
              "sec-fetch-site": "same-origin",
              "x-radius-mutation-nonce": String(
                restartedEntry.state.browserMutationNonce
              )
            }
          }
        );
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(409);
        expect(body.code).toBe("verification-retry-not-retryable");
        expect(restored.providerRecovery.mutations.at(-1)?.status).toBe(
          acknowledgement === "confirmed" ? "confirmed" : "manual_required"
        );
        expect(restored.control.commands).toEqual(commandsBeforeRetry);
        expect(run).toHaveBeenCalledTimes(2);
      } finally {
        await restarted.stopServer("restored", true);
      }
    }
  );

  it("projects the latest saved operation without repository context through the production status route", async () => {
    const owner = createEnvironmentExecutionOwner();
    const unavailable = async (): Promise<never> => {
      throw new Error("Unexpected account lookup");
    };
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      accountContext: createEnvironmentAccountContext("latest-status", {
        createReadOnlyExecutor: unavailable,
        withSelectedAccount: unavailable
      })
    });
    const entry = await runtime.getOrCreateServer(
      "latest-status",
      "environment"
    );
    try {
      const empty = await fetch(`${entry.baseUrl}/api/operations`);
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ operation: null });
      const op = createOperation({
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      finish(op, "failed");
      op.request = { private: "never-return-this" };
      operations.put(op);
      const response = await fetch(`${entry.baseUrl}/api/operations`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const result = await response.json();
      expect(result).toMatchObject({
        operation: {
          operationId: op.operationId,
          repo: op.repo,
          environment: op.environment,
          state: "failed"
        }
      });
      expect(JSON.stringify(result)).not.toContain("never-return-this");
      const beforeExport = Date.now();
      const diagnostic = await fetch(
        `${entry.baseUrl}/api/operations/${op.operationId}/diagnostics`
      );
      expect(diagnostic.status).toBe(200);
      expect(diagnostic.headers.get("content-disposition")).toContain(
        "attachment;"
      );
      expect(diagnostic.headers.get("cache-control")).toBe("no-store");
      const exported = await diagnostic.json();
      expect(Date.parse(exported.generatedAt)).toBeGreaterThanOrEqual(
        beforeExport
      );
      expect(Date.parse(exported.generatedAt)).toBeLessThanOrEqual(Date.now());
      expect(JSON.stringify(exported)).not.toContain("never-return-this");
      expect(owner.hasActiveEnvironmentTasks(undefined)).toBe(false);
    } finally {
      owner.shutdown();
      await runtime.stopServer("latest-status", true);
    }
  });

  it.each([true, false])(
    "releases a rolled-back AWS setup's lock only while AWS is on (awsEnabled=%s)",
    async (awsEnabled) => {
      const lockArn =
        "arn:aws:iam::123456789012:policy/radius-lock-radius-deploy-fixture-app";
      const aws = await fakeAwsOnPath({
        "--version": { stdout: "aws-cli/2.39.0" },
        "sts get-caller-identity": { stdout: '{"Account":"123456789012"}' },
        "iam get-policy": { stdout: '{"Policy":{"PolicyId":"LOCK0"}}' },
        "iam delete-policy": { stdout: "" }
      });
      const run = vi.fn(async (args: string[]) => {
        const command = args.join(" ");
        if (command === "api /repos/fixture/app/environments/dev")
          return { code: 0, stdout: '{"id":17,"name":"dev"}', stderr: "" };
        if (
          command === "api --method DELETE /repos/fixture/app/environments/dev"
        )
          return { code: 0, stdout: "", stderr: "" };
        throw new Error(`Unexpected cleanup command: ${command}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run
      });
      const owner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        awsEnabled,
        accountContext: createEnvironmentAccountContext(
          "aws-cleanup",
          createGitHubAccountCoordinator({
            createExecutor: async () => executor,
            getActiveKeyringLogin: async () => executor.login,
            switchKeyringAccount: async () => {
              throw new Error("Unexpected keyring switch");
            },
            resetIdentityCache: () => {}
          })
        )
      });
      try {
        const entry = await runtime.getOrCreateServer(
          "aws-cleanup",
          "environment"
        );
        const op = createOperation({
          operationId: "op_aws_cleanup",
          repo: "fixture/app",
          environment: "dev",
          provider: "aws"
        });
        op.context.githubLogin = executor.login;
        setContext(op, {
          awsDeployIdentityLock: { policyArn: lockArn, policyId: "LOCK0" }
        });
        recordGitHubEnvironment(op, {
          state: "created",
          origin: "this_operation",
          repo: op.repo,
          name: op.environment,
          providerId: "17"
        });
        finish(op, "failed");
        operations.put(op);
        vi.spyOn(operations, "persist").mockResolvedValue(undefined);

        const response = await fetch(
          `${entry.baseUrl}/api/operations/${op.operationId}/rollback`,
          {
            method: "POST",
            headers: {
              origin: entry.baseUrl,
              "sec-fetch-site": "same-origin",
              "x-radius-mutation-nonce": String(
                entry.state.browserMutationNonce
              )
            }
          }
        );
        expect(response.status).toBe(202);
        await vi.waitFor(() => expect(op.endedAt).toBeTruthy(), {
          timeout: 15000
        });

        expect(op.terminal).toMatchObject({ reason: "rollback-complete" });
        const labels = op.steps.map((step: { label: string }) => step.label);
        if (awsEnabled) {
          expect(await aws.calls()).toEqual([
            "--version",
            "sts get-caller-identity --output json",
            `iam get-policy --policy-arn ${lockArn} --output json`,
            `iam delete-policy --policy-arn ${lockArn}`
          ]);
          expect(op.context.awsDeployIdentityLock).toBeNull();
        } else {
          expect(await aws.calls()).toEqual([]);
          expect(op.context.awsDeployIdentityLock).toEqual({
            policyArn: lockArn,
            policyId: "LOCK0"
          });
          expect(labels).toContainEqual(
            expect.stringMatching(
              /^AWS environments are turned off, so Radius did not release the lock/
            )
          );
        }
      } finally {
        owner.shutdown();
        await runtime.stopServer("aws-cleanup", true);
        await aws.restore();
      }
    }
  );

  it.each([
    ["an AWS setup", "aws", false],
    ["an Azure setup", "azure", true]
  ])(
    "after a restart settles a GitHub write, pauses %s only when it is AWS",
    async (_label, provider, rollsBack) => {
      const roleArn =
        "arn:aws:iam::123456789012:role/radius-deploy-fixture-app";
      const target =
        "fixture/app:<default>:.github/workflows/radius-verify-credentials.yml";
      const runs: Array<string | undefined> = [];
      const owner = createEnvironmentExecutionOwner();
      // Configure environment's part of a resumed run: it settles the write
      // the crash left, then stops at the next boundary if asked to. The
      // cleanup a rollback would schedule comes here too, with its command.
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        awsEnabled: true,
        environmentOperationRunner: async (operationId, commandId) => {
          runs.push(commandId);
          if (commandId) return;
          const op = operations.get(operationId);
          await executeRecoverableMutation({
            operation: op,
            kind: "github_workflow.put",
            target,
            persist: async () => {},
            mutate: async () => {
              throw new Error("A settled write is never sent again.");
            },
            accept: (result) => result,
            // GitHub answered 404: the request never reached it.
            reconcile: async () => ({
              state: "not_applied",
              evidence: "GitHub has no such file."
            })
          });
          if (shouldStop(op)) stopAtBoundary(op, "before-workflow-commit");
        }
      });
      try {
        await runtime.getOrCreateServer("restart", "environment");
        const live = createOperation({
          operationId: `op_restart_${provider}`,
          repo: "fixture/app",
          environment: "dev",
          provider,
          stages: buildStages({ includeIdentity: true })
        });
        recordAwsRole(live, {
          state: "created",
          origin: "this_operation",
          roleArn,
          roleName: "radius-deploy-fixture-app",
          roleId: "AROA1"
        });
        live.resumeRequest = {
          needsAzureCredentials: false,
          environment: { provider, roleName: "radius-deploy-fixture-app" }
        };
        enterStage(live, STAGE_CONFIGURE_ENVIRONMENT);
        // The extension stopped after sending the workflow write.
        prepareProviderMutation(live, { kind: "github_workflow.put", target });
        setExecutionActive(live, true);
        const op = reconcileRestoredOperation(
          fromPersistedOperation(toPersistedOperation(live))
        );
        expect(op.recoveryState).toBe("provider_reconciliation_pending");
        operations.put(op);
        vi.spyOn(operations, "persist").mockResolvedValue(undefined);

        runtime.setupExecution.recoverOperation(op);
        if (rollsBack) {
          // The Azure rule this keeps: settled, then rolled back on its own.
          await vi.waitFor(
            () =>
              expect(runs).toEqual([
                undefined,
                expect.stringMatching(/:rollback:/)
              ]),
            { timeout: 15000 }
          );
          expect(op.providerRecovery.state).toBe("rollback_pending");
          return;
        }
        await vi.waitFor(() => expect(op.endedAt).toBeTruthy(), {
          timeout: 15000
        });
        await vi.waitFor(() =>
          expect(owner.hasActiveEnvironmentTasks("restart")).toBe(false)
        );
        expect(op.state).toBe("cancelled");
        expect(op.providerRecovery.state).not.toBe("rollback_pending");
        // No rollback was scheduled, so the role is still there to reuse.
        expect(runs).toEqual([undefined]);
        expect(op.setupArtifacts.awsRole.state).toBe("created");
        expect(
          projectOperationActions(op).map((action: { id: string }) => action.id)
        ).toEqual(expect.arrayContaining(["continue-setup", "rollback"]));
      } finally {
        owner.shutdown();
        await runtime.stopServer("restart", true);
      }
    }
  );

  it("settles an AWS write a restart interrupted, then pauses for the developer instead of rolling back", async () => {
    const roleArn = "arn:aws:iam::123456789012:role/radius-deploy-fixture-app";
    const aws = await fakeAwsOnPath({
      "--version": { stdout: "aws-cli/2.17.0 Python/3.11 Linux/6" },
      "sts get-caller-identity": { stdout: '{"Account":"123456789012"}' },
      "iam get-role": {
        stdout: JSON.stringify({
          Role: {
            Arn: roleArn,
            RoleId: "AROA1",
            Tags: [{ Key: "radius-operation", Value: "op_aws_crashed" }]
          }
        })
      }
    });
    const runtime = awsSetupRuntime();
    try {
      await runtime.getOrCreateServer("aws-panel", "environment");
      const live = createOperation({
        operationId: "op_aws_crashed",
        repo: "fixture/app",
        environment: "dev",
        provider: "aws",
        stages: buildStages({ includeIdentity: true })
      });
      live.context.githubLogin = "saved-account";
      live.resumeRequest = {
        needsAzureCredentials: false,
        github: { login: "saved-account", credentialSource: "keyring" },
        environment: {
          repo: "fixture/app",
          environment: "dev",
          provider: "aws",
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "shop",
          roleName: "radius-deploy-fixture-app",
          existingRoleArn: ""
        }
      };
      recordGitHubEnvironment(live, {
        state: "created",
        origin: "this_operation",
        repo: "fixture/app",
        name: "dev",
        providerId: "17"
      });
      enterStage(live, STAGE_AUTHORIZE_IDENTITY);
      // The extension stopped after sending create-role, before the answer.
      prepareProviderMutation(live, {
        kind: "aws_role.create",
        target: `attempt-1|${roleArn}`,
        intent: {
          requestedAt: "2026-10-30T12:00:00.000Z",
          accountId: "123456789012",
          roleArn,
          roleName: "radius-deploy-fixture-app",
          subjects: '["repo:fixture/app:environment:dev"]'
        }
      });
      setExecutionActive(live, true);
      const op = reconcileRestoredOperation(
        fromPersistedOperation(toPersistedOperation(live))
      );
      expect(op.recoveryState).toBe("provider_reconciliation_pending");
      operations.put(op);
      vi.spyOn(operations, "persist").mockResolvedValue(undefined);

      runtime.setupExecution.recoverOperation(op);
      await vi.waitFor(() => expect(op.endedAt).toBeTruthy(), {
        timeout: 15000
      });

      // Read only: the write is never sent again, and no lock is taken.
      expect(
        (await aws.calls()).map((call) => call.split(" ").slice(0, 2).join(" "))
      ).toEqual(["--version", "sts get-caller-identity", "iam get-role"]);
      expect(op.state).toBe("cancelled");
      expect(op.providerRecovery.state).not.toBe("rollback_pending");
      expect(op.providerRecovery.mutations[0]).toMatchObject({
        kind: "aws_role.create",
        status: "confirmed",
        providerId: "AROA1"
      });
      expect(op.setupArtifacts.awsRole).toMatchObject({
        state: "created",
        roleId: "AROA1"
      });
      expect(
        projectOperationActions(op).map((action: { id: string }) => action.id)
      ).toEqual(
        expect.arrayContaining(["continue-setup", "rollback", "exit-setup"])
      );
    } finally {
      await runtime.stopServer("aws-panel", true);
      await aws.restore();
    }
  });

  it("waits for AWS sign-in while a restart settles a write, without counting it against the write", async () => {
    const roleArn = "arn:aws:iam::123456789012:role/radius-deploy-fixture-app";
    const aws = await fakeAwsOnPath({
      "--version": { stdout: "aws-cli/2.17.0 Python/3.11 Linux/6" },
      // Expired when the restart first reads AWS, then signed in again.
      "sts get-caller-identity": [
        {
          stderr:
            "An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired",
          code: 254
        },
        { stdout: '{"Account":"123456789012"}' }
      ],
      "iam get-role": {
        stdout: JSON.stringify({
          Role: {
            Arn: roleArn,
            RoleId: "AROA1",
            Tags: [{ Key: "radius-operation", Value: "op_aws_expired" }]
          }
        })
      }
    });
    const runtime = awsSetupRuntime();
    try {
      await runtime.getOrCreateServer("aws-panel", "environment");
      const live = createOperation({
        operationId: "op_aws_expired",
        repo: "fixture/app",
        environment: "dev",
        provider: "aws",
        stages: buildStages({ includeIdentity: true })
      });
      live.context.githubLogin = "saved-account";
      live.resumeRequest = {
        needsAzureCredentials: false,
        github: { login: "saved-account", credentialSource: "keyring" },
        environment: {
          repo: "fixture/app",
          environment: "dev",
          provider: "aws",
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "shop",
          roleName: "radius-deploy-fixture-app",
          existingRoleArn: ""
        }
      };
      recordGitHubEnvironment(live, {
        state: "created",
        origin: "this_operation",
        repo: "fixture/app",
        name: "dev",
        providerId: "17"
      });
      enterStage(live, STAGE_AUTHORIZE_IDENTITY);
      // The extension stopped after sending create-role, before the answer.
      prepareProviderMutation(live, {
        kind: "aws_role.create",
        target: `attempt-1|${roleArn}`,
        intent: {
          requestedAt: "2026-10-30T12:00:00.000Z",
          accountId: "123456789012",
          roleArn,
          roleName: "radius-deploy-fixture-app",
          subjects: '["repo:fixture/app:environment:dev"]'
        }
      });
      setExecutionActive(live, true);
      const op = reconcileRestoredOperation(
        fromPersistedOperation(toPersistedOperation(live))
      );
      expect(op.recoveryState).toBe("provider_reconciliation_pending");
      operations.put(op);
      vi.spyOn(operations, "persist").mockResolvedValue(undefined);

      runtime.setupExecution.recoverOperation(op);
      await vi.waitFor(() => expect(op.endedAt).toBeTruthy(), {
        timeout: 15000
      });

      expect(
        (await aws.calls()).map((call) => call.split(" ").slice(0, 2).join(" "))
      ).toEqual([
        "--version",
        "sts get-caller-identity",
        "--version",
        "sts get-caller-identity",
        "iam get-role"
      ]);
      expect(
        op.steps.filter((step: { label: string }) =>
          step.label.startsWith(
            "Radius could not sign in to AWS to check the interrupted setup."
          )
        )
      ).toHaveLength(1);
      expect(op.providerRecovery.mutations[0].reconcileAttempts ?? 0).toBe(0);
      expect(op.state).toBe("cancelled");
      expect(op.providerRecovery.state).not.toBe("rollback_pending");
      expect(op.providerRecovery.mutations[0]).toMatchObject({
        kind: "aws_role.create",
        status: "confirmed",
        providerId: "AROA1"
      });
      expect(op.setupArtifacts.awsRole).toMatchObject({
        state: "created",
        roleId: "AROA1"
      });
      expect(
        projectOperationActions(op).map((action: { id: string }) => action.id)
      ).toEqual(
        expect.arrayContaining(["continue-setup", "rollback", "exit-setup"])
      );
    } finally {
      await runtime.stopServer("aws-panel", true);
      await aws.restore();
    }
  });
  it("rolls back what an AWS setup created, under the lock, then its GitHub environment", async () => {
    const roleArn = "arn:aws:iam::123456789012:role/radius-deploy-fixture-app";
    const aws = await fakeAwsOnPath({
      "--version": { stdout: "aws-cli/2.39.0" },
      "sts get-caller-identity": { stdout: '{"Account":"123456789012"}' },
      "iam create-policy": { stdout: '{"Policy":{"PolicyId":"LOCK1"}}' },
      "iam get-policy": { stdout: '{"Policy":{"PolicyId":"LOCK1"}}' },
      "iam get-role": {
        stdout: JSON.stringify({
          Role: {
            Arn: roleArn,
            RoleId: "AROA1",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] }
          }
        })
      },
      "iam delete-role-policy": { stdout: "" },
      "iam list-role-policies": { stdout: '{"PolicyNames":[]}' },
      "iam list-attached-role-policies": { stdout: '{"AttachedPolicies":[]}' },
      "iam delete-role": { stdout: "" },
      "iam delete-policy": { stdout: "" }
    });
    const run = vi.fn(async (args: string[]) => {
      const command = args.join(" ");
      if (command === "api /repos/fixture/app/environments/dev")
        return { code: 0, stdout: '{"id":17,"name":"dev"}', stderr: "" };
      if (command === "api --method DELETE /repos/fixture/app/environments/dev")
        return { code: 0, stdout: "", stderr: "" };
      throw new Error(`Unexpected cleanup command: ${command}`);
    });
    const executor = successfulSelectedGhExecutor({
      login: "saved-account",
      requiresKeyringSwitch: false,
      run
    });
    const owner = createEnvironmentExecutionOwner();
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      awsEnabled: true,
      accountContext: createEnvironmentAccountContext(
        "aws-rollback",
        createGitHubAccountCoordinator({
          createExecutor: async () => executor,
          getActiveKeyringLogin: async () => executor.login,
          switchKeyringAccount: async () => {
            throw new Error("Unexpected keyring switch");
          },
          resetIdentityCache: () => {}
        })
      )
    });
    try {
      const entry = await runtime.getOrCreateServer(
        "aws-rollback",
        "environment"
      );
      const op = createOperation({
        operationId: "op_aws_rollback",
        repo: "fixture/app",
        environment: "dev",
        provider: "aws"
      });
      op.context.githubLogin = executor.login;
      recordGitHubEnvironment(op, {
        state: "created",
        origin: "this_operation",
        repo: op.repo,
        name: op.environment,
        providerId: "17"
      });
      recordAwsRole(op, {
        state: "created",
        origin: "this_operation",
        roleArn,
        roleName: "radius-deploy-fixture-app",
        roleId: "AROA1"
      });
      recordAwsRolePolicy(op, {
        roleArn,
        roleName: "radius-deploy-fixture-app",
        roleId: "AROA1",
        policyName: "radius-deploy-dev-1"
      });
      finish(op, "failed");
      operations.put(op);
      vi.spyOn(operations, "persist").mockResolvedValue(undefined);

      const status = await fetch(
        `${entry.baseUrl}/api/operations/${op.operationId}`
      );
      const rollback = (await status.json()).operation.actions.find(
        (action: { id: string }) => action.id === "rollback"
      );
      expect(rollback.preview.removes).toEqual([
        {
          kind: "aws_role_policy",
          target: "radius-deploy-dev-1 on IAM role radius-deploy-fixture-app"
        },
        {
          kind: "aws_role",
          target: "IAM role radius-deploy-fixture-app, if nothing else uses it"
        },
        { kind: "github_environment", target: "fixture/app:dev" }
      ]);

      const response = await fetch(`${entry.baseUrl}${rollback.path}`, {
        method: "POST",
        headers: {
          origin: entry.baseUrl,
          "sec-fetch-site": "same-origin",
          "x-radius-mutation-nonce": String(entry.state.browserMutationNonce)
        }
      });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(op.endedAt).toBeTruthy(), {
        timeout: 15000
      });

      expect(op.terminal).toMatchObject({ reason: "rollback-complete" });
      const calls = await aws.calls();
      expect(
        calls.map((call) => call.split(" ").slice(0, 2).join(" "))
      ).toEqual([
        "--version",
        "sts get-caller-identity",
        "iam create-policy",
        "iam get-policy",
        "iam get-role",
        "iam get-policy",
        "iam delete-role-policy",
        "iam list-role-policies",
        "iam list-attached-role-policies",
        "iam get-policy",
        "iam delete-role",
        "iam get-policy",
        "iam delete-policy"
      ]);
      expect(calls[2]).toContain('"action":"rollback"');
      expect(op.setupArtifacts.awsRole.state).toBe("deleted");
      expect(op.setupArtifacts.awsRolePolicies[0].state).toBe("deleted");
      expect(op.setupArtifacts.githubEnvironment.state).toBe("deleted");
      expect(run).toHaveBeenCalledWith(
        ["api", "--method", "DELETE", "/repos/fixture/app/environments/dev"],
        expect.anything()
      );
    } finally {
      owner.shutdown();
      await runtime.stopServer("aws-rollback", true);
      await aws.restore();
    }
  });

  it("keeps an AWS role whose policy rollback could not delete, then removes both on Retry deletion", async () => {
    const roleArn = "arn:aws:iam::123456789012:role/radius-deploy-fixture-app";
    const answers = (deletePolicy: FakeAwsAnswer) => ({
      "--version": { stdout: "aws-cli/2.39.0" },
      "sts get-caller-identity": { stdout: '{"Account":"123456789012"}' },
      "iam create-policy": { stdout: '{"Policy":{"PolicyId":"LOCK1"}}' },
      "iam get-policy": { stdout: '{"Policy":{"PolicyId":"LOCK1"}}' },
      "iam get-role": {
        stdout: JSON.stringify({
          Role: {
            Arn: roleArn,
            RoleId: "AROA1",
            AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] }
          }
        })
      },
      "iam delete-role-policy": deletePolicy,
      "iam list-role-policies": { stdout: '{"PolicyNames":[]}' },
      "iam list-attached-role-policies": { stdout: '{"AttachedPolicies":[]}' },
      "iam delete-role": { stdout: "" },
      "iam delete-policy": { stdout: "" }
    });
    let aws = await fakeAwsOnPath(
      answers({
        code: 254,
        stderr:
          "An error occurred (ServiceFailure) when calling the DeleteRolePolicy operation"
      })
    );
    const executor = successfulSelectedGhExecutor({
      login: "saved-account",
      requiresKeyringSwitch: false,
      run: vi.fn(async (args: string[]) => {
        throw new Error(`Unexpected cleanup command: ${args.join(" ")}`);
      })
    });
    const owner = createEnvironmentExecutionOwner();
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      awsEnabled: true,
      accountContext: createEnvironmentAccountContext(
        "aws-retry",
        createGitHubAccountCoordinator({
          createExecutor: async () => executor,
          getActiveKeyringLogin: async () => executor.login,
          switchKeyringAccount: async () => {
            throw new Error("Unexpected keyring switch");
          },
          resetIdentityCache: () => {}
        })
      )
    });
    try {
      const entry = await runtime.getOrCreateServer("aws-retry", "environment");
      const op = createOperation({
        operationId: "op_aws_retry",
        repo: "fixture/app",
        environment: "dev",
        provider: "aws"
      });
      op.context.githubLogin = executor.login;
      recordAwsRole(op, {
        state: "created",
        origin: "this_operation",
        roleArn,
        roleName: "radius-deploy-fixture-app",
        roleId: "AROA1"
      });
      recordAwsRolePolicy(op, {
        roleArn,
        roleName: "radius-deploy-fixture-app",
        roleId: "AROA1",
        policyName: "radius-deploy-dev-1"
      });
      finish(op, "failed");
      operations.put(op);
      vi.spyOn(operations, "persist").mockResolvedValue(undefined);
      const post = async (id: string) => {
        const status = await fetch(
          `${entry.baseUrl}/api/operations/${op.operationId}`
        );
        const action = (await status.json()).operation.actions.find(
          (candidate: { id: string }) => candidate.id === id
        );
        return fetch(`${entry.baseUrl}${action.path}`, {
          method: "POST",
          headers: {
            origin: entry.baseUrl,
            "sec-fetch-site": "same-origin",
            "x-radius-mutation-nonce": String(entry.state.browserMutationNonce)
          }
        });
      };

      expect((await post("rollback")).status).toBe(202);
      await vi.waitFor(
        () =>
          expect(op.setupArtifacts.cleanup).toMatchObject({
            attempts: 1,
            state: "succeeded_with_warnings"
          }),
        { timeout: 15000 }
      );
      expect(op.state).toBe("failed_partial");
      expect(op.failure?.code).toBe("setup-cleanup-incomplete");
      expect(
        op.setupArtifacts.cleanup.results.map(
          (result: { artifactType: string; outcome: string }) =>
            `${result.artifactType} ${result.outcome}`
        )
      ).toEqual(["aws_role_policy warning", "aws_role warning"]);
      expect(op.setupArtifacts.awsRolePolicies[0].state).toBe("created");
      expect(op.setupArtifacts.awsRole.state).toBe("created");
      expect(
        (await aws.calls()).some((call) => call.startsWith("iam delete-role "))
      ).toBe(false);

      await aws.restore();
      aws = await fakeAwsOnPath(answers({ stdout: "" }));
      expect((await post("retry-cleanup")).status).toBe(202);
      await vi.waitFor(
        () => expect(op.setupArtifacts.awsRole.state).toBe("deleted"),
        { timeout: 15000 }
      );
      expect(op.setupArtifacts.awsRolePolicies[0].state).toBe("deleted");
      const retried = (await aws.calls()).map((call) =>
        call.split(" ").slice(0, 2).join(" ")
      );
      expect(retried).toContain("iam delete-role-policy");
      expect(retried).toContain("iam delete-role");
      expect(retried.at(-1)).toBe("iam delete-policy");
    } finally {
      owner.shutdown();
      await runtime.stopServer("aws-retry", true);
      await aws.restore();
    }
  });

  it.each([
    ["before any AWS change", 1],
    ["after the first role's changes", 2]
  ])(
    "stops an AWS rollback when its operation is replaced %s, and releases the lock",
    async (_label, stopAtLock) => {
      const roles = [
        "radius-deploy-fixture-app",
        "radius-deploy-fixture-other"
      ];
      const arn = (role: string) => `arn:aws:iam::123456789012:role/${role}`;
      const aws = await fakeAwsOnPath({
        "--version": { stdout: "aws-cli/2.39.0" },
        "sts get-caller-identity": { stdout: '{"Account":"123456789012"}' },
        "iam create-policy": { stdout: '{"Policy":{"PolicyId":"LOCK1"}}' },
        "iam get-policy": { stdout: '{"Policy":{"PolicyId":"LOCK1"}}' },
        "iam get-role": {
          stdout: JSON.stringify({
            Role: {
              Arn: arn(roles[0] as string),
              RoleId: "AROA1",
              AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] }
            }
          })
        },
        "iam delete-role-policy": { stdout: "" },
        "iam delete-policy": { stdout: "" }
      });
      const owner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        awsEnabled: true
      });
      try {
        const entry = await runtime.getOrCreateServer(
          "aws-replaced",
          "environment"
        );
        const op = createOperation({
          operationId: "op_aws_replaced",
          repo: "fixture/app",
          environment: "dev",
          provider: "aws"
        });
        for (const role of roles) {
          recordAwsRolePolicy(op, {
            roleArn: arn(role),
            roleName: role,
            roleId: "AROA1",
            policyName: "radius-deploy-dev-1"
          });
        }
        finish(op, "failed");
        operations.put(op);
        let locks = 0;
        // Each rollback saves its lock before its first change. Replacing the
        // record then ends this execution, as a restart or a new setup does.
        vi.spyOn(operations, "persist").mockImplementation(async () => {
          if (
            op.context.awsDeployIdentityLock &&
            ++locks === stopAtLock &&
            operations.get(op.operationId) === op
          ) {
            operations.put(structuredClone(op));
          }
        });

        const status = await fetch(
          `${entry.baseUrl}/api/operations/${op.operationId}`
        );
        const rollback = (await status.json()).operation.actions.find(
          (action: { id: string }) => action.id === "rollback"
        );
        const response = await fetch(`${entry.baseUrl}${rollback.path}`, {
          method: "POST",
          headers: {
            origin: entry.baseUrl,
            "sec-fetch-site": "same-origin",
            "x-radius-mutation-nonce": String(entry.state.browserMutationNonce)
          }
        });
        expect(response.status).toBe(202);
        const commands = async () =>
          (await aws.calls()).map((call) =>
            call.split(" ").slice(0, 2).join(" ")
          );
        await vi.waitFor(
          async () =>
            expect(
              (await commands()).filter(
                (command) => command === "iam delete-policy"
              )
            ).toHaveLength(stopAtLock),
          { timeout: 15000 }
        );
        await vi.waitFor(() =>
          expect(owner.hasActiveEnvironmentTasks("aws-replaced")).toBe(false)
        );

        const sent = await commands();
        // The role the stop interrupted was never changed.
        expect(
          sent.filter((command) => command === "iam delete-role-policy")
        ).toHaveLength(stopAtLock - 1);
        expect(sent.at(-1)).toBe("iam delete-policy");
        expect(op.endedAt).toBeNull();
        // The role that finished first keeps its recorded result.
        expect(
          op.setupArtifacts.cleanup.results.map(
            (result: { artifactType: string; outcome: string }) =>
              `${result.artifactType} ${result.outcome}`
          )
        ).toEqual(stopAtLock === 1 ? [] : ["aws_role_policy deleted"]);
      } finally {
        owner.shutdown();
        await runtime.stopServer("aws-replaced", true);
        await aws.restore();
      }
    }
  );

  it("keeps an HTTP-admitted rollback recoverable when shutdown wins account acquisition", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const owner = createEnvironmentExecutionOwner();
    const run = vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected cleanup command after shutdown");
    });
    const executor = successfulSelectedGhExecutor({
      login: "saved-account",
      run
    });
    const account = createEnvironmentAccountContext(
      "http-cleanup",
      createGitHubAccountCoordinator({
        createExecutor: async () => {
          entered();
          await gate;
          return executor;
        },
        getActiveKeyringLogin: async () => executor.login,
        switchKeyringAccount: async () => {
          throw new Error("Unexpected keyring switch");
        },
        resetIdentityCache: () => {}
      })
    );
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      accountContext: account
    });
    const entry = await runtime.getOrCreateServer("cleanup", "environment");
    const op = createOperation({
      operationId: "http-cleanup",
      repo: "fixture/app",
      environment: "dev",
      provider: "azure"
    });
    op.context.githubLogin = executor.login;
    recordGitHubEnvironment(op, {
      state: "created",
      origin: "this_operation",
      repo: op.repo,
      name: op.environment,
      providerId: "17"
    });
    finish(op, "failed");
    operations.put(op);
    vi.spyOn(operations, "persist").mockResolvedValue(undefined);
    let done = Promise.resolve();
    try {
      const response = await fetch(
        `${entry.baseUrl}/api/operations/${op.operationId}/rollback`,
        {
          method: "POST",
          headers: {
            origin: entry.baseUrl,
            "sec-fetch-site": "same-origin",
            "x-radius-mutation-nonce": String(entry.state.browserMutationNonce)
          }
        }
      );
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        operationId: op.operationId
      });
      done = new Promise<void>((resolve) => {
        const stop = owner.onEnvironmentTasksSettled("cleanup", () => {
          stop();
          resolve();
        });
      });
      await waiting;
      owner.shutdown();
      release();
      await done;
      expect(run).not.toHaveBeenCalled();
      expect(op.endedAt).toBeNull();
      expect(op.control.commands.at(-1)?.state).toBe("running");
      expect(op.setupArtifacts.githubEnvironment.state).toBe("created");
      expect(account.getExecutor(op.operationId)).toBeUndefined();
    } finally {
      release();
      await done;
      owner.shutdown();
      await runtime.stopServer("cleanup", true);
    }
  });

  it.each(["open", "closed-before-account", "closed-during-read"] as const)(
    "keeps shared verification observation alive across panel closure (%s)",
    async (lifetime) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = () => {};
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const run = vi.fn(async (args: string[]) => {
        const endpoint = args[1];
        if (endpoint === "repos/fixture/app/actions/runs/17") {
          entered();
          await gate;
        } else if (
          endpoint !==
          "repos/fixture/app/actions/runs/17/jobs?per_page=100&page=1"
        ) {
          throw new Error(`Unexpected selected command: ${args.join(" ")}`);
        }
        expect(args).toEqual(["api", endpoint, "--include", "--method", "GET"]);
        return {
          code: 0,
          stdout:
            "HTTP/2 200\n\n" +
            JSON.stringify(
              endpoint.endsWith("/17") ?
                { status: "completed", conclusion: "success" }
              : { jobs: [] }
            ),
          stderr: ""
        };
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        run
      });
      const account = createEnvironmentAccountContext("panel-observation", {
        createReadOnlyExecutor: async () => {
          if (lifetime === "closed-before-account") {
            entered();
            await gate;
          }
          return executor;
        },
        withSelectedAccount: async () => {
          throw new Error("Unexpected write lease");
        }
      });
      const owner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext: account
      });
      const op = createOperation({
        operationId: "op_direct_monitor",
        repo: "fixture/app",
        environment: "dev",
        provider: "azure"
      });
      op.currentStage = STAGE_VERIFY;
      op.recoveryState = "verification_pending";
      op.context.githubLogin = "saved-account";
      op.verification = {
        runId: "17",
        workflow: "verify.yml",
        ref: "topic",
        environment: "dev",
        dispatchedAt: Date.now()
      };
      operations.put(op);
      const persist = vi
        .spyOn(operations, "persist")
        .mockResolvedValue(undefined);
      const fetcher = vi.spyOn(globalThis, "fetch");
      const entry = await runtime.getOrCreateServer("monitor", "environment");
      const done = new Promise<void>((resolve) => {
        const unsubscribe = owner.onEnvironmentTasksSettled("monitor", () => {
          unsubscribe();
          resolve();
        });
      });
      try {
        await Promise.race([waiting, done]);
        expect(op.failure).toBeNull();
        if (lifetime !== "open") await runtime.stopServer("monitor", true);
        release();
        await done;
        expect(fetcher).not.toHaveBeenCalled();
        expect(persist).toHaveBeenCalledOnce();
        expect(account.getExecutor(op.operationId)).toBeUndefined();
        expect(entry.observation?.stopped).toBe(lifetime !== "open");
        expect(op.state).toBe("succeeded");
        expect(op.failure).toBeNull();
        expect(run).toHaveBeenCalledTimes(2);
        expect(runtime.getLastWebviewActivityAt()).toBe(0);
      } finally {
        release();
        await done;
        await runtime.stopServer("monitor", true);
      }
    }
  );

  it.each(["azure", "environment", "repository-refusal"] as const)(
    "enforces the real %s admission or setup outcome without the former setup POST",
    async (stage) => {
      const run = vi.fn(async (args: string[]) => {
        const command = args.join(" ");
        if (command === "api user") {
          return { code: 0, stdout: '{"login":"saved-account"}', stderr: "" };
        }
        if (
          command === "api /repos/fixture/app" ||
          command === "api repos/fixture/app"
        ) {
          return {
            code: 0,
            stdout: JSON.stringify({
              full_name: "fixture/app",
              permissions: { admin: stage !== "repository-refusal" }
            }),
            stderr: ""
          };
        }
        if (command === "api /repos/fixture/app/environments/dev") {
          return { code: 0, stdout: '{"name":"dev","id":17}', stderr: "" };
        }
        if (
          command.startsWith("api --paginate /repos/fixture/app/environments")
        ) {
          return { code: 1, stdout: "", stderr: "namespace fixture refusal" };
        }
        throw new Error(`Unexpected selected command: ${command}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run
      });
      const accountContext = createEnvironmentAccountContext(
        "runtime-service-wiring",
        createGitHubAccountCoordinator({
          createExecutor: async () => executor,
          getActiveKeyringLogin: async () => "original",
          switchKeyringAccount: async () => {
            throw new Error("Unexpected switch");
          },
          resetIdentityCache: () => {}
        })
      );
      const owner = createEnvironmentExecutionOwner();
      const runtime = createTestCanvasServerRuntime({
        executionOwner: owner,
        accountContext
      });
      const originalFetch = globalThis.fetch;
      const forbidden: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (
          url.endsWith("/api/azure-auto-setup") ||
          url.endsWith("/api/create-environment")
        ) {
          forbidden.push(url);
          throw new Error("Setup HTTP transport must not be used");
        }
        return originalFetch(input, init);
      });
      try {
        const entry = await runtime.getOrCreateServer(
          "setup-panel",
          "environment"
        );
        const op = createOperation({
          operationId: `op_direct_${stage}`,
          repo: "fixture/app",
          environment: "dev",
          provider: "azure"
        });
        op.context.githubLogin = "saved-account";
        op.currentStage = STAGE_AUTHORIZE_IDENTITY;
        op.request = {
          needsAzureCredentials: stage === "azure",
          azure: {},
          environment: {}
        };
        requireInput(op, {
          code: "app-selection-required",
          message: "Choose an app.",
          checkpoint: "azure-app-selection"
        });
        operations.put(op);
        const settled = new Promise<void>((resolve) => {
          const stop = owner.onEnvironmentTasksSettled("setup-panel", () => {
            stop();
            resolve();
          });
        });
        const response = await fetch(
          `${entry.baseUrl}/api/operations/${op.operationId}/resume/app-selection-required`,
          {
            method: "POST",
            headers: {
              origin: entry.baseUrl,
              "sec-fetch-site": "same-origin",
              "x-radius-mutation-nonce": String(
                entry.state.browserMutationNonce
              ),
              "content-type": "application/json"
            },
            body: JSON.stringify({
              repo: op.repo,
              environment: op.environment,
              provider: op.provider,
              checkpoint: "azure-app-selection",
              createNew: true
            })
          }
        );
        expect(response.status).toBe(202);
        await settled;
        expect(forbidden).toEqual([]);
        if (stage === "repository-refusal") {
          expect(op.failure.code).toBe("repo-admin-required");
          expect(op.failure.message).toContain("saved-account");
          expect(
            run.mock.calls.some(([args]) =>
              args.some((arg) => arg.includes("/environments"))
            )
          ).toBe(false);
        } else {
          expect(op.failure.message).toContain(
            stage === "azure" ?
              "repo, resourceGroup, and cluster are required."
            : "namespace fixture refusal"
          );
        }
        expect(op.state).toBe("failed");
        expect(accountContext.getExecutor(op.operationId)).toBeUndefined();
        expect(
          run.mock.calls.every(
            ([args]) => args[0] === "api" && !args.includes("--method")
          )
        ).toBe(true);
      } finally {
        await runtime.stopServer("setup-panel", true);
      }
    }
  );

  it("refuses a subject without the repository before running the AWS CLI", async () => {
    const aws = await fakeAwsOnPath({
      "--version": { stdout: "aws-cli/2.17.0 Python/3.11 Linux/6" }
    });
    const runtime = awsSetupRuntime({
      use_default: false,
      include_claim_keys: ["repository_owner", "context"]
    });
    try {
      const op = await runAwsSetup(runtime, "op_aws_shared_subject");

      expect(await aws.calls()).toEqual([]);
      expect(op.state).toBe("failed");
      expect(op.failure.code).toBe("aws-subject-not-repository-specific");
      expect(op.failure.message).toContain(
        "repository_owner:fixture:environment:dev, does not name the repository"
      );
      expect(op.failure.message).toContain(
        "includes only the claims repository_owner, context."
      );
    } finally {
      await runtime.stopServer("aws-panel", true);
      await aws.restore();
    }
  });

  it("runs the AWS CLI on PATH for AWS deploy identity setup", async () => {
    // Answers the version check, then refuses the sign-in check so setup
    // stops before anything could be written.
    const aws = await fakeAwsOnPath({
      "--version": { stdout: "aws-cli/2.17.0 Python/3.11 Linux/6" }
    });
    const runtime = awsSetupRuntime();
    try {
      const op = await runAwsSetup(runtime, "op_aws_cli");

      expect(await aws.calls()).toEqual([
        "--version",
        "sts get-caller-identity --output json --region us-west-2"
      ]);
      expect(op.state).toBe("failed");
      expect(op.failure.message).toContain("AWS CLI verification failed");
      expect(op.failure.message).not.toContain("fake aws: refused");
      expect(op.failure.message).toContain("Nothing was created in AWS.");
    } finally {
      await runtime.stopServer("aws-panel", true);
      await aws.restore();
    }
  });

  it("stops AWS setup before any write when the deploy identity cannot be locked", async () => {
    const aws = await fakeAwsOnPath({
      "--version": { stdout: "aws-cli/2.17.0 Python/3.11 Linux/6" },
      "sts get-caller-identity": { stdout: '{"Account":"123456789012"}' },
      "eks describe-cluster": {
        stdout:
          '{"cluster":{"status":"ACTIVE","accessConfig":{"authenticationMode":"API"}}}'
      },
      "iam create-policy": {
        stderr: "An error occurred (AccessDenied) when calling CreatePolicy",
        code: 254
      }
    });
    const runtime = awsSetupRuntime();
    try {
      const op = await runAwsSetup(runtime, "op_aws_lock");

      const calls = await aws.calls();
      expect(calls.at(-1)).toMatch(
        /^iam create-policy --policy-name radius-lock-radius-deploy-fixture-app --description \{"repo":"fixture\/app","environment":"dev","action":"setup","operationId":"op_aws_lock"\} /
      );
      expect(op.state).toBe("failed");
      expect(op.failure.code).toBe("aws-lock-denied");
      expect(op.failure.message).toContain("not allowed iam:CreatePolicy");
      expect(op.failure.message).toContain("Nothing was created in AWS.");
    } finally {
      await runtime.stopServer("aws-panel", true);
      await aws.restore();
    }
  });

  it("saves the AWS lock to the operation store configured after the runtime, before reading the role", async () => {
    const aws = await fakeAwsOnPath({
      "--version": { stdout: "aws-cli/2.17.0 Python/3.11 Linux/6" },
      "sts get-caller-identity": { stdout: '{"Account":"123456789012"}' },
      "eks describe-cluster": {
        stdout:
          '{"cluster":{"status":"ACTIVE","accessConfig":{"authenticationMode":"API"}}}'
      },
      "iam create-policy": { stdout: '{"Policy":{"PolicyId":"LOCK1"}}' },
      "iam get-policy": { stdout: '{"Policy":{"PolicyId":"LOCK1"}}' },
      "iam get-role": {
        stderr: "An error occurred (AccessDenied) when calling GetRole",
        code: 254
      },
      "iam delete-policy": { stdout: "" }
    });
    // Created first, as extension.ts does at module load.
    const runtime = awsSetupRuntime();
    const lockSaves: string[][] = [];
    await configureOperationStore({
      load: async () => null,
      save: async (envelope) => {
        const held = JSON.stringify(envelope.operations).includes(
          '"policyId":"LOCK1"'
        );
        if (held) lockSaves.push(await aws.calls());
      }
    });
    try {
      await runAwsSetup(runtime, "op_aws_saved_lock");
      expect(lockSaves.length).toBeGreaterThan(0);
      expect(lockSaves[0]).not.toContainEqual(
        expect.stringMatching(/^iam get-role /)
      );
    } finally {
      await runtime.stopServer("aws-panel", true);
      await aws.restore();
    }
  });

  it.each([
    [true, "releases the lock it holds"],
    [false, "The lock it holds on the deploy identity stays"]
  ])(
    "projects the AWS switch (%s) into the status route's exit wording",
    async (awsEnabled, wording) => {
      const runtime = createTestCanvasServerRuntime({
        executionOwner: createEnvironmentExecutionOwner(),
        awsEnabled
      });
      try {
        const entry = await runtime.getOrCreateServer("aws-off", "environment");
        const op = createOperation({
          operationId: "op_aws_switch_view",
          repo: "fixture/app",
          environment: "dev",
          provider: "aws"
        });
        setContext(op, {
          awsDeployIdentityLock: {
            policyArn:
              "arn:aws:iam::123456789012:policy/radius-lock-radius-deploy-fixture-app",
            policyId: "LOCK0"
          }
        });
        finish(op, "failed");
        operations.put(op);
        const status = await fetch(
          `${entry.baseUrl}/api/operations/${op.operationId}`
        );
        const exit = (await status.json()).operation.actions.find(
          (action: { id: string }) => action.id === "exit-setup"
        );
        expect(exit.description).toContain(wording);
      } finally {
        await runtime.stopServer("aws-off", true);
      }
    }
  );

  it("continues a restarted AWS setup from its saved request, taking back its own lock", async () => {
    const lockArn =
      "arn:aws:iam::123456789012:policy/radius-lock-radius-deploy-fixture-app";
    const mine = JSON.stringify({
      repo: "fixture/app",
      environment: "dev",
      action: "setup",
      operationId: "op_aws_restarted"
    });
    const aws = await fakeAwsOnPath({
      "--version": { stdout: "aws-cli/2.17.0 Python/3.11 Linux/6" },
      "sts get-caller-identity": { stdout: '{"Account":"123456789012"}' },
      "eks describe-cluster": {
        stdout:
          '{"cluster":{"status":"ACTIVE","accessConfig":{"authenticationMode":"API"}}}'
      },
      // Its own earlier lock is there, so it is replaced with a fresh one.
      "iam create-policy": [
        {
          stderr:
            "An error occurred (EntityAlreadyExists) when calling the CreatePolicy operation",
          code: 254
        },
        { stdout: '{"Policy":{"PolicyId":"LOCK1"}}' }
      ],
      "iam get-policy": [
        {
          stdout: JSON.stringify({
            Policy: { PolicyId: "LOCK0", Description: mine }
          })
        },
        { stdout: '{"Policy":{"PolicyId":"LOCK1"}}' }
      ],
      "iam get-role": {
        stderr: "An error occurred (AccessDenied) when calling GetRole",
        code: 254
      },
      "iam delete-policy": { stdout: "" }
    });
    const runtime = awsSetupRuntime();
    try {
      const entry = await runtime.getOrCreateServer("aws-panel", "environment");
      const live = createOperation({
        operationId: "op_aws_restarted",
        repo: "fixture/app",
        environment: "dev",
        provider: "aws",
        stages: buildStages({ includeIdentity: true })
      });
      live.context.githubLogin = "saved-account";
      live.resumeRequest = {
        needsAzureCredentials: false,
        github: { login: "saved-account", credentialSource: "keyring" },
        environment: {
          repo: "fixture/app",
          environment: "dev",
          provider: "aws",
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "shop",
          roleName: "radius-deploy-fixture-app",
          existingRoleArn: ""
        }
      };
      enterStage(live, STAGE_AUTHORIZE_IDENTITY);
      setContext(live, {
        awsDeployIdentityLock: { policyArn: lockArn, policyId: "LOCK0" }
      });
      setExecutionActive(live, true);
      const op = reconcileRestoredOperation(
        fromPersistedOperation(toPersistedOperation(live))
      );
      operations.put(op);
      const status = await fetch(
        `${entry.baseUrl}/api/operations/${op.operationId}`
      );
      expect(status.status).toBe(200);
      const view = (await status.json()).operation;
      expect(view.cleanup.retainedArtifacts).toContainEqual({
        kind: "aws_deploy_identity_lock",
        target: "Lock on IAM role radius-deploy-fixture-app (policy ID LOCK0)"
      });
      const cont = view.actions.find(
        (action: { id: string }) => action.id === "continue-setup"
      );
      expect(cont).toMatchObject({
        path: `/api/operations/${op.operationId}/continue`
      });

      const response = await fetch(`${entry.baseUrl}${cont.path}`, {
        method: "POST",
        headers: {
          origin: entry.baseUrl,
          "sec-fetch-site": "same-origin",
          "x-radius-mutation-nonce": String(entry.state.browserMutationNonce),
          "content-type": "application/json"
        },
        body: "{}"
      });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(op.endedAt).toBeTruthy(), {
        timeout: 15000
      });
      // Released after Authorize ends, which is after the record ends. The
      // first delete replaced the earlier lock; the second is the release.
      await vi.waitFor(
        async () =>
          expect(
            (await aws.calls()).filter(
              (call) => call === `iam delete-policy --policy-arn ${lockArn}`
            )
          ).toHaveLength(2),
        { timeout: 15000 }
      );

      const calls = await aws.calls();
      expect(calls.filter((call) => call.startsWith("iam "))).toEqual([
        expect.stringMatching(/^iam create-policy /),
        `iam get-policy --policy-arn ${lockArn} --output json`,
        `iam delete-policy --policy-arn ${lockArn}`,
        expect.stringMatching(/^iam create-policy /),
        `iam get-policy --policy-arn ${lockArn} --output json`,
        "iam get-role --role-name radius-deploy-fixture-app --output json",
        `iam get-policy --policy-arn ${lockArn} --output json`,
        `iam delete-policy --policy-arn ${lockArn}`
      ]);
      expect(op.failure.code).toBe("aws-role-unreadable");
      expect(op.steps.map((step: { label: string }) => step.label)).toContain(
        "🔒 Took back the lock this setup holds on IAM role radius-deploy-fixture-app from its earlier attempt."
      );
      // Cleared once the release answers, just after its delete-policy.
      await vi.waitFor(() =>
        expect(op.context.awsDeployIdentityLock).toBeNull()
      );
    } finally {
      await runtime.stopServer("aws-panel", true);
      await aws.restore();
    }
  });

  it.each([
    ["a stopped setup in this store", true],
    ["a run this store does not know", false]
  ])(
    "tells a waiting AWS setup whether its lock holder is %s",
    async (_label, known) => {
      const holder = createOperation({
        operationId: "op_aws_holder",
        repo: "fixture/app",
        environment: "dev",
        provider: "aws"
      });
      finish(holder, "cancelled");
      if (known) operations.put(holder);
      const aws = await fakeAwsOnPath({
        "--version": { stdout: "aws-cli/2.17.0 Python/3.11 Linux/6" },
        "sts get-caller-identity": { stdout: '{"Account":"123456789012"}' },
        "eks describe-cluster": {
          stdout:
            '{"cluster":{"status":"ACTIVE","accessConfig":{"authenticationMode":"API"}}}'
        },
        "iam create-policy": {
          stderr:
            "An error occurred (EntityAlreadyExists) when calling the CreatePolicy operation",
          code: 254
        },
        "iam get-policy": {
          stdout: JSON.stringify({
            Policy: {
              PolicyId: "LOCK0",
              CreateDate: new Date().toISOString(),
              Description: JSON.stringify({
                repo: "fixture/app",
                environment: "dev",
                action: "setup",
                operationId: "op_aws_holder"
              })
            }
          })
        }
      });
      const runtime = awsSetupRuntime();
      try {
        const op = await startAwsSetup(runtime, "op_aws_waiting");
        await vi.waitFor(
          () =>
            expect(op.context.awsLockWait).toMatchObject({
              holderOperationId: "op_aws_holder",
              stopped: known,
              removable: known
            }),
          { timeout: 15000 }
        );
        requestStop(op);
        await vi.waitFor(() => expect(op.endedAt).toBeTruthy(), {
          timeout: 15000
        });
        expect(
          (await aws.calls()).filter((call) =>
            /^iam (put|update|delete|attach)/.test(call)
          )
        ).toEqual([]);
      } finally {
        await runtime.stopServer("aws-panel", true);
        await aws.restore();
      }
    }
  );

  it("removes exactly the AWS lock a waiting run was shown, through the AWS CLI on PATH", async () => {
    const aws = await fakeAwsOnPath({
      "--version": { stdout: "aws-cli/2.39.0" },
      "sts get-caller-identity": { stdout: '{"Account":"123456789012"}' },
      "iam get-policy": { stdout: '{"Policy":{"PolicyId":"LOCK0"}}' },
      "iam delete-policy": { stdout: "" }
    });
    const runtime = createTestCanvasServerRuntime({
      executionOwner: createEnvironmentExecutionOwner(),
      awsEnabled: true
    });
    try {
      const entry = await runtime.getOrCreateServer("aws-panel", "environment");
      const op = createOperation({
        operationId: "op_aws_wait",
        repo: "fixture/app",
        environment: "dev",
        provider: "aws"
      });
      const lockArn =
        "arn:aws:iam::123456789012:policy/radius-lock-radius-deploy-fixture-app";
      setContext(op, {
        awsLockWait: {
          policyArn: lockArn,
          policyId: "LOCK0",
          holder: "The setup of environment prod in fixture/app",
          since: "2026-10-30T11:00:00Z",
          removable: true
        }
      });
      operations.put(op);

      const response = await fetch(
        `${entry.baseUrl}/api/operations/${op.operationId}/aws-lock/remove?policyId=LOCK0`,
        {
          method: "POST",
          headers: {
            origin: entry.baseUrl,
            "sec-fetch-site": "same-origin",
            "x-radius-mutation-nonce": String(entry.state.browserMutationNonce),
            "content-type": "application/json"
          },
          body: "{}"
        }
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ code: "aws-lock-removed" });
      expect(await aws.calls()).toEqual([
        "--version",
        "sts get-caller-identity --output json",
        `iam get-policy --policy-arn ${lockArn} --output json`,
        `iam delete-policy --policy-arn ${lockArn}`
      ]);
    } finally {
      await runtime.stopServer("aws-panel", true);
      await aws.restore();
    }
  });

  it.each([false, true])(
    "uses saved operation ownership for workflow controls (account unavailable=%s)",
    async (unavailable) => {
      const run = vi.fn(async (args: string[]) => {
        if (args[0] === "run" && args[1] === "view")
          return { code: 0, stdout: '{"status":"in_progress"}', stderr: "" };
        if (args[0] === "api" && args[1] === "--method")
          return { code: 0, stdout: "", stderr: "" };
        throw new Error(`Unexpected command: ${JSON.stringify(args)}`);
      });
      const executor = successfulSelectedGhExecutor({
        login: "saved-account",
        requiresKeyringSwitch: false,
        run
      });
      const accountCoordinator = createGitHubAccountCoordinator({
        createExecutor: async (login) => {
          expect(login).toBe("saved-account");
          if (unavailable) throw new Error("Saved account unavailable");
          return executor;
        },
        getActiveKeyringLogin: async () => "original",
        switchKeyringAccount: async () => {
          throw new Error("Unexpected account switch");
        },
        resetIdentityCache: () => {}
      });
      const lease = vi.spyOn(accountCoordinator, "withSelectedAccount");
      const accountContext = createEnvironmentAccountContext(
        "runtime-account-owner",
        accountCoordinator
      );
      const runtime = createTestCanvasServerRuntime({
        executionOwner: createEnvironmentExecutionOwner(),
        accountContext
      });
      try {
        const entry = await runtime.getOrCreateServer(
          "control-panel",
          "environment"
        );
        const op = createOperation({
          operationId: "op_control_account",
          repo: "fixture/app",
          environment: "dev",
          provider: "azure"
        });
        op.context.githubLogin = "saved-account";
        op.verification = { runId: "42" };
        finish(op, "cancelled");
        setVerificationWorkflowState(op, "unknown");
        operations.put(op);
        const post = () =>
          fetch(
            `${entry.baseUrl}/api/operations/${op.operationId}/cancel-workflow`,
            {
              method: "POST",
              headers: {
                origin: entry.baseUrl,
                "sec-fetch-site": "same-origin",
                "x-radius-mutation-nonce": String(
                  entry.state.browserMutationNonce
                )
              }
            }
          );
        const inspected = await post();
        expect(inspected.status).toBe(unavailable ? 502 : 200);
        if (unavailable) {
          expect(await inspected.json()).toMatchObject({
            code: "workflow-status-read-failed",
            detail: "Saved account unavailable"
          });
          expect(run).not.toHaveBeenCalled();
        } else {
          expect(await inspected.json()).toMatchObject({
            code: "workflow-status-checked"
          });
          const cancelled = await post();
          expect(cancelled.status).toBe(202);
          expect(await cancelled.json()).toMatchObject({
            code: "workflow-cancellation-pending"
          });
          expect(run.mock.calls.map(([args]) => args)).toEqual([
            ["run", "view", "42", "--json", "status", "--repo", "fixture/app"],
            ["run", "view", "42", "--json", "status", "--repo", "fixture/app"],
            [
              "api",
              "--method",
              "POST",
              "repos/fixture/app/actions/runs/42/cancel"
            ]
          ]);
        }
        expect(lease).toHaveBeenCalledTimes(unavailable ? 1 : 2);
        for (const call of lease.mock.calls) {
          expect(call).toEqual([
            "saved-account",
            { ownerKey: "runtime-account-owner", operationId: op.operationId },
            expect.any(Function),
            30000
          ]);
        }
      } finally {
        await runtime.stopServer("control-panel", true);
      }
    }
  );

  it("keeps direct recovery out of webview activity and surfaces admission refusal", async () => {
    const op = createOperation({
      operationId: "op_rollback_transport",
      repo: "fixture/rollback",
      environment: "dev",
      provider: "azure"
    });
    finish(op, "failed");
    op.providerRecovery = { state: "rollback_pending", mutations: [] };
    operations.put(op);
    const report = vi.spyOn(operations, "report");
    const fetcher = vi.spyOn(globalThis, "fetch");
    const runtime = createTestCanvasServerRuntime({
      executionOwner: createEnvironmentExecutionOwner()
    });
    try {
      await runtime.getOrCreateServer("rollback", "environment");
      await vi.waitFor(() =>
        expect(report).toHaveBeenCalledWith(
          expect.objectContaining({
            scope: "provider-recovery-auto-rollback",
            operationId: op.operationId,
            message: expect.any(String)
          })
        )
      );
      expect(fetcher).not.toHaveBeenCalled();
      expect(op.control.commands).toEqual([]);
      expect(runtime.getLastWebviewActivityAt()).toBe(0);
      expect(op.state).toBe("failed");
    } finally {
      await runtime.stopServer("rollback", true);
    }
  });

  it("refuses construction without the shared owner", () => {
    const options = {
      deploymentRuntime: createFakeDeploymentRuntime(),
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext: createProductionGitHubAccountContext(),
      awsEnabled: false
    };
    Reflect.deleteProperty(options, "executionOwner");
    expect(() => createProductionCanvasServerRuntime(options)).toThrow(
      "Missing canvas server dependency: executionOwner"
    );
  });

  it("refuses construction without the shared account context", () => {
    const options = {
      deploymentRuntime: createFakeDeploymentRuntime(),
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext: createProductionGitHubAccountContext(),
      awsEnabled: false
    };
    Reflect.deleteProperty(options, "accountContext");
    expect(() => createProductionCanvasServerRuntime(options)).toThrow(
      "Missing canvas server dependency: accountContext"
    );
  });

  it("refuses construction without the AWS switch", () => {
    const options = {
      deploymentRuntime: createFakeDeploymentRuntime(),
      executionOwner: createEnvironmentExecutionOwner(),
      accountContext: createProductionGitHubAccountContext(),
      awsEnabled: false
    };
    Reflect.deleteProperty(options, "awsEnabled");
    expect(() => createProductionCanvasServerRuntime(options)).toThrow(
      "Missing canvas server dependency: awsEnabled"
    );
  });

  it("decodes and reconciles legacy records before server-ready recovery without changing identity", async () => {
    const legacyEnvelope = {
      schemaVersion: 1,
      operations: [
        {
          schemaVersion: 1,
          operationId: "op_legacy_setup",
          kind: "create",
          provider: "azure",
          repo: "fixture/legacy",
          environment: "dev",
          state: "running",
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          endedAt: null,
          stages: [],
          steps: []
        },
        {
          schemaVersion: 6,
          operationId: "op_legacy_delete",
          kind: "delete",
          provider: "azure",
          repo: "fixture/delete",
          environment: "dev",
          state: "running",
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          endedAt: null,
          currentStage: STAGE_DELETE_RADIUS_ENV,
          stages: [
            {
              id: STAGE_DELETE_RADIUS_ENV,
              state: "running",
              label: "Delete Radius environment"
            }
          ],
          steps: [],
          deleteRecovery: {
            repo: "fixture/delete",
            environment: "dev",
            provider: "azure",
            clientId: "fixture-app",
            tenantId: "fixture-tenant",
            repoId: 42
          }
        },
        {
          schemaVersion: 5,
          operationId: "op_restart_decision",
          kind: "create",
          provider: "azure",
          repo: "fixture/restart",
          environment: "dev",
          state: "running",
          startedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
          endedAt: null,
          stages: [],
          steps: []
        }
      ]
    };
    const saved: PersistedOperationsEnvelope[] = [];
    await configureOperationStore({
      load: async () =>
        parseOperationsEnvelope(JSON.parse(JSON.stringify(legacyEnvelope))),
      save: async (envelope) => {
        saved.push(structuredClone(envelope));
      }
    });
    const quarantined = operations.get("op_legacy_setup");
    const deletion = operations.get("op_legacy_delete");
    expect(operations.get("op_restart_decision")).toMatchObject({
      operationId: "op_restart_decision",
      state: "action_required",
      terminal: { reason: "provider-restart-decision" },
      recoveryState: "interrupted"
    });
    expect(quarantined).toMatchObject({
      operationId: "op_legacy_setup",
      state: "failed_partial",
      providerRecovery: { state: "unrecoverable_legacy" },
      failure: { code: "operation-legacy-unrecoverable" }
    });
    expect(deletion).toMatchObject({
      operationId: "op_legacy_delete",
      schemaVersion: OPERATION_SCHEMA_VERSION,
      request: legacyEnvelope.operations[1].deleteRecovery,
      stages: expect.arrayContaining([
        expect.objectContaining({
          id: STAGE_DELETE_STATE_PACKAGE,
          state: "pending"
        })
      ])
    });
    const owner = createEnvironmentExecutionOwner();
    const runner = vi.fn(async () => {});
    const runtime = createTestCanvasServerRuntime({
      executionOwner: owner,
      environmentOperationRunner: runner
    });
    expect(runner).not.toHaveBeenCalled();
    try {
      const entry = await runtime.getOrCreateServer("legacy", "environment");
      await new Promise<void>((resolve) => {
        const stop = owner.onEnvironmentTasksSettled("legacy", () => {
          stop();
          resolve();
        });
      });
      expect(runner).toHaveBeenCalledExactlyOnceWith("op_legacy_delete");
      const response = await fetch(
        `${entry.baseUrl}/api/operations/op_legacy_setup`
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        operation: { operationId: "op_legacy_setup", state: "failed_partial" }
      });
      expect(saved.length).toBeGreaterThan(0);
      expect(JSON.stringify(saved)).not.toMatch(
        /attachmentGeneration|executionOwner|runtimeKey/
      );
    } finally {
      await runtime.stopServer("legacy", true);
    }
  });

  it("treats removed setup endpoints as unmatched without setup side effects or forged-header authority", async () => {
    const owner = createEnvironmentExecutionOwner();
    const runtime = createTestCanvasServerRuntime({ executionOwner: owner });
    const entry = await runtime.getOrCreateServer("auth", "environment");
    try {
      const unknown = await fetch(entry.baseUrl + "/api/unknown-setup-route");
      const unknownBody = await unknown.text();
      for (const path of ["/api/azure-auto-setup", "/api/create-environment"]) {
        for (const forgedHeader of [false, true]) {
          const response = await fetch(entry.baseUrl + path, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: entry.baseUrl,
              "Sec-Fetch-Site": "same-origin",
              "X-Radius-Mutation-Nonce": String(
                entry.state.browserMutationNonce
              ),
              ...(forgedHeader ?
                { "X-Radius-Server-Owned": "forged-token" }
              : {})
            },
            body: "{"
          });
          expect(response.status).toBe(unknown.status);
          expect(response.status).toBe(200);
          expect(response.headers.get("content-type")).toBe(
            "text/html; charset=utf-8"
          );
          expect(await response.text()).toBe(unknownBody);
        }
      }
      const crossSite = await fetch(entry.baseUrl + "/api/operations", {
        method: "POST",
        headers: { "Sec-Fetch-Site": "cross-site" },
        body: "{"
      });
      expect(crossSite.status).toBe(403);
      expect(await crossSite.json()).toMatchObject({
        code: "cross-site-forbidden"
      });
      expect(owner.hasActiveEnvironmentTasks("auth")).toBe(false);
      expect(operations.all()).toEqual([]);
    } finally {
      await runtime.stopServer("auth", true);
    }
  });
});

interface FakeAwsAnswer {
  stdout?: string;
  stderr?: string;
  code?: number;
}

/**
 * Put a fake `aws` first on PATH. It logs every call and answers by its first
 * two words; anything else is refused, so setup stops rather than writes. A
 * list answers successive calls in order, repeating its last entry.
 */
async function fakeAwsOnPath(
  answers: Record<string, FakeAwsAnswer | FakeAwsAnswer[]>
) {
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), "fake-aws-"));
  const log = path.join(fakeBin, "calls.log");
  // Created up front, so a run that never calls `aws` reads as no calls.
  await fs.writeFile(log, "");
  const originalPath = process.env.PATH;
  const originalPathExt = process.env.PATHEXT;
  const originalLog = process.env.FAKE_AWS_LOG;
  const shAnswer = (answer: FakeAwsAnswer, indent: string) => [
    ...(answer.stdout ? [`${indent}printf '%s\\n' '${answer.stdout}'`] : []),
    ...(answer.stderr ?
      [`${indent}printf '%s\\n' '${answer.stderr}' >&2`]
    : []),
    `${indent}exit ${answer.code ?? 0}`
  ];
  const shCases = Object.entries(answers).map(([command, answer]) => {
    if (!Array.isArray(answer)) {
      return [
        `  ${JSON.stringify(command)})`,
        ...shAnswer(answer, "    "),
        "    ;;"
      ].join("\n");
    }
    // The log already holds this call, so the count is its 1-based turn.
    return [
      `  ${JSON.stringify(command)})`,
      `    n=$(grep -c -e "^${command}" "$FAKE_AWS_LOG")`,
      "    case $n in",
      ...answer.flatMap((entry, index) => [
        index === answer.length - 1 ? "      *)" : `      ${index + 1})`,
        ...shAnswer(entry, "        "),
        "        ;;"
      ]),
      "    esac",
      "    ;;"
    ].join("\n");
  });
  await fs.writeFile(
    path.join(fakeBin, "aws"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$FAKE_AWS_LOG"',
      'key="$1"',
      '[ -n "$2" ] && key="$1 $2"',
      'case "$key" in',
      ...shCases,
      "esac",
      'echo "fake aws: refused" >&2',
      "exit 3",
      ""
    ].join("\n")
  );
  await fs.chmod(path.join(fakeBin, "aws"), 0o755);
  // On Windows, Node parses the command line's quotes before argv is
  // recorded and matched, so quoted arguments arrive whole (#1151).
  await fs.writeFile(
    path.join(fakeBin, "aws.cjs"),
    [
      'const fs = require("node:fs");',
      `const answers = ${JSON.stringify(answers)};`,
      "const args = process.argv.slice(2);",
      'fs.appendFileSync(process.env.FAKE_AWS_LOG, `${args.join(" ")}\\n`);',
      'const key = args.slice(0, 2).join(" ");',
      "const listed = answers[key];",
      "const turn = fs",
      '  .readFileSync(process.env.FAKE_AWS_LOG, "utf8")',
      "  .split(/\\r?\\n/)",
      "  .filter((line) => line.startsWith(key)).length;",
      "const answer = Array.isArray(listed)",
      "  ? listed[Math.min(turn, listed.length) - 1]",
      "  : listed;",
      "if (answer) {",
      "  if (answer.stdout) console.log(answer.stdout);",
      "  if (answer.stderr) console.error(answer.stderr);",
      "  process.exitCode = answer.code ?? 0;",
      "} else {",
      '  console.error("fake aws: refused");',
      "  process.exitCode = 3;",
      "}",
      ""
    ].join("\n")
  );
  await fs.writeFile(
    path.join(fakeBin, "aws.cmd"),
    ["@echo off", `"${process.execPath}" "%~dp0aws.cjs" %*`, ""].join("\r\n")
  );
  process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
  process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  process.env.FAKE_AWS_LOG = log;
  return {
    calls: async () =>
      (await fs.readFile(log, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => line.trim()),
    restore: async () => {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathExt;
      if (originalLog === undefined) delete process.env.FAKE_AWS_LOG;
      else process.env.FAKE_AWS_LOG = originalLog;
      await fs.rm(fakeBin, { recursive: true, force: true });
    }
  };
}

// A canvas runtime with the AWS switch on whose GitHub account answers the
// reads AWS setup makes for fixture/app. `subjectCustomization` is GitHub's
// OIDC subject customization for it; by default it has none.
function awsSetupRuntime(subjectCustomization?: unknown) {
  const run = vi.fn(async (args: string[]) => {
    const command = args.join(" ");
    if (command === "api user") {
      return { code: 0, stdout: '{"login":"saved-account"}', stderr: "" };
    }
    if (
      command === "api /repos/fixture/app" ||
      command === "api repos/fixture/app"
    ) {
      return {
        code: 0,
        stdout: JSON.stringify({
          full_name: "fixture/app",
          id: 42,
          owner: { id: 7 },
          permissions: { admin: true }
        }),
        stderr: ""
      };
    }
    if (command === "api /repos/fixture/app/environments/dev") {
      return { code: 0, stdout: '{"name":"dev","id":17}', stderr: "" };
    }
    if (
      command ===
      "api /repos/fixture/app/environments/dev/variables?per_page=100"
    ) {
      return { code: 0, stdout: '{"variables":[]}', stderr: "" };
    }
    if (command === "api /repos/fixture/app/actions/oidc/customization/sub") {
      return subjectCustomization ?
          { code: 0, stdout: JSON.stringify(subjectCustomization), stderr: "" }
        : { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    }
    throw new Error(`Unexpected selected command: ${command}`);
  });
  const executor = successfulSelectedGhExecutor({
    login: "saved-account",
    requiresKeyringSwitch: false,
    run
  });
  return createTestCanvasServerRuntime({
    executionOwner: createEnvironmentExecutionOwner(),
    accountContext: createEnvironmentAccountContext(
      "runtime-aws-cli",
      createGitHubAccountCoordinator({
        createExecutor: async () => executor,
        getActiveKeyringLogin: async () => "original",
        switchKeyringAccount: async () => {
          throw new Error("Unexpected switch");
        },
        resetIdentityCache: () => {}
      })
    ),
    awsEnabled: true
  });
}

// Schedule a saved AWS setup through the server and wait for it to end.
async function runAwsSetup(
  runtime: ReturnType<typeof awsSetupRuntime>,
  operationId: string
) {
  const op = await startAwsSetup(runtime, operationId);
  // The setup outlives the request, so wait for the operation to finish.
  await vi.waitFor(() => expect(op.endedAt).toBeTruthy(), { timeout: 15000 });
  return op;
}

// Schedule a saved AWS setup through the server without waiting for it.
async function startAwsSetup(
  runtime: ReturnType<typeof awsSetupRuntime>,
  operationId: string
) {
  const entry = await runtime.getOrCreateServer("aws-panel", "environment");
  const op = createOperation({
    operationId,
    repo: "fixture/app",
    environment: "dev",
    provider: "aws"
  });
  op.context.githubLogin = "saved-account";
  op.currentStage = STAGE_AUTHORIZE_IDENTITY;
  op.request = {
    needsAzureCredentials: false,
    azure: {},
    environment: {
      accountId: "123456789012",
      region: "us-west-2",
      cluster: "shop",
      roleName: "radius-deploy-fixture-app"
    }
  };
  // The resume transport is the server-owned way to schedule a saved
  // operation from a test; the AWS path ignores the Azure answer.
  requireInput(op, {
    code: "app-selection-required",
    message: "Choose an app.",
    checkpoint: "azure-app-selection"
  });
  operations.put(op);
  const response = await fetch(
    `${entry.baseUrl}/api/operations/${op.operationId}/resume/app-selection-required`,
    {
      method: "POST",
      headers: {
        origin: entry.baseUrl,
        "sec-fetch-site": "same-origin",
        "x-radius-mutation-nonce": String(entry.state.browserMutationNonce),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        repo: op.repo,
        environment: op.environment,
        provider: op.provider,
        checkpoint: "azure-app-selection",
        createNew: true
      })
    }
  );
  expect(response.status).toBe(202);
  return op;
}
