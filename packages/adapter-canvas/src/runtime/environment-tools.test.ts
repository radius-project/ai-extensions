import { describe, expect, it, vi } from "vitest";
import { isKubernetesNamespace } from "@radius-project/core";
import {
  isValidRepoSlug,
  isResourceGroupName,
  isAksClusterName,
  isUuid
} from "../azure-oidc.js";
import {
  createOperation,
  buildStages,
  createRegistry,
  finish,
  requireInput,
  setVerificationWorkflowState
} from "../operations.js";
import {
  stoppedSetup,
  mergeHandoff,
  retryableSetup,
  reusedOnlyFailure
} from "../../test/support/server/operation-fixtures.js";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import { createFakeSession } from "../../test/support/runtime/fakes.js";
import { createSetupStartService } from "../server/services/setup-start.js";
import { createSessionHolder } from "./session.js";
import { createEnvironmentExecutionOwner } from "./environment-execution-owner.js";
import {
  createEnvironmentTools,
  type EnvironmentToolsPorts
} from "./environment-tools.js";
import type { EnvironmentToolResult } from "./environment-tool-result.js";

const target = { repo: "fixture/app", environment: "dev" };
const setup = {
  ...target,
  provider: "azure",
  resourceGroup: "fixture-rg",
  cluster: "fixture-aks",
  tenantId: "11111111-1111-4111-8111-111111111111",
  subscriptionId: "22222222-2222-4222-8222-222222222222"
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function harness() {
  const registry = createRegistry();
  const owner = createEnvironmentExecutionOwner();
  const session = createSessionHolder();
  session.set(createFakeSession());
  const executor = successfulSelectedGhExecutor();
  const schedule = vi.fn(() => true);
  const persist = vi.fn(async () => {});
  const start = createSetupStartService({
    isValidRepoSlug,
    isResourceGroupName,
    isAksClusterName,
    isUuid,
    isKubernetesNamespace,
    createOperation,
    buildStages,
    finish,
    startConflict: (repo) => registry.startConflict(repo),
    startOperation: (operation) => registry.start(operation),
    persistOperations: persist,
    scheduleEnvironmentOperation: schedule,
    errorMessage: (error) =>
      error instanceof Error ? error.message : String(error)
  });
  const ports: EnvironmentToolsPorts = {
    owner,
    session,
    start,
    account: vi.fn(async () => ({
      state: "selected" as const,
      login: executor.login,
      executor
    })),
    readExecutor: vi.fn(async () => executor),
    workspace: vi.fn(async () => ({
      repo: target.repo,
      branch: "feature/setup"
    })),
    validateBranch: vi.fn(async () => {}),
    getOperation: (id) => registry.get(id),
    control: vi.fn(async () => {
      throw new Error("Unexpected control");
    }),
    resume: vi.fn(async () => {
      throw new Error("Unexpected resume");
    }),
    verification: vi.fn(async () => {
      throw new Error("Unexpected observation");
    }),
    bypass: vi.fn(async () => {
      throw new Error("Unexpected bypass");
    }),
    redact: (value) => value.replaceAll("opaque-private-value", "[redacted]"),
    reportError: vi.fn()
  };
  const tools = createEnvironmentTools(ports);
  const op = createOperation({
    ...target,
    provider: "azure",
    operationId: "setup-1"
  });
  op.context = { githubLogin: executor.login };
  registry.put(op);
  const identity = { ...target, operationId: op.operationId };
  function stopped() {
    const saved = stoppedSetup({ repo: target.repo });
    saved.operationId = op.operationId;
    saved.context = { githubLogin: executor.login };
    registry.put(saved);
    return saved;
  }
  function prompt() {
    op.request = { azure: {} };
    requireInput(op, {
      code: "app-selection-required",
      checkpoint: "selection",
      message: "Choose an application."
    });
  }
  const accepted = async (operationId = op.operationId) => ({
    status: 202,
    body: { operationId }
  });
  return {
    tools,
    ports,
    registry,
    owner,
    session,
    executor,
    op,
    identity,
    stopped,
    prompt,
    accepted,
    persist,
    schedule
  };
}

function interactionId(result: EnvironmentToolResult): string {
  if (!("interaction" in result) || !result.interaction)
    throw new Error("Expected an interaction");
  return result.interaction.interactionId;
}

describe("environment tool handlers", () => {
  it.each([
    { ...setup, tenantId: undefined },
    { ...setup, roleArn: "aws-only" },
    {
      repo: target.repo,
      environment: target.environment,
      provider: "aws",
      accountId: "123456789012",
      region: "us-west-2",
      cluster: "fixture"
    },
    {
      repo: target.repo,
      environment: target.environment,
      provider: "aws",
      roleArn: "fixture-role",
      accountId: "123456789012",
      region: "us-west-2",
      cluster: "fixture",
      tenantId: setup.tenantId
    }
  ])(
    "enforces provider requirements and exclusivity beyond the flat wire schema: %j",
    async (input) => {
      const h = harness();
      expect(await h.tools.start(input)).toMatchObject({
        kind: "refused",
        code: "invalid-environment-tool-input"
      });
      expect(h.ports.account).not.toHaveBeenCalled();
      expect(h.ports.workspace).not.toHaveBeenCalled();
      expect(h.persist).not.toHaveBeenCalled();
    }
  );
  it.each([
    { action: "resume" },
    {
      action: "resume",
      provider: "azure",
      checkpoint: "selection",
      interactionId: "prompt"
    },
    { action: "stop", provider: "azure" },
    { action: "stop", interactionId: "requirement" },
    {
      action: "rollback",
      answer: { code: "app-selection-required", createNew: true }
    },
    {
      action: "resume",
      provider: "azure",
      checkpoint: "selection",
      interactionId: "prompt",
      answer: {
        code: "app-selection-required",
        createNew: true,
        appId: setup.tenantId
      }
    }
  ])(
    "refuses missing or mixed control arguments before account selection: %j",
    async (args) => {
      const h = harness();
      expect(await h.tools.control({ ...h.identity, ...args })).toMatchObject({
        kind: "refused",
        code: "invalid-environment-tool-input"
      });
      expect(h.ports.account).not.toHaveBeenCalled();
      expect(h.ports.control).not.toHaveBeenCalled();
      expect(h.ports.resume).not.toHaveBeenCalled();
    }
  );
  it("does not accept an informational reauthorization ID as a live resume answer handle", async () => {
    const h = harness();
    h.op.context = {};
    const requirement = await h.tools.status(h.identity);
    expect(requirement).toMatchObject({
      kind: "interaction_required",
      interaction: { supported: false }
    });
    h.op.context = { githubLogin: h.executor.login };
    h.prompt();
    const prompt = await h.tools.status(h.identity);
    expect(prompt).toMatchObject({
      interaction: { supported: true, kind: "setup-input" }
    });
    expect(interactionId(prompt)).not.toBe(interactionId(requirement));
    expect(
      await h.tools.control({
        ...h.identity,
        action: "resume",
        provider: "azure",
        checkpoint: "selection",
        interactionId: interactionId(requirement),
        answer: { code: "app-selection-required", createNew: true }
      })
    ).toMatchObject({ code: "operation-resume-mismatch" });
    expect(h.ports.resume).not.toHaveBeenCalled();
  });
  it("does not accept an informational confirmation ID as consent", async () => {
    const h = harness();
    h.stopped();
    const requirement = await h.tools.control({
      ...h.identity,
      action: "rollback"
    });
    expect(requirement).toMatchObject({
      interaction: { kind: "confirmation", supported: false }
    });
    expect(
      await h.tools.control({
        ...h.identity,
        action: "rollback",
        interactionId: interactionId(requirement)
      })
    ).toMatchObject({ code: "invalid-environment-tool-input" });
    expect(
      await h.tools.control({ ...h.identity, action: "rollback" })
    ).toMatchObject({
      kind: "interaction_required"
    });
    expect(h.ports.control).not.toHaveBeenCalled();
  });
  it("starts through shared admission with current worktree branch and no server", async () => {
    const h = harness();
    h.registry.clear();
    const result = await h.tools.start(setup);
    expect(result).toMatchObject({
      kind: "accepted",
      operation: { ...target, provider: "azure", state: "running" }
    });
    expect(h.schedule).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        request: expect.objectContaining({
          environment: expect.objectContaining({
            branch: "feature/setup",
            namespace: "default"
          })
        })
      })
    );
    expect(h.ports.account).toHaveBeenCalledOnce();
  });
  it("does not select an account for invalid provider values", async () => {
    const h = harness();
    h.registry.clear();
    expect(
      await h.tools.start({ ...setup, tenantId: "invalid" })
    ).toMatchObject({ kind: "refused", code: "invalid-azure-operation-input" });
    expect(h.ports.account).not.toHaveBeenCalled();
  });
  it.each(["dev", " dev ", "\tdev\n", " Dev East "])(
    "uses one canonical setup target for %j without changing caller input",
    async (environment) => {
      const h = harness();
      h.registry.clear();
      const input = { ...setup, environment };
      const canonical = environment.trim();
      const result = await h.tools.start(input);
      expect(result).toMatchObject({
        kind: "accepted",
        operation: { repo: target.repo, environment: canonical }
      });
      if (result.kind !== "accepted") throw new Error("Expected acceptance");
      expect(input.environment).toBe(environment);
      expect(h.ports.account).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { repo: target.repo, environment: canonical }
        })
      );
      expect(h.registry.get(result.operation.operationId)).toMatchObject({
        environment: canonical,
        request: { environment: { environment: canonical } },
        resumeRequest: { environment: { environment: canonical } }
      });
      expect(h.persist).toHaveBeenCalledOnce();
      expect(h.schedule).toHaveBeenCalledOnce();
      const identity = {
        repo: target.repo,
        environment: canonical,
        operationId: result.operation.operationId
      };
      expect(await h.tools.status(identity)).toMatchObject({ kind: "status" });
      if (environment !== canonical) {
        expect(
          await h.tools.status({ ...identity, environment })
        ).toMatchObject({ code: "operation-target-mismatch" });
        expect(
          await h.tools.control({ ...identity, environment, action: "stop" })
        ).toMatchObject({ code: "operation-target-mismatch" });
      }
      expect(await h.tools.start(input)).toMatchObject({
        kind: "refused",
        code: "operation-in-progress"
      });
      expect(h.schedule).toHaveBeenCalledOnce();
    }
  );
  it.each(["", " ", "\t\n"])(
    "refuses an empty canonical environment %j before admission",
    async (environment) => {
      const h = harness();
      h.registry.clear();
      expect(await h.tools.start({ ...setup, environment })).toMatchObject({
        kind: "refused",
        code: "invalid-environment-tool-input"
      });
      expect(h.ports.account).not.toHaveBeenCalled();
      expect(h.persist).not.toHaveBeenCalled();
      expect(h.schedule).not.toHaveBeenCalled();
    }
  );
  it("uses the canonical setup target in required account guidance", async () => {
    const h = harness();
    h.registry.clear();
    vi.mocked(h.ports.account).mockResolvedValue({
      state: "choice-required",
      logins: ["octocat", "another-account"]
    });
    expect(
      await h.tools.start({ ...setup, environment: " dev " })
    ).toMatchObject({
      kind: "interaction_required",
      interaction: { ...target, kind: "github-account-selection" }
    });
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
  });
  it("does not retain an account or register setup when shutdown wins account acquisition", async () => {
    const h = harness();
    h.registry.clear();
    vi.mocked(h.ports.account).mockImplementation(async () => {
      h.owner.shutdown();
      return {
        state: "selected",
        login: h.executor.login,
        executor: h.executor
      };
    });
    expect(await h.tools.start(setup)).toMatchObject({
      code: "operation-context-changed"
    });
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
  });
  it("requires an explicit branch for another repository", async () => {
    const h = harness();
    expect(
      await h.tools.start({ ...setup, repo: "another/app" })
    ).toMatchObject({
      kind: "interaction_required",
      interaction: { kind: "target-required", supported: false }
    });
    expect(h.ports.account).not.toHaveBeenCalled();
  });
  it("validates an explicit branch instead of inheriting a workspace target", async () => {
    const h = harness();
    h.registry.clear();
    await h.tools.start({
      ...setup,
      repo: "another/app",
      branch: "feature/other"
    });
    expect(h.ports.validateBranch).toHaveBeenCalledWith("feature/other");
  });
  it.each(["clientId", "appId"])("rejects invalid optional %s", async (key) => {
    const h = harness();
    expect(await h.tools.start({ ...setup, [key]: "bad-id" })).toMatchObject({
      kind: "refused"
    });
    expect(h.ports.account).not.toHaveBeenCalled();
  });
  it.each([
    { state: "choice-required" as const, logins: ["one", "two"] },
    {
      state: "reauthorization-required" as const,
      message: "Reauthorize the saved account."
    },
    { state: "unavailable" as const, message: "opaque-private-value" },
    { state: "declined" as const },
    { state: "stopped" as const },
    { state: "stale-choice" as const }
  ])("does not admit work after account outcome $state", async (selection) => {
    const h = harness();
    h.registry.clear();
    vi.mocked(h.ports.account).mockResolvedValue(selection);
    const result = await h.tools.start(setup);
    expect(result.kind).not.toBe("accepted");
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("opaque-private-value");
  });
  it("refuses duplicate start calls while a host-held account choice is pending", async () => {
    const h = harness();
    h.registry.clear();
    const gate =
      deferred<Awaited<ReturnType<EnvironmentToolsPorts["account"]>>>();
    const entered = deferred<void>();
    vi.mocked(h.ports.account).mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });
    const first = h.tools.start(setup);
    await entered.promise;
    expect(await h.tools.start(setup)).toMatchObject({
      code: "operation-interaction-pending"
    });
    gate.resolve({ state: "declined" });
    await first;
  });
  it.each(["start", "status", "control"] as const)(
    "refuses malformed %s input before I/O",
    async (method) => {
      const h = harness();
      expect(await h.tools[method]({ confirmed: true })).toMatchObject({
        kind: "refused",
        code: "invalid-environment-tool-input"
      });
      expect(h.ports.account).not.toHaveBeenCalled();
    }
  );
  it("refuses malformed repository slugs and stopped-runtime admissions", async () => {
    const h = harness();
    expect(
      await h.tools.status({ ...h.identity, repo: "../other" })
    ).toMatchObject({ code: "invalid-environment-tool-input" });
    h.owner.shutdown();
    expect(await h.tools.start(setup)).toMatchObject({
      kind: "unavailable",
      code: "operation-shutting-down"
    });
  });
  it("reads saved setup state without selecting an account, dispatching or repairing", async () => {
    const h = harness();
    const result = await h.tools.status(h.identity);
    expect(result).toMatchObject({
      kind: "status",
      operation: { operationId: h.op.operationId, actions: ["stop"] }
    });
    expect(h.ports.readExecutor).toHaveBeenCalledWith(h.executor.login);
    expect(h.ports.account).not.toHaveBeenCalled();
    expect(h.ports.verification).not.toHaveBeenCalled();
    expect(h.ports.control).not.toHaveBeenCalled();
  });
  it.each([
    { operationId: "unknown" },
    { environment: "prod" },
    { repo: "other/app" }
  ])("refuses mismatched saved target %j", async (changed) => {
    const h = harness();
    expect(await h.tools.status({ ...h.identity, ...changed })).toMatchObject({
      kind: "refused"
    });
    expect(h.ports.readExecutor).not.toHaveBeenCalled();
  });
  it.each(["missing", "unavailable", "wrong"] as const)(
    "fails closed for %s saved accounts",
    async (kind) => {
      const h = harness();
      if (kind === "missing") h.op.context = {};
      if (kind === "unavailable")
        vi.mocked(h.ports.readExecutor).mockRejectedValue(new Error("private"));
      if (kind === "wrong") h.op.context.githubLogin = "another-account";
      const result = await h.tools.status(h.identity);
      expect(result.kind).toBe(
        kind === "wrong" ? "refused" : "interaction_required"
      );
      expect(h.ports.verification).not.toHaveBeenCalled();
    }
  );
  it.each([
    "unknown",
    "expired",
    "pending",
    "in_progress",
    "success",
    "failed"
  ] as const)("preserves %s observed evidence", async (state) => {
    const h = harness();
    h.op.verification = { runId: "42" };
    vi.mocked(h.ports.verification).mockResolvedValue({
      status: 200,
      body: { state, runId: "42" }
    });
    expect(await h.tools.status(h.identity)).toMatchObject({
      kind: "status",
      verification: { state, runId: "42" }
    });
  });
  it("exposes only positively classified permissions bypass availability", async () => {
    const h = harness();
    h.op.verification = { runId: "42" };
    vi.mocked(h.ports.verification).mockResolvedValue({
      status: 200,
      body: { state: "failed", category: "permissions" }
    });
    expect(await h.tools.status(h.identity)).toMatchObject({
      operation: { actions: ["stop", "bypass-verification"] }
    });
    vi.mocked(h.ports.verification).mockResolvedValue({
      status: 503,
      body: { state: "unknown", error: "Stopped" }
    });
    expect(await h.tools.status(h.identity)).toMatchObject({
      kind: "unavailable",
      code: "verification-unavailable"
    });
  });
  it("rejects retargeting during account acquisition and observation", async () => {
    const h = harness();
    h.op.verification = { runId: "42" };
    vi.mocked(h.ports.verification).mockImplementation(async () => {
      h.op.environment = "other";
      return { status: 200, body: { state: "success" } };
    });
    expect(await h.tools.status(h.identity)).toMatchObject({
      code: "operation-context-changed"
    });
  });
  it("reuses only the same live input occurrence and consumes its typed answer once", async () => {
    const h = harness();
    h.prompt();
    const first = await h.tools.status(h.identity);
    expect(interactionId(await h.tools.status(h.identity))).toBe(
      interactionId(first)
    );
    vi.mocked(h.ports.resume).mockImplementation(async (input, readInput) => {
      expect(input).toEqual({
        operationId: h.op.operationId,
        code: "app-selection-required"
      });
      expect(await readInput()).toMatchObject({
        ...target,
        provider: "azure",
        checkpoint: "selection",
        createNew: true
      });
      return h.accepted();
    });
    const input = {
      ...h.identity,
      action: "resume",
      provider: "azure",
      checkpoint: "selection",
      interactionId: interactionId(first),
      answer: { code: "app-selection-required", createNew: true }
    };
    expect(await h.tools.control(input)).toMatchObject({ kind: "accepted" });
    expect(await h.tools.control(input)).toMatchObject({
      code: "operation-resume-mismatch"
    });
    expect(h.ports.resume).toHaveBeenCalledOnce();
  });
  it("rejects a replaced prompt even with the same code and checkpoint", async () => {
    const h = harness();
    h.prompt();
    const first = await h.tools.status(h.identity);
    h.prompt();
    expect(
      await h.tools.control({
        ...h.identity,
        action: "resume",
        provider: "azure",
        checkpoint: "selection",
        interactionId: interactionId(first),
        answer: { code: "app-selection-required", createNew: true }
      })
    ).toMatchObject({ code: "operation-resume-mismatch" });
  });
  it.each(["azure-login-required", "azure-consent-required", "unknown-input"])(
    "returns unsupported manual guidance for %s",
    async (code) => {
      const h = harness();
      requireInput(h.op, { code, checkpoint: code });
      expect(await h.tools.status(h.identity)).toMatchObject({
        kind: "status",
        interaction: { code, supported: false }
      });
    }
  );
  it("admits cooperative Stop through the existing service without claiming workflow cancellation", async () => {
    const h = harness();
    vi.mocked(h.ports.control).mockImplementation(() => h.accepted());
    expect(
      await h.tools.control({ ...h.identity, action: "stop" })
    ).toMatchObject({ kind: "accepted" });
    expect(h.ports.control).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: h.op.operationId,
        command: "stop"
      })
    );
    expect(h.ports.account).not.toHaveBeenCalled();
    expect(h.ports.readExecutor).not.toHaveBeenCalled();
  });
  it("admits local Stop even when saved credentials are unavailable", async () => {
    const h = harness();
    h.op.context = {};
    vi.mocked(h.ports.account).mockResolvedValue({
      state: "unavailable",
      message: "Credentials are unavailable."
    });
    vi.mocked(h.ports.control).mockImplementation(() => h.accepted());
    expect(
      await h.tools.control({ ...h.identity, action: "stop" })
    ).toMatchObject({ kind: "accepted" });
    expect(h.ports.account).not.toHaveBeenCalled();
    expect(h.ports.readExecutor).not.toHaveBeenCalled();
  });
  it("keeps local Stop bound to its operation context at queued admission", async () => {
    const h = harness();
    vi.mocked(h.ports.control).mockImplementation(async ({ isCurrent }) => {
      expect(isCurrent?.()).toBe(true);
      h.op.context.githubLogin = "replacement-account";
      expect(isCurrent?.()).toBe(false);
      return {
        status: 409,
        body: { code: "operation-context-changed", error: "Stale operation." }
      };
    });
    expect(
      await h.tools.control({ ...h.identity, action: "stop" })
    ).toMatchObject({ kind: "refused", code: "operation-context-changed" });
    expect(h.ports.account).not.toHaveBeenCalled();
  });
  it("refuses ineligible local Stop without checking credentials", async () => {
    const h = harness();
    finish(h.op, "succeeded");
    expect(
      await h.tools.control({ ...h.identity, action: "stop" })
    ).toMatchObject({
      kind: "refused",
      code: "operation-command-ineligible"
    });
    expect(h.ports.control).not.toHaveBeenCalled();
    expect(h.ports.account).not.toHaveBeenCalled();
  });
  it("requires host confirmation for cleanup and never treats an agent boolean as consent", async () => {
    const h = harness();
    h.stopped();
    expect(
      await h.tools.control({ ...h.identity, action: "rollback" })
    ).toMatchObject({
      kind: "interaction_required",
      interaction: { kind: "confirmation", supported: false }
    });
    expect(
      await h.tools.control({
        ...h.identity,
        action: "rollback",
        confirmed: true
      })
    ).toMatchObject({ kind: "refused" });
    expect(h.ports.control).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "only executes after explicit host confirmation=%s",
    async (confirmed) => {
      const h = harness();
      h.stopped();
      const confirm = vi.fn(async () => confirmed);
      h.session.set(
        createFakeSession({
          capabilities: { ui: { elicitation: true } },
          ui: { select: async () => null, confirm }
        })
      );
      vi.mocked(h.ports.control).mockImplementation(() => h.accepted());
      const result = await h.tools.control({
        ...h.identity,
        action: "rollback"
      });
      expect(result.kind).toBe(confirmed ? "accepted" : "refused");
      expect(h.ports.control).toHaveBeenCalledTimes(confirmed ? 1 : 0);
      expect(confirm).toHaveBeenCalledWith(
        expect.stringContaining(h.op.operationId)
      );
    }
  );
  it("rejects duplicate controls and a host answer for replaced state", async () => {
    const h = harness();
    const op = h.stopped();
    const gate = deferred<boolean>();
    const entered = deferred<void>();
    h.session.set(
      createFakeSession({
        capabilities: { ui: { elicitation: true } },
        ui: {
          select: async () => null,
          confirm: () => {
            entered.resolve();
            return gate.promise;
          }
        }
      })
    );
    const pending = h.tools.control({ ...h.identity, action: "rollback" });
    await entered.promise;
    expect(
      await h.tools.control({ ...h.identity, action: "rollback" })
    ).toMatchObject({ code: "operation-interaction-pending" });
    op.context = { githubLogin: "replacement" };
    gate.resolve(true);
    expect(await pending).toMatchObject({ code: "operation-context-changed" });
    expect(h.ports.control).not.toHaveBeenCalled();
  });
  it("preserves owning refusal codes and merge-required guidance", async () => {
    const h = harness();
    const op = mergeHandoff({ repo: target.repo });
    op.operationId = h.op.operationId;
    op.context = { githubLogin: h.executor.login };
    h.registry.put(op);
    vi.mocked(h.ports.control).mockResolvedValue({
      status: 409,
      body: {
        code: "verification-merge-required",
        error: "Merge the recorded PR."
      }
    });
    expect(
      await h.tools.control({ ...h.identity, action: "verify" })
    ).toMatchObject({
      kind: "interaction_required",
      interaction: { kind: "pull-request-merge", supported: false }
    });
  });
  it("surfaces and redacts thrown service failures", async () => {
    const h = harness();
    vi.mocked(h.ports.control).mockRejectedValue(
      new Error("opaque-private-value")
    );
    expect(await h.tools.control({ ...h.identity, action: "stop" })).toEqual({
      kind: "unavailable",
      code: "environment-tool-failed",
      message: "[redacted]"
    });
    expect(h.ports.reportError).toHaveBeenCalledOnce();
  });
  it.each([409, 503])(
    "preserves a service refusal with status %s and no diagnostic fields",
    async (status) => {
      const h = harness();
      vi.mocked(h.ports.control).mockResolvedValue({ status, body: {} });
      expect(await h.tools.control({ ...h.identity, action: "stop" })).toEqual({
        kind: status === 503 ? "unavailable" : "refused",
        code:
          status === 503 ?
            "environment-service-unavailable"
          : "environment-command-refused",
        message: "The environment service refused the operation."
      });
    }
  );
  it("preserves string service errors and stable admission codes", async () => {
    const h = harness();
    vi.mocked(h.ports.control).mockRejectedValueOnce("opaque-private-value");
    expect(
      await h.tools.control({ ...h.identity, action: "stop" })
    ).toMatchObject({
      kind: "unavailable",
      message: "[redacted]"
    });
    vi.mocked(h.ports.control).mockResolvedValueOnce({
      status: 202,
      body: { code: "operation-stop-requested" }
    });
    expect(
      await h.tools.control({ ...h.identity, action: "stop" })
    ).toMatchObject({
      kind: "accepted",
      code: "operation-stop-requested",
      operation: h.identity
    });
  });
  it.each(["declined", "retargeted"] as const)(
    "does not control an operation after its account is %s",
    async (state) => {
      const h = harness();
      const op = h.stopped();
      vi.mocked(h.ports.account).mockImplementation(async () => {
        if (state === "declined") return { state: "declined" };
        op.environment = "replacement";
        return {
          state: "selected",
          login: h.executor.login,
          executor: h.executor
        };
      });
      expect(
        await h.tools.control({ ...h.identity, action: "continue" })
      ).toMatchObject({
        kind: "refused",
        code:
          state === "declined" ?
            "github-account-declined"
          : "operation-context-changed"
      });
      expect(h.ports.control).not.toHaveBeenCalled();
    }
  );
  it("rejects ineligible controls without soliciting destructive consent", async () => {
    const h = harness();
    expect(
      await h.tools.control({ ...h.identity, action: "rollback" })
    ).toMatchObject({
      code: "operation-command-ineligible"
    });
    expect(h.ports.control).not.toHaveBeenCalled();
  });
  it.each([
    {
      action: "continue",
      source: "stopped",
      command: { command: "continue" },
      sensitive: false
    },
    {
      action: "retry-setup",
      source: "failed",
      command: { command: "retry", retryKind: "setup" },
      sensitive: false
    },
    {
      action: "exit",
      source: "stopped",
      command: { command: "exit" },
      sensitive: true
    },
    {
      action: "exit",
      source: "reused",
      command: { command: "exit" },
      sensitive: false
    },
    {
      action: "abandon",
      source: "active-workflow",
      command: { command: "exit", abandon: true },
      sensitive: true
    },
    {
      action: "cancel-workflow",
      source: "active-workflow",
      command: { command: "cancel-workflow" },
      sensitive: true
    }
  ])(
    "maps $action for $source through the owning service",
    async ({ action, source, command, sensitive }) => {
      const h = harness();
      const op =
        source === "failed" ? retryableSetup(target.repo)
        : source === "reused" ? reusedOnlyFailure(target.repo)
        : stoppedSetup({ repo: target.repo });
      op.operationId = h.identity.operationId;
      op.context = { githubLogin: h.executor.login };
      if (source === "active-workflow")
        op.verification = {
          runId: "42",
          workflow: "radius-verify-credentials.yml",
          status: "in_progress"
        };
      if (source === "active-workflow")
        setVerificationWorkflowState(op, "active");
      h.registry.put(op);
      const confirm = vi.fn(async () => true);
      h.session.set(
        createFakeSession({
          capabilities: { ui: { elicitation: true } },
          ui: { select: async () => null, confirm }
        })
      );
      vi.mocked(h.ports.control).mockImplementation(() => h.accepted());
      expect(await h.tools.control({ ...h.identity, action })).toMatchObject({
        kind: "accepted"
      });
      expect(h.ports.control).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: h.identity.operationId,
          ...command
        })
      );
      expect(confirm).toHaveBeenCalledTimes(sensitive ? 1 : 0);
    }
  );
  it("validates an application answer before passing it to continuation", async () => {
    const h = harness();
    h.prompt();
    const prompt = await h.tools.status(h.identity);
    expect(
      await h.tools.control({
        ...h.identity,
        action: "resume",
        provider: "azure",
        checkpoint: "selection",
        interactionId: interactionId(prompt),
        answer: {
          code: "app-selection-required",
          createNew: false,
          appId: "invalid"
        }
      })
    ).toMatchObject({ code: "invalid-azure-operation-input" });
    expect(h.ports.resume).not.toHaveBeenCalled();
  });
  it("revalidates a typed answer when continuation actually reads it", async () => {
    const h = harness();
    h.prompt();
    const prompt = await h.tools.status(h.identity);
    vi.mocked(h.ports.resume).mockImplementation(async (_input, readInput) => {
      h.prompt();
      await readInput();
      return h.accepted();
    });
    expect(
      await h.tools.control({
        ...h.identity,
        action: "resume",
        provider: "azure",
        checkpoint: "selection",
        interactionId: interactionId(prompt),
        answer: { code: "app-selection-required", createNew: true }
      })
    ).toMatchObject({ kind: "unavailable", code: "environment-tool-failed" });
    expect(h.ports.reportError).toHaveBeenCalledOnce();
  });
  it.each([
    {
      state: "failed",
      category: "permissions",
      runId: "42",
      status: 200,
      allowed: true
    },
    {
      state: "failed",
      category: "permissions",
      runId: 42,
      status: 200,
      allowed: true
    },
    {
      state: "failed",
      category: "permissions",
      runId: "bad-run",
      status: 200,
      allowed: false
    },
    { state: "failed", category: "permissions", status: 200, allowed: false },
    {
      state: "failed",
      category: "cluster-unreachable",
      runId: "42",
      status: 200,
      allowed: false
    },
    {
      state: "failed",
      category: "cloud-unreachable",
      runId: "42",
      status: 200,
      allowed: false
    },
    {
      state: "unknown",
      category: "permissions",
      runId: "42",
      status: 200,
      allowed: false
    },
    {
      state: "expired",
      category: "permissions",
      runId: "42",
      status: 200,
      allowed: false
    },
    {
      state: "failed",
      category: "permissions",
      runId: "42",
      status: 503,
      allowed: false
    }
  ])(
    "requires exact permissions evidence before bypass: %j",
    async ({ status, allowed, ...body }) => {
      const h = harness();
      h.op.verification = { runId: "42" };
      vi.mocked(h.ports.verification).mockResolvedValue({ status, body });
      const confirm = vi.fn(async () => true);
      h.session.set(
        createFakeSession({
          capabilities: { ui: { elicitation: true } },
          ui: { select: async () => null, confirm }
        })
      );
      vi.mocked(h.ports.bypass).mockImplementation(
        async (input, executor, current) => {
          expect(input).toEqual({ ...h.identity, runId: "42" });
          expect(executor).toBe(h.executor);
          expect(current()).toBe(true);
          return h.accepted();
        }
      );
      expect(
        await h.tools.control({ ...h.identity, action: "bypass-verification" })
      ).toMatchObject({
        kind: allowed ? "accepted" : "refused"
      });
      expect(confirm).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(h.ports.bypass).toHaveBeenCalledTimes(allowed ? 1 : 0);
    }
  );
  it.each([
    "shutdown",
    "record",
    "account",
    "verification",
    "control",
    "repo",
    "environment"
  ] as const)(
    "refuses bypass if %s changes during evidence collection",
    async (change) => {
      const h = harness();
      h.op.verification = { runId: "42" };
      vi.mocked(h.ports.verification).mockImplementation(async () => {
        if (change === "shutdown") h.owner.shutdown();
        if (change === "record") h.registry.put({ ...h.op });
        if (change === "account") h.op.context.githubLogin = "other";
        if (change === "verification") h.op.verification.runId = "43";
        if (change === "control") h.op.control.stopRequestedAt = "changed";
        if (change === "repo") h.op.repo = "another/repo";
        if (change === "environment") h.op.environment = "another";
        return {
          status: 200,
          body: { state: "failed", category: "permissions", runId: "42" }
        };
      });
      expect(
        await h.tools.control({ ...h.identity, action: "bypass-verification" })
      ).toMatchObject({
        code: "verification-bypass-ineligible"
      });
      expect(h.ports.bypass).not.toHaveBeenCalled();
    }
  );
});
