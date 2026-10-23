import { describe, expect, it, vi } from "vitest";
import {
  admitDeployment,
  type DeploymentAdmissionPorts
} from "./deployment-admission.js";

function fixture() {
  const executor = { login: "fixture" };
  const reservation = { id: "lease" };
  const order: string[] = [];
  let current = true;
  const ports: DeploymentAdmissionPorts<typeof executor, typeof reservation> = {
    reserve: vi.fn(() => {
      order.push("reserve");
      return reservation;
    }),
    release: vi.fn(() => {
      order.push("release");
    }),
    isCurrent: () => current,
    selectAccount: vi.fn(async (input) => {
      expect(input.isCurrent()).toBe(true);
      order.push("account");
      return executor;
    }),
    readDeployment: vi.fn(async (selected) => {
      expect(selected).toBe(executor);
      order.push("read");
      return null;
    }),
    blocksMutation: (status) => status !== "success",
    readDefaultBranch: vi.fn(async (selected) => {
      expect(selected).toBe(executor);
      order.push("branch");
      return " develop \n";
    })
  };
  return {
    ports,
    executor,
    reservation,
    order,
    stop: () => {
      current = false;
    }
  };
}

const TARGET = {
  repo: "fixture/app",
  environment: "dev",
  savedLogin: "fixture"
};

describe("deployment admission", () => {
  it("reserves before selected reads and transfers the lease only after resolving the branch", async () => {
    const { ports, executor, reservation, order } = fixture();
    expect(await admitDeployment(TARGET, ports)).toEqual({
      kind: "admitted",
      executor,
      reservation,
      branch: "develop"
    });
    expect(order).toEqual(["reserve", "account", "read", "branch"]);
    expect(ports.selectAccount).toHaveBeenCalledWith({
      target: { repo: "fixture/app", environment: "dev" },
      savedLogin: "fixture",
      isCurrent: expect.any(Function)
    });
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("keeps an explicit branch without reading a default or following later input changes", async () => {
    const { ports, executor } = fixture();
    const input = { ...TARGET, branch: "feature/selected" };
    ports.selectAccount = async () => {
      input.branch = "changed";
      return executor;
    };
    expect(await admitDeployment(input, ports)).toMatchObject({
      kind: "admitted",
      branch: "feature/selected"
    });
    expect(ports.readDefaultBranch).not.toHaveBeenCalled();
  });

  it.each([{ repo: "" }, { environment: " " }])(
    "refuses an incomplete target %j before reserving",
    async (invalid) => {
      const { ports } = fixture();
      await expect(
        admitDeployment({ ...TARGET, ...invalid }, ports)
      ).rejects.toThrow("targetRepo and environment are required");
      expect(ports.reserve).not.toHaveBeenCalled();
      expect(ports.selectAccount).not.toHaveBeenCalled();
    }
  );

  it("refuses a concurrent reservation without selecting an account", async () => {
    const { ports } = fixture();
    ports.reserve = () => undefined;
    expect(await admitDeployment(TARGET, ports)).toEqual({
      kind: "refused",
      reason: "conflict",
      message: "Another deployment operation is already starting."
    });
    expect(ports.selectAccount).not.toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
  });

  it.each(["selectAccount", "readDefaultBranch"] as const)(
    "releases exactly once and preserves a %s failure",
    async (method) => {
      const { ports, reservation } = fixture();
      const failure = new Error("selected account unavailable");
      ports[method] = async () => {
        throw failure;
      };
      await expect(admitDeployment(TARGET, ports)).rejects.toBe(failure);
      expect(ports.release).toHaveBeenCalledExactlyOnceWith(reservation);
    }
  );

  it("fails closed when persisted operation state is unavailable", async () => {
    const { ports, reservation } = fixture();
    ports.readDeployment = async () => {
      throw new Error("read failed");
    };
    expect(await admitDeployment(TARGET, ports)).toMatchObject({
      kind: "refused",
      reason: "unavailable",
      message: expect.stringContaining("Could not verify")
    });
    expect(ports.readDefaultBranch).not.toHaveBeenCalled();
    expect(ports.release).toHaveBeenCalledExactlyOnceWith(reservation);
  });

  it.each(["deleting", "pending", "in_progress"])(
    "does not resolve a branch while persisted status is %s",
    async (status) => {
      const { ports, reservation } = fixture();
      ports.readDeployment = async () => ({ status });
      expect(await admitDeployment(TARGET, ports)).toEqual({
        kind: "refused",
        reason: "conflict",
        message:
          status === "deleting" ?
            "This deployment is currently being deleted. Wait for it to finish before deploying again."
          : "A deployment to this environment is already in progress."
      });
      expect(ports.readDefaultBranch).not.toHaveBeenCalled();
      expect(ports.release).toHaveBeenCalledExactlyOnceWith(reservation);
    }
  );

  it("admits a completed persisted deployment", async () => {
    const { ports } = fixture();
    ports.readDeployment = async () => ({ status: "success" });
    expect(await admitDeployment(TARGET, ports)).toMatchObject({
      kind: "admitted"
    });
  });

  it.each(["", " \n"])(
    "never guesses main for unresolved default %j",
    async (branch) => {
      const { ports, reservation } = fixture();
      ports.readDefaultBranch = async () => branch;
      await expect(admitDeployment(TARGET, ports)).rejects.toThrow(
        "Could not resolve the deployment branch"
      );
      expect(ports.release).toHaveBeenCalledExactlyOnceWith(reservation);
    }
  );

  it.each(["before", "account", "read", "branch"] as const)(
    "fences changed ownership during %s",
    async (phase) => {
      const { ports, executor, reservation, stop } = fixture();
      if (phase === "before") stop();
      if (phase === "account")
        ports.selectAccount = async () => {
          stop();
          return executor;
        };
      if (phase === "read")
        ports.readDeployment = async () => {
          stop();
          return null;
        };
      if (phase === "branch")
        ports.readDefaultBranch = async () => {
          stop();
          return "develop";
        };
      await expect(admitDeployment(TARGET, ports)).rejects.toThrow(
        "context changed during admission"
      );
      expect(ports.release).toHaveBeenCalledExactlyOnceWith(reservation);
    }
  );
});
