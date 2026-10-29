import { describe, expect, it, vi } from "vitest";
import {
  assertSetupExecutionActive,
  ensureAzureServicePrincipal,
  resolveAzureAutoSetupApplication,
  type ProviderMutationCommandResult
} from "@radius-project/core";
import { buildRadiusAppProvenanceTags } from "../../azure-oidc.js";
import {
  azurePorts,
  callerId,
  clientId,
  command,
  existingIdentityAz,
  resolved
} from "../../../../core/test/support/azure-setup.js";
import { createAzureRecoveryPort } from "./azure-setup-recovery.js";
import {
  prepareProviderMutation,
  providerMutationRecord,
  requestStop,
  createOperation,
  fromPersistedOperation,
  toPersistedOperation,
  settleProviderMutation
} from "../../operations.js";
import { ProviderMutationRecoveryError } from "./provider-mutation-recovery.js";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function retryFixture(kind: "owner" | "tags") {
  let stopped = false;
  let attempts = 0;
  const operation = createOperation({
    operationId: "op_azure_retry",
    repo: "owner/repo",
    environment: "dev",
    provider: "azure"
  });
  const mutationKind =
    kind === "owner" ? "azure_app_owner.add" : "azure_app_tags.patch";
  const target =
    kind === "owner" ?
      `${clientId}:${callerId}`
    : `${clientId}:${operation.operationId}`;
  const tags = buildRadiusAppProvenanceTags({
    repo: operation.repo,
    environment: operation.environment,
    operationId: operation.operationId
  });
  const write = vi.fn(async (): Promise<ProviderMutationCommandResult> =>
    attempts === 1 ? command("", 1, "Directory_ObjectNotFound") : command()
  );
  const fixture = azurePorts(async (args) => {
    const call = args.slice(0, 4).join(" ");
    if (
      kind === "owner" ?
        call === "ad app owner add"
      : args[0] === "rest" && args.includes("PATCH")
    ) {
      attempts++;
      return write();
    }
    if (args.slice(0, 3).join(" ") === "ad app list") return command("[]");
    if (args.slice(0, 3).join(" ") === "ad app create")
      return command(clientId);
    if (call === "ad app owner add") return command();
    if (call === "ad app owner list") return command(callerId);
    if (args[0] === "rest" && args.includes("PATCH")) return command();
    if (args.slice(0, 3).join(" ") === "ad app show" && args.includes("tags"))
      return command(JSON.stringify(tags));
    return existingIdentityAz(args);
  });
  const record = () => providerMutationRecord(operation, mutationKind, target);
  const saved: NonNullable<ReturnType<typeof record>>[] = [];
  const persist = vi.fn(async () => {
    const current = record();
    if (current) saved.push(structuredClone(current));
  });
  const recovery = createAzureRecoveryPort(operation, persist, () => stopped);
  fixture.application.operationId = operation.operationId;
  fixture.application.recovery = recovery;
  fixture.application.assertActive = () =>
    assertSetupExecutionActive(() => stopped);
  fixture.application.checkpoint = vi.fn(async () => {
    assertSetupExecutionActive(() => stopped);
    return true;
  });
  const run = () =>
    resolveAzureAutoSetupApplication({
      ports: fixture.application,
      oidc: resolved.oidc,
      environment: "dev",
      explicitAppId: "",
      createNewApp: true,
      appNameProvided: false,
      requestedAppName: "",
      requestedClientId: "",
      serviceManagementReference: "",
      callerIdentity: { kind: "user" }
    });
  return {
    ...fixture,
    operation,
    mutationKind,
    target,
    record,
    saved,
    persist,
    recovery,
    write,
    run,
    shutdown: () => {
      stopped = true;
    }
  };
}

