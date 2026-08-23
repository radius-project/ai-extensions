import { describe, expect, it } from "vitest";
import {
  acceptCommand,
  beginRetryAttempt,
  buildCommandId,
  createOperation,
  findActiveCommand,
  finish,
  fromPersistedOperation,
  prepareProviderMutation,
  provenOwnedCleanupTargets,
  recordAzureApp,
  recordCommitState,
  recordCommittedWorkflowFile,
  recordGitHubEnvironment,
  requestStop,
  rollbackArtifactIdentity,
  setCommandState,
  settleProviderMutation,
  toPersistedOperation,
  reconcileRestoredOperation
} from "../../operations.js";
import type { OperationCommandKind } from "../../operations.js";
import { CLEANUP_COMMANDS, cleanupRunnerKind } from "./cleanup-commands.js";
import {
  activeCleanupCommand,
  planRecoveredCleanup,
  planRecoveredSchedule
} from "./recovered-cleanup-command.js";

function recovered(operationId = "op_cleanup") {
  const operation = createOperation({
    operationId,
    provider: "azure",
    repo: "octo/app",
    environment: "prod"
  });
  recordAzureApp(operation, {
    state: "created",
    origin: "this_operation",
    appId: "app-1",
    displayName: "radius-app"
  });
  recordGitHubEnvironment(operation, {
    state: "created",
    origin: "this_operation",
    repo: "octo/app",
    name: "prod"
  });
  // The shape restart recovery leaves behind: reopened as running so a pass can
  // still be scheduled against it.
  operation.recoveryState = "provider_reconciliation_pending";
  operation.providerRecovery.state = "rollback_pending";
  return operation;
}

function persistCounter() {
  const saves: number[] = [];
  return {
    saves,
    persist: async () => {
      saves.push(saves.length + 1);
    }
  };
}

describe("the deletion pass a recovered operation resumes", () => {
  it.each<[string, OperationCommandKind, string]>([
    ["a rollback", "rollback", "rollback"],
    ["a cleanup retry", "retry_cleanup", "cleanup_retry"],
    ["an exit", "exit_setup", "exit_setup"]
  ])(
    "translates %s to the runner key its spec is registered under",
    (_label, commandKind, runnerKind) => {
      const operation = recovered();
      const accepted = acceptCommand(operation, {
        kind: commandKind,
        attempt: 1,
        target: "cleanup#abc"
      });
      setCommandState(operation, accepted.command.commandId, "running");

      const active = activeCleanupCommand(operation);

      expect(active).toEqual({
        commandId: accepted.command.commandId,
        kind: runnerKind
      });
      // The whole point of the translation: the runner has to find a spec.
      expect(CLEANUP_COMMANDS[active!.kind]).toBeDefined();
      expect(CLEANUP_COMMANDS[active!.kind].selectTargets).toBeTypeOf(
        "function"
      );
    }
  );

  it("resumes a command still sitting at accepted", () => {
    const operation = recovered();
    const accepted = acceptCommand(operation, {
      kind: "retry_cleanup",
      attempt: 1,
      target: "cleanup#abc"
    });

    expect(activeCleanupCommand(operation)).toEqual({
      commandId: accepted.command.commandId,
      kind: "cleanup_retry"
    });
  });

  it.each<[string, OperationCommandKind]>([
    ["a finished retry", "retry_cleanup"],
    ["a finished rollback", "rollback"],
    ["a finished exit", "exit_setup"]
  ])("never resumes %s", (_label, commandKind) => {
    const operation = recovered();
    const accepted = acceptCommand(operation, {
      kind: commandKind,
      attempt: 1,
      target: "cleanup#abc"
    });
    setCommandState(operation, accepted.command.commandId, "finished", "done");

    expect(activeCleanupCommand(operation)).toBeNull();
  });

  it("ignores an active command that is not a deletion", () => {
    const operation = recovered();
    const accepted = acceptCommand(operation, {
      kind: "retry_verification",
      attempt: 1,
      target: "verification"
    });
    setCommandState(operation, accepted.command.commandId, "running");

    expect(activeCleanupCommand(operation)).toBeNull();
  });

  it("prefers the newest in-flight pass over an older finished one", () => {
    const operation = recovered();
    const older = acceptCommand(operation, {
      kind: "rollback",
      attempt: 1,
      target: "cleanup#abc"
    });
    setCommandState(operation, older.command.commandId, "finished", "cleaned");
    const newer = acceptCommand(operation, {
      kind: "retry_cleanup",
      attempt: 2,
      target: "cleanup#abc"
    });
    setCommandState(operation, newer.command.commandId, "running");

    expect(activeCleanupCommand(operation)).toEqual({
      commandId: newer.command.commandId,
      kind: "cleanup_retry"
    });
  });

  it("resumes nothing for a record with no commands at all", () => {
    expect(activeCleanupCommand(recovered())).toBeNull();
    expect(activeCleanupCommand(null)).toBeNull();
  });

  it("resumes nothing once the record is terminal", () => {
    const operation = recovered();
    const accepted = acceptCommand(operation, {
      kind: "retry_cleanup",
      attempt: 1,
      target: "cleanup#abc"
    });
    setCommandState(operation, accepted.command.commandId, "running");
    finish(operation, "failed_partial", { failure: { code: "x" } });

    // A terminal record owns no work, so a command persisted as running by a
    // process that went away must not be picked up as if it were live.
    expect(activeCleanupCommand(operation)).toBeNull();
  });
});

