import { afterEach, describe, expect, it, vi } from "vitest";
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
  createOperation,
  operations,
  requireInput,
  STAGE_VERIFY
} from "../../../src/operations.js";
import type { EnvironmentToolResult } from "../../../src/runtime/environment-tool-result.js";

afterEach(() => {
  operations.clear();
  vi.restoreAllMocks();
});

const target = { repo: "fixture/app", environment: "dev" };
async function composition(
  options: {
    logins?: string[];
    select?: (message: string, options: string[]) => Promise<string | null>;
    confirm?: (message: string) => Promise<boolean>;
    permissionsFailure?: boolean;
    beforeResume?: () => Promise<void>;
  } = {}
) {
  const fake = createFakeDependencies();
  const owner = createEnvironmentExecutionOwner();
  const run = vi.fn(async (args: string[]) => {
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
  const accountContext = createEnvironmentAccountContext("tools-runtime", {
    createReadOnlyExecutor: readExecutor,
    withSelectedAccount: async () => {
      throw new Error("Unexpected account lease");
    }
  });
  const runner = vi.fn(async () => {});
  const runtime = createTestCanvasServerRuntime({
    executionOwner: owner,
    accountContext,
    environmentOperationRunner: runner
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
  const account = createDeploymentAccountResolver({
    readIdentity: async () => ({
      accounts: (options.logins ?? ["saved-account"]).map((login) => ({
        login,
        active: login === "saved-account",
        hasWorkflow: true,
        hasPackages: true,
        switchable: true,
        acting: false
      }))
    }),
    readiness: {
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
      resume: async (...args) => {
        await options.beforeResume?.();
        return runtime.operationResume(...args);
      },
      owner,
      session: fake.deps.session,
      account,
      workspace: async () => ({ repo: target.repo, branch: "feature/current" }),
      validateBranch: async () => {},
      redact: (value) => value,
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
    readExecutor,
    executor,
    reportError,
    settled
  };
}

describe("registered environment tools with production runtime services", () => {
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
      const h = await composition();
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
              roleArn: "arn:aws:iam::123456789012:role/fixture",
              accountId: "123456789012",
              region: "us-west-2",
              cluster: "fixture-eks"
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
      logins: ["another", "saved-account"],
      select
    });
    try {
      const result = await h.invoke("radius_setup_environment", {
        ...target,
        provider: "aws",
        roleArn: "fixture-role",
        accountId: "123456789012",
        region: "us-west-2",
        cluster: "fixture"
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
