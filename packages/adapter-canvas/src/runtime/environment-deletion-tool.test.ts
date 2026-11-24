import { describe, expect, it, vi } from "vitest";
import {
  createEnvironmentDeletionTool,
  type EnvironmentDeletionToolPorts
} from "./environment-deletion-tool.js";

const target = { repo: "octo/app", environment: "dev" };
const azure = {
  provider: "azure",
  tenantId: "tenant",
  clientId: "client",
  repoId: 42,
  environmentId: 17
};

function harness() {
  const operation = { operationId: "op-1", currentStage: null };
  const calls: string[] = [];
  const discover = vi.fn(async () => azure);
  const createOperation = vi.fn(() => operation);
  const startOperation = vi.fn(() => {
    calls.push("register");
    return { ok: true as const, operation };
  });
  const persistOperations = vi.fn(async () => {
    calls.push("persist");
  });
  const finish = vi.fn();
  const isCurrent = vi.fn(() => true);
  const schedule = vi.fn<(record: typeof operation) => boolean>(() => {
    calls.push("schedule");
    return true;
  });
  const confirm = vi.fn<EnvironmentDeletionToolPorts["confirm"]>(async () => {
    calls.push("confirm");
    return "approved";
  });
  const openScope = vi.fn<EnvironmentDeletionToolPorts["openScope"]>(
    async () => ({
      repo: target.repo,
      login: "octocat",
      registration: {
        activeDeleteOperation: () => null,
        resolveEnvDeployment: async () => null,
        discoverEnvironmentTarget: discover,
        createOperation,
        buildDeleteStages: () => [],
        startOperation,
        persistOperations,
        finish,
        errorMessage: String
      },
      isCurrent,
      schedule
    })
  );
  const control = vi.fn<EnvironmentDeletionToolPorts["control"]>(async () => ({
    kind: "observed"
  }));
  return {
    invoke: createEnvironmentDeletionTool({
      openScope,
      control,
      confirm,
      redact: (value) => value.replace("private detail", "[redacted]")
    }),
    operation,
    calls,
    discover,
    createOperation,
    startOperation,
    persistOperations,
    finish,
    isCurrent,
    schedule,
    confirm,
    openScope,
    control
  };
}