describe("planning the deletion a recovered operation runs", () => {
  it("resumes an interrupted cleanup retry under its runner key", async () => {
    const operation = recovered();
    const accepted = acceptCommand(operation, {
      kind: "retry_cleanup",
      attempt: 1,
      target: "cleanup#abc"
    });
    setCommandState(operation, accepted.command.commandId, "running");
    const store = persistCounter();

    const plan = await planRecoveredCleanup({
      operation,
      persist: store.persist
    });

    expect(plan).toEqual({
      state: "resume",
      commandId: accepted.command.commandId,
      kind: "cleanup_retry"
    });
    // A resume changes nothing about the record, so it writes nothing.
    expect(store.saves).toEqual([]);
    expect(operation.control.commands).toHaveLength(1);
  });

  it("opens a fresh rollback rather than reusing a finished retry", async () => {
    const operation = recovered();
    const stale = acceptCommand(operation, {
      kind: "retry_cleanup",
      attempt: 1,
      target: "cleanup#abc"
    });
    setCommandState(operation, stale.command.commandId, "finished", "cleaned");
    const store = persistCounter();

    const plan = await planRecoveredCleanup({
      operation,
      persist: store.persist
    });

    expect(plan.state).toBe("start");
    if (plan.state !== "start") throw new Error("expected a fresh rollback");
    expect(plan.kind).toBe("rollback");
    expect(plan.commandId).not.toBe(stale.command.commandId);
    expect(CLEANUP_COMMANDS[plan.kind]).toBeDefined();
    // Durable before the runner touches it: a command a pass executes but no
    // reload can find is how the same deletion gets scheduled twice.
    expect(store.saves).toEqual([1]);
    const created = operation.control.commands.at(-1);
    expect(created).toMatchObject({
      kind: "rollback",
      commandId: plan.commandId,
      state: "running"
    });
    expect(stale.command.state).toBe("finished");
  });

  it("keys the fresh rollback on the exact artifact set it will remove", async () => {
    const operation = recovered();
    const store = persistCounter();

    const plan = await planRecoveredCleanup({
      operation,
      persist: store.persist
    });

    if (plan.state !== "start") throw new Error("expected a fresh rollback");
    const digest = rollbackArtifactIdentity(
      provenOwnedCleanupTargets(operation)
    );
    expect(digest).toMatch(/^cleanup#[0-9a-f]{16}$/);
    expect(plan.commandId).toBe(
      buildCommandId({
        operationId: "op_cleanup",
        kind: "rollback",
        attempt: plan.attempt,
        target: digest
      })
    );
  });

  it("resolves a repeated decision to the command it already opened", async () => {
    const operation = recovered();
    const store = persistCounter();

    const first = await planRecoveredCleanup({
      operation,
      persist: store.persist
    });
    const second = await planRecoveredCleanup({
      operation,
      persist: store.persist
    });

    if (first.state !== "start") throw new Error("expected a fresh rollback");
    // The second pass finds the first still running rather than deleting
    // through the ledger a second time.
    expect(second).toEqual({
      state: "resume",
      commandId: first.commandId,
      kind: "rollback"
    });
    expect(operation.control.commands).toHaveLength(1);
    expect(store.saves).toEqual([1]);
  });

  it("refuses to open a rollback while a provider answer is outstanding", async () => {
    const operation = recovered();
    const mutation = prepareProviderMutation(operation, {
      kind: "azure_application.create",
      target: "octo/app:prod:radius-deploy"
    });
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "outcome_unknown",
      "The create response was lost."
    );
    const store = persistCounter();

    const plan = await planRecoveredCleanup({
      operation,
      persist: store.persist
    });

    expect(plan).toEqual({
      state: "blocked",
      detail: expect.stringContaining(
        "has not confirmed the outcome of azure_application.create"
      )
    });
    expect(operation.control.commands).toEqual([]);
    expect(store.saves).toEqual([]);
  });

  it("refuses to open a rollback a reconciliation could only hand over", async () => {
    const operation = recovered();
    const mutation = prepareProviderMutation(operation, {
      kind: "github_environment.put",
      target: "octo/app:prod"
    });
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "manual_required",
      "GitHub did not prove who created that environment."
    );

    const plan = await planRecoveredCleanup({
      operation,
      persist: async () => {}
    });

    expect(plan).toMatchObject({ state: "blocked" });
  });

  it("refuses to open a rollback it could not prove the workflow files by", async () => {
    const operation = recovered();
    recordCommitState(operation, { mode: "default_branch", branch: "main" });
    recordCommittedWorkflowFile(operation, {
      path: ".github/workflows/radius-verify-credentials.yml",
      mode: "default_branch",
      branch: "main",
      commitSha: "c".repeat(40),
      blobSha: "blob-1",
      contentSha256: "d".repeat(64),
      previousBlobSha: null,
      // The gap: Radius cannot say whether the file existed before setup, so a
      // revert would either delete somebody's file or restore the wrong bytes.
      previousBlobKnown: false
    });

    const plan = await planRecoveredCleanup({
      operation,
      persist: async () => {
        throw new Error("a refused plan must persist nothing");
      }
    });

    expect(plan).toMatchObject({
      state: "blocked",
      detail: expect.stringContaining("existed before setup")
    });
    expect(operation.control.commands).toEqual([]);
  });

  it("opens nothing when the ledger proves nothing was created", async () => {
    const operation = createOperation({
      operationId: "op_empty",
      provider: "azure",
      repo: "octo/app",
      environment: "prod"
    });
    operation.providerRecovery.state = "rollback_pending";
    const store = persistCounter();

    const plan = await planRecoveredCleanup({
      operation,
      persist: store.persist
    });

    expect(plan).toEqual({ state: "nothing_owned" });
    expect(operation.control.commands).toEqual([]);
    expect(store.saves).toEqual([]);
  });

  it("leaves nothing half-written when the durable save fails", async () => {
    const operation = recovered();

    await expect(
      planRecoveredCleanup({
        operation,
        persist: async () => {
          throw new Error("disk full");
        }
      })
    ).rejects.toThrow("disk full");

    // The command exists in memory but was never handed to a runner, so the
    // next decision resolves to it rather than opening a second one.
    const plan = await planRecoveredCleanup({
      operation,
      persist: async () => {}
    });
    expect(plan.state).toBe("resume");
    expect(operation.control.commands).toHaveLength(1);
  });

  it("reopens the attempt so a stop from the interrupted pass cannot halt it", async () => {
    const operation = recovered();
    requestStop(operation);

    const plan = await planRecoveredCleanup({
      operation,
      persist: async () => {}
    });

    if (plan.state !== "start") throw new Error("expected a fresh rollback");
    // Recovery already decided this attempt must be undone; a half-run deletion
    // is worse than the stop the customer asked for before the crash.
    expect(operation.stopRequested).toBe(false);
    expect(plan.attempt).toBeGreaterThan(0);
  });

  it("counts the fresh rollback as its own cleanup attempt", async () => {
    const operation = recovered();
    beginRetryAttempt(operation, "cleanup");

    const plan = await planRecoveredCleanup({
      operation,
      persist: async () => {}
    });

    if (plan.state !== "start") throw new Error("expected a fresh rollback");
    expect(plan.attempt).toBe(2);
    expect(operation.control.attempts.cleanup).toBe(2);
  });
});

