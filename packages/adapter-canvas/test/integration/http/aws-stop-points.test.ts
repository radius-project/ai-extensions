import { afterEach, describe, expect, it, vi } from "vitest";
import { readRecordedAwsLock } from "@radius-project/core";
import { createEnvironmentAccountContext } from "../../../src/runtime/environment-account-context.js";
import { createEnvironmentExecutionOwner } from "../../../src/runtime/environment-execution-owner.js";
import { createGitHubAccountCoordinator } from "../../../src/server/services/github-account-coordinator.js";
import {
  configureOperationStore,
  createOperation,
  onOperationTerminal,
  operations,
  requireInput,
  STAGE_AUTHORIZE_IDENTITY
} from "../../../src/operations.js";
import { disabledOperationStore } from "../../../src/operation-store.js";
import { createTestCanvasServerRuntime } from "../../support/server/production-runtime.js";
import { installCliShim, type CliShim } from "../../support/aws/cli-shim.js";
import type { FakeAwsSnapshot } from "../../support/aws/fake-aws.js";
import {
  ACCOUNT,
  CLUSTER,
  completedSetup,
  createAwsScenario,
  ENVIRONMENT,
  LOGIN,
  REGION,
  REPO,
  ROLE,
  type AwsScenario
} from "../../support/aws/scenarios.js";
import {
  lostLocks,
  readOwnership,
  unsavedRollbackResults,
  unsavedSetupChanges
} from "../../support/aws/checks.js";
import {
  writeLabels,
  type OutsideCall
} from "../../support/aws/stop-points.js";

// The riskiest stop points of AWS setup and Delete setup, run through the
// production runtime: its own composition, CLI spawning, cleanup pass, and
// server-ready recovery, with the operation store configured after the
// runtime is created, as the extension does at load. AWS and GitHub are the
// stateful fakes behind a PATH shim, so the runtime's own `aws` and `gh`
// calls reach them. A crash holds the call open and starts a new runtime over
// the same saved records.

type Runtime = ReturnType<typeof createTestCanvasServerRuntime>;

const extensions: Array<{
  owner: ReturnType<typeof createEnvironmentExecutionOwner>;
  runtime: Runtime;
  panel: string;
}> = [];
let installed: CliShim | null = null;

afterEach(async () => {
  // A crashed runtime still holds a call. Refuse it and everything after,
  // then stop every runtime and wait for its work to drain: a refused lock
  // release retries after a delay. The shim leaves PATH only once nothing
  // is left to call it, so no late call reaches the next test or a real CLI.
  installed?.refuseAll();
  const stopped = extensions.splice(0);
  for (const { owner, runtime, panel } of stopped) {
    const drained = owner.shutdown();
    await runtime.stopServer(panel, true);
    await drained;
  }
  expect(stopped.flatMap(({ owner }) => owner.pendingOperationIds())).toEqual(
    []
  );
  await installed?.quiet();
  await installed?.restore();
  installed = null;
  onOperationTerminal(null);
  vi.restoreAllMocks();
  operations.clear();
  await configureOperationStore(disabledOperationStore());
});

// One extension process: a runtime with its own owner, and the store it
// configures after it is created. `restored` sees the records the store
// restored, before the server starts any recovery.
async function startExtension(
  s: AwsScenario,
  panel: string,
  restored: () => void = () => {}
) {
  const owner = createEnvironmentExecutionOwner();
  const runtime = createTestCanvasServerRuntime({
    executionOwner: owner,
    awsEnabled: true,
    accountContext: createEnvironmentAccountContext(
      `aws-stop-points-${panel}`,
      createGitHubAccountCoordinator({
        createExecutor: async () => s.executor,
        getActiveKeyringLogin: async () => LOGIN,
        switchKeyringAccount: async () => {
          throw new Error("Unexpected keyring switch");
        },
        resetIdentityCache: () => {}
      })
    )
  });
  extensions.push({ owner, runtime, panel });
  s.outside.startProcess();
  operations.clear();
  await configureOperationStore(s.disk);
  restored();
  const entry = await runtime.getOrCreateServer(panel, "environment");
  return { owner, runtime, entry, panel };
}

