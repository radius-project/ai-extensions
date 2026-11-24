import { describe, expect, it, vi } from "vitest";
import type { SelectedGhExecutor } from "../../gh.js";
import {
  buildDeleteStages,
  beginRetryAttempt,
  canRetryDeletion,
  createOperation,
  fromPersistedOperation,
  reconcileRestoredOperation,
  STAGE_DELETE_RADIUS_ENV,
  STAGE_DELETE_GITHUB_ENV,
  STAGE_DELETE_STATE_PACKAGE,
  toPersistedOperation
} from "../../operations.js";
import type { EnvironmentDeletionPorts } from "./environment-deletion.js";
import type { EnvironmentDeletionDispatch } from "./radius-environment-workflow-deletion.js";
import type { EnvironmentDispatchAttempt } from "./environment-dispatch-evidence.js";
import {
  hasSelectedEnvironmentDeletion,
  runSelectedEnvironmentDeletion
} from "./selected-environment-deletion.js";

function fixture() {
  const operation = createOperation({
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    kind: "delete",
    stages: buildDeleteStages()
  });
  operation.request = {
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    repoId: 7,
    environmentId: 17,
    clientId: "client",
    tenantId: "tenant",
    selectedOwner: "octocat"
  };
  const never = async () => {
    throw new Error("unexpected external operation");
  };
  const executor: SelectedGhExecutor = {
    login: "octocat",
    credentialSource: "injected",
    requiresKeyringSwitch: false,
    scopes: [],
    run: never,
    runOrThrow: never,
    verifyIdentity: vi.fn(async () => {}),
    packageCredentials: () => {
      throw new Error("unexpected package credential read");
    },
    redact: String,
    errorMessage: String
  };
  const readRepositoryId = vi.fn(async () => 7);
  const readTarget = vi.fn(async () => ({
    repoId: 7,
    environmentId: 17,
    clientId: "client",
    tenantId: "tenant",
    provider: "azure"
  }));
  const isEnvironmentAbsent = vi.fn(async () => true);
  const dispatch = { dispatchedAt: 1234, correlationId: "del-ya-fixture" };
  const observe = vi.fn(async (_dispatch: EnvironmentDeletionDispatch) => ({
    outcome: "deleted" as const
  }));
  const deleteGitHubEnvironment = vi.fn(never);
  const persist = vi.fn(async () => {});
  const deleteRadius = vi.fn(async () => ({ outcome: "deleted" as const }));
  const deleteStatePackage = vi.fn<
    EnvironmentDeletionPorts["deleteStatePackage"]
  >(async () => "deleted");
  const bind = vi.fn(
    (
      _executor: SelectedGhExecutor,
      _assertCurrent: () => void,
      beforeDispatch: (dispatch: EnvironmentDeletionDispatch) => Promise<void>,
      recoverDispatch: () => EnvironmentDeletionDispatch | undefined
    ): EnvironmentDeletionPorts => ({
      persist,
      readRepositoryId,
      deleteStatePackage,
      deleteRadiusEnvironment: async () => {
        const recovered = recoverDispatch();
        if (recovered) return observe(recovered);
        await beforeDispatch(dispatch);
        return deleteRadius();
      },
      runAz: never,
      withCredentialProvenanceLock: (work) => work(),
      readAzureIdentity: never,
      readCredentialProvenance: never,
      removeCredentialProvenance: never,
      clearEnvironmentCredentialProvenance: never,
      removeAwsEnvironmentAccess: never,
      removeAwsDeployIdentityLock: never,
      deleteGitHubEnvironment,
      reportStatePackageDeletionFailure: async () => {},
      errorMessage: String
    })
  );
  const withOwner = vi.fn(
    async (
      _login: string,
      work: (executor: SelectedGhExecutor) => Promise<void>
    ) => work(executor)
  );
  const isCurrent = vi.fn(() => true);
  return {
    operation,
    executor,
    readRepositoryId,
    readTarget,
    isEnvironmentAbsent,
    dispatch,
    observe,
    deleteGitHubEnvironment,
    persist,
    deleteRadius,
    deleteStatePackage,
    bind,
    withOwner,
    isCurrent,
    dependencies: {
      bind,
      withOwner,
      isCurrent,
      readTarget,
      isEnvironmentAbsent
    }
  };
}