describe.each(["owner", "tags"] as const)(
  "Azure %s propagation through the journal",
  (kind) => {
    it.each([
      "delay",
      "final-incomplete",
      "final-failed",
      "failed",
      "positive"
    ] as const)(
      "preserves issued-read evidence across shutdown during %s",
      async (boundary) => {
        const test = retryFixture(kind);
        test.write.mockResolvedValue(command("", 1, "ECONNRESET"));
        const entered = deferred();
        const gate = deferred();
        const run = test.application.runAz;
        let reads = 0;
        test.application.runAz = async (args) => {
          const target =
            kind === "owner" ?
              args.slice(0, 4).join(" ") === "ad app owner list"
            : args.slice(0, 3).join(" ") === "ad app show" &&
              args.includes("tags");
          if (!target) return run(args);
          reads++;
          if (boundary === "delay")
            return reads === 1 ? command("[]") : run(args);
          if (
            (boundary === "final-incomplete" || boundary === "final-failed") &&
            reads < 6
          )
            return command("[]");
          entered.resolve();
          await gate.promise;
          return (
            boundary === "positive" ? run(args)
            : boundary === "failed" || boundary === "final-failed" ?
              command("", 1, "AuthorizationFailed")
            : command("[]")
          );
        };
        test.application.sleep = async () => {
          if (boundary === "delay") {
            entered.resolve();
            await gate.promise;
          }
        };
        const finalizer = vi.spyOn(test.application, "finalizeFailure");
        const pending = test.run();
        const interrupted = expect(pending).rejects.toMatchObject({
          code: "setup-execution-interrupted"
        });
        let before: ReturnType<typeof test.record>;
        let savedBefore: typeof test.saved;
        try {
          await entered.promise;
          before = structuredClone(test.record());
          savedBefore = structuredClone(test.saved);
          test.shutdown();
        } finally {
          gate.resolve();
        }
        await interrupted;
        expect(before).toMatchObject({
          status: "outcome_unknown",
          initialDiagnostic: expect.stringContaining("ECONNRESET")
        });
        expect(reads).toBe(
          boundary === "final-incomplete" || boundary === "final-failed" ? 6 : 1
        );
        expect(test.write).toHaveBeenCalledOnce();
        expect(finalizer).not.toHaveBeenCalled();
        expect(test.operation.failure).toBeNull();
        expect(test.operation.endedAt).toBeNull();
        expect(test.operation.providerRecovery.state).not.toBe(
          "rollback_pending"
        );
        if (boundary === "positive") {
          expect(test.record()?.status).toBe("confirmed");
          expect(test.saved.at(-1)?.status).toBe("confirmed");
        } else {
          expect(test.record()).toEqual(before);
          expect(test.saved).toEqual(savedBefore);
          expect(test.recovery.unresolved()).toEqual([before]);
        }
      }
    );

    it.each(["delay", "prepared", "validation"] as const)(
      "prevents the retry when shutdown wins during %s",
      async (boundary) => {
        const test = retryFixture(kind);
        const entered = deferred();
        const gate = deferred();
        const hold = async () => {
          entered.resolve();
          await gate.promise;
        };
        let retry = false;
        test.application.sleep = async () => {
          expect(test.record()).toMatchObject({
            status: "not_applied",
            evidence: "Directory_ObjectNotFound"
          });
          retry = true;
          if (boundary === "delay") await hold();
        };
        const save = test.persist.getMockImplementation();
        if (!save) throw new Error("Missing persistence fixture");
        test.persist.mockImplementation(async () => {
          await save();
          if (
            retry &&
            boundary === "prepared" &&
            test.record()?.status === "prepared"
          )
            await hold();
        });
        test.application.recovery = {
          ...test.recovery,
          execute: (input) =>
            test.recovery.execute({
              ...input,
              validateBeforeMutation: async () => {
                if (retry && boundary === "validation") await hold();
              }
            })
        };

        const pending = test.run();
        const interrupted = expect(pending).rejects.toMatchObject({
          code: "setup-execution-interrupted"
        });
        try {
          await entered.promise;
          test.shutdown();
        } finally {
          gate.resolve();
        }
        await interrupted;

        expect(test.write).toHaveBeenCalledOnce();
        expect(test.record()).toMatchObject({
          status: "not_applied",
          initialDiagnostic: expect.stringContaining(
            "Directory_ObjectNotFound"
          ),
          finalDiagnostic: expect.stringContaining("Directory_ObjectNotFound")
        });
        expect(test.record()?.reconcileAttempts ?? 0).toBe(0);
        expect(test.saved.map((entry) => entry.status)).not.toContain(
          "outcome_unknown"
        );
        expect(test.recovery.unresolved()).toEqual([]);
      }
    );

    it("retries conclusive rejections with the same identity and retains diagnostics", async () => {
      const test = retryFixture(kind);
      test.write
        .mockResolvedValueOnce(command("", 1, "Directory_ObjectNotFound first"))
        .mockResolvedValueOnce(command("", 1, "Directory_ObjectNotFound last"))
        .mockResolvedValueOnce(command("", "0"));

      await expect(test.run()).resolves.toMatchObject({ clientId });

      expect(test.write).toHaveBeenCalledTimes(3);
      expect(
        test.events.filter(
          (event) => Array.isArray(event) && event[0] === "sleep"
        )
      ).toEqual([
        ["sleep", 2000],
        ["sleep", 4000]
      ]);
      expect(new Set(test.saved.map((entry) => entry.mutationId)).size).toBe(1);
      expect(test.record()).toMatchObject({
        status: "confirmed",
        providerIdempotencyKey: kind === "owner" ? test.target : clientId,
        initialDiagnostic: expect.stringContaining("first"),
        finalDiagnostic: expect.stringContaining("last")
      });
    });

    it.each([
      ["Directory_ObjectNotFound", 6],
      ["AuthorizationFailed", 1],
      ["Directory_ObjectNotFound\nRetry-After: 11", 1]
    ] as const)(
      "retains exhaustion/refusal for %s",
      async (detail, attempts) => {
        const test = retryFixture(kind);
        test.write.mockResolvedValue(command("", 1, detail));

        await expect(test.run()).resolves.toBeNull();

        expect(test.write).toHaveBeenCalledTimes(attempts);
        expect(test.events.at(-1)).toMatchObject({
          kind:
            kind === "owner" ? "app-owner-add-failed" : "app-tag-update-failed"
        });
        expect(test.record()).toMatchObject({
          status: "not_applied",
          evidence: detail
        });
        expect(
          test.events.filter(
            (event) => Array.isArray(event) && event[0] === "sleep"
          )
        ).toEqual(
          attempts === 6 ?
            [2000, 4000, 6000, 8000, 10000].map((delay) => ["sleep", delay])
          : []
        );
      }
    );

    it("does not add a user Stop boundary between attempts", async () => {
      const test = retryFixture(kind);
      const stop = vi.spyOn(test.application, "stopBoundary");
      test.application.sleep = async () => {
        requestStop(test.operation);
      };
      test.application.checkpoint = async (boundary) =>
        boundary !==
        `after-app-registration-${kind === "owner" ? "owner-add" : "tag-update"}`;

      await expect(test.run()).resolves.toBeNull();

      expect(test.write).toHaveBeenCalledTimes(2);
      expect(test.record()?.status).toBe("confirmed");
      const boundary = `before-app-registration-${kind === "owner" ? "owner-add" : "tag-update"}`;
      expect(
        stop.mock.calls.filter(([name]) => name === boundary)
      ).toHaveLength(1);
    });

    it("settles an issued acknowledgement after shutdown without another write", async () => {
      const test = retryFixture(kind);
      test.write.mockImplementation(async () => {
        test.shutdown();
        return command();
      });

      await expect(test.run()).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });

      expect(test.write).toHaveBeenCalledOnce();
      expect(test.record()?.status).toBe("confirmed");
      expect(test.saved.at(-1)?.status).toBe("confirmed");
    });

    it.each(["not_applied", "confirmed"] as const)(
      "surfaces failed %s evidence persistence without another request",
      async (status) => {
        const test = retryFixture(kind);
        if (status === "confirmed") test.write.mockResolvedValue(command());
        test.persist.mockImplementation(async () => {
          if (test.record()?.status === status)
            throw new Error("storage unavailable");
        });

        await expect(test.run()).rejects.toMatchObject({
          code: "provider-mutation-recovery-persistence-failed",
          message: expect.stringContaining("storage unavailable")
        });

        expect(test.write).toHaveBeenCalledOnce();
        expect(test.record()?.status).toBe(status);
      }
    );

    it("reconciles an unknown response rather than retrying its propagation text", async () => {
      const test = retryFixture(kind);
      test.write.mockResolvedValue(
        command("", 1, "Directory_ObjectNotFound\nECONNRESET")
      );

      await expect(test.run()).resolves.toMatchObject({ clientId });

      expect(test.write).toHaveBeenCalledOnce();
      expect(
        test.saved.some((entry) => entry.status === "outcome_unknown")
      ).toBe(true);
      expect(test.record()?.status).toBe("confirmed");
      expect(test.events).not.toContainEqual(["sleep", expect.any(Number)]);
    });

    it("reconciles a restored unresolved attempt without replaying it", async () => {
      const test = retryFixture(kind);
      prepareProviderMutation(test.operation, {
        kind: test.mutationKind,
        target: test.target
      });
      const restored = fromPersistedOperation(
        toPersistedOperation(test.operation)
      );
      test.application.recovery = createAzureRecoveryPort(
        restored,
        async () => {},
        () => false
      );

      await expect(test.run()).resolves.toMatchObject({ clientId });

      expect(test.write).not.toHaveBeenCalled();
      expect(
        providerMutationRecord(restored, test.mutationKind, test.target)?.status
      ).toBe("confirmed");
    });

    it("does not retry an unknown request whose target is still absent", async () => {
      const test = retryFixture(kind);
      test.write.mockResolvedValue(
        command("", 1, "Directory_ObjectNotFound\nECONNRESET")
      );
      const run = test.application.runAz;
      test.application.runAz = async (args) => {
        if (
          test.write.mock.calls.length > 0 &&
          (args.slice(0, 4).join(" ") === "ad app owner list" ||
            (args.slice(0, 3).join(" ") === "ad app show" &&
              args.includes("tags")))
        )
          return command("[]");
        return run(args);
      };
      if (kind === "owner") await expect(test.run()).resolves.toBeNull();
      else
        await expect(test.run()).rejects.toMatchObject({
          code: "provider-mutation-manual-required"
        });
      expect(test.write).toHaveBeenCalledOnce();
      expect(test.record()?.status).toBe(
        kind === "owner" ? "not_applied" : "manual_required"
      );
    });

    it("does not replay a restored manual-required attempt", async () => {
      const test = retryFixture(kind);
      const mutation = prepareProviderMutation(test.operation, {
        kind: test.mutationKind,
        target: test.target
      });
      settleProviderMutation(
        test.operation,
        mutation.mutationId,
        "manual_required",
        "Inspect the original request."
      );
      const restored = fromPersistedOperation(
        toPersistedOperation(test.operation)
      );
      test.application.recovery = createAzureRecoveryPort(
        restored,
        async () => {},
        () => false
      );
      await expect(test.run()).rejects.toMatchObject({
        code: "provider-mutation-manual-required"
      });
      expect(test.write).not.toHaveBeenCalled();
    });
  }
);

