import { describe, it, expect, vi } from "vitest";
import {
  createOperation,
  buildDeleteStages,
  OPERATION_KIND_DELETE,
  STAGE_DELETE_RADIUS_ENV,
  STAGE_DELETE_CREDENTIAL,
  STAGE_DELETE_GITHUB_ENV,
  STAGE_REVIEW_APP_REGISTRATION
} from "../../operations.js";
import {
  runEnvironmentDeletion,
  DELETE_APP_REGISTRATION_DECISION,
  type EnvironmentDeletionPorts
} from "./environment-deletion.js";

function makeOp(
  overrides: {
    provider?: string;
    includeAzureCleanup?: boolean;
    request?: Record<string, unknown>;
  } = {}
) {
  const provider = overrides.provider ?? "azure";
  const includeAzureCleanup =
    overrides.includeAzureCleanup ?? provider === "azure";
  const op = createOperation({
    provider,
    repo: "octo/app",
    environment: "dev",
    kind: OPERATION_KIND_DELETE,
    stages: buildDeleteStages({ includeAzureCleanup })
  });
  op.request = {
    repo: "octo/app",
    environment: "dev",
    provider,
    clientId: "app-1",
    appDisplayName: "radius-deploy-octo-app",
    ...overrides.request
  };
  return op;
}

function ok(stdout = ""): { code: number; stdout: string; stderr: string } {
  return { code: 0, stdout, stderr: "" };
}
function fail(stderr: string): {
  code: number;
  stdout: string;
  stderr: string;
} {
  return { code: 1, stdout: "", stderr };
}

function makePorts(
  over: Partial<EnvironmentDeletionPorts> = {}
): EnvironmentDeletionPorts {
  return {
    deleteRadiusEnvironment: vi.fn(async () => ({
      outcome: "deleted" as const
    })),
    runAz: vi.fn(async () => ok("[]")),
    deleteGitHubEnvironment: vi.fn(async () => ({
      outcome: "deleted" as const
    })),
    persist: vi.fn(async () => {}),
    errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
    log: vi.fn(),
    ...over
  };
}

function stage(
  op: { stages: Array<{ id: string; state: string }> },
  id: string
) {
  return op.stages.find((s) => s.id === id)?.state;
}

describe("runEnvironmentDeletion — azure happy path", () => {
  it("deletes env, credential, github env, and prompts for the now-unused app", async () => {
    const op = makeOp();
    // list returns the env's credential first, then empty on the review list.
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([
            { id: "c1", name: "github-octo-app-dev-mutable", subject: "" }
          ])
        )
      ) // stage 2 list
      .mockResolvedValueOnce(ok("")) // stage 2 delete cred
      .mockResolvedValueOnce(ok("[]")) // stage 4 review list (empty → unused)
      .mockResolvedValueOnce(ok(JSON.stringify(["radius-managed"]))); // stage 4 tag show (radius-managed)
    const ports = makePorts({ runAz });

    await runEnvironmentDeletion(op, ports);

    expect(stage(op, STAGE_DELETE_RADIUS_ENV)).toBe("succeeded");
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("succeeded");
    expect(stage(op, STAGE_DELETE_GITHUB_ENV)).toBe("succeeded");
    // The unused app registration is never auto-deleted — even one Radius
    // created — so the operation parks in `input_required` awaiting a decision.
    expect(op.state).toBe("input_required");
    expect(op.endedAt).toBeNull();
    expect(op.inputRequired.code).toBe(DELETE_APP_REGISTRATION_DECISION);
    expect(op.inputRequired.message).toMatch(/Radius created it/);
    expect(runAz).toHaveBeenCalledTimes(4); // no `az ad app delete`
    expect(
      op.steps.some((s: { label: string }) =>
        /Deleted the unused app registration/.test(s.label)
      )
    ).toBe(false);
  });
});

