import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createCanvasServer } from "../../../src/server/create-canvas-server.js";
import { createRequestHandler } from "../../../src/server/create-request-handler.js";
import { validateBrowserMutationRequest } from "../../../src/server/browser-mutation.js";
import { createOperationsControlRoutes } from "../../../src/server/routes/operations-control.js";
import { createOperationsStatusRoutes } from "../../../src/server/routes/operations-status.js";
import { createTestRouteTable } from "../../support/server/route-table.js";
import {
  newOperation,
  mergeHandoff,
  retryableSetup,
  reusedOnlyFailure,
  stoppedSetup,
  type OperationFixture
} from "../../support/server/operation-fixtures.js";
import {
  acceptCommand,
  buildDeleteStages,
  buildStages,
  canDismissOperation,
  createOperation,
  createRegistry,
  enterStage,
  finish,
  isTerminalState,
  dismissOperation,
  recordAzureApp,
  recordCommitState,
  recordCommittedWorkflowFile,
  recordGitHubEnvironment,
  recordServicePrincipal,
  setCommandState,
  setStageState,
  setVerificationWorkflowState,
  stopAtBoundary,
  toClientView,
  INPUT_REQUIRED_STATE,
  OPERATION_KIND_DELETE,
  STAGE_VERIFY
} from "../../../src/operations.js";
import {
  CLEANUP_COMMANDS,
  cleanupRunnerKind
} from "../../../src/server/services/cleanup-commands.js";
import type { CanvasServerContainer } from "../../../src/server/create-canvas-server.js";
import type {
  OperationActionRecord,
  OperationRecord
} from "../../../src/server/routes/operations-status.js";

// Cooperative controls over a real loopback socket. Every external seam is an
// in-memory double — including the pull-request merge proof, so this suite never
// reaches GitHub — while the eligibility rules, command identity, and retry
// snapshot are the real production functions. The eligibility, persistence, and
// scheduling branches themselves belong to the route unit suite; what is proven
// here is the socket: framing, the nonce, the receiving instance, and the
// journeys a panel actually walks.

let container: CanvasServerContainer | undefined;

const BROWSER_NONCE = "browser-nonce";

afterEach(async () => {
  await container?.stopAll();
  container = undefined;
});

interface Harness {
  records: Map<string, OperationRecord>;
  invalidatedListings: string[];
  persistCalls: string[];
  scheduled: Array<{ kind: string; instanceId: string; commandId: string }>;
  createScheduled: Array<{ instanceId: string; operationId: string }>;
  registry: ReturnType<typeof createRegistry>;
  setPullRequestMergeCheck(
    check: () => Promise<
      | { state: "merged" }
      | { state: "open" }
      | { state: "unavailable"; login: string; detail: string }
    >
  ): void;
}

