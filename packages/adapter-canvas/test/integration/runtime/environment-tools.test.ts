import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildProcess } from "node:child_process";
import { createHarness } from "@radius-project/adapter-shared/test-support/ghcr-bootstrap";
import { buildEnvironmentSuffix } from "@radius-project/core/platforms";
import * as gh from "../../../src/gh.js";
import {
  AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT,
  createAzureAppCreateContinuation
} from "../../../src/azure-app-create-continuation.js";
import { resolveOidcSubject } from "../../../src/azure-oidc.js";
import { createGitHubAccountCoordinator } from "../../../src/server/services/github-account-coordinator.js";
import {
  createGitHubAccountReadinessService,
  probeGhcrPackageWriteAccess,
  type GitHubAccountReadinessService
} from "../../../src/server/services/github-account-readiness.js";
import { bootstrapRadiusExtension } from "../../../src/runtime/bootstrap.js";
import { createEnvironmentTools } from "../../../src/runtime/environment-tools.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createEnvironmentAccountContext } from "../../../src/runtime/environment-account-context.js";
import { createDeploymentAccountResolver } from "../../../src/runtime/deployment-account.js";
import { githubAccountChoice } from "../../../src/runtime/github-account-choice.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import {
  createFakeDependencies,
  createFakeSession
} from "../../support/runtime/fakes.js";
import { successfulSelectedGhExecutor } from "../../support/server/selected-gh.js";
import {
  mergeHandoff,
  stoppedSetup
} from "../../support/server/operation-fixtures.js";
import {
  createOperation,
  enterStage,
  STAGE_AUTHORIZE_IDENTITY,
  finish,
  operations,
  recordAzureApp,
  recordCommittedWorkflowFile,
  recordCommitState,
  toPersistedOperation,
  requireInput,
  requestStop,
  stopAtBoundary,
  setContext,
  setCloudContext,
  setAzureAppCreateContinuation,
  pauseForProviderRestart,
  onOperationTerminal,
  STAGE_VERIFY
} from "../../../src/operations.js";
import type { EnvironmentToolResult } from "../../../src/runtime/environment-tool-result.js";