describe("runEnvironmentDeletion — environment still has deployed applications", () => {
  it("aborts fail-closed before any cleanup and asks the user to delete the app first", async () => {
    const op = makeOp();
    const deleteRadiusEnvironment = vi.fn(async () => ({
      outcome: "apps_present" as const,
      detail:
        "The environment still has one or more deployed applications. Delete the application(s) first, then delete the environment."
    }));
    const runAz = vi.fn(async () => ok("[]"));
    const deleteGitHubEnvironment = vi.fn(async () => ({
      outcome: "deleted" as const
    }));
    const ports = makePorts({
      deleteRadiusEnvironment,
      runAz,
      deleteGitHubEnvironment
    });

    await runEnvironmentDeletion(op, ports);

    // Terminal action-required state carrying the app-first guidance.
    expect(op.state).toBe("action_required");
    expect(op.terminal).toMatchObject({
      code: "environment-has-applications"
    });
    expect(op.terminal.userMessage).toMatch(
      /Delete the application\(s\) first/
    );
    // The env stage failed; no later stage ran (finish marks them skipped).
    expect(stage(op, STAGE_DELETE_RADIUS_ENV)).toBe("failed");
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("skipped");
    expect(stage(op, STAGE_DELETE_GITHUB_ENV)).toBe("skipped");
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("skipped");
    // No cleanup I/O was performed (fail-closed).
    expect(runAz).not.toHaveBeenCalled();
    expect(deleteGitHubEnvironment).not.toHaveBeenCalled();
  });

  it("falls back to a default message when the outcome omits a detail", async () => {
    const op = makeOp();
    const deleteRadiusEnvironment = vi.fn(async () => ({
      outcome: "apps_present" as const
    }));
    const ports = makePorts({ deleteRadiusEnvironment });

    await runEnvironmentDeletion(op, ports);

    expect(op.state).toBe("action_required");
    expect(op.terminal.userMessage).toMatch(
      /still has one or more deployed applications/
    );
  });
});

describe("runEnvironmentDeletion — app registration still in use", () => {
  it("does not delete when credentials remain", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list (nothing to delete)
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ id: "x", name: "other-env", subject: "" }]))
      ); // stage 4 review list (non-empty)
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(op.state).toBe("succeeded");
    // No app delete is attempted while a credential remains.
    expect(runAz).toHaveBeenCalledTimes(2);
    expect(
      op.steps.some((s: { label: string }) =>
        /still has 1 credential/.test(s.label)
      )
    ).toBe(true);
  });
});

describe("runEnvironmentDeletion — aws provider", () => {
  it("runs only radius env + github env stages, never az", async () => {
    const op = makeOp({ provider: "aws", includeAzureCleanup: false });
    const ports = makePorts();
    await runEnvironmentDeletion(op, ports);
    expect(ports.runAz).not.toHaveBeenCalled();
    expect(op.stages.map((s: { id: string }) => s.id)).toEqual([
      STAGE_DELETE_RADIUS_ENV,
      STAGE_DELETE_GITHUB_ENV
    ]);
    expect(op.state).toBe("succeeded");
  });
});

describe("runEnvironmentDeletion — best-effort warnings", () => {
  it("fails closed and stops before cleanup when the radius env delete fails", async () => {
    const op = makeOp({ provider: "aws", includeAzureCleanup: false });
    const ports = makePorts({
      deleteRadiusEnvironment: vi.fn(async () => ({
        outcome: "failed" as const,
        detail: "workflow failed"
      }))
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_RADIUS_ENV)).toBe("failed");
    expect(op.state).toBe("failed_partial");
    expect(op.failure?.code).toBe("radius-env-delete-failed");
    expect(op.failure?.message).toBe("workflow failed");
    // Nothing downstream ran: the GitHub environment (and any credential) that a
    // retry needs must not be torn down after an unconfirmed radius delete.
    expect(ports.deleteGitHubEnvironment).not.toHaveBeenCalled();
    expect(stage(op, STAGE_DELETE_GITHUB_ENV)).toBe("skipped");
  });

  it("records not_found as a clean success", async () => {
    const op = makeOp({ provider: "aws", includeAzureCleanup: false });
    const ports = makePorts({
      deleteRadiusEnvironment: vi.fn(async () => ({
        outcome: "not_found" as const
      })),
      deleteGitHubEnvironment: vi.fn(async () => ({
        outcome: "not_found" as const
      }))
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_RADIUS_ENV)).toBe("succeeded");
    expect(op.state).toBe("succeeded");
  });

  it("fails closed and stops before cleanup when the radius delete throws", async () => {
    const op = makeOp({ provider: "aws", includeAzureCleanup: false });
    const ports = makePorts({
      deleteRadiusEnvironment: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_RADIUS_ENV)).toBe("failed");
    expect(op.state).toBe("failed_partial");
    expect(op.failure?.message).toBe("boom");
    expect(ports.deleteGitHubEnvironment).not.toHaveBeenCalled();
  });

  it("warns when the github env delete fails", async () => {
    const op = makeOp({ provider: "aws", includeAzureCleanup: false });
    const ports = makePorts({
      deleteGitHubEnvironment: vi.fn(async () => ({
        outcome: "failed" as const
      }))
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_GITHUB_ENV)).toBe("warning");
    const warn = op.steps.find(
      (s: { warning?: { code?: string; message?: string } }) =>
        s.warning?.code === "github-env-delete-failed"
    );
    expect(warn?.warning?.message).toBe(
      "The GitHub environment delete failed."
    );
    expect(op.state).toBe("succeeded_with_warnings");
  });

  it("treats a thrown github env delete as a warning", async () => {
    const op = makeOp({ provider: "aws", includeAzureCleanup: false });
    const ports = makePorts({
      deleteGitHubEnvironment: vi.fn(async () => {
        throw new Error("network");
      })
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_GITHUB_ENV)).toBe("warning");
  });
});