function start(): Harness {
  const records = new Map<string, OperationRecord>();
  const registry = createRegistry();
  const persistCalls: string[] = [];
  const scheduled: Harness["scheduled"] = [];
  const createScheduled: Harness["createScheduled"] = [];
  const invalidatedListings: string[] = [];
  let pullRequestMergeCheck = (): Promise<
    | { state: "merged" }
    | { state: "open" }
    | { state: "unavailable"; login: string; detail: string }
  > => {
    throw new Error("checkPullRequestMerge must not run over the socket");
  };

  const persistOperations = () => {
    persistCalls.push("persist");
    return Promise.resolve();
  };

  const routes = createTestRouteTable({
    ...createOperationsControlRoutes({
      get: (operationId) => records.get(operationId) ?? null,
      acquireForRetry: (operation) => registry.acquireForRetry(operation),
      persistOperations,
      // Merge-proof eligibility is the route unit suite's to decide; no journey
      // here may reach GitHub for it, so the port refuses rather than answers.
      checkPullRequestMerge: () => pullRequestMergeCheck(),
      inspectVerificationWorkflow: () => Promise.resolve("inactive"),
      cancelVerificationWorkflow: () => Promise.resolve("inactive"),
      schedule: ({ kind, instanceId, commandId }) => {
        scheduled.push({ kind, instanceId, commandId });
        return true;
      },
      invalidateEnvironmentListing: (repo) => {
        invalidatedListings.push(repo);
      }
    }),
    // The by-id read is composed too: a client that just issued a command polls
    // this route next, so the two must agree over the same socket.
    ...createOperationsStatusRoutes(
      {
        latest: () => null,
        latestAny: () => null,
        get: (operationId) => records.get(operationId) ?? null,
        toClientView,
        productVersion: () => "0.0.0",
        now: () => 0
      },
      {
        isValidRepoSlug: (value) =>
          typeof value === "string" && /^[^/\s]+\/[^/\s]+$/.test(value),
        isResourceGroupName: () => true,
        isAksClusterName: () => true,
        isKubernetesNamespace: () => true,
        isUuid: () => true,
        buildStages,
        createOperation,
        startConflict: (repo) => registry.startConflict(repo),
        claimSelectionHandle: () => ({
          ok: true,
          login: "octocat",
          credentialSource: "keyring",
          commit() {},
          release() {}
        }),
        startOperation: (operation) => {
          const result = registry.start(operation);
          if (result.ok) records.set(operation.operationId, operation);
          return result;
        },
        persistOperations,
        finish,
        scheduleEnvironmentOperation: (instanceId, operation) => {
          createScheduled.push({
            instanceId,
            operationId: operation.operationId
          });
          return true;
        },
        errorMessage: (error) => String(error)
      },
      // The resume and abandon actions round out the family. They are declared
      // next to the controls and must keep answering for themselves, so they get
      // real handlers here rather than the throwing stub.
      {
        // The seeded fixtures are real records; the action port declares a
        // narrower request shape than the control port, so the read is asserted
        // rather than widening the fixture type for one dependency.
        getOperation: (operationId) =>
          (records.get(operationId) ?? null) as OperationActionRecord | null,
        canResumeInput: () => false,
        resumeAfterInput: () => {},
        requireInput: () => {},
        finish,
        isTerminalState,
        canDismissOperation,
        dismissOperation,
        persistOperations,
        toClientView,
        scheduleEnvironmentOperation: () => true,
        errorMessage: (error) => String(error),
        inputRequiredState: INPUT_REQUIRED_STATE
      }
    )
  });

  container = createCanvasServer({
    createHttpServer: (handler) => createServer(handler),
    createRequestHandler: ({ instanceId, instances, markActivity }) =>
      createRequestHandler({
        instanceId,
        instances,
        routes,
        markActivity,
        validateBrowserMutation: (context) =>
          validateBrowserMutationRequest({
            request: context.request,
            baseUrl: `http://${context.request.headers.host || ""}`,
            nonce: BROWSER_NONCE
          }),
        handleUnmatchedRequest: (_request, response) => {
          response.writeHead(404);
          response.end("unmatched");
        }
      }),
    createState: () => ({}),
    defaultPage: "graph",
    now: () => Date.now(),
    preferredPort: async () => 0,
    prepareIdentity: () => {}
  });

  return {
    records,
    persistCalls,
    scheduled,
    createScheduled,
    registry,
    invalidatedListings,
    setPullRequestMergeCheck: (check) => {
      pullRequestMergeCheck = check;
    }
  };
}

function seed(harness: Harness, op: OperationFixture): OperationFixture {
  harness.records.set(op.operationId, op);
  harness.registry.put(op);
  return op;
}

function post(
  baseUrl: string,
  path: string,
  headers: Readonly<Record<string, string>> = browserHeaders(baseUrl)
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}"
  });
}

// The controls are declared `nonce-required`, so a real browser request carries
// the same-origin proof and the instance nonce. Sending them here keeps the
// suite on the production path rather than around it.
function browserHeaders(baseUrl: string): Readonly<Record<string, string>> {
  return {
    Origin: new URL(baseUrl).origin,
    "Sec-Fetch-Site": "same-origin",
    "X-Radius-Mutation-Nonce": BROWSER_NONCE
  };
}

interface PreviewEntry {
  kind: string;
  target: string;
}

interface ProjectedAction {
  id: string;
  label: string;
  path: string;
  placement: string;
  scope: string;
  tone: string;
  requiresConfirmation: boolean;
  confirmLabel: string;
  cancelLabel: string;
  preview: { removes: PreviewEntry[]; keeps: PreviewEntry[] };
}