afterEach(() => {
  onOperationTerminal(null);
  operations.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const target = { repo: "fixture/app", environment: "dev" };
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function composition(
  options: {
    awsEnabled?: boolean;
    logins?: string[];
    select?: (message: string, options: string[]) => Promise<string | null>;
    confirm?: (message: string) => Promise<boolean>;
    permissionsFailure?: boolean;
    beforeResume?: () => Promise<void>;
    duringResumeRead?: () => Promise<void>;
    realSetup?: boolean;
    beforeLease?: () => Promise<void>;
    leaseLogin?: string;
    readiness?: GitHubAccountReadinessService;
    close?: () => Promise<void>;
    controlCheck?: () => void;
    cancellationRun?: (
      args: string[]
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
  } = {}
) {
  const fake = createFakeDependencies();
  const owner = createEnvironmentExecutionOwner();
  const run = vi.fn(async (args: string[]) => {
    if (options.cancellationRun) return options.cancellationRun(args);
    if (options.permissionsFailure) {
      if (args.join(" ") === "run view 42 --log --repo fixture/app")
        return {
          code: 0,
          stdout: "Error from server (Forbidden): cannot list resource",
          stderr: ""
        };
      if (
        args[0] === "api" &&
        args[1] === "/repos/fixture/app/environments/dev/variables?per_page=100"
      )
        return { code: 0, stdout: "RADIUS_MANAGED", stderr: "" };
      if (
        args.join(" ") ===
        "variable set RADIUS_VERIFICATION_BYPASSED --body 42 --env dev --repo fixture/app"
      )
        return { code: 0, stdout: "", stderr: "" };
    }
    const path = args[1];
    const value =
      path === "repos/fixture/app/actions/runs/42" ?
        {
          status: "completed",
          conclusion: options.permissionsFailure ? "failure" : "success"
        }
      : path === "repos/fixture/app/actions/runs/42/jobs?per_page=100&page=1" ?
        {
          total_count: options.permissionsFailure ? 1 : 0,
          jobs:
            options.permissionsFailure ?
              [
                {
                  id: 1,
                  name: "verify",
                  steps: [{ name: "Verify AKS Access", conclusion: "failure" }]
                }
              ]
            : []
        }
      : undefined;
    if (args[0] !== "api" || value === undefined)
      throw new Error(`Unexpected command ${args.join(" ")}`);
    return {
      code: 0,
      stdout: `HTTP/2 200 OK\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(value)}`,
      stderr: ""
    };
  });
  const executor = successfulSelectedGhExecutor({
    login: "saved-account",
    run
  });
  const readExecutor = vi.fn(async (login: string) => {
    if (login !== executor.login) throw new Error("Wrong saved account");
    return executor;
  });
  const accountContext = createEnvironmentAccountContext(
    "tools-runtime",
    options.realSetup || options.cancellationRun ?
      createGitHubAccountCoordinator({
        createExecutor: async () => {
          await options.beforeLease?.();
          return options.leaseLogin ?
              successfulSelectedGhExecutor({
                login: options.leaseLogin,
                requiresKeyringSwitch: false,
                run
              })
            : executor;
        },
        getActiveKeyringLogin: async () => executor.login,
        switchKeyringAccount: async () => {
          throw new Error("Unexpected account switch");
        },
        resetIdentityCache: () => {}
      })
    : {
        createReadOnlyExecutor: readExecutor,
        withSelectedAccount: async () => {
          throw new Error("Unexpected account lease");
        }
      }
  );
  const runner = vi.fn(async () => {});
  const runtime = createTestCanvasServerRuntime({
    awsEnabled: options.awsEnabled ?? false,
    executionOwner: owner,
    accountContext,
    ...(options.realSetup ? {} : { environmentOperationRunner: runner })
  });
  const ready = vi.fn(async ({ login }: { login: string }) => ({
    ready: true,
    login,
    credentialSource: "keyring" as const,
    summary: "Ready to configure deployments" as const,
    checks: Object.fromEntries([]),
    repair: null,
    repairRemediation: null,
    restoration: null
  }));
  const readIdentity = vi.fn(async () => ({
    accounts: (options.logins ?? ["saved-account"]).map((login) => ({
      login,
      active: login === "saved-account",
      hasWorkflow: true,
      hasPackages: true,
      switchable: true,
      acting: false
    }))
  }));
  const account = createDeploymentAccountResolver({
    readinessOwner: owner,
    logDiagnostic: fake.deps.logError,
    readIdentity,
    readiness: options.readiness ?? {
      check: async (input) => {
        const result = await ready(input);
        const check = { state: "ready" as const, detail: "Ready" };
        return {
          ...result,
          checks: {
            identity: check,
            repository: check,
            workflow: check,
            environment: check,
            packages: check
          }
        };
      }
    },
    createExecutor: readExecutor,
    get choose() {
      return githubAccountChoice(fake.deps.session.tryGet());
    },
    redactDiagnostic: (value) => value
  });
  const reportError = vi.fn();
  const deps = {
    ...fake.deps,
    ...runtime,
    executionOwner: owner,
    environment: createEnvironmentTools({
      ...runtime.environmentServices,
      control: (input, publish) =>
        runtime.environmentServices.control(
          {
            ...input,
            isCurrent: () => {
              const current = input.isCurrent?.() !== false;
              options.controlCheck?.();
              return current;
            }
          },
          publish
        ),
      resume: async (...args) => {
        await options.beforeResume?.();
        const [input, read, publish] = args;
        return runtime.operationResume(
          input,
          async () => {
            const value = await read();
            await options.duringResumeRead?.();
            return value;
          },
          publish
        );
      },
      owner,
      session: fake.deps.session,
      account,
      workspace: async () => ({ repo: target.repo, branch: "feature/current" }),
      validateBranch: async () => {},
      redact: (value) => value.replaceAll("opaque-private-value", "[redacted]"),
      reportError
    })
  };
  const session = createFakeSession(
    options.select || options.confirm ?
      {
        capabilities: { ui: { elicitation: true } },
        ui: {
          select: options.select ?? (async () => null),
          confirm: options.confirm
        }
      }
    : {}
  );
  if (options.close) Object.assign(session, { close: options.close });
  const extension = await bootstrapRadiusExtension(deps, {
    createCanvas: (declaration) => declaration,
    joinSession: async () => session
  });
  const persist = vi.spyOn(operations, "persist").mockResolvedValue(undefined);
  async function invoke(
    name: string,
    args: Record<string, unknown>
  ): Promise<EnvironmentToolResult> {
    const tool = extension.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Missing registered tool ${name}`);
    return JSON.parse(
      String(await tool.handler(args))
    ) as EnvironmentToolResult;
  }
  async function settled() {
    await new Promise<void>((resolve) => {
      const stop = owner.onEnvironmentTasksSettled(undefined, () => {
        stop();
        resolve();
      });
    });
  }
  return {
    ...fake,
    runtime,
    owner,
    extension,
    invoke,
    runner,
    persist,
    run,
    ready,
    readIdentity,
    readExecutor,
    executor,
    accountContext,
    reportError,
    settled
  };
}

describe("registered environment tools with production runtime services", () => {
  it.each(["released", "timed-out"] as const)(
    "keeps a %s queued readiness lease tracked beyond the cleanup deadline without starting a switch",
    async (end) => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      let active = "original";
      const entered = deferred();
      const release = deferred();
      const acquired = deferred();
      const switches: string[] = [];
      const coordinator = createGitHubAccountCoordinator(
        {
          createExecutor: async (login) =>
            successfulSelectedGhExecutor({ login }),
          getActiveKeyringLogin: async () => active,
          switchKeyringAccount: async (login) => {
            switches.push(login);
            active = login;
            return { ok: true };
          },
          resetIdentityCache() {}
        },
        {
          setTimer: (callback, ms) => {
            const timer = setTimeout(callback, ms);
            acquired.resolve();
            return timer;
          }
        }
      );
      const holder = coordinator.withSelectedAccount(
        "holder",
        { ownerKey: "other" },
        async () => {
          entered.resolve();
          await release.promise;
        }
      );
      await entered.promise;
      const probe = vi.fn(async () => {
        throw new Error("Unexpected probe");
      });
      const readiness = createGitHubAccountReadinessService(coordinator, {
        ownerKey: "runtime",
        ports: { probePackageAccess: probe }
      });
      const close = vi.fn(async () => {});
      const h = await composition({ readiness, close });
      const pending = h.invoke("radius_setup_environment", {
        ...target,
        provider: "azure",
        tenantId: "11111111-1111-4111-8111-111111111111",
        subscriptionId: "22222222-2222-4222-8222-222222222222",
        resourceGroup: "group",
        cluster: "cluster"
      });
      try {
        await acquired.promise;
        const shutdown = h.extension.shutdown();
        await vi.advanceTimersByTimeAsync(1999);
        expect(close).not.toHaveBeenCalled();
        expect(h.owner.pendingReadinessCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await expect(shutdown).resolves.toEqual({
          complete: false,
          exitCode: 1
        });
        expect(close).toHaveBeenCalledOnce();
        expect(h.owner.pendingReadinessCount()).toBe(1);
        if (end === "timed-out") {
          await vi.advanceTimersByTimeAsync(999);
          expect(h.owner.pendingReadinessCount()).toBe(1);
          await vi.advanceTimersByTimeAsync(1);
        } else release.resolve();
        await expect(pending).resolves.toMatchObject({
          code: "github-account-stopped"
        });
        expect(h.owner.pendingReadinessCount()).toBe(0);
        expect(switches).not.toContain("saved-account");
        expect(probe).not.toHaveBeenCalled();
        expect(h.persist).not.toHaveBeenCalled();
        expect(h.runner).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await holder;
        await pending;
        await h.extension.shutdown();
      }
    }
  );

  it.each(
    (["GET", "POST"] as const).flatMap((heldMethod) =>
      (["restored", "failed", "external"] as const).map((restoration) => ({
        heldMethod,
        restoration
      }))
    )
  )(
    "drains readiness held at $heldMethod with $restoration restoration before SDK teardown",
    async ({ heldMethod, restoration }) => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const entered = deferred();
      const released = deferred();
      const cleanupEntered = deferred();
      const cleanupReleased = deferred();
      const restoreEntered = deferred();
      const restoreReleased = deferred();
      const calls: string[] = [];
      let active = "original";
      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async () =>
          successfulSelectedGhExecutor({
            login: "saved-account",
            requiresKeyringSwitch: true,
            run: async (args) => {
              expect(args).toEqual(["api", "repos/fixture/app"]);
              return {
                code: 0,
                stdout: JSON.stringify({ permissions: { admin: true } }),
                stderr: ""
              };
            }
          }),
        getActiveKeyringLogin: async () => {
          if (
            restoration === "external" &&
            calls.length &&
            (heldMethod === "GET" || calls.includes("DELETE"))
          ) {
            restoreEntered.resolve();
            await restoreReleased.promise;
            active = "external";
          }
          return active;
        },
        switchKeyringAccount: async (login) => {
          if (login === "original") {
            restoreEntered.resolve();
            await restoreReleased.promise;
            if (restoration === "failed")
              return {
                ok: false,
                error: "restore unavailable client_secret=fixture-value"
              };
          }
          active = login;
          return { ok: true };
        },
        resetIdentityCache() {}
      });
      const readiness = createGitHubAccountReadinessService(coordinator, {
        ownerKey: "readiness",
        ports: {
          probePackageAccess: (executor, repo, environment, assertActive) =>
            probeGhcrPackageWriteAccess(
              executor,
              repo,
              environment,
              async (_url, init) => {
                const method = init.method ?? "GET";
                calls.push(method);
                if (method === heldMethod) {
                  entered.resolve();
                  await released.promise;
                }
                if (method === "DELETE") {
                  cleanupEntered.resolve();
                  await cleanupReleased.promise;
                }
                return {
                  ok: true,
                  status: method === "POST" ? 202 : 200,
                  headers: { get: () => "/upload" },
                  json: async () => ({ token: "opaque" })
                };
              },
              15000,
              assertActive
            )
        }
      });
      const close = vi.fn(async () => {});
      const h = await composition({ readiness, close });
      const pending = h.invoke("radius_setup_environment", {
        ...target,
        provider: "azure",
        tenantId: "11111111-1111-4111-8111-111111111111",
        subscriptionId: "22222222-2222-4222-8222-222222222222",
        resourceGroup: "group",
        cluster: "cluster"
      });
      try {
        await entered.promise;
        const shutdown = h.extension.shutdown();
        await vi.advanceTimersByTimeAsync(0);
        expect(close).not.toHaveBeenCalled();
        released.resolve();
        if (heldMethod === "POST") {
          await cleanupEntered.promise;
          expect(calls).toEqual(["GET", "POST", "DELETE"]);
          expect(close).not.toHaveBeenCalled();
          cleanupReleased.resolve();
        }
        await restoreEntered.promise;
        expect(close).not.toHaveBeenCalled();
        restoreReleased.resolve();
        await expect(pending).resolves.toMatchObject({
          kind: "refused",
          code: "github-account-stopped"
        });
        await expect(shutdown).resolves.toEqual({
          complete: restoration !== "failed",
          exitCode: restoration === "failed" ? 1 : 0
        });
        expect(close).toHaveBeenCalledOnce();
        expect(active).toBe(
          restoration === "restored" ? "original"
          : restoration === "failed" ? "saved-account"
          : "external"
        );
        const diagnostics = vi
          .mocked(h.deps.logError)
          .mock.calls.map(([message]) => message);
        if (restoration !== "restored") {
          expect(
            diagnostics.filter((message) =>
              message.includes("Restore the original")
            )
          ).toHaveLength(1);
          expect(diagnostics.join("\n")).not.toContain("fixture-value");
        }
        expect(
          diagnostics.some((message) => message.includes("drain failed"))
        ).toBe(restoration === "failed");
        expect(calls).toEqual(
          heldMethod === "GET" ? ["GET"] : ["GET", "POST", "DELETE"]
        );
        expect(h.persist).not.toHaveBeenCalled();
        expect(h.runner).not.toHaveBeenCalled();
        expect(h.readExecutor).not.toHaveBeenCalled();
        expect(operations.latest(target.repo)).toBeNull();
      } finally {
        released.resolve();
        cleanupReleased.resolve();
        restoreReleased.resolve();
        await pending;
        await h.extension.shutdown();
      }
    }
  );

  it("interrupts a registered accepted Azure continuation at its held validation read without advancing durable state", async () => {
    const h = await composition({ realSetup: true });
    const entered = deferred();
    const gate = deferred();
    const subscriptionId = "11111111-1111-4111-8111-111111111111";
    const tenantId = "22222222-2222-4222-8222-222222222222";
    const callerId = "33333333-3333-4333-8333-333333333333";
    const serviceManagementReference = "44444444-4444-4444-8444-444444444444";
    const repository = {
      id: 23,
      full_name: target.repo,
      owner: { id: 11 },
      permissions: { admin: true }
    };
    const subjectConfig = {
      use_default: true,
      use_immutable_subject: false
    };
    const oidcSuffix = buildEnvironmentSuffix(target.environment);
    const oidc = await resolveOidcSubject(
      {
        targetRepo: target.repo,
        envName: target.environment,
        suffix: oidcSuffix
      },
      async (path) => {
        if (path === "/repos/fixture/app")
          return { ok: true, json: repository };
        if (path === "/repos/fixture/app/actions/oidc/customization/sub")
          return { ok: true, json: subjectConfig };
        throw new Error(`Unexpected fixture OIDC request: ${path}`);
      }
    );
    const op = createOperation({ ...target, provider: "azure" });
    op.context.githubLogin = h.executor.login;
    op.request = {
      needsAzureCredentials: true,
      github: { login: h.executor.login },
      azure: {
        subscriptionId,
        tenantId,
        resourceGroup: "fixture-group",
        cluster: "fixture-cluster"
      },
      environment: {
        ...target,
        provider: "azure",
        branch: "feature/current",
        subscriptionId,
        tenantId,
        resourceGroup: "fixture-group",
        cluster: "fixture-cluster"
      }
    };
    op.resumeRequest = structuredClone(op.request);
    enterStage(op, STAGE_AUTHORIZE_IDENTITY);
    requireInput(op, AZURE_SERVICE_MANAGEMENT_REFERENCE_PROMPT);
    const continuation = createAzureAppCreateContinuation(
      {
        operationId: op.operationId,
        request: {
          ...target,
          operationEnvironment: target.environment,
          requestedSubscriptionId: subscriptionId,
          requestedTenantId: tenantId,
          resourceGroup: "fixture-group",
          clusterResourceGroup: "",
          clusterName: "fixture-cluster",
          explicitAppId: "",
          createNewApp: false,
          appNameProvided: false,
          requestedAppName: "",
          requestedClientId: ""
        },
        githubExecutor: {
          login: h.executor.login,
          credentialSource: h.executor.credentialSource,
          requiresKeyringSwitch: h.executor.requiresKeyringSwitch,
          scopes: [...h.executor.scopes]
        },
        resolved: {
          subscriptionId,
          tenantId,
          oidcSuffix,
          callerIdentity: { kind: "user" },
          oidc
        }
      },
      "radius-deploy-fixture-app",
      callerId,
      op.inputRequired.requestedAt
    );
    expect(continuation).not.toBeNull();
    expect(setAzureAppCreateContinuation(op, continuation)).toEqual(
      continuation
    );
    operations.put(op);
    const snapshots: ReturnType<typeof toPersistedOperation>[] = [];
    h.persist.mockImplementation(async () => {
      snapshots.push(structuredClone(toPersistedOperation(op)));
    });
    h.run.mockImplementation(async (args) => {
      const path = args[1]?.replace(/^\//, "");
      const body =
        path === "user" ? { login: h.executor.login }
        : path === "repos/fixture/app" ? repository
        : path === "repos/fixture/app/environments/dev" ?
          { name: "dev", id: 17 }
        : path === "repos/fixture/app/actions/oidc/customization/sub" ?
          subjectConfig
        : undefined;
      if (args[0] !== "api" || body === undefined)
        throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    });
    const runAz = vi.fn(async (args: string[]) => {
      if (args.join(" ") === "account show --output json") {
        entered.resolve();
        await gate.promise;
        return JSON.stringify({
          id: subscriptionId,
          tenantId,
          user: { type: "user" }
        });
      }
      if (args.join(" ") === "ad signed-in-user show --query id -o tsv")
        return callerId;
      throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
    });
    vi.spyOn(gh, "cliExec").mockImplementation(
      (command, args, _options, callback) => {
        expect(command).toBe("az");
        void runAz(args).then(
          (stdout) => callback(null, stdout, ""),
          (error: unknown) =>
            callback(
              error instanceof Error ? error : new Error(String(error)),
              "",
              ""
            )
        );
        return new ChildProcess();
      }
    );
    const lease = vi.spyOn(h.accountContext.coordinator, "withSelectedAccount");
    const packages = vi.spyOn(h.executor, "packageCredentials");
    const diagnostics = vi.spyOn(operations, "report");
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        throw new Error("Unexpected network request");
      });
    let closing: ReturnType<typeof h.extension.shutdown> | undefined;
    try {
      await operations.persist();
      const identity = { ...target, operationId: op.operationId };
      const status = await h.invoke("radius_environment_status", identity);
      if (!("interaction" in status) || !status.interaction?.supported)
        throw new Error("Expected current registered continuation prompt");
      expect(
        await h.invoke("radius_environment_control", {
          ...identity,
          action: "resume",
          provider: "azure",
          checkpoint: status.interaction.checkpoint,
          interactionId: status.interaction.interactionId,
          answer: {
            code: status.interaction.code,
            serviceManagementReference
          }
        })
      ).toMatchObject({ kind: "accepted" });
      const reachedValidation = await Promise.race([
        entered.promise.then(() => true),
        h.settled().then(() => false)
      ]);
      expect(
        reachedValidation,
        JSON.stringify({
          failure: op.failure,
          azure: runAz.mock.calls,
          github: h.run.mock.calls
        })
      ).toBe(true);
      expect(runAz.mock.calls).toEqual([
        [["account", "show", "--output", "json"]]
      ]);
      const durable = structuredClone(snapshots.at(-1));
      expect(durable).toMatchObject({
        state: "running",
        inputRequired: null,
        azureAppCreateContinuation: {
          ...continuation,
          acceptedPrompt: continuation?.prompt
        },
        resumeRequest: { azure: { serviceManagementReference } }
      });
      expect(op.inputRequired).toBeNull();
      expect(op.azureAppCreateContinuation).toBeUndefined();
      const mutations = structuredClone(op.providerRecovery);
      const artifacts = structuredClone(op.setupArtifacts);
      const calls = {
        gh: h.run.mock.calls.map(([args]) => [...args]),
        packages: packages.mock.calls.length,
        saves: snapshots.length
      };
      expect(h.accountContext.getExecutor(op.operationId)).toBe(h.executor);
      expect(h.owner.hasActiveEnvironmentTasks(undefined)).toBe(true);
      const executing = lease.mock.results.at(-1);
      if (executing?.type !== "return")
        throw new Error("Expected real selected-account execution");
      closing = h.extension.shutdown();
      expect(h.owner.isShuttingDown()).toBe(true);
      expect(h.accountContext.getExecutor(op.operationId)).toBe(h.executor);
      gate.resolve();
      await expect.soft(executing.value).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      await closing;
      await h.settled();
      expect
        .soft(runAz.mock.calls)
        .toEqual([[["account", "show", "--output", "json"]]]);
      expect
        .soft(h.run.mock.calls.map(([args]) => [...args]))
        .toEqual(calls.gh);
      expect.soft(packages).toHaveBeenCalledTimes(calls.packages);
      expect.soft(snapshots).toHaveLength(calls.saves);
      expect.soft(snapshots.at(-1)).toEqual(durable);
      expect(op.providerRecovery).toEqual(mutations);
      expect(op.setupArtifacts).toEqual(artifacts);
      expect(op.state).toBe("running");
      expect(op.endedAt).toBeNull();
      expect(op.failure).toBeNull();
      expect(op.azureAppCreateContinuation).toBeUndefined();
      expect(h.accountContext.getExecutor(op.operationId)).toBeUndefined();
      expect(h.owner.hasActiveEnvironmentTasks(undefined)).toBe(false);
      expect(diagnostics).not.toHaveBeenCalled();
      expect(h.reportError).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(h.runner).not.toHaveBeenCalled();
      expect(h.runtime.servers.size).toBe(0);
    } finally {
      gate.resolve();
      await (closing ?? h.extension.shutdown());
      await h.settled();
    }
  });

  it.each(["control-only", "setup-context"] as const)(
    "accepts concurrent registered Stops through the real serialized control service during %s progress",
    async (progress) => {
      const h = await composition();
      const op = createOperation({ ...target, provider: "azure" });
      op.context.githubLogin = "saved-account";
      operations.put(op);
      const snapshots: ReturnType<typeof toPersistedOperation>[] = [];
      h.persist.mockImplementation(async () => {
        if (progress === "setup-context") {
          setContext(op, { clientId: "resolved-app", appName: "setup-app" });
          setCloudContext(op, "azure", {
            subscriptionId: "resolved-subscription"
          });
        }
        snapshots.push(structuredClone(toPersistedOperation(op)));
      });
      const input = {
        ...target,
        operationId: op.operationId,
        action: "stop"
      };
      try {
        const results = await Promise.all([
          h.invoke("radius_environment_control", input),
          h.invoke("radius_environment_control", input)
        ]);
        expect(results).toMatchObject([
          { kind: "accepted", code: "operation-stop-pending" },
          { kind: "accepted", code: "operation-stop-pending" }
        ]);
        expect(snapshots).toHaveLength(2);
        expect(snapshots[0].control.stop.requestedAt).toBeTruthy();
        expect(snapshots[1].control.stop.requestedAt).toBe(
          snapshots[0].control.stop.requestedAt
        );
        expect(h.readIdentity).not.toHaveBeenCalled();
        expect(h.ready).not.toHaveBeenCalled();
        expect(h.readExecutor).not.toHaveBeenCalled();
        expect(h.runner).not.toHaveBeenCalled();
      } finally {
        await h.extension.shutdown();
      }
    }
  );

  it.each(
    (["retarget", "replacement", "shutdown"] as const).flatMap((change) =>
      (["before-admission", "after-check"] as const).map((boundary) => ({
        change,
        boundary
      }))
    )
  )(
    "keeps real registered Stop authority through $change at $boundary",
    async ({ change, boundary }) => {
      let queued = false;
      const op = createOperation({ ...target, provider: "azure" });
      op.context.githubLogin = "saved-account";
      const replacement = structuredClone(op);
      const h = await composition({
        controlCheck: () => {
          if (queued) return;
          queued = true;
          const changeAuthority = () => {
            if (change === "retarget") op.environment = "replacement";
            if (change === "replacement") operations.put(replacement);
            if (change === "shutdown") h.owner.shutdown();
          };
          if (boundary === "after-check") queueMicrotask(changeAuthority);
          else changeAuthority();
        }
      });
      operations.put(op);
      const snapshots: ReturnType<typeof toPersistedOperation>[] = [];
      const authorityAtSave: boolean[] = [];
      h.persist.mockImplementation(async () => {
        const current = operations.get(op.operationId);
        if (!current) throw new Error("Missing operation");
        authorityAtSave.push(
          !h.owner.isShuttingDown() &&
            current === op &&
            op.environment === target.environment
        );
        snapshots.push(structuredClone(toPersistedOperation(current)));
      });
      const originalStop = structuredClone(op.control.stop);
      try {
        const result = await h.invoke("radius_environment_control", {
          ...target,
          operationId: op.operationId,
          action: "stop"
        });
        if (boundary === "before-admission") {
          expect(result).toMatchObject({
            code:
              change === "shutdown" ?
                "operation-shutting-down"
              : "operation-context-changed"
          });
          expect(op.control.stop).toEqual(originalStop);
          expect(snapshots).toEqual([]);
        } else {
          expect(result).toMatchObject(
            change === "retarget" ?
              { kind: "refused", code: "operation-target-mismatch" }
            : { kind: "accepted", code: "operation-stop-pending" }
          );
          expect(snapshots).toHaveLength(1);
          expect(authorityAtSave).toEqual([true]);
          expect(snapshots[0].environment).toBe(target.environment);
          expect(snapshots[0].control.stop.requestedAt).toBeTruthy();
        }
        expect(replacement.control.stop).toEqual(originalStop);
        expect(h.readIdentity).not.toHaveBeenCalled();
        expect(h.ready).not.toHaveBeenCalled();
        expect(h.readExecutor).not.toHaveBeenCalled();
        expect(h.runner).not.toHaveBeenCalled();
      } finally {
        await h.extension.shutdown();
      }
    }
  );

  it("reports a real inconclusive GHCR probe without selecting another account or starting setup", async () => {
    const select = vi.fn(async () => "saved-account");
    const probe = vi.fn(async () => {
      throw new Error("network timeout client_secret=fixture-value");
    });
    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) =>
        successfulSelectedGhExecutor({
          login,
          requiresKeyringSwitch: false,
          run: async () => ({
            code: 0,
            stdout: '{"permissions":{"admin":true}}',
            stderr: ""
          })
        }),
      getActiveKeyringLogin: async () => "first",
      switchKeyringAccount: async () => {
        throw new Error("Unexpected switch");
      },
      resetIdentityCache() {}
    });
    const h = await composition({
      awsEnabled: true,
      logins: ["first", "saved-account"],
      select,
      readiness: createGitHubAccountReadinessService(coordinator, {
        ownerKey: "tools-runtime",
        ports: {
          probePackageAccess: (executor, repo, environment) =>
            probeGhcrPackageWriteAccess(executor, repo, environment, probe)
        }
      })
    });
    try {
      const result = await h.invoke("radius_setup_environment", {
        ...target,
        provider: "aws",
        accountId: "123456789012",
        region: "us-west-2",
        cluster: "eks",
        vpcId: "vpc-1",
        subnetIds: "subnet-a,subnet-b",
        roleName: "fixture"
      });
      expect(result.kind).toBe("unavailable");
      expect(JSON.stringify(result)).toContain(
        "GitHub Packages authorization could not be verified"
      );
      expect(JSON.stringify(result)).not.toContain("fixture-value");
      expect(probe).toHaveBeenCalledOnce();
      expect(select).not.toHaveBeenCalled();
      expect(h.readExecutor).not.toHaveBeenCalled();
      expect(h.persist).not.toHaveBeenCalled();
      expect(h.runner).not.toHaveBeenCalled();
      expect(operations.latest(target.repo)).toBeFalsy();
    } finally {
      await h.extension.shutdown();
    }
  });

  it.each(["active", "inactive"] as const)(
    "keeps the registered tool's saved %s observation after shutdown during persistence",
    async (observed) => {
      const h = await composition({
        confirm: async () => true,
        cancellationRun: async (args) => {
          if (args[0] !== "run")
            throw new Error("Unexpected cancellation mutation");
          return {
            code: 0,
            stdout: JSON.stringify({
              status: observed === "active" ? "in_progress" : "completed"
            }),
            stderr: ""
          };
        }
      });
      const op = stoppedSetup({ repo: target.repo });
      op.context = { githubLogin: h.executor.login };
      op.verification = { runId: "42", workflowState: "unknown" };
      operations.put(op);
      const snapshots: ReturnType<typeof toPersistedOperation>[] = [];
      h.persist.mockImplementation(async () => {
        snapshots.push(structuredClone(toPersistedOperation(op)));
        h.owner.shutdown();
      });
      try {
        expect(
          await h.invoke("radius_environment_control", {
            ...target,
            operationId: op.operationId,
            action: "cancel-workflow"
          })
        ).toMatchObject({ code: "operation-shutting-down" });
        expect(snapshots).toHaveLength(1);
        expect(snapshots[0].verification).toMatchObject({
          runId: "42",
          workflowState: observed
        });
        expect(toPersistedOperation(op).verification).toEqual(
          snapshots[0].verification
        );
        await operations.persist();
        expect(snapshots[1].verification).toEqual(snapshots[0].verification);
        expect(h.run).toHaveBeenCalledOnce();
        expect(op.control.commands).toEqual([]);
      } finally {
        await h.extension.shutdown();
      }
    }
  );

  it("refuses disabled AWS before identity reads or trusted account-choice interaction", async () => {
    const select = vi.fn(async () => "saved-account");
    const h = await composition({
      logins: ["another", "saved-account"],
      select
    });
    try {
      expect(
        await h.invoke("radius_setup_environment", {
          ...target,
          provider: "aws",
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "eks",
          vpcId: "vpc-1",
          subnetIds: "subnet-a,subnet-b",
          roleName: "fixture",
          namespace: "INVALID"
        })
      ).toMatchObject({ kind: "refused", code: "provider-unsupported" });
      expect(h.readIdentity).not.toHaveBeenCalled();
      expect(h.ready).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(h.readExecutor).not.toHaveBeenCalled();
      expect(h.persist).not.toHaveBeenCalled();
      expect(h.runner).not.toHaveBeenCalled();
      expect(h.run).not.toHaveBeenCalled();
      expect(operations.latest(target.repo)).toBeFalsy();
    } finally {
      await h.extension.shutdown();
    }
  });
  it.each([
    { roleName: "fixture-role" },
    { existingRoleArn: "arn:aws:iam::123456789012:role/existing" },
    {
      roleName: "fixture-role",
      existingRoleArn: "arn:aws:iam::123456789012:role/existing"
    }
  ])(
    "retains AWS selectors through registered setup admission: %j",
    async (selectors) => {
      const h = await composition({ awsEnabled: true });
      try {
        const result = await h.invoke("radius_setup_environment", {
          ...target,
          provider: "aws",
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "eks",
          vpcId: "vpc-1",
          subnetIds: "subnet-a,subnet-b",
          ...selectors
        });
        expect(result.kind).toBe("accepted");
        await h.settled();
        expect(
          operations.latest(target.repo)?.request.environment
        ).toMatchObject(selectors);
        expect(h.runner).toHaveBeenCalledOnce();
      } finally {
        await h.extension.shutdown();
      }
    }
  );
  it.each(["continue", "retry-setup"] as const)(
    "rejects a saved legacy AWS request through registered %s and the real coordinator",
    async (action) => {
      const h = await composition({ awsEnabled: true, realSetup: true });
      const op = createOperation({ ...target, provider: "aws" });
      op.context.githubLogin = "saved-account";
      op.request = {
        needsAzureCredentials: false,
        environment: {
          ...target,
          provider: "aws",
          branch: "feature/current",
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "eks",
          vpcId: "vpc-1",
          subnetIds: "subnet-a,subnet-b",
          roleArn: "arn:aws:iam::123456789012:role/legacy"
        }
      };
      if (action === "continue") {
        requestStop(op);
        stopAtBoundary(op, "before-aws");
      } else {
        finish(op, "failed_partial", {
          failure: { code: "operation-stalled", message: "lost contact" }
        });
      }
      operations.put(op);
      h.run.mockImplementation(async (args) => {
        const path = args[1]?.replace(/^\//, "");
        const body =
          path === "user" ? { login: "saved-account" }
          : path === "repos/fixture/app" ?
            { full_name: target.repo, permissions: { admin: true } }
          : path === "repos/fixture/app/environments/dev" ?
            { name: "dev", id: 17 }
          : undefined;
        if (args[0] !== "api" || body === undefined)
          throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
        return { code: 0, stdout: JSON.stringify(body), stderr: "" };
      });
      const cli = vi.spyOn(gh, "cliExec").mockImplementation(() => {
        throw new Error(
          "Legacy input must not invoke AWS or provider configuration"
        );
      });
      try {
        expect(
          await h.invoke("radius_environment_control", {
            ...target,
            operationId: op.operationId,
            action
          })
        ).toMatchObject({ kind: "accepted" });
        await h.settled();
        expect(op.failure).toMatchObject({
          code: "invalid-aws-operation-input"
        });
        expect(cli).not.toHaveBeenCalled();
        expect(
          h.run.mock.calls.every(
            ([args]) => args[0] === "api" && !args[1].includes("/variables")
          )
        ).toBe(true);
        expect(op.context.awsRoleArn).toBeUndefined();
        expect(op.verification).toBeUndefined();
      } finally {
        await h.extension.shutdown();
      }
    }
  );
  it.each([
    [{ roleName: "named-role" }, "named-role"],
    [
      { existingRoleArn: "arn:aws:iam::123456789012:role/picked-role" },
      "picked-role"
    ],
    [
      {
        roleName: "named-role",
        existingRoleArn: "arn:aws:iam::123456789012:role/picked-role"
      },
      "picked-role"
    ]
  ] as const)(
    "retries runtime-owned AWS selectors with the intended role: %j",
    async (selectors, expectedRole) => {
      const h = await composition({ awsEnabled: true, realSetup: true });
      const op = createOperation({ ...target, provider: "aws" });
      op.context.githubLogin = "saved-account";
      op.request = {
        needsAzureCredentials: false,
        environment: {
          ...target,
          provider: "aws",
          branch: "feature/current",
          accountId: "123456789012",
          region: "us-west-2",
          cluster: "eks",
          vpcId: "vpc-1",
          subnetIds: "subnet-a,subnet-b",
          ...selectors
        }
      };
      finish(op, "failed_partial", {
        failure: { code: "operation-stalled", message: "lost contact" }
      });
      operations.put(op);
      h.run.mockImplementation(async (args) => {
        const path = args[1]?.replace(/^\//, "");
        const body =
          path === "user" ? { login: "saved-account" }
          : path === "repos/fixture/app" ?
            {
              id: 23,
              name: "app",
              full_name: target.repo,
              owner: { id: 11, login: "fixture" },
              permissions: { admin: true }
            }
          : path === "repos/fixture/app/environments/dev" ?
            { name: "dev", id: 17 }
          : (
            path === "repos/fixture/app/environments/dev/variables?per_page=100"
          ) ?
            { variables: [] }
          : path === "repos/fixture/app/actions/oidc/customization/sub" ?
            { use_default: true, use_immutable_subject: false }
          : undefined;
        if (args[0] !== "api" || body === undefined)
          throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
        return { code: 0, stdout: JSON.stringify(body), stderr: "" };
      });
      const cli = vi
        .spyOn(gh, "cliExec")
        .mockImplementation((command, args, _options, callback) => {
          expect(command).toBe("aws");
          const key = args.slice(0, 2).join(" ");
          if (key === "--version") callback(null, "aws-cli/2.17.0", "");
          else if (key === "sts get-caller-identity")
            callback(null, '{"Account":"123456789012"}', "");
          else if (key === "eks describe-cluster")
            callback(
              null,
              '{"cluster":{"status":"ACTIVE","accessConfig":{"authenticationMode":"API"}}}',
              ""
            );
          else if (key === "iam create-policy" || key === "iam get-policy")
            callback(null, '{"Policy":{"PolicyId":"LOCK1"}}', "");
          else if (key === "iam delete-policy") callback(null, "", "");
          else if (key === "iam get-role") {
            callback(
              Object.assign(new Error("AccessDenied"), { code: 1 }),
              "",
              "AccessDenied"
            );
          } else throw new Error(`Unexpected AWS command: ${args.join(" ")}`);
          return new ChildProcess();
        });
      try {
        expect(
          await h.invoke("radius_environment_control", {
            ...target,
            operationId: op.operationId,
            action: "retry-setup"
          })
        ).toMatchObject({ kind: "accepted" });
        await h.settled();
        expect(op.request.environment).toMatchObject(selectors);
        const awsArgs = cli.mock.calls.map(([, args]) => args);
        expect(awsArgs.filter((args) => args[1] === "get-role").at(-1)).toEqual(
          ["iam", "get-role", "--role-name", expectedRole, "--output", "json"]
        );
        // The deploy identity lock is released when the retry fails.
        expect(awsArgs.at(-1)?.slice(0, 2)).toEqual(["iam", "delete-policy"]);
        expect(op.failure?.code).toBe("aws-role-unreadable");
        expect(op.verification).toBeUndefined();
      } finally {
        await h.extension.shutdown();
      }
    }
  );
  it.each(["shutdown", "target", "issued-success", "issued-error"] as const)(
    "preserves registered bypass authority and settlement at %s",
    async (boundary) => {
      const h = await composition({
        permissionsFailure: true,
        confirm: async () => true
      });
      const op = createOperation({ ...target, provider: "azure" });
      op.context.githubLogin = h.executor.login;
      op.currentStage = STAGE_VERIFY;
      op.verification = {
        runId: "42",
        workflow: "verify.yml",
        ref: "feature/current",
        environment: "dev",
        dispatchedAt: Date.now()
      };
      operations.put(op);
      const gate = deferred();
      const entered = deferred();
      const original = h.executor.run;
      h.executor.run = async (args, options) => {
        if (args[0] !== "variable") return original(args, options);
        if (boundary.startsWith("issued")) {
          const result = await original(args, options);
          entered.resolve();
          await gate.promise;
          if (boundary === "issued-error") throw new Error("write unavailable");
          return result;
        }
        entered.resolve();
        await gate.promise;
        return original(args, options);
      };
      try {
        const pending = h.invoke("radius_environment_control", {
          ...target,
          operationId: op.operationId,
          action: "bypass-verification"
        });
        await entered.promise;
        if (boundary === "target") op.verification.runId = "43";
        else await h.extension.shutdown();
        gate.resolve();
        expect(await pending).toMatchObject({
          kind: boundary === "issued-success" ? "accepted" : "unavailable",
          ...(boundary === "shutdown" || boundary === "target" ?
            { code: "workflow-observation-stopped" }
          : {})
        });
        expect(
          h.run.mock.calls.filter(([args]) => args[0] === "variable")
        ).toHaveLength(boundary.startsWith("issued") ? 1 : 0);
        expect(h.accountContext.getExecutor(op.operationId)).toBeUndefined();
      } finally {
        gate.resolve();
        await h.extension.shutdown();
      }
    }
  );

  it("preserves transient busy guidance for registered continuation while the stopped task settles", async () => {
    const h = await composition();
    const op = stoppedSetup({ repo: target.repo });
    op.context = { githubLogin: h.executor.login };
    operations.put(op);
    const gate = deferred();
    const done = deferred();
    h.owner.attachRuntime().schedule(op.operationId, {
      run: () => gate.promise,
      failed: async () => {
        throw new Error("Unexpected failure");
      },
      settling() {},
      settled: done.resolve
    });
    const input = {
      ...target,
      operationId: op.operationId,
      action: "continue"
    };
    try {
      expect(await h.invoke("radius_environment_control", input)).toMatchObject(
        {
          kind: "refused",
          code: "operation-task-busy",
          message: expect.stringContaining("Wait for it to finish, then retry")
        }
      );
      expect(h.persist).not.toHaveBeenCalled();
      gate.resolve();
      await done.promise;
      expect(await h.invoke("radius_environment_control", input)).toMatchObject(
        { kind: "accepted" }
      );
      await h.settled();
      expect(h.runner).toHaveBeenCalledOnce();
    } finally {
      gate.resolve();
      await done.promise;
      await h.extension.shutdown();
    }
  });

  it.each(
    ["shutdown", "run"].flatMap((change) =>
      [false, true].map((reject) => ({ change, reject }))
    )
  )(
    "refuses stale registered Stop observation after $change reject=$reject",
    async ({ change, reject }) => {
      const entered = deferred();
      const gate = deferred();
      const h = await composition({
        cancellationRun: async () => {
          entered.resolve();
          await gate.promise;
          if (reject) throw new Error("late status error");
          return { code: 0, stdout: '{"status":"completed"}', stderr: "" };
        }
      });
      const op = createOperation({ ...target, provider: "azure" });
      op.context.githubLogin = h.executor.login;
      op.verification = { runId: "42", workflowState: "active" };
      op.resumeRequest = { environment: { ...target, provider: "azure" } };
      op.currentStage = STAGE_VERIFY;
      pauseForProviderRestart(op);
      operations.put(op);
      const announce = vi.fn();
      onOperationTerminal(announce);
      try {
        const pending = h.invoke("radius_environment_control", {
          ...target,
          operationId: op.operationId,
          action: "stop"
        });
        await entered.promise;
        if (change === "shutdown") await h.extension.shutdown();
        else op.verification = { runId: "43", workflowState: "active" };
        gate.resolve();
        expect(await pending).toMatchObject({
          kind: change === "shutdown" ? "unavailable" : "refused",
          code:
            change === "shutdown" ?
              "operation-shutting-down"
            : "operation-context-changed",
          message: expect.stringContaining("Stop request was saved")
        });
        expect(op.verification).toEqual({
          runId: change === "run" ? "43" : "42",
          workflowState: "active"
        });
        expect(op.state).toBe("cancelled");
        expect(h.persist).toHaveBeenCalledTimes(1);
        expect(announce).not.toHaveBeenCalled();
        expect(h.accountContext.getExecutor(op.operationId)).toBeUndefined();
      } finally {
        gate.resolve();
        await h.extension.shutdown();
      }
    }
  );

  it("durably settles a registered Stop and duplicate Stop during the same runtime's held resume save", async () => {
    const entered = deferred();
    const gate = deferred();
    const controlEntered = deferred();
    const h = await composition({ controlCheck: controlEntered.resolve });
    const op = createOperation({ ...target, provider: "azure" });
    op.context.githubLogin = h.executor.login;
    op.request = { azure: {} };
    requireInput(op, {
      code: "service-management-reference-required",
      checkpoint: "reference"
    });
    operations.put(op);
    const snapshots: ReturnType<typeof toPersistedOperation>[] = [];
    h.persist.mockImplementation(async () => {
      snapshots.push(structuredClone(toPersistedOperation(op)));
      if (snapshots.length === 1) {
        entered.resolve();
        await gate.promise;
      }
    });
    let resume: Promise<EnvironmentToolResult> | undefined;
    let stop: Promise<EnvironmentToolResult> | undefined;
    let duplicate: Promise<EnvironmentToolResult> | undefined;
    try {
      const identity = { ...target, operationId: op.operationId };
      const status = await h.invoke("radius_environment_status", identity);
      if (!("interaction" in status) || !status.interaction)
        throw new Error("Missing registered input interaction");
      resume = h.invoke("radius_environment_control", {
        ...identity,
        action: "resume",
        provider: "azure",
        checkpoint: "reference",
        interactionId: status.interaction.interactionId,
        answer: {
          code: "service-management-reference-required",
          serviceManagementReference: "approved"
        }
      });
      await entered.promise;
      const accountCalls = h.readExecutor.mock.calls.length;
      stop = h.invoke("radius_environment_control", {
        ...identity,
        action: "stop"
      });
      const reached = await Promise.race([
        controlEntered.promise.then(() => true),
        stop.then(() => false)
      ]);
      expect(reached).toBe(true);
      duplicate = h.invoke("radius_environment_control", {
        ...identity,
        action: "stop"
      });
      gate.resolve();
      expect(await stop).toMatchObject({
        kind: "accepted",
        code: "operation-stopped"
      });
      expect(await duplicate).toMatchObject({
        kind: "accepted",
        code: "operation-stopped"
      });
      await resume;
      expect(op.state).toBe("cancelled");
      expect(op.inputRequired).toBeNull();
      expect(snapshots.at(-1)?.state).toBe("cancelled");
      expect(snapshots.at(-1)?.control.stop.requestedAt).toBeTruthy();
      expect(h.runner).not.toHaveBeenCalled();
      expect(h.run).not.toHaveBeenCalled();
      expect(h.readExecutor).toHaveBeenCalledTimes(accountCalls);
      const admission = h.owner.claimAdmission(op.operationId);
      expect(admission).not.toBeNull();
      admission?.release();
    } finally {
      gate.resolve();
      await Promise.all([resume, stop, duplicate]);
      await h.extension.shutdown();
    }
  });

  it.each(
    ["read", "save"].flatMap((boundary) =>
      [
        "shutdown",
        "target",
        "replacement",
        "save-error",
        "correction-error"
      ].map((change) => ({ boundary, change }))
    )
  )(
    "guards registered resume across held $boundary after $change",
    async ({ boundary, change }) => {
      const entered = deferred();
      const gate = deferred();
      const h = await composition({
        duringResumeRead:
          boundary === "read" ?
            async () => {
              entered.resolve();
              await gate.promise;
            }
          : undefined
      });
      const op = createOperation({ ...target, provider: "azure" });
      op.context.githubLogin = h.executor.login;
      op.request = { azure: {} };
      requireInput(op, {
        code: "service-management-reference-required",
        checkpoint: "reference"
      });
      operations.put(op);
      let saves = 0;
      h.persist.mockImplementation(async () => {
        saves++;
        if (boundary === "save" && saves === 1) {
          entered.resolve();
          await gate.promise;
        }
        if (
          (change === "save-error" && saves === 1) ||
          change === "correction-error"
        )
          throw new Error("fixture save failed");
      });
      try {
        const identity = { ...target, operationId: op.operationId };
        const status = await h.invoke("radius_environment_status", identity);
        if (!("interaction" in status) || !status.interaction)
          throw new Error("Missing prompt");
        const command = {
          ...identity,
          action: "resume",
          provider: "azure",
          checkpoint: "reference",
          interactionId: status.interaction.interactionId,
          answer: {
            code: "service-management-reference-required",
            serviceManagementReference: "approved"
          }
        };
        const pending = h.invoke("radius_environment_control", command);
        await entered.promise;
        const replacement = structuredClone(op);
        if (change === "replacement") operations.put(replacement);
        if (change === "target") op.environment = "other";
        if (change === "shutdown") h.owner.shutdown();
        gate.resolve();
        const correctionFails = change === "correction-error";
        expect(await pending).toMatchObject({
          kind:
            (
              change === "save-error" ||
              correctionFails ||
              change === "shutdown"
            ) ?
              "unavailable"
            : "refused",
          code:
            correctionFails ? "operation-resume-recovery-persist-failed"
            : change === "save-error" ? "operation-resume-persist-failed"
            : change === "shutdown" ? "operation-shutting-down"
            : "operation-resume-mismatch"
        });
        expect(h.runner).not.toHaveBeenCalled();
        expect(h.runtime.servers.size).toBe(0);
        if (change === "replacement")
          expect(operations.get(op.operationId)).toEqual(replacement);
        if (change === "target") expect(op.environment).toBe("other");
        if (
          (change === "shutdown" && boundary === "read") ||
          change === "save-error"
        ) {
          expect(op.state).toBe("input_required");
          expect(op.request.azure.serviceManagementReference).toBeUndefined();
        }
        if (change === "shutdown" && boundary === "save") {
          expect(op.state).toBe("running");
          expect(op.request.azure.serviceManagementReference).toBe("approved");
        }
        const claim = h.owner.claimAdmission(op.operationId);
        expect(claim === null).toBe(correctionFails || change === "shutdown");
        claim?.release();
      } finally {
        gate.resolve();
        await h.extension.shutdown();
      }
    }
  );

  it.each(["active", "unknown"])(
    "refuses a mismatched leased executor for %s workflow",
    async (state) => {
      const h = await composition({
        confirm: async () => true,
        leaseLogin: "wrong-account",
        cancellationRun: async () => {
          throw new Error("Wrong executor must not run");
        }
      });
      const op = stoppedSetup({ repo: target.repo });
      op.context = { githubLogin: h.executor.login };
      op.verification = { runId: "42", workflowState: state };
      operations.put(op);
      try {
        expect(
          await h.invoke("radius_environment_control", {
            ...target,
            operationId: op.operationId,
            action: "cancel-workflow"
          })
        ).toMatchObject({
          kind: "unavailable",
          code:
            state === "active" ?
              "workflow-cancel-failed"
            : "workflow-status-read-failed"
        });
        expect(h.run).not.toHaveBeenCalled();
      } finally {
        await h.extension.shutdown();
      }
    }
  );

  it.each(
    ["confirmation", "save", "account", "status"].flatMap((boundary) =>
      [
        "shutdown",
        "removed",
        "replaced",
        "repo",
        "environment",
        "login",
        "run",
        "attempt"
      ].map((change) => [boundary, change] as const)
    )
  )(
    "fences confirmed cancellation across held %s and %s",
    async (boundary, change) => {
      const entered = deferred();
      const gate = deferred();
      const hold = async () => {
        entered.resolve();
        await gate.promise;
      };
      const confirm = vi.fn(async () => {
        if (boundary === "confirmation") await hold();
        return true;
      });
      const h = await composition({
        confirm,
        beforeLease: boundary === "account" ? hold : undefined,
        cancellationRun: async (args) => {
          if (args[0] !== "run")
            throw new Error("Cancellation POST must not be issued");
          if (boundary === "status") await hold();
          return { code: 0, stdout: '{"status":"in_progress"}', stderr: "" };
        }
      });
      const op = stoppedSetup({ repo: target.repo });
      op.context = { githubLogin: h.executor.login };
      op.verification = { runId: "42", workflowState: "active" };
      operations.put(op);
      if (boundary === "save") h.persist.mockImplementationOnce(hold);
      let pending: Promise<EnvironmentToolResult> | undefined;
      try {
        pending = h.invoke("radius_environment_control", {
          ...target,
          operationId: op.operationId,
          action: "cancel-workflow"
        });
        await entered.promise;
        expect(confirm).toHaveBeenCalledWith(
          expect.stringContaining("run 42 using @saved-account")
        );
        const replacement = structuredClone(op);
        if (change === "shutdown") h.owner.shutdown();
        if (change === "removed") operations.delete(op.operationId);
        if (change === "replaced") operations.put(replacement);
        if (change === "repo") op.repo = "fixture/other";
        if (change === "environment") op.environment = "other";
        if (change === "login") op.context = { githubLogin: "other-account" };
        if (change === "run")
          op.verification = { runId: "43", workflowState: "active" };
        if (change === "attempt") op.control.attempts.verification += 1;
        gate.resolve();
        const result = await pending;
        expect(result.kind).not.toBe("accepted");
        expect(result.code).toBe(
          change === "shutdown" && boundary !== "confirmation" ?
            "operation-shutting-down"
          : "operation-context-changed"
        );
        expect(h.run.mock.calls.some(([args]) => args.includes("POST"))).toBe(
          false
        );
        if (change === "removed")
          expect(operations.get(op.operationId)).toBeNull();
        if (change === "replaced")
          expect(operations.get(op.operationId)).toBe(replacement);
        if (change === "run")
          expect(op.verification).toEqual({
            runId: "43",
            workflowState: "active"
          });
        expect(h.accountContext.getExecutor(op.operationId)).toBeUndefined();
      } finally {
        gate.resolve();
        await pending;
        await h.extension.shutdown();
      }
    }
  );

  it.each(["shutdown", "run", "repo", "login", "removed", "replaced"] as const)(
    "retains original issued cancellation across %s",
    async (change) => {
      const entered = deferred();
      const gate = deferred();
      const h = await composition({
        confirm: async () => true,
        cancellationRun: async (args) => {
          if (args[0] === "api") {
            entered.resolve();
            await gate.promise;
            return { code: 0, stdout: "", stderr: "" };
          }
          if (args[0] === "run")
            return { code: 0, stdout: '{"status":"in_progress"}', stderr: "" };
          throw new Error(`Unexpected command ${args.join(" ")}`);
        }
      });
      const op = stoppedSetup({ repo: target.repo });
      op.context = { githubLogin: h.executor.login };
      op.verification = { runId: "42", workflowState: "active" };
      operations.put(op);
      const diagnostics = vi
        .spyOn(operations, "report")
        .mockImplementation(() => {});
      try {
        const pending = h.invoke("radius_environment_control", {
          ...target,
          operationId: op.operationId,
          action: "cancel-workflow"
        });
        await entered.promise;
        const replacement = structuredClone(op);
        if (change === "shutdown") h.owner.shutdown();
        if (change === "run")
          op.verification = { runId: "43", workflowState: "active" };
        if (change === "repo") op.repo = "fixture/other";
        if (change === "login") op.context = { githubLogin: "other-account" };
        if (change === "removed") operations.delete(op.operationId);
        if (change === "replaced") operations.put(replacement);
        gate.resolve();
        const result = await pending;
        expect(
          h.run.mock.calls.filter(([args]) => args.includes("POST"))
        ).toEqual([
          [
            [
              "api",
              "--method",
              "POST",
              "repos/fixture/app/actions/runs/42/cancel"
            ],
            { timeout: 30000, beforeExecute: expect.any(Function) }
          ]
        ]);
        expect(result.cancellation).toMatchObject({
          target: { repo: "fixture/app", login: "saved-account", runId: "42" },
          state: "cancelling",
          issued: true
        });
        if (change === "removed" || change === "replaced") {
          expect(result.code).toBe("workflow-cancellation-result-detached");
          expect(diagnostics).toHaveBeenCalledWith(
            expect.objectContaining({ code: result.code })
          );
          expect(operations.get(op.operationId)).toBe(
            change === "removed" ? null : replacement
          );
        } else {
          expect(result.kind).toBe("accepted");
          expect(op.control.commands.at(-1)).toMatchObject({
            target: "42",
            state: "finished",
            outcome: "cancelling",
            workflowCancellation: { runId: "42", login: "saved-account" }
          });
          expect(h.persist).toHaveBeenCalledTimes(2);
          if (change === "run")
            expect(op.verification).toEqual({
              runId: "43",
              workflowState: "active"
            });
        }
      } finally {
        gate.resolve();
        await h.extension.shutdown();
      }
    }
  );

  it.each(
    [
      "current",
      "removed",
      "replaced",
      "repository",
      "environment",
      "provider",
      "account",
      "context",
      "request",
      "resume-request",
      "provider-recovery",
      "artifacts",
      "shutdown"
    ].flatMap((change) =>
      ["continue", "rollback"].map((action) => [change, action] as const)
    )
  )(
    "preserves admission ownership when the tool's held save becomes %s after %s authorization",
    async (change, action) => {
      const confirm = vi.fn(async () => true);
      const h = await composition({ confirm });
      const op = stoppedSetup({ repo: target.repo });
      op.context = { githubLogin: h.executor.login };
      operations.put(op);
      const entered = deferred();
      const gate = deferred();
      h.persist.mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
      });
      try {
        const pending = h.invoke("radius_environment_control", {
          ...target,
          operationId: op.operationId,
          action
        });
        await entered.promise;
        expect(h.runner).not.toHaveBeenCalled();
        const replacement = structuredClone(op);
        if (change === "removed") operations.delete(op.operationId);
        if (change === "replaced") operations.put(replacement);
        if (change === "repository") op.repo = "fixture/other";
        if (change === "environment") op.environment = "other";
        if (change === "provider") op.provider = "aws";
        if (change === "account") op.context = { githubLogin: "other-account" };
        if (change === "context")
          op.context = {
            githubLogin: h.executor.login,
            branch: "other-branch"
          };
        if (change === "request")
          op.request = { azure: { appId: "other-app" } };
        if (change === "resume-request")
          op.resumeRequest = { environment: { environment: "other" } };
        if (change === "provider-recovery")
          op.providerRecovery = { state: "reconciliation_pending" };
        if (change === "artifacts")
          recordAzureApp(op, { state: "created", appId: "other-app" });
        if (change === "shutdown") h.owner.shutdown();
        expect(confirm).toHaveBeenCalledTimes(action === "rollback" ? 1 : 0);
        gate.resolve();
        const result = await pending;
        if (change === "current") {
          expect(result).toMatchObject({ kind: "accepted" });
          await h.settled();
          expect(h.runner).toHaveBeenCalledOnce();
        } else {
          expect(result).toMatchObject({
            kind: "refused",
            code: "operation-context-changed"
          });
          expect(h.runner).not.toHaveBeenCalled();
          expect(h.persist).toHaveBeenCalledTimes(2);
          if (change === "removed")
            expect(operations.get(op.operationId)).toBeNull();
          if (change === "replaced")
            expect(operations.get(op.operationId)).toBe(replacement);
        }
      } finally {
        gate.resolve();
        await h.extension.shutdown();
      }
    }
  );

  it("refuses registered controls while another admission owns the operation", async () => {
    const h = await composition();
    const op = stoppedSetup({ repo: target.repo });
    op.context = { githubLogin: h.executor.login };
    operations.put(op);
    const claim = h.owner.claimAdmission(op.operationId);
    if (!claim) throw new Error("Missing fixture admission");
    try {
      expect(
        await h.invoke("radius_environment_control", {
          ...target,
          operationId: op.operationId,
          action: "continue"
        })
      ).toMatchObject({ kind: "refused", code: "operation-context-changed" });
      expect(h.persist).not.toHaveBeenCalled();
      expect(h.runner).not.toHaveBeenCalled();
      expect(claim.canRestore()).toBe(true);
    } finally {
      claim.release();
      await h.extension.shutdown();
    }
  });

  it("surfaces failed corrective persistence and blocks registered recovery", async () => {
    const h = await composition();
    const op = stoppedSetup({ repo: target.repo });
    op.context = { githubLogin: h.executor.login };
    operations.put(op);
    const entered = deferred();
    const gate = deferred();
    h.persist
      .mockImplementationOnce(async () => {
        entered.resolve();
        await gate.promise;
      })
      .mockRejectedValueOnce(new Error("Fixture corrective save failed"));
    try {
      const input = {
        ...target,
        operationId: op.operationId,
        action: "continue"
      };
      const pending = h.invoke("radius_environment_control", input);
      await entered.promise;
      const replacement = stoppedSetup({ repo: target.repo });
      replacement.operationId = op.operationId;
      replacement.context = { githubLogin: h.executor.login };
      operations.put(replacement);
      gate.resolve();
      expect(await pending).toMatchObject({
        kind: "unavailable",
        code: "operation-control-recovery-persist-failed",
        message: expect.stringContaining(
          "inspect the saved operation before recovery"
        )
      });
      expect(await h.invoke("radius_environment_control", input)).toMatchObject(
        {
          kind: "refused",
          code: "operation-context-changed"
        }
      );
      expect(operations.get(op.operationId)).toBe(replacement);
      expect(h.runner).not.toHaveBeenCalled();
      expect(h.persist).toHaveBeenCalledTimes(2);
    } finally {
      gate.resolve();
      await h.extension.shutdown();
    }
  });

  it.each(["malformed", "empty", "oversized"] as const)(
    "serializes safe %s application guidance through the registered status handler",
    async (shape) => {
      const h = await composition();
      const id = (n: number) =>
        `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
      const candidates = Array.from({ length: 21 }, (_, n) => ({
        appId: id(n),
        displayName: `opaque-private-value${"x".repeat(201)}`,
        credentials: "never-return-this"
      }));
      const op = createOperation({ ...target, provider: "azure" });
      op.context.githubLogin = h.executor.login;
      op.request = { azure: {} };
      requireInput(op, {
        code: "app-selection-required",
        checkpoint: "azure-app-selection",
        metadata: {
          candidates:
            shape === "malformed" ? [null, { appId: "bad" }]
            : shape === "empty" ? []
            : candidates,
          defaultAppId: id(20)
        }
      });
      operations.put(op);
      try {
        const result = await h.invoke("radius_environment_status", {
          ...target,
          operationId: op.operationId
        });
        if (!("interaction" in result) || !result.interaction?.appSelection)
          throw new Error("Expected application guidance");
        const choices = result.interaction.appSelection;
        expect(choices.candidates).toHaveLength(shape === "oversized" ? 20 : 0);
        expect(choices.truncated).toBe(shape === "oversized");
        expect(choices.defaultAppId).toBe(
          shape === "oversized" ? id(20) : undefined
        );
        if (shape === "oversized") {
          expect(choices.candidates.at(-1)?.appId).toBe(id(20));
          expect(
            choices.candidates.every(
              (choice) => choice.displayName.length <= 200
            )
          ).toBe(true);
        }
        expect(JSON.stringify(result)).not.toContain("opaque-private-value");
        expect(JSON.stringify(result)).not.toContain("never-return-this");
        expect(h.run).not.toHaveBeenCalled();
      } finally {
        await h.extension.shutdown();
      }
    }
  );
  it.each(["candidate", "explicit"] as const)(
    "refreshes a real multi-app prompt after settlement and resumes the %s ID without another dialog",
    async (selection) => {
      const h = await composition({ realSetup: true });
      const firstId = "11111111-1111-4111-8111-111111111111";
      const secondId = "22222222-2222-4222-8222-222222222222";
      const explicitId = "55555555-5555-4555-8555-555555555555";
      const tenantId = "33333333-3333-4333-8333-333333333333";
      const callerId = "44444444-4444-4444-8444-444444444444";
      const candidates = [
        {
          appId: firstId,
          displayName: "Radius fixture-app",
          createdDateTime: "2026-10-01T12:00:00Z"
        },
        {
          appId: secondId,
          displayName: "Radius fixture-app",
          createdDateTime: "2026-09-30T12:00:00Z"
        }
      ];
      const saving = deferred();
      const saved = deferred();
      const readingApp = deferred();
      const appRead = deferred();
      const success = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      h.run.mockImplementation(async (args) => {
        const endpoint = args[1]?.replace(/^\//, "");
        if (args[0] === "api") {
          if (endpoint === "user") return success('{"login":"saved-account"}');
          if (endpoint === "repos/fixture/app")
            return success(
              '{"id":23,"name":"app","full_name":"fixture/app","default_branch":"main","owner":{"id":11,"login":"fixture","type":"User"},"permissions":{"admin":true}}'
            );
          if (endpoint === "repos/fixture/app/environments/dev")
            return success('{"name":"dev","id":17}');
          if (endpoint === "repos/fixture/app/actions/oidc/customization/sub")
            return success(
              '{"use_default":true,"use_immutable_subject":false}'
            );
          if (
            endpoint ===
            "repos/fixture/app/environments/dev/variables/AZURE_CLIENT_ID"
          )
            return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
        }
        throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
      });
      const runAz = vi.fn(async (args: string[]) => {
        const command = args.slice(0, 3).join(" ");
        if (args.slice(0, 2).join(" ") === "account set") return success();
        if (args.slice(0, 2).join(" ") === "account show")
          return success(
            JSON.stringify({
              id: firstId,
              tenantId,
              user: { type: "user", name: "fixture@example.test" }
            })
          );
        if (command === "ad signed-in-user show" || command === "ad app owner")
          return success(callerId);
        if (command === "ad app list")
          return success(JSON.stringify(candidates));
        if (args.includes("federated-credential"))
          return { code: 1, stdout: "", stderr: "No matching credential" };
        if (command === "ad app show") {
          readingApp.resolve();
          await appRead.promise;
          return success("app-object");
        }
        if (command === "ad sp show")
          return { code: 1, stdout: "", stderr: "Service principal not found" };
        throw new Error(`Unexpected Azure command: ${args.join(" ")}`);
      });
      vi.spyOn(gh, "cliExec").mockImplementation(
        (command, args, _options, callback) => {
          expect(command).toBe("az");
          void runAz(args).then(
            (result) => callback(null, result.stdout, result.stderr),
            (error: unknown) =>
              callback(
                error instanceof Error ? error : new Error(String(error)),
                "",
                ""
              )
          );
          return new ChildProcess();
        }
      );
      const ghcr = createHarness({ finalRepository: target.repo });
      vi.stubGlobal(
        "fetch",
        async (
          input: string,
          options?: Parameters<typeof ghcr.fetchImpl>[1]
        ) => {
          const url = new URL(input);
          if (url.origin === "https://api.github.com") {
            url.host = "api.test";
            if (url.pathname === "/users/fixture") url.pathname = "/users/acme";
          } else if (url.origin === "https://ghcr.io")
            url.host = "registry.test";
          else throw new Error(`Unexpected fetch: ${url.href}`);
          const response = await ghcr.fetchImpl(url.href, options);
          return {
            ...response,
            headers: {
              get: (name: string) =>
                response.headers
                  .get(name)
                  ?.replaceAll("registry.test", "ghcr.io") ?? null
            }
          };
        }
      );
      h.persist.mockImplementation(async () => {
        if (operations.latest(target.repo)?.state === "input_required") {
          saving.resolve();
          await saved.promise;
        }
      });
      try {
        const started = await h.invoke("radius_setup_environment", {
          ...target,
          provider: "azure",
          subscriptionId: firstId,
          tenantId,
          resourceGroup: "fixture-group",
          cluster: "fixture-cluster"
        });
        if (started.kind !== "accepted")
          throw new Error(JSON.stringify(started));
        const identity = {
          ...target,
          operationId: started.operation.operationId
        };
        await Promise.race([saving.promise, readingApp.promise, h.settled()]);
        const op = operations.get(identity.operationId);
        expect(
          op?.state,
          JSON.stringify({
            failure: op?.failure,
            az: runAz.mock.calls,
            gh: h.run.mock.calls
          })
        ).toBe("input_required");
        expect(op.executionActive).toBe(true);
        const active = await h.invoke("radius_environment_status", identity);
        expect(active).toMatchObject({ interaction: { supported: false } });
        saved.resolve();
        await h.settled();
        const status = await h.invoke("radius_environment_status", identity);
        expect(status).toMatchObject({
          interaction: {
            supported: true,
            appSelection: {
              candidates,
              defaultAppId: secondId,
              truncated: false
            }
          }
        });
        if (!("interaction" in status) || !status.interaction?.appSelection)
          throw new Error("Expected application choices");
        if (!("interaction" in active) || !active.interaction)
          throw new Error("Expected active prompt");
        expect(status.interaction.interactionId).not.toBe(
          active.interaction.interactionId
        );
        const answer = {
          ...identity,
          action: "resume",
          provider: "azure",
          checkpoint: status.interaction.checkpoint,
          interactionId: status.interaction.interactionId,
          answer: {
            code: status.interaction.code,
            createNew: false,
            appId:
              selection === "candidate" ?
                status.interaction.appSelection.defaultAppId
              : explicitId
          }
        };
        expect(
          await h.invoke("radius_environment_control", {
            ...answer,
            interactionId: active.interaction.interactionId
          })
        ).toMatchObject({ code: "operation-resume-mismatch" });
        expect(
          await h.invoke("radius_environment_control", answer)
        ).toMatchObject({ kind: "accepted" });
        await Promise.race([readingApp.promise, h.settled()]);
        expect(runAz.mock.calls).toEqual(
          expect.arrayContaining([
            [
              expect.arrayContaining([
                "ad",
                "app",
                "show",
                "--id",
                answer.answer.appId
              ])
            ]
          ])
        );
        expect(op.request.azure.appId).toBe(answer.answer.appId);
        expect(op.request.azure.createNew).not.toBe(true);
        expect(
          await h.invoke("radius_environment_control", answer)
        ).toMatchObject({ kind: "refused" });
        expect(h.reportError).not.toHaveBeenCalled();
        expect(h.runtime.servers.size).toBe(0);
        const callsBeforeShutdown = {
          gh: h.run.mock.calls.length,
          az: runAz.mock.calls.length
        };
        const closing = h.extension.shutdown();
        appRead.resolve();
        await closing;
        await h.settled();
        expect(op.endedAt).toBeNull();
        expect(op.failure).toBeNull();
        expect(h.run).toHaveBeenCalledTimes(callsBeforeShutdown.gh);
        expect(runAz).toHaveBeenCalledTimes(callsBeforeShutdown.az);
        expect(
          await h.invoke("radius_environment_status", identity)
        ).toMatchObject({
          kind: "unavailable",
          code: "operation-shutting-down"
        });
      } finally {
        saved.resolve();
        const closing = h.extension.shutdown();
        appRead.resolve();
        await closing;
        await h.settled();
      }
    }
  );
  it.each(["open", "unavailable"] as const)(
    "distinguishes an %s merge check without dispatching verification",
    async (state) => {
      const h = await composition();
      const op = mergeHandoff({
        repo: target.repo,
        pullRequestUrl: "https://github.com/fixture/app/pull/12"
      });
      op.context = { githubLogin: h.executor.login };
      operations.put(op);
      h.run.mockImplementation(async (args) => {
        expect(args[0]).toBe("api");
        expect(args[1]).toBe("repos/fixture/app/pulls/12");
        return state === "open" ?
            {
              code: 0,
              stdout: JSON.stringify({ merged: false, state: "open" }),
              stderr: ""
            }
          : { code: 1, stdout: "", stderr: "Account unavailable" };
      });
      try {
        expect(
          await h.invoke("radius_environment_control", {
            ...target,
            operationId: op.operationId,
            action: "verify"
          })
        ).toMatchObject(
          state === "open" ?
            {
              kind: "interaction_required",
              code: "verification-retry-pull-request-open",
              interaction: {
                kind: "pull-request-merge",
                supported: false,
                pullRequestUrl: "https://github.com/fixture/app/pull/12"
              }
            }
          : {
              kind: "refused",
              code: "verification-retry-github-account-unavailable"
            }
        );
        expect(h.run).toHaveBeenCalledOnce();
        expect(h.runner).not.toHaveBeenCalled();
        expect(op.verification).toMatchObject({ runId: null });
        expect(h.runtime.servers.size).toBe(0);
      } finally {
        await h.extension.shutdown();
      }
    }
  );
  it.each([
    null,
    "",
    "opaque-private-value",
    "http://github.com/fixture/app/pull/12",
    "https://github.com/foreign/app/pull/12"
  ])(
    "does not expose invalid saved merge evidence %j through the registered tool",
    async (pullRequestUrl) => {
      const h = await composition({ realSetup: true });
      const op = mergeHandoff({ repo: target.repo, pullRequestUrl });
      op.context = { githubLogin: h.executor.login };
      operations.put(op);
      try {
        const result = await h.invoke("radius_environment_control", {
          ...target,
          operationId: op.operationId,
          action: "verify"
        });
        expect(result).toMatchObject({
          kind: "refused",
          code: "verification-retry-github-account-unavailable"
        });
        expect(result).not.toHaveProperty("interaction");
        if (pullRequestUrl)
          expect(JSON.stringify(result)).not.toContain(pullRequestUrl);
        expect(h.run).not.toHaveBeenCalled();
        expect(h.runtime.servers.size).toBe(0);
      } finally {
        await h.extension.shutdown();
      }
    }
  );
  it("preserves unknown dispatch evidence when the registered verify tool shuts down during send", async () => {
    const h = await composition({ realSetup: true });
    const entered = deferred();
    const send = deferred();
    const saving = deferred();
    const saved = deferred();
    const op = createOperation({ ...target, provider: "azure" });
    op.context.githubLogin = h.executor.login;
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
    const snapshots: ReturnType<typeof toPersistedOperation>[] = [];
    h.persist.mockImplementation(async () => {
      snapshots.push(structuredClone(toPersistedOperation(op)));
      if (op.providerRecovery.mutations.at(-1)?.status === "outcome_unknown") {
        saving.resolve();
        await saved.promise;
      }
    });
    h.run.mockImplementation(async (args) => {
      if (args[0] === "run" && args[1] === "list")
        return { code: 0, stdout: "[]", stderr: "" };
      if (args[0] !== "workflow")
        throw new Error(`Unexpected command ${args.join(" ")}`);
      entered.resolve();
      await send.promise;
      return { code: 1, stdout: "", stderr: "timeout", timedOut: true };
    });
    const external = vi.spyOn(gh, "cliExec").mockImplementation(() => {
      throw new Error("Unexpected ambient command");
    });
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => {
        throw new Error("Unexpected network request");
      });
    let done = Promise.resolve();
    try {
      const result = await h.invoke("radius_environment_control", {
        ...target,
        operationId: op.operationId,
        action: "verify"
      });
      expect(result).toMatchObject({
        kind: "accepted",
        operation: { ...target, operationId: op.operationId }
      });
      done = h.settled();
      await Promise.race([entered.promise, done]);
      expect(h.run).toHaveBeenCalledTimes(2);
      expect(h.accountContext.getExecutor(op.operationId)).toBe(h.executor);
      await h.extension.shutdown();
      send.resolve();
      await Promise.race([saving.promise, done]);
      expect(op.providerRecovery.mutations.at(-1)?.status).toBe(
        "outcome_unknown"
      );
      expect(h.accountContext.getExecutor(op.operationId)).toBe(h.executor);
      saved.resolve();
      await done;
      expect(h.accountContext.getExecutor(op.operationId)).toBeUndefined();
      expect(h.owner.hasActiveEnvironmentTasks(undefined)).toBe(false);
      expect(h.run).toHaveBeenCalledTimes(2);
      expect(op.endedAt).toBeNull();
      expect(op.failure).toBeNull();
      expect(snapshots.at(-1)?.providerRecovery.mutations.at(-1)).toMatchObject(
        {
          kind: "github_workflow.dispatch_retry",
          status: "outcome_unknown"
        }
      );
      expect(
        await h.invoke("radius_environment_control", {
          ...target,
          operationId: op.operationId,
          action: "verify"
        })
      ).toMatchObject({ kind: "unavailable", code: "operation-shutting-down" });
      expect(h.runtime.servers.size).toBe(0);
      expect(h.runner).not.toHaveBeenCalled();
      expect(external).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
      expect(h.reportError).not.toHaveBeenCalled();
    } finally {
      send.resolve();
      saved.resolve();
      await h.extension.shutdown();
      await done;
    }
  });
  it("registers flat provider schemas while retaining a nested answer union", async () => {
    const h = await composition();
    try {
      for (const tool of h.extension.tools) {
        expect(tool.parameters).toMatchObject({
          type: "object",
          properties: expect.any(Object)
        });
        for (const keyword of ["oneOf", "anyOf", "allOf", "enum", "not"])
          expect(tool.parameters).not.toHaveProperty(keyword);
      }
      expect(
        h.extension.tools.find(
          ({ name }) => name === "radius_environment_control"
        )?.parameters
      ).toMatchObject({
        properties: { answer: { anyOf: expect.any(Array) } }
      });
    } finally {
      await h.extension.shutdown();
    }
  });

  it.each(["before-command", "service-read"] as const)(
    "refuses a same-code replacement prompt at %s without accepting its answer",
    async (when) => {
      let enter = () => {};
      let release = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const h = await composition({
        beforeResume: async () => {
          enter();
          await gate;
        }
      });
      const op = createOperation({ ...target, provider: "azure" });
      op.context.githubLogin = "saved-account";
      op.request = { azure: {} };
      const prompt = {
        code: "service-management-reference-required",
        checkpoint: "reference"
      };
      requireInput(op, prompt);
      operations.put(op);
      try {
        const identity = { ...target, operationId: op.operationId };
        const status = await h.invoke("radius_environment_status", identity);
        if (!("interaction" in status) || !status.interaction)
          throw new Error("Expected current input handle");
        if (when === "before-command") requireInput(op, { ...prompt });
        const command = h.invoke("radius_environment_control", {
          ...identity,
          action: "resume",
          provider: "azure",
          checkpoint: prompt.checkpoint,
          interactionId: status.interaction.interactionId,
          answer: {
            code: prompt.code,
            serviceManagementReference: "obsolete-answer"
          }
        });
        if (when === "service-read") {
          await entered;
          requireInput(op, { ...prompt });
        }
        release();
        expect(await command).toMatchObject({
          kind: when === "service-read" ? "unavailable" : "refused",
          code:
            when === "service-read" ?
              "environment-tool-failed"
            : "operation-resume-mismatch"
        });
        expect(op.request.azure.serviceManagementReference).toBeUndefined();
        expect(op.state).toBe("input_required");
        expect(h.persist).not.toHaveBeenCalled();
        expect(h.runner).not.toHaveBeenCalled();
        expect(h.reportError).toHaveBeenCalledTimes(
          when === "service-read" ? 1 : 0
        );
      } finally {
        release();
        await h.extension.shutdown();
      }
    }
  );

  it("does not treat a reauthorization requirement ID as a supported input handle", async () => {
    const h = await composition();
    const op = createOperation({ ...target, provider: "azure" });
    op.context.githubLogin = "saved-account";
    op.request = { azure: {} };
    requireInput(op, {
      code: "service-management-reference-required",
      checkpoint: "reference"
    });
    operations.put(op);
    try {
      const identity = { ...target, operationId: op.operationId };
      h.readExecutor.mockRejectedValueOnce(new Error("Account unavailable"));
      const requirement = await h.invoke("radius_environment_status", identity);
      expect(requirement).toMatchObject({
        kind: "interaction_required",
        interaction: { supported: false }
      });
      if (requirement.kind !== "interaction_required")
        throw new Error("Expected reauthorization requirement");
      await h.invoke("radius_environment_status", identity);
      expect(
        await h.invoke("radius_environment_control", {
          ...identity,
          action: "resume",
          provider: "azure",
          checkpoint: "reference",
          interactionId: requirement.interaction.interactionId,
          answer: {
            code: "service-management-reference-required",
            serviceManagementReference: "not-authorized-by-this-id"
          }
        })
      ).toMatchObject({ kind: "refused", code: "operation-resume-mismatch" });
      expect(h.runner).not.toHaveBeenCalled();
      expect(h.persist).not.toHaveBeenCalled();
    } finally {
      await h.extension.shutdown();
    }
  });
  it.each(["verification", "bypass"] as const)(
    "stops the tool-owned %s observer on runtime shutdown",
    async (method) => {
      const h = await composition();
      const op = createOperation({
        ...target,
        provider: "azure",
        operationId: "stopped-observer"
      });
      op.context.githubLogin = "saved-account";
      op.currentStage = STAGE_VERIFY;
      op.verification = {
        runId: "42",
        workflow: "verify.yml",
        ref: "feature/current",
        environment: "dev",
        dispatchedAt: Date.now()
      };
      operations.put(op);
      h.run.mockImplementation(async () => {
        h.owner.shutdown();
        return { code: 0, stdout: "RADIUS_MANAGED", stderr: "" };
      });
      try {
        const identity = {
          ...target,
          operationId: op.operationId,
          runId: "42"
        };
        const result =
          method === "verification" ?
            await h.runtime.environmentServices.verification(
              identity,
              h.executor
            )
          : await h.runtime.environmentServices.bypass(
              identity,
              h.executor,
              () => true
            );
        expect(result).toMatchObject({ status: 503 });
        expect(h.run.mock.calls.some(([args]) => args[0] === "variable")).toBe(
          false
        );
        expect(h.runtime.servers.size).toBe(0);
      } finally {
        await h.extension.shutdown();
      }
    }
  );
  it.each([true, false])(
    "records an exact-run bypass only after trusted host confirmation=%s",
    async (confirmed) => {
      const confirm = vi.fn(async () => confirmed);
      const h = await composition({ permissionsFailure: true, confirm });
      const op = createOperation({
        ...target,
        provider: "azure",
        operationId: "saved-bypass"
      });
      op.context.githubLogin = "saved-account";
      op.currentStage = STAGE_VERIFY;
      op.verification = {
        runId: "42",
        workflow: "verify.yml",
        ref: "feature/current",
        environment: "dev",
        dispatchedAt: Date.now()
      };
      operations.put(op);
      const identity = { ...target, operationId: op.operationId };
      try {
        expect(
          await h.invoke("radius_environment_status", identity)
        ).toMatchObject({
          kind: "status",
          verification: { state: "failed" },
          operation: {
            actions: expect.arrayContaining(["bypass-verification"])
          }
        });
        expect(h.run.mock.calls.some(([args]) => args[0] === "variable")).toBe(
          false
        );
        expect(
          await h.invoke("radius_environment_control", {
            ...identity,
            action: "bypass-verification"
          })
        ).toMatchObject({ kind: confirmed ? "accepted" : "refused" });
        expect(confirm).toHaveBeenCalledWith(
          expect.stringContaining("saved-bypass")
        );
        expect(
          h.run.mock.calls.filter(([args]) => args[0] === "variable")
        ).toHaveLength(confirmed ? 1 : 0);
        expect(h.runner).not.toHaveBeenCalled();
        expect(h.runtime.servers.size).toBe(0);
        expect(h.deps.deploy.fetch).not.toHaveBeenCalled();
      } finally {
        await h.extension.shutdown();
      }
    }
  );
  it.each([
    ["azure", "dev"],
    ["aws", "dev"],
    ["azure", " dev "],
    ["aws", "\tdev\n"]
  ] as const)(
    "durably admits %s verify-only setup named %j without Canvas or local HTTP",
    async (provider, environment) => {
      const h = await composition({ awsEnabled: true });
      try {
        const result = await h.invoke("radius_setup_environment", {
          ...target,
          environment,
          provider,
          ...(provider === "azure" ?
            {
              tenantId: "11111111-1111-4111-8111-111111111111",
              subscriptionId: "22222222-2222-4222-8222-222222222222",
              resourceGroup: "fixture-rg",
              cluster: "fixture-aks"
            }
          : {
              existingRoleArn: "arn:aws:iam::123456789012:role/fixture",
              accountId: "123456789012",
              region: "us-west-2",
              cluster: "fixture-eks",
              vpcId: "vpc-0f1e",
              subnetIds: "subnet-a,subnet-b"
            })
        });
        expect(result).toMatchObject({
          kind: "accepted",
          operation: { ...target, provider }
        });
        if (result.kind !== "accepted")
          throw new Error("Expected admitted operation");
        await h.settled();
        expect(h.runner).toHaveBeenCalledWith(result.operation.operationId);
        expect(h.runner).toHaveBeenCalledOnce();
        expect(h.ready).toHaveBeenCalledWith(expect.objectContaining(target));
        expect(
          operations.get(result.operation.operationId)?.request
        ).toMatchObject({
          github: { login: "saved-account" },
          environment: {
            branch: "feature/current",
            provider,
            namespace: "default"
          }
        });
        expect(h.persist).toHaveBeenCalled();
        expect(h.runtime.servers.size).toBe(0);
        expect(h.getOrCreateServer).not.toHaveBeenCalled();
        expect(h.deps.deploy.fetch).not.toHaveBeenCalled();
        expect(h.run).not.toHaveBeenCalled();
        const identity = {
          ...target,
          operationId: result.operation.operationId
        };
        expect(
          await h.invoke("radius_environment_status", identity)
        ).toMatchObject({
          kind: "status",
          operation: identity
        });
        expect(
          await h.invoke("radius_environment_control", {
            ...identity,
            action: "stop"
          })
        ).toMatchObject({
          kind: "accepted",
          operation: identity
        });
      } finally {
        await h.extension.shutdown();
      }
    }
  );
  it("uses a trusted target-bound account choice and rechecks it before admission", async () => {
    const select = vi.fn(async () => "saved-account");
    const h = await composition({
      awsEnabled: true,
      logins: ["another", "saved-account"],
      select
    });
    try {
      const result = await h.invoke("radius_setup_environment", {
        ...target,
        provider: "aws",
        roleName: "fixture-role",
        accountId: "123456789012",
        region: "us-west-2",
        cluster: "fixture",
        vpcId: "vpc-0f1e",
        subnetIds: "subnet-a,subnet-b"
      });
      expect(result.kind).toBe("accepted");
      await h.settled();
      expect(select).toHaveBeenCalledWith(
        expect.stringContaining("fixture/app, environment dev"),
        ["another", "saved-account"]
      );
      expect(h.ready.mock.calls.map(([input]) => input.login)).toEqual([
        "another",
        "saved-account",
        "saved-account"
      ]);
    } finally {
      await h.extension.shutdown();
    }
  });
  it("observes and persists verification with the saved executor after task ownership has settled", async () => {
    const h = await composition();
    const op = createOperation({
      ...target,
      provider: "azure",
      operationId: "saved-setup"
    });
    op.context.githubLogin = "saved-account";
    op.currentStage = STAGE_VERIFY;
    op.verification = {
      runId: "42",
      workflow: "verify.yml",
      ref: "feature/current",
      environment: "dev",
      dispatchedAt: Date.now()
    };
    operations.put(op);
    try {
      const result = await h.invoke("radius_environment_status", {
        ...target,
        operationId: op.operationId
      });
      expect(result).toMatchObject({
        kind: "status",
        operation: { state: "succeeded" },
        verification: { state: "success", runId: "42" }
      });
      expect(h.run).toHaveBeenCalledTimes(2);
      expect(h.readExecutor).toHaveBeenCalledWith("saved-account");
      expect(h.ready).not.toHaveBeenCalled();
      expect(h.runner).not.toHaveBeenCalled();
      expect(h.runtime.servers.size).toBe(0);
    } finally {
      await h.extension.shutdown();
    }
  });
  it("resumes one issued prompt through the production continuation service and refuses replay", async () => {
    const select = vi.fn(async () => null);
    const confirm = vi.fn(async () => false);
    const h = await composition({ select, confirm });
    const op = createOperation({
      ...target,
      provider: "azure",
      operationId: "saved-input"
    });
    op.context.githubLogin = "saved-account";
    op.request = { azure: {} };
    requireInput(op, {
      code: "service-management-reference-required",
      checkpoint: "reference"
    });
    operations.put(op);
    try {
      const status = await h.invoke("radius_environment_status", {
        ...target,
        operationId: op.operationId
      });
      if (!("interaction" in status) || !status.interaction)
        throw new Error("Expected issued prompt");
      const input = {
        ...target,
        operationId: op.operationId,
        action: "resume",
        provider: "azure",
        checkpoint: "reference",
        interactionId: status.interaction.interactionId,
        answer: {
          code: "service-management-reference-required",
          serviceManagementReference: "approved-reference"
        }
      };
      expect(await h.invoke("radius_environment_control", input)).toMatchObject(
        { kind: "accepted" }
      );
      await h.settled();
      expect(op.request.azure.serviceManagementReference).toBe(
        "approved-reference"
      );
      expect(h.runner).toHaveBeenCalledOnce();
      expect(select).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(await h.invoke("radius_environment_control", input)).toMatchObject(
        { code: "operation-resume-mismatch" }
      );
    } finally {
      await h.extension.shutdown();
    }
  });
});
