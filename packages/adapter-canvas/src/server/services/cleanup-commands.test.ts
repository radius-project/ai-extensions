import { describe, expect, it } from "vitest";
import { CLEANUP_COMMANDS, isCleanupCommandKind } from "./cleanup-commands.js";
import {
  acceptCommand,
  beginRetryAttempt,
  buildStages,
  createOperation,
  finish,
  isSetupExited,
  provenOwnedCleanupTargets,
  recordAzureApp,
  recordCleanupState,
  recordGitHubEnvironment,
  recordServicePrincipal,
  setCommandState,
  EXIT_COMMAND_KIND
} from "../../operations.js";

// The table is data, but the data is the safety property: which resources each
// command may delete, and which outcome closes the setup. Both are asserted
// against real records rather than by reading the literal back.

function partialFailure() {
  const op = createOperation({
    provider: "azure",
    repo: "contoso/store",
    environment: "dev",
    stages: buildStages({ includeIdentity: true })
  });
  recordAzureApp(op, {
    state: "created",
    appId: "app-1",
    displayName: "radius-deploy"
  });
  // Reused: this attempt did not create it, so no command may select it.
  recordServicePrincipal(op, {
    state: "reused",
    appId: "app-1",
    objectId: "sp-1"
  });
  recordGitHubEnvironment(op, {
    state: "created",
    repo: "contoso/store",
    name: "dev"
  });
  finish(op, "failed_partial", { failure: { code: "operation-stalled" } });
  return op;
}

describe("cleanup command table", () => {
  it("names exactly the three commands the deletion pass serves", () => {
    expect(Object.keys(CLEANUP_COMMANDS).sort()).toEqual([
      "cleanup_retry",
      "exit_setup",
      "rollback"
    ]);
    expect(isCleanupCommandKind("exit_setup")).toBe(true);
    expect(isCleanupCommandKind("retry_setup")).toBe(false);
  });

  it("selects the proven-owned set for a rollback and for an exit alike", () => {
    const op = partialFailure();
    const proven = provenOwnedCleanupTargets(op).map(
      (entry) => entry.artifactType
    );
    expect(proven).toEqual(["github_environment", "azure_app"]);

    for (const kind of ["rollback", "exit_setup"] as const) {
      expect(
        CLEANUP_COMMANDS[kind].selectTargets(op).map((entry) => entry.key)
      ).toEqual(provenOwnedCleanupTargets(op).map((entry) => entry.key));
    }
    // The reused Service Principal is in neither selection, which is the whole
    // point: exiting a setup never removes a resource the customer already had.
    expect(proven).not.toContain("service_principal");
  });

  it("selects only what the previous attempt could not remove for a retry", () => {
    const op = partialFailure();
    recordCleanupState(op, {
      state: "succeeded_with_warnings",
      attempts: 1,
      results: [
        {
          attempt: 1,
          artifactType: "azure_app",
          target: "radius-deploy (app-1)",
          identity: "app-1",
          outcome: "warning",
          detail: "Azure CLI returned 429."
        },
        {
          attempt: 1,
          artifactType: "github_environment",
          target: "contoso/store:dev",
          identity: "contoso/store:dev",
          outcome: "deleted",
          detail: null
        }
      ]
    });

    expect(
      CLEANUP_COMMANDS.cleanup_retry
        .selectTargets(op)
        .map((entry) => entry.artifactType)
    ).toEqual(["azure_app"]);
  });

  it("closes the setup only when an exit pass removed everything it selected", () => {
    const clean = partialFailure();
    beginRetryAttempt(clean, "cleanup");
    const accepted = acceptCommand(clean, {
      kind: EXIT_COMMAND_KIND,
      attempt: 1,
      target: "cleanup#abc"
    });
    setCommandState(
      clean,
      accepted.command.commandId,
      "finished",
      CLEANUP_COMMANDS.exit_setup.cleanedOutcome
    );
    expect(isSetupExited(clean)).toBe(true);

    const incomplete = partialFailure();
    beginRetryAttempt(incomplete, "cleanup");
    const warned = acceptCommand(incomplete, {
      kind: EXIT_COMMAND_KIND,
      attempt: 1,
      target: "cleanup#abc"
    });
    setCommandState(
      incomplete,
      warned.command.commandId,
      "finished",
      "warnings"
    );
    // Resources it created are still present, so the setup stays open and the
    // panel keeps reporting them.
    expect(isSetupExited(incomplete)).toBe(false);
  });

  it("gives each command its own terminal reason and customer sentence", () => {
    const reasons = Object.values(CLEANUP_COMMANDS).map(
      (command) => command.terminalReason
    );
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(CLEANUP_COMMANDS.exit_setup.terminalReason).toBe("setup-exited");
    expect(CLEANUP_COMMANDS.exit_setup.cleanedMessage).toBe(
      "Radius closed this setup and removed the resources it created during this attempt."
    );
    expect(CLEANUP_COMMANDS.exit_setup.incompleteMessage).toBe(
      "Radius removed what it could while closing this setup, but some resources it created are still present."
    );
    for (const command of Object.values(CLEANUP_COMMANDS)) {
      expect(command.cleanedMessage).not.toBe("");
      expect(command.incompleteMessage).not.toBe("");
    }
  });
});