describe("runEnvironmentDeletion — credential stage edge cases", () => {
  it("skips credential deletion with a warning when clientId is missing", async () => {
    const op = makeOp({ request: { clientId: "" } });
    const runAz = vi.fn().mockResolvedValue(ok("[]")); // only the review list
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("warning");
  });

  it("warns when listing federated credentials fails", async () => {
    const op = makeOp();
    const runAz = vi.fn().mockResolvedValueOnce(fail("")); // empty stderr → fallback
    // Stage 4 review list returns a remaining credential so no app delete runs.
    runAz.mockResolvedValueOnce(
      ok(JSON.stringify([{ name: "keep", subject: "" }]))
    );
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("warning");
    const warn = op.steps.find(
      (s: { warning?: { code?: string; message?: string } }) =>
        s.warning?.code === "federated-credential-list-failed"
    );
    expect(warn?.warning?.message).toBe(
      "Listing federated credentials failed."
    );
  });

  it("warns when the credential list output is unreadable", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      // Command succeeds but returns output that is not a credential array, so
      // stage 2 must warn rather than falsely report nothing to remove.
      .mockResolvedValueOnce(ok("not json"))
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "keep", subject: "" }]))
      ); // stage 4 review non-empty
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("warning");
    const warn = op.steps.find(
      (s: { warning?: { code?: string } }) =>
        s.warning?.code === "federated-credential-list-unreadable"
    );
    expect(warn?.warning?.message).toBe(
      "Listing federated credentials returned output that could not be parsed."
    );
  });

  it("records no-credential as clean success", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // list empty
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "keep", subject: "" }]))
      ); // review non-empty
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("succeeded");
  });

  it("treats an az not-found credential delete as success", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([{ name: "github-octo-app-dev-mutable", subject: "" }])
        )
      )
      .mockResolvedValueOnce(fail("Request_ResourceNotFound")) // delete → not found
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "other-env", subject: "" }]))
      ); // review non-empty → left in place
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("succeeded");
  });

  it("warns when a credential delete genuinely fails", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([{ name: "github-octo-app-dev-mutable", subject: "" }])
        )
      )
      .mockResolvedValueOnce(fail("Forbidden")) // delete fails
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "other-env", subject: "" }]))
      ); // review non-empty → left in place
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("warning");
  });
});