type Extension = Awaited<ReturnType<typeof startExtension>>;

async function shim(s: AwsScenario): Promise<CliShim> {
  installed = await installCliShim({
    aws: s.outside.runAws,
    gh: (args) => s.outside.gh(args)
  });
  return installed;
}

// Wait until the operation has ended and the runtime holds no work for it.
async function settled(
  extension: Extension,
  operationId: string
): Promise<void> {
  await vi.waitFor(
    () => {
      expect(operations.get(operationId)?.endedAt).toBeTruthy();
      expect(extension.owner.pendingOperationIds()).toEqual([]);
    },
    { timeout: 15000 }
  );
}

async function post(extension: Extension, path: string, body?: unknown) {
  const { baseUrl, state } = extension.entry;
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "x-radius-mutation-nonce": String(state.browserMutationNonce),
      "content-type": "application/json"
    },
    body: JSON.stringify(body ?? {})
  });
}

async function actions(
  extension: Extension,
  operationId: string
): Promise<Array<{ id: string; path: string }>> {
  const response = await fetch(
    `${extension.entry.baseUrl}/api/operations/${operationId}`
  );
  return (await response.json()).operation.actions;
}

async function act(extension: Extension, operationId: string, id: string) {
  const action = (await actions(extension, operationId)).find(
    (candidate) => candidate.id === id
  );
  if (!action) throw new Error(`${operationId} offers no ${id}.`);
  const response = await post(extension, action.path);
  expect(response.status).toBeLessThan(300);
}

// Schedule a saved AWS setup through the server, as the resume transport does.
async function startSetup(extension: Extension, operationId: string) {
  const op = createOperation({
    operationId,
    repo: REPO,
    environment: ENVIRONMENT,
    provider: "aws"
  });
  op.context.githubLogin = LOGIN;
  op.currentStage = STAGE_AUTHORIZE_IDENTITY;
  const environment = {
    repo: REPO,
    environment: ENVIRONMENT,
    provider: "aws",
    accountId: ACCOUNT,
    region: REGION,
    cluster: CLUSTER,
    roleName: ROLE,
    existingRoleArn: ""
  };
  op.request = { needsAzureCredentials: false, azure: {}, environment };
  // What the start service saves, since `request` is not saved.
  op.resumeRequest = {
    needsAzureCredentials: false,
    github: { login: LOGIN, credentialSource: "keyring" },
    environment
  };
  requireInput(op, {
    code: "app-selection-required",
    message: "Choose an app.",
    checkpoint: "azure-app-selection"
  });
  operations.put(op);
  await operations.persist();
  const response = await post(
    extension,
    `/api/operations/${operationId}/resume/app-selection-required`,
    {
      repo: REPO,
      environment: ENVIRONMENT,
      provider: "aws",
      checkpoint: "azure-app-selection",
      createNew: true
    }
  );
  expect(response.status).toBeLessThan(300);
}

function withoutProvider(snapshot: FakeAwsSnapshot) {
  return { ...snapshot, oidcProviders: [] };
}

function writesSince(s: AwsScenario, from: number): string[] {
  return writeLabels(
    s.outside.calls.filter((call: OutsideCall) => call.index >= from)
  );
}

function recordedLock(operationId: string) {
  return readRecordedAwsLock(operations.get(operationId)?.context);
}

