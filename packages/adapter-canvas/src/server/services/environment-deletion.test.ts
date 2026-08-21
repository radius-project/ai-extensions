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

// Simulate a resumed operation by marking the given stages as already finished,
// so only the still-pending stages run on the next invocation.
function markStagesDone(
  op: { stages: Array<{ id: string; state: string }> },
  ids: string[]
) {
  for (const id of ids) {
    const target = op.stages.find((s) => s.id === id);
    if (target) target.state = "succeeded";
  }
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

  it("deletes env, credential, github env, and leaves the app registration in place", async () => {
    const op = makeOp();
    // list returns the env's credential first, then the delete succeeds. Stage 4
    // performs no Azure calls — it only records that the app was left in place.
    const runAz = vi
      .fn()
      .mockResolvedValueOnce(
        ok(
          JSON.stringify([
            { id: "c1", name: "github-octo-app-dev-mutable", subject: "" }
          ])
        )
      ) // stage 2 list
      .mockResolvedValueOnce(ok("")); // stage 2 delete cred
    const ports = makePorts({
      runAz,
      readCredentialProvenance: () => createdProvenance()
    });

    await runEnvironmentDeletion(op, ports);

    expect(stage(op, STAGE_DELETE_RADIUS_ENV)).toBe("succeeded");
    expect(stage(op, STAGE_DELETE_CREDENTIAL)).toBe("succeeded");
    expect(stage(op, STAGE_DELETE_GITHUB_ENV)).toBe("succeeded");
    // The app registration is never touched — no prompt, no delete, no probe.
    expect(stage(op, STAGE_REVIEW_APP_REGISTRATION)).toBe("succeeded");
    expect(op.state).toBe("succeeded");
    expect(op.endedAt).not.toBeNull();
    // Only the two stage-2 calls ran; stage 4 issued no `az` command.
    expect(runAz).toHaveBeenCalledTimes(2);
    expect(
      op.steps.some((s: { label: string }) =>
        /Left the app registration \(app-1\) in place/.test(s.label)
      )
    ).toBe(true);
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

  it("resume: runs only the GitHub delete under the lock when the credential stage is already done", async () => {
    // Simulate a restart that resumes after stages 1 and 2 already completed:
    // only the GitHub-environment delete is still pending. It must still run
    // under the credential-provenance lock, and must not re-run any az command.
    const op = makeOp();
    markStagesDone(op, [STAGE_DELETE_RADIUS_ENV, STAGE_DELETE_CREDENTIAL]);
    op.request.credentialConsumerRetirementReady = true;
    let lockHeld = false;
    const runAz = vi.fn();
    const ports = makePorts({
      runAz,
      withCredentialProvenanceLock: async (work) => {
        lockHeld = true;
        try {
          return await work();
        } finally {
          lockHeld = false;
        }
      },
      deleteRadiusEnvironment: vi.fn(),
      deleteGitHubEnvironment: vi.fn(async () => {
        expect(lockHeld).toBe(true);
        return { outcome: "deleted" as const };
      })
    });
    await runEnvironmentDeletion(op, ports);
    expect(ports.deleteRadiusEnvironment).not.toHaveBeenCalled();
    expect(runAz).not.toHaveBeenCalled();
    expect(ports.deleteGitHubEnvironment).toHaveBeenCalledOnce();
    // Retirement handoff set in stage 2 is still consumed on resume.
    expect(ports.clearEnvironmentCredentialProvenance).toHaveBeenCalledWith(
      5,
      "dev"
    );
    expect(stage(op, STAGE_DELETE_GITHUB_ENV)).toBe("succeeded");
    expect(op.state).toBe("succeeded");
  });

  it("resume: attributes a lock failure to the GitHub stage when only it is pending", async () => {
    const op = makeOp();
    markStagesDone(op, [STAGE_DELETE_RADIUS_ENV, STAGE_DELETE_CREDENTIAL]);
    const ports = makePorts({
      deleteRadiusEnvironment: vi.fn(),
      withCredentialProvenanceLock: async () => {
        throw new Error("lock timeout");
      }
    });
    await runEnvironmentDeletion(op, ports);
    expect(op.state).toBe("failed_partial");
    expect(op.failure?.code).toBe("credential-provenance-lock-unavailable");
    expect(op.failure?.stage).toBe(STAGE_DELETE_GITHUB_ENV);
    expect(stage(op, STAGE_DELETE_GITHUB_ENV)).toBe("failed");
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
    const persist = vi.fn(async () => {});
    let persistedDuringHeartbeat = 0;
    let activityAdvanced = false;
    // Invoke the heartbeat while the operation is still in flight (before the
    // runner finishes it), which is the real scenario: `touchOperation` only
    // refreshes activity on a non-terminal operation.
    const deleteRadiusEnvironment = vi.fn(
      async (_input, onHeartbeat?: () => void | Promise<void>) => {
        expect(typeof onHeartbeat).toBe("function");
        // Simulate a long, quiet poll: force a stale timestamp, then heartbeat.
        op.lastActivityAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const stale = op.lastActivityAt;
        persist.mockClear();
        await onHeartbeat!();
        persistedDuringHeartbeat = persist.mock.calls.length;
        activityAdvanced = Date.parse(op.lastActivityAt) > Date.parse(stale);
        return { outcome: "deleted" as const };
      }
    );
    const ports = makePorts({ deleteRadiusEnvironment, persist });

    await runEnvironmentDeletion(op, ports);

    expect(persistedDuringHeartbeat).toBe(1);
    expect(activityAdvanced).toBe(true);
  });
});