interface ProjectedOperation {
  state: string;
  terminalState: string;
  currentStage: string;
  summary: string;
  headline: { code: string; title: string };
  guidance: unknown[];
  actions: ProjectedAction[];
  stop: { requested: boolean };
  nextTransition: { code: string; message: string };
}

// Every control answers with the same envelope, and the by-id read answers with
// the projection inside it, so the shapes are declared once here rather than
// re-cast at each assertion.
interface ControlBody {
  code: string;
  operationId: string;
  commandId: string;
  attempt: number;
  duplicate?: boolean;
  removed: boolean;
  statusUrl: string;
  operation: ProjectedOperation;
}

async function body(response: Response): Promise<ControlBody> {
  return (await response.json()) as ControlBody;
}

/** The projection a polling panel reads back over the same socket. */
async function poll(
  baseUrl: string,
  statusPath: string
): Promise<ProjectedOperation> {
  const response = await fetch(`${baseUrl}${statusPath}`);
  expect(response.status).toBe(200);
  return (await body(response)).operation;
}

function action(
  operation: ProjectedOperation,
  id: string
): ProjectedAction | undefined {
  return operation.actions.find((entry) => entry.id === id);
}

describe("operation controls real-loopback HIT", () => {
  it("returns the blocking cleanup operation and lets it reacquire the lock", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const old = seed(harness, stoppedSetup());

    const createResponse = await fetch(`${entry.baseUrl}/api/operations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...browserHeaders(entry.baseUrl)
      },
      body: JSON.stringify({
        repo: "contoso/store",
        environment: "prod",
        provider: "azure",
        clientId: "client-1",
        tenantId: "tenant-1",
        subscriptionId: "subscription-1",
        resourceGroup: "rg-prod",
        cluster: "aks-prod"
      })
    });

    expect(createResponse.status).toBe(409);
    expect(await createResponse.json()).toEqual({
      error:
        "An earlier setup for contoso/store must finish deletion before a new setup can start.",
      code: "previous-cleanup-required",
      operationId: old.operationId
    });
    expect(harness.records.size).toBe(1);
    expect(harness.persistCalls).toEqual([]);
    expect(harness.createScheduled).toEqual([]);

    const prior = await poll(
      entry.baseUrl,
      `/api/operations/${encodeURIComponent(old.operationId)}`
    );
    const rollback = action(prior, "rollback");
    expect(rollback?.label).toBe("Delete setup");
    if (!rollback) throw new Error("Expected rollback action.");

    const rollbackResponse = await post(entry.baseUrl, rollback.path);
    expect(rollbackResponse.status).toBe(202);
    expect(harness.scheduled).toEqual([
      {
        kind: "rollback",
        instanceId: "panel-a",
        commandId: expect.stringContaining(`${old.operationId}:rollback:`)
      }
    ]);
  });

  it("accepts a stop over the socket and shows it on the status route", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness, newOperation());

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/stop`
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const accepted = await body(response);
    expect(accepted.code).toBe("operation-stop-pending");
    expect(accepted.operation.stop.requested).toBe(true);
    expect(harness.persistCalls).toEqual(["persist"]);

    // The status URL the response hands back reports the same pending stop.
    const polled = await poll(entry.baseUrl, accepted.statusUrl);
    expect(polled.stop.requested).toBe(true);
    expect(polled.nextTransition.code).toBe("stopping");
  });

  it("offers and schedules only Retry deletion for an incomplete delete", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = createOperation({
      provider: "azure",
      repo: "contoso/store",
      environment: "dev",
      kind: OPERATION_KIND_DELETE,
      stages: buildDeleteStages()
    }) as OperationFixture;
    op.stages[0].state = "succeeded";
    setStageState(op, op.stages[1].id, "failed");
    finish(op, "failed_partial", {
      failure: { code: "credential-delete-failed" }
    });
    seed(harness, op);

    const before = await poll(
      entry.baseUrl,
      `/api/operations/${encodeURIComponent(op.operationId)}`
    );
    expect(before.actions.map((entry) => entry.id)).toEqual(["retry-deletion"]);
    expect(before.actions.map((entry) => entry.label)).not.toContain(
      "Stop Setup"
    );

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/retry/deletion`
    );
    expect(response.status).toBe(202);
    const accepted = await body(response);
    expect(accepted.operation.state).toBe("running");
    expect(accepted.operation.nextTransition).toMatchObject({
      code: "retrying-deletion"
    });
    expect(harness.scheduled).toEqual([
      {
        kind: "deletion_retry",
        instanceId: "panel-a",
        commandId: accepted.commandId
      }
    ]);
  });

  it.each(["rollback", "retry_cleanup", "exit_setup"] as const)(
    "rejects Stop over HTTP while %s cleanup is running",
    async (kind) => {
      const harness = start();
      const entry = await container!.getOrCreate("panel-a");
      const op = seed(harness, newOperation());
      const accepted = acceptCommand(op, {
        kind,
        attempt: 1,
        target: "cleanup#owned"
      });
      setCommandState(op, accepted.command.commandId, "running");

      const response = await post(
        entry.baseUrl,
        `/api/operations/${op.operationId}/stop`
      );

      expect(response.status).toBe(409);
      expect(await body(response)).toMatchObject({
        code: "operation-cleanup-not-stoppable",
        error:
          "Setup cannot be paused while cleanup is running. Wait for cleanup to finish."
      });
      expect(op.stopRequested).toBe(false);
      expect(harness.persistCalls).toEqual([]);
    }
  );

  it("continues an interrupted setup and schedules it on the receiving instance", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-b");
    const op = seed(harness, retryableSetup());

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/retry/setup`
    );

    expect(response.status).toBe(202);
    const accepted = await body(response);
    expect(accepted.attempt).toBe(2);
    expect(accepted.commandId).toBe(`${op.operationId}:retry_setup:2:setup`);
    expect(accepted.operation.state).toBe("running");
    expect(harness.scheduled).toEqual([
      {
        kind: "setup_continuation",
        instanceId: "panel-b",
        commandId: accepted.commandId
      }
    ]);
  });

  it("leaves the family's other sub-routes to their own handlers", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness, newOperation());

    // Abandon and resume sit one segment away from stop and retry. They must
    // reach the operations-status handlers — which refuse this record on their
    // own terms — rather than being claimed by a control template.
    const abandon = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/abandon`
    );
    expect(abandon.status).toBe(409);
    expect((await body(abandon)).code).toBe("operation-abandon-mismatch");

    const resume = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/resume/app-selection-required`
    );
    expect(resume.status).toBe(409);
    expect((await body(resume)).code).toBe("operation-resume-mismatch");

    // A path this family never declared still falls through to the unmatched
    // handler instead of being swallowed by a neighbouring template.
    const unknown = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/pause`
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("unmatched");
  });

  it("fails closed over HTTP when the selected account cannot verify the setup pull request", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness, mergeHandoff());
    op.context = { githubLogin: "alice" };
    harness.setPullRequestMergeCheck(() =>
      Promise.resolve({
        state: "unavailable",
        login: "alice",
        detail: "selected credential unavailable"
      })
    );

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/retry/verification`
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "verification-retry-github-account-unavailable",
      error:
        "Radius could not verify the setup pull request with @alice. Re-check that GitHub account and try again.",
      detail: "selected credential unavailable"
    });
    expect(harness.persistCalls).toEqual(["persist"]);
    expect(harness.scheduled).toEqual([]);
  });

  it("refuses a control request that cannot prove it came from the panel", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness, newOperation());

    for (const path of [
      `/api/operations/${op.operationId}/stop`,
      `/api/operations/${op.operationId}/retry/setup`
    ]) {
      const response = await post(entry.baseUrl, path, {
        Origin: new URL(entry.baseUrl).origin,
        "Sec-Fetch-Site": "same-origin"
      });

      expect(response.status).toBe(403);
      expect((await body(response)).code).toBe(
        "browser-mutation-validation-failed"
      );
    }
    // The refusal lands before the handler, so nothing was recorded on the
    // operation and no runner was asked to pick it up.
    expect(harness.persistCalls).toEqual([]);
    expect(harness.scheduled).toEqual([]);
  });
});