describe("runEnvironmentDeletion — review edge cases", () => {
  it("warns when the review list is unreadable", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list empty
      .mockResolvedValueOnce(fail("network")); // stage 4 review list fails
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("warning");
    expect(op.state).toBe("succeeded_with_warnings");
  });

  it("warns when the review list output is unreadable", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list empty
      // Stage 4 review list succeeds but returns unparseable output, so the app
      // registration is left in place with a warning rather than prompted for
      // deletion on data it could not read.
      .mockResolvedValueOnce(ok("not json"));
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("warning");
    const warn = op.steps.find(
      (s: { warning?: { code?: string } }) =>
        s.warning?.code === "app-registration-review-unavailable"
    );
    expect(warn).toBeDefined();
    expect(op.state).toBe("succeeded_with_warnings");
  });

  it("warns when the app delete fails", async () => {
    const op = makeOp({ request: { deleteAppRegistration: true } });
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list empty (nothing to delete)
      .mockResolvedValueOnce(ok("[]")) // stage 4 re-list before delete: still empty
      .mockResolvedValueOnce(fail("")); // stage 4 app delete fails (empty stderr → fallback)
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("warning");
    const warn = op.steps.find(
      (s: { warning?: { code?: string; message?: string } }) =>
        s.warning?.code === "app-registration-delete-failed"
    );
    expect(warn?.warning?.message).toBe(
      "Deleting the app registration failed."
    );
  });
});

describe("runEnvironmentDeletion — fallbacks and optional ports", () => {
  it("uses fallback messages and works without a log port", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([{ name: "github-octo-app-dev-mutable", subject: "" }])
        )
      )
      .mockResolvedValueOnce(fail("")) // credential delete fails with empty stderr
      .mockResolvedValueOnce(fail("")); // review list fails with empty stderr
    // Ports without a `log` exercise the default no-op logger.
    const ports: EnvironmentDeletionPorts = {
      deleteRadiusEnvironment: vi.fn(async () => ({
        outcome: "deleted" as const
      })),
      runAz,
      deleteGitHubEnvironment: vi.fn(async () => ({
        outcome: "deleted" as const
      })),
      persist: vi.fn(async () => {}),
      errorMessage: (e) => String(e)
    };
    await runEnvironmentDeletion(op, ports);
    const credWarn = op.steps.find(
      (s: { warning?: { code?: string; message?: string } }) =>
        s.warning?.code === "federated-credential-delete-failed"
    );
    expect(credWarn?.warning?.message).toBe(
      "Deleting the federated credential failed."
    );
    expect(op.state).toBe("succeeded_with_warnings");
  });
});