describe("a cleanup delete that never got an answer", () => {
  function withUnsettledDeletion(status: "outcome_unknown" | "prepared") {
    const operation = recovered();
    const accepted = acceptCommand(operation, {
      kind: "retry_cleanup",
      attempt: 1,
      target: "cleanup#abc"
    });
    setCommandState(operation, accepted.command.commandId, "running");
    const mutation = prepareProviderMutation(operation, {
      kind: "azure_app.cleanup_delete",
      target: "app-1"
    });
    if (status === "outcome_unknown") {
      settleProviderMutation(
        operation,
        mutation.mutationId,
        "outcome_unknown",
        "The delete response was lost."
      );
    }
    return { operation, commandId: accepted.command.commandId };
  }

  it.each([["outcome_unknown"], ["prepared"]] as const)(
    "refuses to resume the pass that issued it while it is %s",
    async (status) => {
      const { operation } = withUnsettledDeletion(status);

      const plan = await planRecoveredCleanup({
        operation,
        persist: async () => {
          throw new Error("a blocked plan must persist nothing");
        }
      });

      // Resuming would walk the same selection again and reissue a delete whose
      // outcome nobody established — the one replay this journal exists to stop.
      expect(plan).toMatchObject({
        state: "blocked",
        detail: expect.stringContaining(
          "azure_app deletion it issued for app-1"
        )
      });
    }
  );

  it("resumes the pass once the deletion is settled", async () => {
    const { operation, commandId } = withUnsettledDeletion("outcome_unknown");
    settleProviderMutation(
      operation,
      operation.providerRecovery.mutations[0].mutationId,
      "confirmed",
      "The exact identity is absent."
    );

    await expect(
      planRecoveredCleanup({ operation, persist: async () => {} })
    ).resolves.toEqual({
      state: "resume",
      commandId,
      kind: "cleanup_retry"
    });
  });

  it("does not open a fresh rollback around an unsettled deletion either", async () => {
    const operation = recovered();
    const mutation = prepareProviderMutation(operation, {
      kind: "github_environment.cleanup_delete",
      target: "octo/app:prod"
    });
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "outcome_unknown",
      "The delete response was lost."
    );

    const plan = await planRecoveredCleanup({
      operation,
      persist: async () => {
        throw new Error("a blocked plan must persist nothing");
      }
    });

    expect(plan.state).toBe("blocked");
    expect(operation.control.commands).toEqual([]);
  });

  it("ignores a settled deletion and a forward mutation of another kind", async () => {
    const { operation, commandId } = withUnsettledDeletion("outcome_unknown");
    settleProviderMutation(
      operation,
      operation.providerRecovery.mutations[0].mutationId,
      "not_applied",
      "GitHub refused the delete."
    );

    await expect(
      planRecoveredCleanup({ operation, persist: async () => {} })
    ).resolves.toMatchObject({ state: "resume", commandId });
  });
});

