import { describe, expect, it } from "vitest";
import {
  admitSetupOperation,
  type SetupAdmissionInput,
  type SetupAdmissionPorts,
  type SetupNamespaceIssue,
  type SetupOperationSnapshot,
  type SetupStartResult
} from "./setup-admission.js";

interface Operation extends SetupOperationSnapshot {
  state: string;
}

function setup({
  existing,
  stale = false,
  start = { ok: true },
  namespaceIssue = null,
  saveError
}: {
  existing?: Operation | null;
  stale?: boolean;
  start?: SetupStartResult;
  namespaceIssue?: SetupNamespaceIssue | null;
  saveError?: Error;
} = {}) {
  const events: string[] = [];
  const failures: unknown[] = [];
  const seeds: Parameters<
    SetupAdmissionPorts<Operation>["createOperation"]
  >[0][] = [];
  const operation: Operation = {
    operationId: "op_new",
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    currentStage: "configure",
    state: "running"
  };
  const ports: SetupAdmissionPorts<Operation> = {
    isValidRepo: (repo) => {
      events.push("validate");
      return repo === "octo/app";
    },
    getOperation: (id) => {
      events.push(`get:${id}`);
      if (existing === undefined) throw new Error("unscripted getOperation");
      return existing;
    },
    isStale: () => stale,
    isTerminal: (state) => state === "failed",
    continuationStages: ["identity", "configure"],
    createOperation: (input) => {
      events.push("create");
      seeds.push(input);
      return operation;
    },
    startOperation: () => {
      events.push("start");
      return start;
    },
    persist: async () => {
      events.push("persist");
      if (saveError) throw saveError;
    },
    recordPersistenceFailure: (op, error) => {
      events.push("record-failure");
      failures.push(error);
      op.state = "failed";
    },
    checkNamespace: async (op, target) => {
      events.push(`namespace:${op.operationId}`);
      expect(target.repo).toBe("octo/app");
      return namespaceIssue;
    },
    enterConfiguration: (op) => {
      events.push("configure");
      op.currentStage = "configure";
    }
  };
  return { ports, operation, events, seeds, failures };
}

function existing(overrides: Partial<Operation> = {}): Operation {
  return {
    operationId: "op_existing",
    repo: "octo/app",
    environment: "dev",
    provider: "azure",
    currentStage: "identity",
    state: "running",
    ...overrides
  };
}