describe("runEnvironmentDeletion — app-registration provenance", () => {
  it("prompts (never auto-deletes) when the unused app was not created by Radius", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list empty
      .mockResolvedValueOnce(ok("[]")) // stage 4 review list empty → unused
      .mockResolvedValueOnce(ok(JSON.stringify(["some-user-tag"]))); // tag show: no radius-managed → user
    const ports = makePorts({ runAz });

    await runEnvironmentDeletion(op, ports);

    expect(op.state).toBe("input_required");
    expect(op.endedAt).toBeNull();
    expect(op.inputRequired.code).toBe(DELETE_APP_REGISTRATION_DECISION);
    expect(op.inputRequired.metadata.clientId).toBe("app-1");
    expect(op.inputRequired.metadata.appDisplayName).toBe(
      "radius-deploy-octo-app"
    );
    expect(op.inputRequired.message).toMatch(/did not create it/);
    // The provenance probe ran, but no `az ad app delete` was attempted.
    expect(runAz).toHaveBeenCalledTimes(3);
    expect(
      op.steps.some((s: { label: string }) =>
        /Deleted the unused app registration/.test(s.label)
      )
    ).toBe(false);
  });

  it("prompts when provenance cannot be read", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list empty
      .mockResolvedValueOnce(ok("[]")) // stage 4 review list empty → unused
      .mockResolvedValueOnce(fail("network")); // tag show fails (not a 404) → unknown
    const ports = makePorts({ runAz });

    await runEnvironmentDeletion(op, ports);

    expect(op.state).toBe("input_required");
    expect(op.inputRequired.code).toBe(DELETE_APP_REGISTRATION_DECISION);
    expect(op.inputRequired.message).toMatch(/could not confirm/);
  });

  it("prompts (labelled by client id) when the tag output is unparseable and no display name is known", async () => {
    const op = makeOp({ request: { appDisplayName: "" } });
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list empty
      .mockResolvedValueOnce(ok("[]")) // stage 4 review list empty → unused
      .mockResolvedValueOnce(ok("not-json")); // tag show returns unparseable stdout → unknown
    const ports = makePorts({ runAz });

    await runEnvironmentDeletion(op, ports);

    expect(op.state).toBe("input_required");
    expect(op.inputRequired.code).toBe(DELETE_APP_REGISTRATION_DECISION);
    expect(op.inputRequired.metadata.appDisplayName).toBe("");
    // Falls back to the client id in the prompt when no display name is known.
    expect(op.inputRequired.message).toContain("app-1");
    expect(op.inputRequired.message).toMatch(/could not confirm/);
  });

  it("records an already-deleted app registration as a clean success", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list empty
      .mockResolvedValueOnce(ok("[]")) // stage 4 review list empty → unused
      .mockResolvedValueOnce(fail("Request_ResourceNotFound")); // tag show 404 → gone
    const ports = makePorts({ runAz });

    await runEnvironmentDeletion(op, ports);

    expect(op.state).toBe("succeeded");
    expect(runAz).toHaveBeenCalledTimes(3); // no delete attempted
    expect(
      op.steps.some((s: { label: string }) =>
        /App registration was already deleted/.test(s.label)
      )
    ).toBe(true);
  });

  it("deletes on resume when the user confirms", async () => {
    const op = makeOp({ request: { deleteAppRegistration: true } });
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list empty
      .mockResolvedValueOnce(ok("[]")) // stage 4 re-list before delete: still empty
      .mockResolvedValueOnce(ok("")); // stage 4 app delete (no provenance probe)
    const ports = makePorts({ runAz });

    await runEnvironmentDeletion(op, ports);

    expect(op.state).toBe("succeeded");
    expect(runAz).toHaveBeenLastCalledWith([
      "ad",
      "app",
      "delete",
      "--id",
      "app-1"
    ]);
    expect(
      op.steps.some((s: { label: string }) =>
        /Deleted the unused app registration/.test(s.label)
      )
    ).toBe(true);
  });

  it("keeps the app registration on resume when the user declines", async () => {
    const op = makeOp({ request: { deleteAppRegistration: false } });
    const runAz = vi.fn().mockResolvedValueOnce(ok("[]")); // stage 2 list only
    const ports = makePorts({ runAz });

    await runEnvironmentDeletion(op, ports);

    expect(op.state).toBe("succeeded");
    expect(runAz).toHaveBeenCalledTimes(1); // no provenance probe, no delete
    expect(
      op.steps.some((s: { label: string }) =>
        /Kept the app registration at your request/.test(s.label)
      )
    ).toBe(true);
  });

  it("does not delete the app when a credential appeared while the prompt was open", async () => {
    const op = makeOp({ request: { deleteAppRegistration: true } });
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list empty
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "new-cred", subject: "" }]))
      ); // stage 4 re-list: a credential was added while awaiting the decision
    const ports = makePorts({ runAz });

    await runEnvironmentDeletion(op, ports);

    expect(op.state).toBe("succeeded_with_warnings");
    expect(runAz).toHaveBeenCalledTimes(2); // re-list only; NO app delete
    const warn = op.steps.find(
      (s: { warning?: { code?: string } }) =>
        s.warning?.code === "app-registration-became-shared"
    );
    expect(warn).toBeDefined();
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("warning");
  });

  it("does not delete the app when the re-check list is unreadable after confirmation", async () => {
    const op = makeOp({ request: { deleteAppRegistration: true } });
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(ok("[]")) // stage 2 list empty
      .mockResolvedValueOnce(fail("boom")); // stage 4 re-list fails → unreadable
    const ports = makePorts({ runAz });

    await runEnvironmentDeletion(op, ports);

    expect(op.state).toBe("succeeded_with_warnings");
    expect(runAz).toHaveBeenCalledTimes(2); // re-list only; NO app delete
    const warn = op.steps.find(
      (s: { warning?: { code?: string } }) =>
        s.warning?.code === "app-registration-recheck-unavailable"
    );
    expect(warn).toBeDefined();
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("warning");
  });
});

describe("runEnvironmentDeletion — fail-closed default message", () => {
  it("uses a generic retry message when the failed outcome has no detail", async () => {
    const op = makeOp({ provider: "aws", includeAzureCleanup: false });
    const ports = makePorts({
      deleteRadiusEnvironment: vi.fn(async () => ({
        outcome: "failed" as const
      }))
    });
    await runEnvironmentDeletion(op, ports);
    expect(op.state).toBe("failed_partial");
    expect(op.failure?.message).toMatch(/retry the deletion/i);
  });
});