describe("saved-account environment deletion", () => {
  it("appends a dispatch generation to the same operation after a saved refusal", async () => {
    const f = fixture();
    const first = {
      ...f.dispatch,
      branch: "main",
      head: "a".repeat(40),
      operationAttempt: 0,
      state: "refused"
    };
    const second: EnvironmentDispatchAttempt = {
      ...f.dispatch,
      correlationId: "del-ya-second",
      branch: "main",
      head: "a".repeat(40),
      operationAttempt: 1,
      state: "unresolved"
    };
    f.operation.request.selectedDispatchAttempts = [first];
    const restored = reconcileRestoredOperation(
      fromPersistedOperation(toPersistedOperation(f.operation))
    );
    beginRetryAttempt(restored, "deletion");
    const claimDispatch = vi.fn(async (_generation: number) => {});
    await runSelectedEnvironmentDeletion(restored, {
      ...f.dependencies,
      claimDispatch,
      verifyRetryTarget: async () => {},
      bind(executor, current, legacyDispatch, legacyRecovery, journal) {
        return {
          ...f.bind(executor, current, legacyDispatch, legacyRecovery),
          async deleteRadiusEnvironment() {
            expect(journal.latest()).toEqual(first);
            await journal.begin(second);
            expect(restored.request.selectedDispatchAttempts).toEqual([
              first,
              second
            ]);
            await journal.record({ ...second, state: "refused" });
            return { outcome: "failed" };
          }
        };
      }
    });
    expect(claimDispatch).toHaveBeenCalledExactlyOnceWith(2);
    expect(restored.operationId).toBe(f.operation.operationId);
    expect(restored.request.selectedDispatchAttempts).toEqual([
      first,
      { ...second, state: "refused" }
    ]);
    expect(canRetryDeletion(restored)).toMatchObject({
      ok: true,
      resumeFrom: STAGE_DELETE_RADIUS_ENV
    });
    expect(f.deleteGitHubEnvironment).not.toHaveBeenCalled();
  });

  it("reacquires the exact saved account and resumes only package cleanup after restart", async () => {
    const f = fixture();
    for (const stage of f.operation.stages) {
      if (stage.id !== STAGE_DELETE_STATE_PACKAGE) stage.state = "succeeded";
    }
    f.operation.request.selectedDispatchStarted = true;
    const resumed = reconcileRestoredOperation(
      fromPersistedOperation(toPersistedOperation(f.operation))
    );
    expect(hasSelectedEnvironmentDeletion(resumed)).toBe(true);
    await runSelectedEnvironmentDeletion(resumed, f.dependencies);
    expect(f.withOwner).toHaveBeenCalledWith("octocat", expect.any(Function));
    expect(f.bind).toHaveBeenCalledWith(
      f.executor,
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ owner: "octocat" })
    );
    expect(f.deleteRadius).not.toHaveBeenCalled();
    expect(f.deleteStatePackage).toHaveBeenCalledExactlyOnceWith({
      repo: "octo/app",
      environment: "dev"
    });
    expect(resumed.state).toBe("succeeded");
  });

  it("never dispatches a second workflow for a restarted operation with uncertain dispatch", async () => {
    const f = fixture();
    f.operation.request.selectedDispatchStarted = true;
    const restored = reconcileRestoredOperation(
      fromPersistedOperation(toPersistedOperation(f.operation))
    );
    await runSelectedEnvironmentDeletion(restored, f.dependencies);
    expect(restored.state).toBe("failed_partial");
    expect(restored.currentStage).toBe(STAGE_DELETE_RADIUS_ENV);
    expect(restored.failure.message).toContain("may have been accepted");
    expect(f.deleteRadius).not.toHaveBeenCalled();
    expect(f.deleteStatePackage).not.toHaveBeenCalled();
  });

  it("does not dispatch if the saved operation becomes stale while persisting intent", async () => {
    const f = fixture();
    f.persist.mockImplementation(async () => {
      if (f.operation.request.selectedDispatchStarted)
        f.isCurrent.mockReturnValue(false);
    });
    await runSelectedEnvironmentDeletion(f.operation, f.dependencies);
    expect(f.operation.state).toBe("failed_partial");
    expect(f.operation.failure.message).toContain("no longer current");
    expect(f.deleteRadius).not.toHaveBeenCalled();
    expect(f.deleteStatePackage).not.toHaveBeenCalled();
  });

  it("restores the exact dispatch correlation and observes it without dispatching again", async () => {
    const f = fixture();
    for (const stage of f.operation.stages) {
      if (stage.id !== STAGE_DELETE_RADIUS_ENV) stage.state = "succeeded";
    }
    Object.assign(f.operation.request, {
      selectedDispatchStarted: true,
      selectedDispatchTime: f.dispatch.dispatchedAt,
      selectedDispatchCorrelation: f.dispatch.correlationId
    });
    const restored = reconcileRestoredOperation(
      fromPersistedOperation(toPersistedOperation(f.operation))
    );
    await runSelectedEnvironmentDeletion(restored, f.dependencies);
    expect(f.observe).toHaveBeenCalledExactlyOnceWith(f.dispatch);
    expect(f.deleteRadius).not.toHaveBeenCalled();
    expect(restored.state).toBe("succeeded");
  });

  it.each([true, false])(
    "continues after an interrupted environment delete only if absence is confirmed (%s)",
    async (absent) => {
      const f = fixture();
      for (const stage of f.operation.stages) {
        if (stage.id === STAGE_DELETE_GITHUB_ENV) break;
        stage.state = "succeeded";
      }
      f.readTarget.mockRejectedValue(new Error("Environment lookup failed"));
      f.isEnvironmentAbsent.mockResolvedValue(absent);
      await runSelectedEnvironmentDeletion(f.operation, f.dependencies);
      expect(f.deleteGitHubEnvironment).not.toHaveBeenCalled();
      if (absent) {
        expect(f.deleteStatePackage).toHaveBeenCalledOnce();
        expect(f.operation.state).toBe("succeeded");
      } else {
        expect(f.deleteStatePackage).not.toHaveBeenCalled();
        expect(f.operation.failure.message).toContain(
          "Environment lookup failed"
        );
      }
    }
  );

  it("retains a state package when a replacement claims the saved environment name", async () => {
    const f = fixture();
    for (const stage of f.operation.stages) {
      if (stage.id !== STAGE_DELETE_STATE_PACKAGE) stage.state = "succeeded";
    }
    f.isEnvironmentAbsent.mockResolvedValue(false);
    await runSelectedEnvironmentDeletion(f.operation, f.dependencies);
    expect(f.deleteStatePackage).not.toHaveBeenCalled();
    expect(f.operation.failure.message).toContain("kept the state package");
  });
  it.each([
    [STAGE_DELETE_RADIUS_ENV, { environmentId: 18 }],
    [STAGE_DELETE_RADIUS_ENV, { tenantId: "replacement-tenant" }],
    [STAGE_DELETE_GITHUB_ENV, { clientId: "replacement-client" }]
  ] as const)(
    "does not mutate a changed target before %s",
    async (pending, replacement) => {
      const f = fixture();
      for (const stage of f.operation.stages) {
        if (stage.id === pending) break;
        stage.state = "succeeded";
      }
      f.readTarget.mockResolvedValue({
        ...(await f.readTarget()),
        ...replacement
      });
      await runSelectedEnvironmentDeletion(f.operation, f.dependencies);
      expect(f.operation.failure.message).toContain("changed after approval");
      expect(f.deleteRadius).not.toHaveBeenCalled();
      expect(f.deleteGitHubEnvironment).not.toHaveBeenCalled();
      expect(f.deleteStatePackage).not.toHaveBeenCalled();
    }
  );
  it.each([
    "wrong-account",
    "wrong-repository",
    "scope-ended",
    "lost-account"
  ] as const)("fails before any cleanup for %s", async (reason) => {
    const f = fixture();
    if (reason === "wrong-account")
      f.withOwner.mockImplementation(async (_login, work) =>
        work({ ...f.executor, login: "different" })
      );
    if (reason === "wrong-repository") f.readRepositoryId.mockResolvedValue(8);
    if (reason === "scope-ended") f.isCurrent.mockReturnValue(false);
    if (reason === "lost-account")
      f.withOwner.mockRejectedValue(new Error("saved account not available"));
    await expect(
      runSelectedEnvironmentDeletion(f.operation, f.dependencies)
    ).rejects.toThrow();
    expect(f.deleteRadius).not.toHaveBeenCalled();
    expect(f.deleteStatePackage).not.toHaveBeenCalled();
  });

  it("preserves the selected-only discriminator when recovering a damaged owner", async () => {
    const f = fixture();
    f.operation.request.selectedOwner = {};
    const resumed = reconcileRestoredOperation(
      fromPersistedOperation(toPersistedOperation(f.operation))
    );
    expect(hasSelectedEnvironmentDeletion(resumed)).toBe(true);
    await expect(
      runSelectedEnvironmentDeletion(resumed, f.dependencies)
    ).rejects.toThrow("no valid saved GitHub owner");
    expect(f.withOwner).not.toHaveBeenCalled();
  });
});