describe("what a restored operation is handed to next", () => {
  const GENERIC_STATES = [
    "idle",
    "reconciling",
    "rollback_pending",
    "manual_required",
    "complete"
  ] as const;

  function restored(state: (typeof GENERIC_STATES)[number]) {
    const operation = recovered();
    operation.providerRecovery.state = state;
    return operation;
  }

  function unsettledDelete(
    operation: ReturnType<typeof recovered>,
    kind = "azure_app.cleanup_delete"
  ) {
    const mutation = prepareProviderMutation(operation, {
      kind,
      target: "app-1"
    });
    settleProviderMutation(
      operation,
      mutation.mutationId,
      "outcome_unknown",
      "The delete response was lost."
    );
    return operation;
  }

  it.each(GENERIC_STATES)(
    "routes an unsettled cleanup delete to cleanup from the %s state",
    (state) => {
      const operation = unsettledDelete(restored(state));

      // Whatever the setup's own mutations left behind, a deletion Radius
      // issued belongs to the rollback. Forward setup would rebuild resources
      // the customer asked it to remove.
      expect(planRecoveredSchedule(operation)).toEqual({ kind: "cleanup" });
    }
  );

  it.each(GENERIC_STATES)(
    "routes an in-flight cleanup command to cleanup from the %s state",
    (state) => {
      const operation = restored(state);
      const accepted = acceptCommand(operation, {
        kind: "retry_cleanup",
        attempt: 1,
        target: "cleanup#abc"
      });
      setCommandState(operation, accepted.command.commandId, "running");

      expect(planRecoveredSchedule(operation)).toEqual({ kind: "cleanup" });
    }
  );

  it.each([
    ["a rollback", "rollback"],
    ["a cleanup retry", "retry_cleanup"],
    ["an exit", "exit_setup"]
  ] as const)("routes an in-flight %s to cleanup", (_label, kind) => {
    const operation = restored("reconciling");
    const accepted = acceptCommand(operation, {
      kind,
      attempt: 1,
      target: "cleanup#abc"
    });
    setCommandState(operation, accepted.command.commandId, "accepted");

    expect(planRecoveredSchedule(operation)).toEqual({ kind: "cleanup" });
  });

  it("routes every cleanup deletion kind to cleanup", () => {
    for (const artifactType of [
      "azure_app",
      "service_principal",
      "federated_credential",
      "role_assignment",
      "github_environment"
    ]) {
      const operation = unsettledDelete(
        restored("reconciling"),
        `${artifactType}.cleanup_delete`
      );
      expect(planRecoveredSchedule(operation)).toEqual({ kind: "cleanup" });
    }
  });

  it("settles the setup branch before anything else, cleanup included", () => {
    const operation = unsettledDelete(restored("rollback_pending"));
    const branch = prepareProviderMutation(operation, {
      kind: "github_branch.delete",
      target: "octo/app\u0000radius/setup-prod\u0000base"
    });
    settleProviderMutation(
      operation,
      branch.mutationId,
      "outcome_unknown",
      "The delete response was lost."
    );

    expect(planRecoveredSchedule(operation)).toEqual({ kind: "branch_delete" });
  });

  it("sends a finished cleanup command with nothing outstanding forward", () => {
    const operation = restored("reconciling");
    const accepted = acceptCommand(operation, {
      kind: "retry_cleanup",
      attempt: 1,
      target: "cleanup#abc"
    });
    setCommandState(operation, accepted.command.commandId, "finished", "done");

    expect(planRecoveredSchedule(operation)).toEqual({ kind: "forward_setup" });
  });

  it("resumes a verification retry when only its dispatch is outstanding", () => {
    const operation = restored("reconciling");
    const accepted = acceptCommand(operation, {
      kind: "retry_verification",
      attempt: 1,
      target: "verification"
    });
    setCommandState(operation, accepted.command.commandId, "running");
    prepareProviderMutation(operation, {
      kind: "github_workflow.dispatch_retry",
      target: "octo/app:verify.yml:main:prod:cmd"
    });

    expect(planRecoveredSchedule(operation)).toEqual({
      kind: "verification_retry",
      commandId: accepted.command.commandId
    });
  });

  it("goes forward when a dispatch retry has no command left to resume", () => {
    const operation = restored("reconciling");
    prepareProviderMutation(operation, {
      kind: "github_workflow.dispatch_retry",
      target: "octo/app:verify.yml:main:prod:cmd"
    });

    // Nothing recorded the retry that dispatch belongs to, so there is no
    // command identity to resume it under.
    expect(planRecoveredSchedule(operation)).toEqual({ kind: "forward_setup" });
  });

  it("takes no command list at all as nothing to resume", () => {
    const operation = restored("reconciling");
    prepareProviderMutation(operation, {
      kind: "github_workflow.dispatch_retry",
      target: "octo/app:verify.yml:main:prod:cmd"
    });
    delete (operation as { control?: unknown }).control;

    expect(planRecoveredSchedule(operation)).toEqual({ kind: "forward_setup" });
  });

  it("goes forward only when nothing destructive is outstanding", () => {
    const operation = restored("reconciling");
    prepareProviderMutation(operation, {
      kind: "azure_application.create",
      target: "octo/app:prod:radius-deploy"
    });

    expect(planRecoveredSchedule(operation)).toEqual({ kind: "forward_setup" });
  });

  it("never reports forward setup while any deletion is outstanding", () => {
    // The livelock this ordering exists to prevent: a cleanup record handed to
    // the forward setup neither settles its deletions nor releases the lock,
    // and comes back to the same decision after every restart.
    for (const state of GENERIC_STATES) {
      const operation = unsettledDelete(restored(state));
      for (let restart = 0; restart < 3; restart++) {
        expect(planRecoveredSchedule(operation).kind).not.toBe("forward_setup");
      }
    }
  });
});

