import { describe, expect, it } from "vitest";
import {
  CLEANUP_COMMANDS,
  cleanupRemovedGitHubEnvironment,
  cleanupRunnerKind,
  isCleanupCommandKind
} from "./cleanup-commands.js";
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

// The environment picker reads a repo-scoped cached listing that a different
// request assembles, so what a finished deletion pass removed decides whether
// that cache may stand. Getting this wrong in either direction is visible: keep
// it and a rolled-back environment stays on the page as Pending; drop it after
// a pass that removed nothing and the picker re-lists for no reason.
describe("cleanupRemovedGitHubEnvironment", () => {
  it.each([
    ["deleted", true],
    ["not_found", true],
    ["warning", false],
    ["skipped", false]
  ])("reports %s as %s", (outcome, expected) => {
    expect(
      cleanupRemovedGitHubEnvironment([
        { artifactType: "github_environment", outcome }
      ])
    ).toBe(expected);
  });

  it("ignores removals of everything that is not the environment", () => {
    expect(
      cleanupRemovedGitHubEnvironment([
        { artifactType: "azure_app", outcome: "deleted" },
        { artifactType: "workflow_file", outcome: "deleted" }
      ])
    ).toBe(false);
  });

  it("reports an empty pass as changing nothing", () => {
    expect(cleanupRemovedGitHubEnvironment([])).toBe(false);
  });

  it("reports a removal recorded alongside other outcomes", () => {
    expect(
      cleanupRemovedGitHubEnvironment([
        { artifactType: "azure_app", outcome: "warning" },
        { artifactType: "github_environment", outcome: "deleted" }
      ])
    ).toBe(true);
  });

  it("matches the results a real rollback pass records", () => {
    const op = partialFailure();
    const selected = CLEANUP_COMMANDS.rollback
      .selectTargets(op)
      .map((entry) => entry.artifactType);
    expect(selected).toContain("github_environment");
    expect(
      cleanupRemovedGitHubEnvironment(
        selected.map((artifactType) => ({
          artifactType,
          outcome: artifactType === "github_environment" ? "deleted" : "warning"
        }))
      )
    ).toBe(true);
  });
});

describe("translating a persisted command kind to its runner key", () => {
  it.each([
    ["rollback", "rollback"],
    ["retry_cleanup", "cleanup_retry"],
    ["exit_setup", "exit_setup"]
  ])("maps %s to %s", (commandKind, runnerKind) => {
    expect(cleanupRunnerKind(commandKind)).toBe(runnerKind);
  });

  it("resolves every deletion kind to a spec the executor can run", () => {
    for (const commandKind of ["rollback", "retry_cleanup", "exit_setup"]) {
      const runnerKind = cleanupRunnerKind(commandKind);
      expect(runnerKind).not.toBeNull();
      // The defect this mapping exists for: a persisted kind handed straight to
      // the executor selects no spec, and the pass dies on an undefined
      // selector before it deletes anything or says why.
      expect(CLEANUP_COMMANDS[runnerKind!]).toBeDefined();
      expect(isCleanupCommandKind(runnerKind!)).toBe(true);
    }
  });

  it("does not accept a persisted kind as a runner key in its own right", () => {
    // `retry_cleanup` is a saved command, never a spec. Treating the two names
    // as interchangeable is exactly what produced the undefined selector.
    expect(isCleanupCommandKind("retry_cleanup")).toBe(false);
    expect(CLEANUP_COMMANDS.retry_cleanup).toBeUndefined();
  });

  it.each([
    ["a forward command", "retry_setup"],
    ["a verification retry", "retry_verification"],
    ["a stop", "stop"],
    ["a runner key posing as a command kind", "cleanup_retry"],
    ["an empty string", ""]
  ])("returns nothing for %s", (_label, commandKind) => {
    expect(cleanupRunnerKind(commandKind)).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
    ["an object", { kind: "rollback" }]
  ])("returns nothing for %s", (_label, commandKind) => {
    expect(cleanupRunnerKind(commandKind)).toBeNull();
  });

  it("does not inherit a mapping from the prototype chain", () => {
    expect(cleanupRunnerKind("constructor")).toBeNull();
    expect(cleanupRunnerKind("toString")).toBeNull();
  });
});