describe("the independent environment deletion tool", () => {
  it("requires explicit target input and never selects a different workspace", async () => {
    const f = harness();
    expect(await f.invoke(null)).toMatchObject({ kind: "requires_input" });
    expect(await f.invoke({ repo: "../app", environment: "dev" })).toEqual({
      kind: "refused",
      code: "invalid-target"
    });
    expect(await f.invoke({ ...target, repo: "other/app" })).toEqual({
      kind: "refused",
      code: "workspace-target-unavailable"
    });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.startOperation).not.toHaveBeenCalled();
  });

  it("does not prompt or schedule when the selected environment uses AWS", async () => {
    const f = harness();
    f.discover.mockResolvedValue({ ...azure, provider: "aws" });
    expect(await f.invoke(target)).toEqual({
      kind: "refused",
      code: "provider-unsupported"
    });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.schedule).not.toHaveBeenCalled();
  });

  it.each(["status", "retry"] as const)(
    "requires the exact operation ID to request %s without new admission",
    async (mode) => {
      const f = harness();
      expect(await f.invoke({ ...target, mode, operationId: "../op" })).toEqual(
        {
          kind: "requires_input",
          fields: ["operationId"]
        }
      );
      expect(f.control).not.toHaveBeenCalled();
      expect(await f.invoke({ ...target, mode, operationId: "op-1" })).toEqual({
        kind: "observed"
      });
      expect(f.control).toHaveBeenCalledWith({
        ...target,
        mode,
        operationId: "op-1"
      });
      expect(f.openScope).not.toHaveBeenCalled();
    }
  );

  it.each([
    [{ mode: "force" }, "invalid-mode"],
    [{ mode: "delete", operationId: "op-1" }, "unexpected-operation-id"]
  ] as const)(
    "refuses inconsistent deletion arguments %j",
    async (args, code) => {
      const f = harness();
      expect(await f.invoke({ ...target, ...args })).toEqual({
        kind: "refused",
        code
      });
      expect(f.openScope).not.toHaveBeenCalled();
      expect(f.control).not.toHaveBeenCalled();
      expect(f.confirm).not.toHaveBeenCalled();
    }
  );

  it.each(["unavailable", "declined"] as const)(
    "does not trust argument approval when host confirmation is %s",
    async (decision) => {
      const f = harness();
      f.confirm.mockResolvedValue(decision);
      expect(await f.invoke({ ...target, approved: true })).toEqual(
        decision === "unavailable" ?
          { kind: "requires_confirmation", target }
        : { kind: "refused", code: "confirmation-declined" }
      );
      expect(f.startOperation).not.toHaveBeenCalled();
    }
  );

  it("schedules the exact persisted record with canonical target after trusted confirmation", async () => {
    const f = harness();
    expect(await f.invoke({ ...target, repo: "Octo/App" })).toEqual({
      kind: "accepted",
      target,
      operationId: "op-1"
    });
    expect(f.confirm).toHaveBeenCalledWith({
      ...target,
      provider: "azure",
      repoId: 42
    });
    expect(f.calls).toEqual(["confirm", "register", "persist", "schedule"]);
    expect(f.schedule.mock.calls[0]?.[0]).toBe(f.operation);
    expect(f.operation).toHaveProperty("request", {
      ...target,
      ...azure,
      selectedOwner: "octocat",
      environmentId: 17
    });
  });

  it("rejects a replacement repository before registering", async () => {
    const f = harness();
    f.discover
      .mockResolvedValueOnce(azure)
      .mockResolvedValueOnce({ ...azure, repoId: 7 });
    expect(await f.invoke(target)).toEqual({
      kind: "refused",
      code: "target-changed"
    });
    expect(f.createOperation).not.toHaveBeenCalled();
  });

  it("does not register when the identity is incomplete", async () => {
    const f = harness();
    f.discover.mockResolvedValue({ ...azure, tenantId: "" });
    expect(await f.invoke(target)).toEqual({
      kind: "refused",
      code: "target-identity-unavailable"
    });
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it("does not schedule on persistence failure", async () => {
    const f = harness();
    f.persistOperations.mockRejectedValueOnce(new Error("disk offline"));
    expect(await f.invoke(target)).toEqual({
      kind: "refused",
      code: "registration-failed"
    });
    expect(f.finish).toHaveBeenCalledWith(
      f.operation,
      "failed",
      expect.objectContaining({
        failure: expect.objectContaining({
          code: "operation-registration-persist-failed"
        })
      })
    );
    expect(f.schedule).not.toHaveBeenCalled();
  });

  it("terminalizes the exact registered operation if its scope closes while persisting", async () => {
    const f = harness();
    f.persistOperations.mockImplementationOnce(async () => {
      f.isCurrent.mockReturnValue(false);
    });
    expect(await f.invoke(target)).toEqual({
      kind: "failed",
      code: "operation-scheduling-failed",
      operationId: "op-1"
    });
    expect(f.schedule).not.toHaveBeenCalled();
    expect(f.finish).toHaveBeenCalledWith(
      f.operation,
      "failed",
      expect.objectContaining({
        failure: expect.objectContaining({
          code: "operation-scheduling-failed"
        })
      })
    );
    expect(f.persistOperations).toHaveBeenCalledTimes(2);
  });

  it("redacts errors thrown by the trusted host without starting deletion", async () => {
    const f = harness();
    f.confirm.mockRejectedValue(new Error("private detail"));
    expect(await f.invoke(target)).toEqual({
      kind: "failed",
      code: "environment-deletion-unavailable",
      message: "[redacted]"
    });
    expect(f.startOperation).not.toHaveBeenCalled();
  });
});