describe("a cleanup command that outlived the process", () => {
  const ACTIVE_KINDS: OperationCommandKind[] = [
    "rollback",
    "retry_cleanup",
    "exit_setup"
  ];

  function interrupted(
    kind: OperationCommandKind,
    state: "accepted" | "running" | "finished"
  ) {
    const operation = recovered(`op_${kind}`);
    requestStop(operation);
    beginRetryAttempt(operation, "cleanup");
    const accepted = acceptCommand(operation, {
      kind,
      attempt: 1
    });
    setCommandState(operation, accepted.command.commandId, state);
    return { operation, commandId: accepted.command.commandId };
  }

  it.each(ACTIVE_KINDS)(
    "hands a restarted %s back to cleanup with the same command",
    async (kind) => {
      for (const state of ["accepted", "running"] as const) {
        const { operation, commandId } = interrupted(kind, state);

        const restored = reconcileRestoredOperation(
          fromPersistedOperation(toPersistedOperation(operation))
        );

        // No unresolved mutation is outstanding here — the command itself is
        // the only evidence that work was in flight, so it has to survive the
        // restart for the scheduler to see it.
        // The persisted command keeps its own identity and state; the
        // scheduler sees it under the runner key that can execute it.
        expect(findActiveCommand(restored)).toMatchObject({
          kind,
          commandId,
          state
        });
        expect(activeCleanupCommand(restored)).toEqual({
          commandId,
          kind: cleanupRunnerKind(kind)
        });
        expect(planRecoveredSchedule(restored)).toEqual({ kind: "cleanup" });
        await expect(
          planRecoveredCleanup({
            operation: restored,
            persist: async () => {}
          })
        ).resolves.toEqual({
          state: "resume",
          commandId,
          kind: cleanupRunnerKind(kind)
        });
      }
    }
  );

  it.each(ACTIVE_KINDS)(
    "never routes a restarted %s into the forward setup",
    (kind) => {
      for (const state of ["accepted", "running"] as const) {
        let record = interrupted(kind, state).operation;
        for (let restart = 0; restart < 3; restart++) {
          record = reconcileRestoredOperation(
            fromPersistedOperation(toPersistedOperation(record))
          );
          expect(planRecoveredSchedule(record).kind).toBe("cleanup");
        }
      }
    }
  );

  it("leaves a finished cleanup command as history rather than resuming it", () => {
    const { operation, commandId } = interrupted("rollback", "finished");

    const restored = reconcileRestoredOperation(
      fromPersistedOperation(toPersistedOperation(operation))
    );

    expect(activeCleanupCommand(restored)).toBeNull();
    expect(
      restored.control.commands.map(
        (entry: { commandId: string }) => entry.commandId
      )
    ).toContain(commandId);
  });
});