describe("setup admission without Canvas", () => {
  it.each([{}, { repo: "" }])(
    "refuses a missing target before looking up work: %j",
    async (input) => {
      const test = setup();
      const result = await admitSetupOperation(input, test.ports);
      expect(result).toMatchObject({
        outcome: "refused",
        operation: null,
        issue: { code: "target-missing" }
      });
      expect(test.events).toEqual([]);
    }
  );

  it("refuses an invalid repository before starting work", async () => {
    const test = setup();
    expect(
      await admitSetupOperation({ repo: "invalid" }, test.ports)
    ).toMatchObject({
      outcome: "refused",
      operation: null,
      issue: { code: "invalid-repo" }
    });
    expect(test.events).toEqual(["validate"]);
  });

  it("persists a fresh operation before namespace checks and stage progress", async () => {
    const test = setup();
    const result = await admitSetupOperation({ repo: "octo/app" }, test.ports);
    expect(result).toEqual({
      outcome: "admitted",
      operation: test.operation,
      target: { repo: "octo/app", environment: "dev", provider: "azure" }
    });
    expect(test.seeds).toEqual([
      {
        repo: "octo/app",
        environment: "dev",
        provider: "azure",
        journey: {
          origin: null,
          resumeTarget: null,
          resumeBranch: null,
          resumeReason: null
        }
      }
    ]);
    expect(test.events).toEqual([
      "validate",
      "create",
      "start",
      "persist",
      "namespace:op_new",
      "configure"
    ]);
  });

  it.each([
    { environment: "", provider: "", operationId: 7, branch: "feature/work" },
    {
      environment: "prod",
      provider: "aws",
      operationId: "",
      resumeBranch: "feature/resume",
      branch: "ignored",
      origin: "planned",
      resumeTarget: "planned",
      resumeReason: "setup"
    }
  ] satisfies SetupAdmissionInput[])(
    "preserves explicit/default target and journey fields: %j",
    async (input) => {
      const test = setup();
      await admitSetupOperation({ repo: "octo/app", ...input }, test.ports);
      expect(test.seeds[0]).toEqual({
        repo: "octo/app",
        environment: input.environment || "dev",
        provider: input.provider || "azure",
        journey: {
          origin: input.origin || null,
          resumeTarget: input.resumeTarget || null,
          resumeBranch: input.resumeBranch || input.branch || null,
          resumeReason: input.resumeReason || null
        }
      });
    }
  );

  it.each(["operation-in-progress", "previous-cleanup-required"] as const)(
    "does not own a refused start: %s",
    async (reason) => {
      const conflict: SetupStartResult = {
        ok: false,
        reason,
        conflict: { operationId: "op_other" }
      };
      const test = setup({ start: conflict });
      expect(
        await admitSetupOperation({ repo: "octo/app" }, test.ports)
      ).toMatchObject({
        outcome: "refused",
        operation: null,
        issue: { code: "operation-start-conflict", conflict }
      });
      expect(test.events).toEqual(["validate", "create", "start"]);
    }
  );

  it("records a failed save and refuses without checking namespace or making writes", async () => {
    const error = new Error("disk full");
    const test = setup({ saveError: error });
    expect(
      await admitSetupOperation({ repo: "octo/app" }, test.ports)
    ).toMatchObject({
      outcome: "refused",
      operation: test.operation,
      issue: { code: "operation-persistence-failed", operationId: "op_new" }
    });
    expect(test.failures).toEqual([error]);
    expect(test.operation.state).toBe("failed");
    expect(test.events).toEqual([
      "validate",
      "create",
      "start",
      "persist",
      "record-failure"
    ]);
  });

  it.each([
    null,
    existing({ state: "failed" }),
    existing({ repo: "other/app" }),
    existing({ environment: "prod" }),
    existing({ provider: "aws" }),
    existing({ currentStage: "verify" }),
    existing({ inputRequired: { code: "consent" } })
  ])(
    "refuses a mismatched, terminal or input-blocked continuation: %j",
    async (record) => {
      const test = setup({ existing: record });
      expect(
        await admitSetupOperation(
          { repo: "octo/app", operationId: "op_existing" },
          test.ports
        )
      ).toMatchObject({
        outcome: "refused",
        operation: null,
        issue: {
          code: "operation-continuation-mismatch",
          operationId: "op_existing"
        }
      });
      expect(test.events).toEqual(["validate", "get:op_existing"]);
    }
  );

  it("refuses a stale continuation before using its account or making writes", async () => {
    const test = setup({ existing: existing(), stale: true });
    const result = await admitSetupOperation(
      { repo: "octo/app", operationId: "op_existing" },
      test.ports
    );
    expect(result).toMatchObject({
      issue: { code: "operation-continuation-mismatch" }
    });
    expect(test.events).toEqual(["validate", "get:op_existing"]);
  });

  it.each(["identity", "configure"])(
    "adopts the exact %s-stage record without creating or saving another",
    async (currentStage) => {
      const operation = existing({ currentStage });
      const test = setup({ existing: operation });
      const result = await admitSetupOperation(
        { repo: "octo/app", operationId: operation.operationId },
        test.ports
      );
      expect(result.outcome).toBe("admitted");
      expect(result.operation).toBe(operation);
      expect(test.events).toEqual([
        "validate",
        "get:op_existing",
        "namespace:op_existing",
        "configure"
      ]);
    }
  );

  it("compares the requested operation identity separately from the canonical environment", async () => {
    const operation = existing({ environment: "requested-name" });
    const test = setup({ existing: operation });
    const result = await admitSetupOperation(
      {
        repo: "octo/app",
        operationId: operation.operationId,
        operationEnvironment: "requested-name",
        environment: "canonical-name"
      },
      test.ports
    );
    expect(result).toMatchObject({
      outcome: "admitted",
      target: { environment: "canonical-name" }
    });
    expect(result.operation).toBe(operation);
  });

  it.each([false, true])(
    "retains only the owned record on namespace refusal (continuation=%s)",
    async (continuation) => {
      const issue: SetupNamespaceIssue = {
        code: "namespace-claims-unavailable",
        detail: "account unavailable"
      };
      const operation = existing();
      const test = setup({ existing: operation, namespaceIssue: issue });
      const result = await admitSetupOperation(
        {
          repo: "octo/app",
          ...(continuation ? { operationId: operation.operationId } : {})
        },
        test.ports
      );
      expect(result).toMatchObject({
        outcome: "refused",
        operation: continuation ? null : test.operation,
        issue
      });
      expect(test.events).not.toContain("configure");
    }
  );

  it("propagates a namespace read throw without entering configuration", async () => {
    const error = new Error("reader unavailable");
    const test = setup();
    test.ports.checkNamespace = async () => {
      throw error;
    };
    await expect(
      admitSetupOperation({ repo: "octo/app" }, test.ports)
    ).rejects.toBe(error);
    expect(test.events).not.toContain("configure");
  });
});