describe("AWS setup through the production runtime, crashed at its riskiest calls", () => {
  it.each([
    ["the role read, after the lock is saved", "iam get-role", "crash-before"],
    ["create-role, with the answer lost", "iam create-role", "crash-after"],
    [
      "put-role-policy, with the answer lost",
      "iam put-role-policy",
      "crash-after"
    ],
    [
      "create-access-entry, with the answer lost",
      "eks create-access-entry",
      "crash-after"
    ]
  ] as const)("at %s", async (_label, command, kind) => {
    const s = await createAwsScenario("new");
    const baseline = s.aws.snapshot();
    const before = readOwnership(s);
    await shim(s);
    const first = await startExtension(s, "panel-1");
    s.outside.armWhen((call) => call.command === command, kind);
    await startSetup(first, "op_aws_stop_point");
    await s.outside.whenCrashed();
    const savesAtCrash = s.disk.saves;

    // The extension starts again over what it saved: every change AWS made
    // is recorded or journaled, and the lock is named. A write whose answer
    // was lost is then settled by reading AWS; nothing is written, and
    // nothing rolls back.
    const restarting = s.outside.calls.length;
    const second = await startExtension(s, "panel-2", () => {
      expect(unsavedSetupChanges(s, "op_aws_stop_point", before)).toEqual([]);
      expect(lostLocks(s, "op_aws_stop_point", kind, savesAtCrash)).toEqual([]);
      expect(recordedLock("op_aws_stop_point")).not.toBeNull();
    });
    await settled(second, "op_aws_stop_point");
    expect(writesSince(s, restarting)).toEqual([]);
    const op = operations.get("op_aws_stop_point");
    expect(op.providerRecovery?.state).not.toBe("rollback_pending");
    expect((await actions(second, op.operationId)).map((a) => a.id)).toEqual(
      expect.arrayContaining(["continue-setup"])
    );

    // Pause, if the restart left the decision open, then Delete setup.
    if (
      !(await actions(second, op.operationId)).some(
        (action) => action.id === "rollback"
      )
    ) {
      await act(second, op.operationId, "stop");
      await settled(second, op.operationId);
    }
    // Delete setup when AWS holds something this setup made; Exit setup,
    // which still releases the lock, when it made nothing yet.
    const offered = (await actions(second, op.operationId)).map((a) => a.id);
    await act(
      second,
      op.operationId,
      offered.includes("rollback") ? "rollback" : "exit-setup"
    );
    await vi.waitFor(() => expect(recordedLock(op.operationId)).toBeNull(), {
      timeout: 15000
    });
    await settled(second, op.operationId);
    expect(withoutProvider(s.aws.snapshot())).toEqual(
      withoutProvider(baseline)
    );
    expect(recordedLock(op.operationId)).toBeNull();
  });
});

describe("Continue setup through the production runtime, after a crash while it held the lock", () => {
  it("takes back its own lock, with no Remove lock, and releases it", async () => {
    const s = await createAwsScenario("new");
    await shim(s);
    const first = await startExtension(s, "panel-1");
    s.outside.armWhen(
      (call) => call.command === "iam get-role",
      "crash-before"
    );
    await startSetup(first, "op_aws_stop_point");
    await s.outside.whenCrashed();
    const second = await startExtension(s, "panel-2");
    await settled(second, "op_aws_stop_point");
    const held = recordedLock("op_aws_stop_point");
    expect(held).not.toBeNull();

    await act(second, "op_aws_stop_point", "continue-setup");
    await vi.waitFor(
      () => {
        const op = operations.get("op_aws_stop_point");
        expect(op.endedAt).toBeTruthy();
        expect(recordedLock("op_aws_stop_point")).toBeNull();
      },
      { timeout: 15000 }
    );
    await settled(second, "op_aws_stop_point");

    const labels = operations
      .get("op_aws_stop_point")
      .steps.map((step: { label: string }) => step.label);
    expect(labels).toContain(
      `🔒 Took back the lock this setup holds on IAM role ${ROLE} from its earlier attempt.`
    );
    expect(labels.some((label: string) => label.startsWith("⏳"))).toBe(false);
    expect(s.aws.locks()).toEqual([]);
  });
});

// A setup whose Configure environment finished and whose verification then
// failed, saved by the in-process services before the extension starts.
async function failedSetup(s: AwsScenario): Promise<string> {
  const op = await completedSetup(s);
  return op.operationId;
}