it("records already-owner evidence inside the single issued attempt", async () => {
  const test = retryFixture("owner");
  test.write.mockResolvedValue(
    command("", 1, "added object references already exist")
  );

  await expect(test.run()).resolves.toMatchObject({ clientId });

  expect(test.write).toHaveBeenCalledOnce();
  expect(test.record()).toMatchObject({
    status: "confirmed",
    evidence: expect.stringContaining("already an owner")
  });
});
describe("Canvas Azure recovery binding", () => {
  it.each([
    "azure_application.create",
    "azure_service_principal.create",
    "azure_federated_credential.create",
    "azure_role_assignment.create"
  ])(
    "persists an unsent %s as not applied when shutdown wins the prepared save",
    async (kind) => {
      const operation = { operationId: "held-azure" };
      let stopped = false;
      let release = () => {};
      let entered = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prepared = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const saved: string[] = [];
      const binding = createAzureRecoveryPort(
        operation,
        async () => {
          const status = providerMutationRecord(
            operation,
            kind,
            "target"
          )?.status;
          saved.push(String(status));
          if (status === "prepared") {
            entered();
            await gate;
          }
        },
        () => stopped
      );
      const mutate = vi.fn(async () => ({ code: 0, stdout: "id", stderr: "" }));
      const confirmed = vi.fn();
      const pending = binding.execute({
        kind,
        target: "target",
        mutate,
        accept: () => "id",
        onConfirmed: confirmed,
        reconcile: async () => {
          throw new Error("Unsent writes must not reconcile");
        }
      });
      const rejected = expect(pending).rejects.toMatchObject({
        code: "setup-execution-interrupted"
      });
      await prepared;
      stopped = true;
      release();
      await rejected;
      expect(saved).toEqual(["prepared", "not_applied"]);
      expect(mutate).not.toHaveBeenCalled();
      expect(confirmed).not.toHaveBeenCalled();
    }
  );

  it.each(["runtime", "call", "neither"])(
    "preserves the %s assertion with call-specific inputs",
    async (guard) => {
      const operation = { operationId: "composed-azure" };
      const call = vi.fn(() =>
        assertSetupExecutionActive(() => guard === "call")
      );
      const mutate = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
      const pending = createAzureRecoveryPort(
        operation,
        async () => {},
        () => guard === "runtime"
      ).execute({
        kind: "azure_application.create",
        target: "target",
        assertActive: call,
        mutate,
        accept: () => "id",
        reconcile: async () => {
          throw new Error("Unexpected reconciliation");
        }
      });
      if (guard === "neither") {
        await expect(pending).resolves.toMatchObject({
          state: "applied",
          value: "id"
        });
        expect(mutate).toHaveBeenCalledOnce();
      } else {
        await expect(pending).rejects.toMatchObject({
          code: "setup-execution-interrupted"
        });
        expect(mutate).not.toHaveBeenCalled();
      }
      expect(call).toHaveBeenCalledTimes(
        guard === "runtime" ? 0
        : guard === "call" ? 1
        : 3
      );
    }
  );

  it("preserves recovery error identity and increments reconciliation exactly once", async () => {
    const operation = { operationId: "principal-recovery" };
    prepareProviderMutation(operation, {
      kind: "azure_service_principal.create",
      target: "application"
    });
    const binding = createAzureRecoveryPort(
      operation,
      async () => {},
      () => false
    );
    let original: unknown;
    const recovery = {
      ...binding,
      execute: async <T>(input: Parameters<typeof binding.execute<T>>[0]) => {
        try {
          return await binding.execute(input);
        } catch (error) {
          original = error;
          throw error;
        }
      }
    };
    let received: unknown;
    try {
      await ensureAzureServicePrincipal(
        "application",
        async () => ({
          code: 1,
          stdout: "",
          stderr: "Request_ResourceNotFound"
        }),
        recovery,
        async () => true,
        async () => {}
      );
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(ProviderMutationRecoveryError);
    expect(received).toBe(original);
    expect(
      providerMutationRecord(
        operation,
        "azure_service_principal.create",
        "application"
      )
    ).toMatchObject({ status: "outcome_unknown", reconcileAttempts: 1 });
    expect(binding.unresolved()).toHaveLength(1);
  });
});
