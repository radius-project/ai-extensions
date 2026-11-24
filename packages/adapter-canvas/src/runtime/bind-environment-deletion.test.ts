import { describe, expect, it, vi } from "vitest";
import { bindEnvironmentDeletion } from "./bind-environment-deletion.js";

const target = { repo: "octo/app", environment: "dev", operationId: "op-1" };

function harness() {
  const isCurrent = () => true;
  const validate = vi.fn(async () => true);
  const scope = { repo: "Octo/App", login: "operator", isCurrent, validate };
  const workspace = vi.fn(async () => scope);
  const confirm = vi.fn<(message: string) => Promise<boolean | undefined>>(
    async () => true
  );
  const schedule = vi.fn(() => true);
  const openScope = vi.fn<
    Parameters<typeof bindEnvironmentDeletion>[0]["openScope"]
  >(async (repo, login) => ({
    repo,
    login,
    isCurrent,
    schedule,
    registration: {
      activeDeleteOperation: () => null,
      resolveEnvDeployment: async () => null,
      discoverEnvironmentTarget: async () => ({
        provider: "azure",
        repoId: 42,
        environmentId: 17,
        clientId: "client",
        tenantId: "tenant"
      }),
      createOperation: () => ({
        operationId: target.operationId,
        currentStage: null
      }),
      buildDeleteStages: () => [],
      startOperation: (operation) => ({ ok: true, operation }),
      persistOperations: async () => {},
      finish: vi.fn(),
      errorMessage: String
    }
  }));
  const control = vi.fn<
    Parameters<typeof bindEnvironmentDeletion>[0]["control"]
  >(async ({ command }) =>
    command === "status" ?
      {
        status: 200,
        body: { retryable: true, operationId: target.operationId }
      }
    : { status: 202, body: { operationId: target.operationId } }
  );
  return {
    invoke: bindEnvironmentDeletion({
      workspace,
      control,
      confirm,
      openScope,
      redact: (value) => value
    }),
    control,
    confirm,
    openScope,
    validate,
    schedule
  };
}

describe("selected environment deletion binding", () => {
  it("names the verified account and target in the host prompt before scheduling", async () => {
    const f = harness();
    const { repo, environment } = target;
    expect(await f.invoke({ repo, environment })).toMatchObject({
      kind: "accepted",
      operationId: target.operationId
    });
    expect(f.openScope).toHaveBeenCalledExactlyOnceWith(
      "Octo/App",
      "operator",
      expect.any(Function)
    );
    expect(f.confirm).toHaveBeenCalledWith(
      expect.stringContaining(
        'environment "dev" in Octo/App (repository ID 42) as operator'
      )
    );
    expect(f.schedule).toHaveBeenCalledTimes(1);
  });

  it("observes the exact operation under the selected owner without prompting", async () => {
    const f = harness();
    expect(await f.invoke({ ...target, mode: "status" })).toMatchObject({
      kind: "operation_status",
      status: 200
    });
    expect(f.control).toHaveBeenCalledExactlyOnceWith({
      ...target,
      repo: "Octo/App",
      login: "operator",
      isCurrent: expect.any(Function),
      command: "status"
    });
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.openScope).not.toHaveBeenCalled();
  });

  it("does not prompt for retry when operation ownership cannot be established", async () => {
    const f = harness();
    f.control.mockResolvedValueOnce({ status: 404, body: {} });
    expect(await f.invoke({ ...target, mode: "retry" })).toMatchObject({
      kind: "operation_status",
      status: 404
    });
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it.each([null, "unavailable", {}, { retryable: false }])(
    "does not prompt for retry unless the status explicitly permits it (%j)",
    async (body) => {
      const f = harness();
      f.control.mockResolvedValueOnce({ status: 200, body });
      expect(await f.invoke({ ...target, mode: "retry" })).toEqual({
        kind: "refused",
        code: "deletion-not-retryable"
      });
      expect(f.confirm).not.toHaveBeenCalled();
      expect(f.control).toHaveBeenCalledOnce();
    }
  );

  it("refuses operation control before contacting the runner if the workspace is stale", async () => {
    const f = harness();
    f.validate.mockResolvedValue(false);
    expect(await f.invoke({ ...target, mode: "status" })).toEqual({
      kind: "refused",
      code: "workspace-target-unavailable"
    });
    expect(f.control).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])(
    "does not schedule initial deletion if approval is missing or its workspace became stale (%s)",
    async (decision) => {
      const f = harness();
      f.confirm.mockResolvedValue(decision);
      f.validate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const { repo, environment } = target;
      expect(await f.invoke({ repo, environment })).toMatchObject(
        decision === undefined ?
          { kind: "requires_confirmation" }
        : { kind: "refused", code: "confirmation-declined" }
      );
      expect(f.schedule).not.toHaveBeenCalled();
    }
  );

  it.each([
    [undefined, "requires_confirmation"],
    [false, "refused"]
  ] as const)(
    "does not retry when trusted confirmation returns %s",
    async (answer, kind) => {
      const f = harness();
      f.confirm.mockResolvedValue(answer);
      expect(await f.invoke({ ...target, mode: "retry" })).toMatchObject({
        kind
      });
      expect(f.control).toHaveBeenCalledTimes(1);
    }
  );

  it("does not retry after the workspace changes during confirmation", async () => {
    const f = harness();
    f.validate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await f.invoke({ ...target, mode: "retry" })).toEqual({
      kind: "refused",
      code: "workspace-target-unavailable"
    });
    expect(f.control).toHaveBeenCalledTimes(1);
  });

  it("resumes only the exact saved operation after a separate owner-bound prompt", async () => {
    const f = harness();
    expect(await f.invoke({ ...target, mode: "retry" })).toMatchObject({
      kind: "operation_retry",
      status: 202
    });
    expect(f.confirm).toHaveBeenCalledWith(
      'Retry unresolved deletion stages for Azure-backed Radius environment "dev" in Octo/App as operator (operation op-1)?'
    );
    expect(f.control).toHaveBeenLastCalledWith({
      ...target,
      repo: "Octo/App",
      login: "operator",
      isCurrent: expect.any(Function),
      command: "retry"
    });
  });
});