describe("Delete setup and Retry deletion through the production runtime, crashed between two removals on one role", () => {
  it.each([
    ["Delete setup", "rollback"],
    ["Retry deletion", "retry-cleanup"]
  ] as const)("%s", async (_label, action) => {
    const s = await createAwsScenario("new");
    const baseline = s.aws.snapshot();
    const operationId = await failedSetup(s);
    await shim(s);
    const first = await startExtension(s, "panel-1");
    if (action === "retry-cleanup") {
      // The first Delete setup keeps the policy and the role it trusts, so
      // Retry deletion has them to remove.
      s.aws.refuseOnce("iam delete-role-policy", "Throttling");
      await act(first, operationId, "rollback");
      await settled(first, operationId);
      expect(
        (await actions(first, operationId)).map((offered) => offered.id)
      ).toContain("retry-cleanup");
    }
    const from = s.outside.calls.length;
    // The access entry went first, and AWS confirmed it; the crash comes as
    // the policy's removal lands.
    s.outside.armWhen(
      (call) => call.command === "iam delete-role-policy",
      "crash-after"
    );
    await act(first, operationId, action);
    await s.outside.whenCrashed();
    const savesAtCrash = s.disk.saves;

    // The restored record holds every removal AWS confirmed, and its lock.
    const second = await startExtension(s, "panel-2", () => {
      expect(unsavedRollbackResults(s, operationId, from)).toEqual([]);
      expect(lostLocks(s, operationId, "crash-after", savesAtCrash)).toEqual(
        []
      );
    });

    // The command the person confirmed resumes on its own, repeats nothing
    // AWS confirmed, and finishes.
    const resuming = s.outside.calls.length;
    await vi.waitFor(
      () =>
        expect(operations.get(operationId)?.terminal?.reason).toMatch(
          /^(rollback|cleanup)-complete$/
        ),
      { timeout: 15000 }
    );
    await settled(second, operationId);
    expect(
      s.outside.calls
        .slice(resuming)
        .filter((call) => call.command === "eks delete-access-entry")
    ).toEqual([]);
    expect(withoutProvider(s.aws.snapshot())).toEqual(
      withoutProvider(baseline)
    );
    expect(s.github.environment(ENVIRONMENT)).toBeUndefined();
    expect(recordedLock(operationId)).toBeNull();
  });
});

describe("Exit setup through the production runtime, crashed as it releases the lock", () => {
  it.each(["crash-before", "crash-after"] as const)(
    "%s the lock's delete-policy",
    async (kind) => {
      const s = await createAwsScenario("new");
      const baseline = s.aws.snapshot();
      const operationId = await failedSetup(s);
      await shim(s);
      const first = await startExtension(s, "panel-1");
      s.outside.armWhen((call) => call.command === "iam delete-policy", kind);
      await act(first, operationId, "exit-setup");
      await s.outside.whenCrashed();
      const savesAtCrash = s.disk.saves;

      const second = await startExtension(s, "panel-2");
      await settled(second, operationId);
      // Released or still named on the record, never lost.
      expect(lostLocks(s, operationId, kind, savesAtCrash)).toEqual([]);

      // The next exit or rollback ends with no lock in IAM or on the record.
      const offered = (await actions(second, operationId)).map((a) => a.id);
      const next = ["exit-setup", "rollback", "retry-cleanup"].find((id) =>
        offered.includes(id)
      );
      if (next) {
        await act(second, operationId, next);
        await vi.waitFor(() => expect(recordedLock(operationId)).toBeNull(), {
          timeout: 15000
        });
        await settled(second, operationId);
      }
      expect(s.aws.locks()).toEqual([]);
      expect(recordedLock(operationId)).toBeNull();
      expect(withoutProvider(s.aws.snapshot())).toEqual(
        withoutProvider(baseline)
      );
    }
  );
});
