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
    tenantId: "tenant-1",
    repoId: 5,
    appDisplayName: "radius-deploy-octo-app",
    ...overrides.request
  };
  return op;
}

function ok(stdout = ""): { code: number; stdout: string; stderr: string } {
  let normalized = stdout;
  try {
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed)) {
      normalized = JSON.stringify(
        parsed.map((entry) =>
          entry && typeof entry === "object" && "name" in entry ?
            {
              id: entry.id || "c1",
              issuer:
                entry.issuer || "https://token.actions.githubusercontent.com",
              audiences: entry.audiences || ["api://AzureADTokenExchange"],
              ...entry
            }
          : entry
        )
      );
    }
  } catch {}
  return { code: 0, stdout: normalized, stderr: "" };
}
function fail(stderr: string): {
  code: number;
  stdout: string;
  stderr: string;
} {
  return { code: 1, stdout: "", stderr };
}

// Provenance proving Radius created the standard per-environment credential, so
// the reclamation plan authorizes deleting it.
function createdProvenance(name = "github-octo-app-dev-mutable", subject = "") {
  return [
    {
      schemaVersion: 2 as const,
      repo: "octo/app",
      repoId: 5,
      environment: "dev",
      tenantId: "tenant-1",
      clientId: "app-1",
      applicationObjectId: "app-object-1",
      credentialId: "c1",
      name,
      subject,
      issuer: "https://token.actions.githubusercontent.com",
      audiences: ["api://AzureADTokenExchange"],
      subjectConfig: { useDefault: true },
      origin: "created" as const,
      operationId: "op-1",
      recordedAt: new Date(0).toISOString()
    }
  ];
}

function makePorts(
  over: Partial<EnvironmentDeletionPorts> = {},
  revalidated: {
    id: string;
    name: string;
    subject: string;
    issuer: string;
    audiences: string[];
  } | null = {
    id: "c1",
    name: "github-octo-app-dev-mutable",
    subject: "",
    issuer: "https://token.actions.githubusercontent.com",
    audiences: ["api://AzureADTokenExchange"]
  }
): EnvironmentDeletionPorts {
  const suppliedRunAz = over.runAz;
  const runAz = vi.fn(async (args: string[]) => {
    if (args.includes("show") && args.includes("federated-credential")) {
      return revalidated ? ok(JSON.stringify(revalidated)) : fail("changed");
    }
    return suppliedRunAz ? suppliedRunAz(args) : ok("[]");
  });
  return {
    deleteRadiusEnvironment: vi.fn(async () => ({
      outcome: "deleted" as const
    })),
    withCredentialProvenanceLock: async (work) => work(),
    readAzureIdentity: vi.fn(async () => ({
      tenantId: "tenant-1",
      applicationObjectId: "app-object-1"
    })),
    deleteGitHubEnvironment: vi.fn(async () => ({
      outcome: "deleted" as const
    })),
    readCredentialProvenance: vi.fn(() => []),
    removeCredentialProvenance: vi.fn(async () => {}),
    clearEnvironmentCredentialProvenance: vi.fn(async () => {}),
    persist: vi.fn(async () => {}),
    errorMessage: (e) => (e instanceof Error ? e.message : String(e)),
    log: vi.fn(),
    ...over,
    runAz
  };
}

function stage(
  op: { stages: Array<{ id: string; state: string }> },
  id: string
) {
  return op.stages.find((s) => s.id === id)?.state;
}