// The stop → decide → act journey over the real socket. Stopping is one
// request, and what happens next is the customer's choice between two more:
// continue the setup, or roll back what the attempt created.
describe("stop, then continue or roll back, over the socket", () => {
  it("stops a running operation and then continues it from the saved resume point", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness, newOperation());
    op.resumeRequest = {
      needsAzureCredentials: true,
      azure: {},
      environment: {
        repo: "contoso/store",
        environment: "dev",
        provider: "azure"
      }
    };
    recordAzureApp(op, { state: "created", appId: "app-1" });
    recordServicePrincipal(op, { state: "created", appId: "app-1" });

    // 1. Stop, and let the executor honor it at its next safe boundary.
    const stopped = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/stop`
    );
    expect(stopped.status).toBe(202);
    stopAtBoundary(op, "after_service_principal");

    // 2. The stopped record projects both paths, forward first.
    const view = await poll(entry.baseUrl, `/api/operations/${op.operationId}`);
    expect(view.terminalState).toBe("cancelled");
    expect(view.headline.title).toBe("Environment setup paused");
    expect(view.actions.map((entry) => entry.label)).toEqual([
      "Continue setup",
      "Delete setup",
      "Exit setup"
    ]);

    // 3. Continuing reuses the same operation id and the retained ledger.
    const continued = await post(entry.baseUrl, view.actions[0].path);
    expect(continued.status).toBe(202);
    const accepted = await body(continued);
    expect(accepted.operationId).toBe(op.operationId);
    expect(accepted.commandId).toBe(
      `${op.operationId}:continue_setup:2:continue`
    );
    expect(accepted.operation.state).toBe("running");
    expect(harness.scheduled).toEqual([
      {
        kind: "setup_continuation",
        instanceId: "panel-a",
        commandId: accepted.commandId
      }
    ]);
  });

  describe("interrupted verification recovery over the socket", () => {
    it("cancels the exact persisted workflow before cleanup becomes available", async () => {
      const harness = start();
      const entry = await container!.getOrCreate("panel-recovery");
      const op = seed(harness, stoppedSetup({ includeEnvironment: true }));
      op.verification = { runId: "42" };
      setVerificationWorkflowState(op, "active");

      const response = await post(
        entry.baseUrl,
        `/api/operations/${op.operationId}/cancel-workflow`
      );

      expect(response.status).toBe(200);
      expect(await body(response)).toMatchObject({
        code: "workflow-cancelled"
      });
      const view = await poll(
        entry.baseUrl,
        `/api/operations/${op.operationId}`
      );
      expect(view.actions.map((action) => action.id)).toContain("rollback");
      expect(view.actions.map((action) => action.id)).not.toContain(
        "cancel-workflow"
      );
    });

    it("abandons the stopped setup and releases admission while its workflow is active", async () => {
      const harness = start();
      const entry = await container!.getOrCreate("panel-abandon");
      const op = seed(harness, stoppedSetup({ includeEnvironment: true }));
      op.verification = { runId: "42" };
      setVerificationWorkflowState(op, "active");

      const response = await post(
        entry.baseUrl,
        `/api/operations/${op.operationId}/exit?mode=abandon`
      );

      expect(response.status).toBe(200);
      expect(await body(response)).toMatchObject({
        code: "setup-exited",
        removed: false,
        operation: {
          headline: { title: "Environment setup abandoned" },
          actions: []
        }
      });
      expect(harness.scheduled).toEqual([]);
      expect(harness.registry.cleanupRequired("contoso/store")).toBeNull();
    });

    it("rejects a stale abandon URL after cleanup becomes safe", async () => {
      const harness = start();
      const entry = await container!.getOrCreate("panel-abandon-stale");
      const op = seed(harness, stoppedSetup({ includeEnvironment: true }));
      setVerificationWorkflowState(op, "inactive");

      const response = await post(
        entry.baseUrl,
        `/api/operations/${op.operationId}/exit?mode=abandon`
      );

      expect(response.status).toBe(409);
      expect(await body(response)).toMatchObject({
        code: "operation-abandon-not-available"
      });
      expect(harness.scheduled).toEqual([]);
      expect(
        harness.registry.cleanupRequired("contoso/store")?.operationId
      ).toBe(op.operationId);
    });
  });

  it("stops a running operation and then rolls it back through the same record", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-b");
    const op = seed(harness, stoppedSetup({ includeEnvironment: true }));

    const view = await poll(entry.baseUrl, `/api/operations/${op.operationId}`);
    const rollback = action(view, "rollback")!;
    expect(rollback.tone).toBe("danger");
    expect(rollback.requiresConfirmation).toBe(true);
    // The preview the dialog renders is the server's own, in deletion order.
    expect(rollback.preview.removes.map((entry) => entry.kind)).toEqual([
      "github_environment",
      "service_principal",
      "azure_app"
    ]);

    const response = await post(entry.baseUrl, rollback.path);
    expect(response.status).toBe(202);
    const accepted = await body(response);
    expect(accepted.operationId).toBe(op.operationId);
    expect(harness.scheduled).toEqual([
      {
        kind: "rollback",
        instanceId: "panel-b",
        commandId: accepted.commandId
      }
    ]);
    // The kind the route schedules is a runner key, not the persisted command
    // kind. Recovery has to make the same translation, so both are pinned to
    // the one table that actually holds a deletion spec.
    expect(CLEANUP_COMMANDS[harness.scheduled[0].kind]).toBeDefined();
    expect(cleanupRunnerKind("rollback")).toBe(harness.scheduled[0].kind);

    // While cleanup owns the record, no forward retry and no stop are offered.
    const during = await poll(entry.baseUrl, accepted.statusUrl);
    expect(during.actions).toEqual([]);
    expect(during.nextTransition).toEqual({
      code: "rolling-back",
      message: "Deleting setup resources…"
    });
  });

  it("accepts a second continue after the customer stops the continuation", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness, stoppedSetup({ includeEnvironment: true }));

    const first = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/continue`
    );
    expect(first.status).toBe(202);
    expect(await body(first)).not.toMatchObject({ duplicate: true });

    // The customer stops the continuation, then decides to continue again. The
    // saved command from the first attempt must not swallow the second click.
    stopAtBoundary(op, "after_service_principal");
    const second = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/continue`
    );

    expect(second.status).toBe(202);
    const accepted = await body(second);
    expect(accepted.duplicate).toBeUndefined();
    expect(accepted.attempt).toBe(3);
    expect(accepted.commandId).toBe(
      `${op.operationId}:continue_setup:3:continue`
    );
    expect(harness.scheduled).toHaveLength(2);
  });

  it("offers and accepts a post-commit rollback after verification failed", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");

    // The journey the product model names: workflows committed, verification
    // dispatched, the run failed at Azure Login. The environment is unfinished,
    // so both choices are on offer over the same socket.
    const op = seed(harness, newOperation());
    op.context = { githubLogin: "alice" };
    recordAzureApp(op, {
      state: "created",
      appId: "app-1",
      displayName: "radius-store"
    });
    recordServicePrincipal(op, {
      state: "created",
      appId: "app-1",
      objectId: "sp-1"
    });
    recordGitHubEnvironment(op, {
      state: "created",
      repo: "contoso/store",
      name: "dev"
    });
    recordCommittedWorkflowFile(op, {
      path: ".github/workflows/radius-verify-credentials.yml",
      mode: "default_branch",
      branch: "main",
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
      runId: "4242"
    };
    enterStage(op, STAGE_VERIFY);
    finish(op, "failed_partial", {
      failure: {
        code: "verify-run-failed",
        stage: STAGE_VERIFY,
        message: "Credential verification failed.",
        classification: "user-fixable",
        evidence: "Azure Login (OIDC) failed."
      }
    });

    const view = await poll(entry.baseUrl, `/api/operations/${op.operationId}`);
    expect(view.actions.map((entry) => entry.id)).toEqual([
      "retry-verification",
      "rollback",
      "exit-setup"
    ]);
    const rollback = action(view, "rollback");
    expect(rollback?.label).toBe("Delete setup");
    expect(rollback?.scope).toBe("post_commit");
    expect(rollback?.preview.removes[0]).toEqual({
      kind: "workflow_file",
      target: ".github/workflows/radius-verify-credentials.yml on main"
    });

    const response = await post(
      entry.baseUrl,
      `/api/operations/${op.operationId}/rollback`
    );
    expect(response.status).toBe(202);
    expect(harness.scheduled.map((entry) => entry.kind)).toEqual(["rollback"]);
  });
});

// Leaving a setup behind, end to end over the socket. Both shapes matter: the
// reported one, where every resource that exists was reused and the panel has
// to close without deleting anything, and the one where this attempt added a
// GitHub environment that would otherwise stay in the environment list.
describe("exiting a setup over the socket", () => {
  it("closes a reused-only failure without deleting anything and refreshes the listing", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness, reusedOnlyFailure());

    // 1. The headline does not claim resources exist, because none of the ones
    //    that do belong to this attempt.
    const view = await poll(entry.baseUrl, `/api/operations/${op.operationId}`);
    expect(view.summary).toBe(
      'Creating environment "dev" failed partway through.'
    );
    const exit = action(view, "exit-setup");
    expect(exit).toMatchObject({
      label: "Exit setup",
      placement: "bottom",
      // Nothing is deleted, so nothing is confirmed.
      requiresConfirmation: false,
      path: `/api/operations/${op.operationId}/exit`
    });
    expect(exit?.preview.removes).toEqual([]);
    expect(exit?.preview.keeps.map((keep) => keep.target)).toContain(
      "radius-deploy (app-1)"
    );

    // 2. Exiting answers immediately: there is no deletion to schedule.
    const response = await post(entry.baseUrl, exit!.path);
    expect(response.status).toBe(200);
    const closed = await body(response);
    expect(closed.code).toBe("setup-exited");
    expect(closed.removed).toBe(false);
    expect(closed.operation.headline.code).toBe("setup-exited");
    expect(closed.operation.actions).toEqual([]);
    expect(harness.scheduled).toEqual([]);
    expect(harness.invalidatedListings).toEqual(["contoso/store"]);

    // 3. The decision survives the poll the browser makes next, so a reload
    //    cannot put the abandoned attempt back on the page.
    const after = await poll(
      entry.baseUrl,
      `/api/operations/${op.operationId}`
    );
    expect(after.headline).toMatchObject({
      code: "setup-exited",
      title: "Environment setup closed"
    });
    expect(after.actions).toEqual([]);
    expect(after.guidance).toEqual([]);

    // 4. A repeated request is refused rather than closing the record twice.
    const repeat = await post(entry.baseUrl, exit!.path);
    expect(repeat.status).toBe(409);
    expect(await body(repeat)).toMatchObject({ code: "setup-already-exited" });
  });

  it("confirms and schedules the disposal when this attempt created the environment", async () => {
    const harness = start();
    const entry = await container!.getOrCreate("panel-a");
    const op = seed(harness, stoppedSetup({ includeEnvironment: true }));

    const view = await poll(entry.baseUrl, `/api/operations/${op.operationId}`);
    expect(view.summary).toBe('Creating environment "dev" was paused.');
    const exit = action(view, "exit-setup");
    // A deletion is confirmed against the server's own preview before it runs.
    expect(exit).toMatchObject({
      placement: "bottom",
      requiresConfirmation: true,
      confirmLabel: "Exit setup",
      cancelLabel: "Keep this setup"
    });
    expect(exit?.preview.removes).toContainEqual({
      kind: "github_environment",
      target: "contoso/store:dev"
    });

    const response = await post(entry.baseUrl, exit!.path);
    expect(response.status).toBe(202);
    const accepted = await body(response);
    expect(harness.scheduled).toEqual([
      {
        kind: "exit_setup",
        instanceId: "panel-a",
        commandId: accepted.commandId
      }
    ]);
    // The listing is dropped by the deletion pass, which is the only thing that
    // can prove the environment is gone.
    expect(harness.invalidatedListings).toEqual([]);
    expect(accepted.operation.state).toBe("running");

    // A second press while the pass is in flight resolves to the same command.
    const repeat = await post(entry.baseUrl, exit!.path);
    expect(repeat.status).toBe(202);
    expect(await body(repeat)).toMatchObject({
      duplicate: true,
      commandId: accepted.commandId
    });
    expect(harness.scheduled).toHaveLength(1);
  });
});