describe("runEnvironmentDeletion — azure happy path", () => {
  it("holds the provenance lock through credential and GitHub deletion", async () => {
    const op = makeOp();
    let lockHeld = false;
    const ports = makePorts({
      withCredentialProvenanceLock: async (work) => {
        lockHeld = true;
        try {
          return await work();
        } finally {
          lockHeld = false;
        }
      },
      runAz: vi.fn().mockResolvedValue(ok("[]")),
      deleteGitHubEnvironment: vi.fn(async () => {
        expect(lockHeld).toBe(true);
        return { outcome: "deleted" as const };
      })
    });
    await runEnvironmentDeletion(op, ports);
    expect(lockHeld).toBe(false);
  });

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
    const ports = makePorts({
      runAz,
      readCredentialProvenance: () => createdProvenance()
    });

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
  it("stops before GitHub deletion when the provenance lock is unavailable", async () => {
    const op = makeOp();
    const ports = makePorts({
      withCredentialProvenanceLock: async () => {
        throw new Error("lock timeout");
      }
    });
    await runEnvironmentDeletion(op, ports);
    expect(op.state).toBe("failed_partial");
    expect(op.failure?.code).toBe("credential-provenance-lock-unavailable");
    expect(ports.deleteGitHubEnvironment).not.toHaveBeenCalled();
  });

  it("stops before GitHub deletion when credential identity is incomplete", async () => {
    const op = makeOp({ request: { clientId: "" } });
    const runAz = vi.fn().mockResolvedValue(ok("[]")); // only the review list
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("failed");
    expect(op.state).toBe("failed_partial");
    expect(ports.deleteGitHubEnvironment).not.toHaveBeenCalled();
  });

  it("warns when listing federated credentials fails", async () => {
    const op = makeOp();
    const runAz = vi.fn().mockResolvedValueOnce(fail("")); // empty stderr → fallback
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("failed");
    expect(ports.deleteGitHubEnvironment).not.toHaveBeenCalled();
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
      // stage 2 must stop rather than falsely report nothing to remove.
      .mockResolvedValueOnce(ok("not json"));
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("failed");
    expect(ports.deleteGitHubEnvironment).not.toHaveBeenCalled();
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
    expect(ports.clearEnvironmentCredentialProvenance).toHaveBeenCalledWith(
      5,
      "dev"
    );
  });

  it("keeps no-candidate provenance when GitHub deletion fails", async () => {
    const op = makeOp();
    const ports = makePorts({
      runAz: vi.fn().mockResolvedValue(ok("[]")),
      deleteGitHubEnvironment: vi.fn(async () => ({
        outcome: "failed" as const,
        detail: "network"
      }))
    });
    await runEnvironmentDeletion(op, ports);
    expect(ports.clearEnvironmentCredentialProvenance).not.toHaveBeenCalled();
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
    const ports = makePorts({
      runAz,
      readCredentialProvenance: () => createdProvenance()
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("succeeded");
  });

  it("stops before deleting the GitHub environment when credential deletion fails", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([{ name: "github-octo-app-dev-mutable", subject: "" }])
        )
      )
      .mockResolvedValueOnce(fail("Forbidden")); // delete fails
    const ports = makePorts({
      runAz,
      readCredentialProvenance: () => createdProvenance()
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("failed");
    expect(op.state).toBe("failed_partial");
    expect(op.failure?.code).toBe("federated-credential-delete-failed");
    expect(ports.deleteGitHubEnvironment).not.toHaveBeenCalled();
    expect(ports.removeCredentialProvenance).not.toHaveBeenCalled();
    expect(ports.clearEnvironmentCredentialProvenance).not.toHaveBeenCalled();
  });
});

describe("runEnvironmentDeletion — credential provenance gate (#331)", () => {
  it("retains a matched credential with no provenance and never calls delete", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([{ name: "github-octo-app-dev-mutable", subject: "" }])
        )
      ) // stage 2 list — one env-scoped candidate
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([{ name: "github-octo-app-dev-mutable", subject: "" }])
        )
      ); // stage 4 review list non-empty → app left in place
    // Default makePorts returns no provenance.
    const ports = makePorts({ runAz });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("warning");
    const retained = op.steps.find(
      (s: { warning?: { code?: string; message?: string } }) =>
        s.warning?.code === "federated-credential-retained-unverified"
    );
    expect(retained?.warning?.message).toMatch(/no Radius provenance/);
    // No `az ad app federated-credential delete` was ever attempted.
    const deleteCall = runAz.mock.calls.find((c) => c[0].includes("delete"));
    expect(deleteCall).toBeUndefined();
    expect(ports.removeCredentialProvenance).not.toHaveBeenCalled();
  });

  it("retains a reused credential", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([{ name: "github-octo-app-dev-mutable", subject: "" }])
        )
      )
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "keep", subject: "" }]))
      );
    const ports = makePorts({
      runAz,
      readCredentialProvenance: () => [
        { ...createdProvenance()[0], origin: "reused" as const }
      ]
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("warning");
    expect(
      op.steps.some(
        (s: { warning?: { code?: string } }) =>
          s.warning?.code === "federated-credential-retained-reused"
      )
    ).toBe(true);
  });

  it("retains a credential whose subject drifted from the recorded evidence", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([
            { name: "github-octo-app-dev-mutable", subject: "drifted" }
          ])
        )
      )
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "keep", subject: "" }]))
      );
    const ports = makePorts({
      runAz,
      // Recorded subject was "", live subject is now "drifted".
      readCredentialProvenance: () => createdProvenance()
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("warning");
    expect(
      op.steps.some(
        (s: { warning?: { code?: string } }) =>
          s.warning?.code === "federated-credential-retained-changed"
      )
    ).toBe(true);
  });

  it("revalidates immediately before delete and retains a replacement object", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([
            { id: "c1", name: "github-octo-app-dev-mutable", subject: "" }
          ])
        )
      )
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "keep", subject: "" }]))
      );
    const ports = makePorts(
      {
        runAz,
        readCredentialProvenance: () => createdProvenance()
      },
      {
        id: "replacement-id",
        name: "github-octo-app-dev-mutable",
        subject: "",
        issuer: "https://token.actions.githubusercontent.com",
        audiences: ["api://AzureADTokenExchange"]
      }
    );
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("warning");
    expect(ports.removeCredentialProvenance).not.toHaveBeenCalled();
    expect(
      op.steps.some(
        (step: { warning?: { code?: string } }) =>
          step.warning?.code === "federated-credential-revalidation-failed"
      )
    ).toBe(true);
  });

  it("stops before deleting the GitHub environment when revalidation is unavailable", async () => {
    const op = makeOp();
    const ports = makePorts(
      {
        runAz: vi
          .fn()
          .mockResolvedValueOnce(
            ok(
              JSON.stringify([
                { id: "c1", name: "github-octo-app-dev-mutable", subject: "" }
              ])
            )
          ),
        readCredentialProvenance: () => createdProvenance()
      },
      null
    );
    await runEnvironmentDeletion(op, ports);
    expect(op.state).toBe("failed_partial");
    expect(op.failure?.code).toBe(
      "federated-credential-revalidation-unavailable"
    );
    expect(ports.deleteGitHubEnvironment).not.toHaveBeenCalled();
    expect(ports.removeCredentialProvenance).not.toHaveBeenCalled();
  });

  it("stops cleanly when durable provenance cannot be read", async () => {
    const op = makeOp();
    const ports = makePorts({
      runAz: vi
        .fn()
        .mockResolvedValueOnce(
          ok(
            JSON.stringify([
              { id: "c1", name: "github-octo-app-dev-mutable", subject: "" }
            ])
          )
        ),
      readCredentialProvenance: async () => {
        throw new Error("corrupt store");
      }
    });
    await runEnvironmentDeletion(op, ports);
    expect(op.state).toBe("failed_partial");
    expect(op.failure?.code).toBe("credential-provenance-unavailable");
    expect(ports.deleteGitHubEnvironment).not.toHaveBeenCalled();
  });

  it("treats a missing credential as success when stale provenance cannot be cleared", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([
            { id: "c1", name: "github-octo-app-dev-mutable", subject: "" }
          ])
        )
      )
      .mockResolvedValueOnce(fail("Request_ResourceNotFound"))
      .mockResolvedValueOnce(
        ok(JSON.stringify([{ name: "keep", subject: "" }]))
      );
    const ports = makePorts({
      readCredentialProvenance: () => createdProvenance(),
      removeCredentialProvenance: async () => {
        throw new Error("disk locked");
      }
    });
    ports.runAz = runAz;
    await runEnvironmentDeletion(op, ports);
    expect(ports.deleteGitHubEnvironment).toHaveBeenCalledOnce();
    expect(
      op.steps.some(
        (step: { warning?: { code?: string } }) =>
          step.warning?.code === "credential-provenance-clear-failed"
      )
    ).toBe(true);
  });

  it("uses stable provenance identity after a repository rename", async () => {
    const op = makeOp({ request: { repo: "octo/renamed" } });
    op.repo = "octo/renamed";
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([
            { id: "c1", name: "github-octo-app-dev-mutable", subject: "" }
          ])
        )
      )
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok(JSON.stringify([{ name: "keep" }])));
    const ports = makePorts({
      runAz,
      readCredentialProvenance: () => createdProvenance()
    });
    await runEnvironmentDeletion(op, ports);
    expect(ports.removeCredentialProvenance).toHaveBeenCalledWith(
      "app-1",
      "c1"
    );
  });

  it("retires a deleted environment's shared-consumer record", async () => {
    const op = makeOp();
    const shared = {
      ...createdProvenance()[0],
      repo: "octo/other",
      repoId: 6,
      environment: "prod",
      origin: "reused" as const
    };
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([
            { id: "c1", name: "github-octo-app-dev-mutable", subject: "" }
          ])
        )
      )
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([
            { id: "c1", name: "github-octo-app-dev-mutable", subject: "" }
          ])
        )
      );
    const ports = makePorts({
      runAz,
      readCredentialProvenance: () => [...createdProvenance(), shared]
    });
    await runEnvironmentDeletion(op, ports);
    expect(ports.removeCredentialProvenance).not.toHaveBeenCalled();
    expect(ports.clearEnvironmentCredentialProvenance).toHaveBeenCalledWith(
      5,
      "dev"
    );
  });

  it("does not mutate credentials when the active tenant differs", async () => {
    const op = makeOp();
    const runAz = vi.fn();
    const ports = makePorts({
      runAz,
      readAzureIdentity: async () => ({
        tenantId: "other-tenant",
        applicationObjectId: "app-object-1"
      })
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("failed");
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("skipped");
    expect(op.state).toBe("failed_partial");
    expect(ports.deleteGitHubEnvironment).not.toHaveBeenCalled();
    expect(runAz).not.toHaveBeenCalled();
    expect(
      op.steps.some(
        (step: { warning?: { code?: string } }) =>
          step.warning?.code === "federated-credential-tenant-mismatch"
      )
    ).toBe(true);
  });

  it("matches tenant GUIDs case-insensitively during app review", async () => {
    const op = makeOp({ request: { tenantId: "TENANT-1" } });
    await runEnvironmentDeletion(op, makePorts());
    expect(op.state).toBe("input_required");
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("running");
  });

  it("does not review an app registration without the expected tenant", async () => {
    const op = makeOp();
    const credentialStage = op.stages.find(
      (candidate: { id: string }) => candidate.id === STAGE_DELETE_CREDENTIAL
    );
    if (credentialStage) credentialStage.state = "succeeded";
    delete op.request.tenantId;
    const runAz = vi.fn();
    await runEnvironmentDeletion(op, makePorts({ runAz }));
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("warning");
    expect(runAz).not.toHaveBeenCalled();
    expect(
      op.steps.some(
        (step: { warning?: { code?: string } }) =>
          step.warning?.code === "app-registration-tenant-unavailable"
      )
    ).toBe(true);
  });

  it("does not review an app registration when its identity cannot be read", async () => {
    const op = makeOp();
    const credentialStage = op.stages.find(
      (candidate: { id: string }) => candidate.id === STAGE_DELETE_CREDENTIAL
    );
    if (credentialStage) credentialStage.state = "succeeded";
    const runAz = vi.fn();
    const ports = makePorts({
      runAz,
      readAzureIdentity: async () => {
        throw new Error("identity lookup failed");
      }
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("warning");
    expect(runAz).not.toHaveBeenCalled();
    expect(
      op.steps.some(
        (step: { warning?: { code?: string } }) =>
          step.warning?.code === "app-registration-identity-unavailable"
      )
    ).toBe(true);
  });

  it("reports a warning when clearing provenance fails after a confirmed delete", async () => {
    const op = makeOp();
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([
            { id: "c1", name: "github-octo-app-dev-mutable", subject: "" }
          ])
        )
      )
      .mockResolvedValueOnce(ok(""))
      .mockResolvedValueOnce(ok("[]"))
      .mockResolvedValueOnce(ok(JSON.stringify(["radius-managed"])));
    const ports = makePorts({
      runAz,
      readCredentialProvenance: () => createdProvenance(),
      removeCredentialProvenance: async () => {
        throw new Error("disk locked");
      }
    });
    await runEnvironmentDeletion(op, ports);
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("warning");
    expect(
      op.steps.some(
        (step: { warning?: { code?: string } }) =>
          step.warning?.code === "credential-provenance-clear-failed"
      )
    ).toBe(true);
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
      .mockResolvedValueOnce(
        ok(
          JSON.stringify({
            id: "c1",
            name: "github-octo-app-dev-mutable",
            subject: "",
            issuer: "https://token.actions.githubusercontent.com",
            audiences: ["api://AzureADTokenExchange"]
          })
        )
      )
      .mockResolvedValueOnce(fail("")); // credential delete fails with empty stderr
    // Ports without a `log` exercise the default no-op logger.
    const ports: EnvironmentDeletionPorts = {
      deleteRadiusEnvironment: vi.fn(async () => ({
        outcome: "deleted" as const
      })),
      withCredentialProvenanceLock: async (work) => work(),
      runAz,
      readAzureIdentity: vi.fn(async () => ({
        tenantId: "tenant-1",
        applicationObjectId: "app-object-1"
      })),
      deleteGitHubEnvironment: vi.fn(async () => ({
        outcome: "deleted" as const
      })),
      // Provenance proves Radius created this credential, so it is eligible for
      // deletion (and the delete-failure warning path is exercised).
      readCredentialProvenance: () => createdProvenance(),
      removeCredentialProvenance: async () => {},
      clearEnvironmentCredentialProvenance: async () => {},
      persist: vi.fn(async () => {}),
      errorMessage: (e) => String(e)
    };
    await runEnvironmentDeletion(op, ports);
    expect(op.failure?.message).toBe(
      "Deleting the federated credential failed. The GitHub environment was kept so you can retry."
    );
    expect(op.state).toBe("failed_partial");
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

describe("runEnvironmentDeletion — heartbeat", () => {
  it("passes a heartbeat that refreshes activity and persists while the run is polled", async () => {
    const op = makeOp();
    let heartbeat: (() => void | Promise<void>) | undefined;
    const deleteRadiusEnvironment = vi.fn(
      async (_input, onHeartbeat?: () => void | Promise<void>) => {
        heartbeat = onHeartbeat;
        return { outcome: "deleted" as const };
      }
    );
    const persist = vi.fn(async () => {});
    const ports = makePorts({ deleteRadiusEnvironment, persist });

    await runEnvironmentDeletion(op, ports);

    expect(typeof heartbeat).toBe("function");
    // Simulate a long, quiet poll: force a stale timestamp, then heartbeat.
    op.lastActivityAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stale = op.lastActivityAt;
    persist.mockClear();
    await heartbeat!();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(Date.parse(op.lastActivityAt)).toBeGreaterThan(Date.parse(stale));
  });
});
