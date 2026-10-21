import { describe, expect, it, vi } from "vitest";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import type { GitHubAccountReadiness } from "../server/services/github-account-readiness.js";
import {
  createDeploymentAccountResolver,
  type DeploymentAccountPorts
} from "./deployment-account.js";

const TARGET = { repo: "fixture/app", environment: "dev" };

function ready(): GitHubAccountReadiness {
  const check = { state: "ready" as const, detail: "Ready." };
  return {
    ready: true,
    login: "saved",
    credentialSource: "keyring",
    summary: "Ready to configure deployments",
    checks: {
      repository: check,
      workflow: check,
      environment: check,
      packages: check,
      identity: check
    },
    repair: null,
    repairRemediation: null,
    restoration: null
  };
}

function fixture(overrides: Partial<DeploymentAccountPorts> = {}) {
  const executor = successfulSelectedGhExecutor({ login: "saved" });
  const readIdentity = vi.fn(async () => ({
    accounts: [
      {
        login: "saved",
        hasWorkflow: true,
        hasPackages: true,
        switchable: true,
        acting: false
      }
    ]
  }));
  const check = vi.fn(async () => ready());
  const createExecutor = vi.fn(async () => executor);
  const resolve = createDeploymentAccountResolver({
    readIdentity,
    readiness: { check },
    createExecutor,
    redactDiagnostic: (value) =>
      value.replaceAll("private-host-value", "[REDACTED]"),
    ...overrides
  });
  return { resolve, executor, readIdentity, check, createExecutor };
}

describe("deployment GitHub account binding", () => {
  it("returns the verified selected executor for an unambiguous target", async () => {
    const { resolve, executor, check, createExecutor } = fixture();
    expect(await resolve({ target: TARGET, isCurrent: () => true })).toEqual({
      state: "selected",
      login: "saved",
      executor
    });
    expect(check).toHaveBeenCalledTimes(2);
    expect(check).toHaveBeenLastCalledWith({ ...TARGET, login: "saved" });
    expect(createExecutor).toHaveBeenCalledExactlyOnceWith("saved");
  });

  it.each(["missing", "error"] as const)(
    "preserves %s readiness without acquiring credentials or choosing another account",
    async (state) => {
      const readiness = ready();
      readiness.ready = false;
      readiness.checks.workflow = {
        state,
        detail: "private-host-value is unavailable."
      };
      const { resolve, readIdentity, createExecutor } = fixture({
        readiness: { check: async () => readiness }
      });
      expect(
        await resolve({
          target: TARGET,
          savedLogin: "saved",
          isCurrent: () => true
        })
      ).toMatchObject({
        state: state === "error" ? "unavailable" : "reauthorization-required",
        message: "[REDACTED] is unavailable."
      });
      expect(readIdentity).not.toHaveBeenCalled();
      expect(createExecutor).not.toHaveBeenCalled();
    }
  );

  it("uses the owning readiness summary if individual failed checks are absent", async () => {
    const readiness = ready();
    readiness.ready = false;
    readiness.summary = "Additional GitHub access is required";
    const { resolve } = fixture({
      readiness: { check: async () => readiness }
    });
    expect(
      await resolve({
        target: TARGET,
        savedLogin: "saved",
        isCurrent: () => true
      })
    ).toMatchObject({
      state: "reauthorization-required",
      message: "Additional GitHub access is required"
    });
  });

  it("passes explicit host selection through the shared policy and returns only its chosen executor", async () => {
    const choose = vi.fn(async () => "saved");
    const { resolve, executor } = fixture({
      readIdentity: async () => ({
        accounts: ["first", "saved"].map((login) => ({
          login,
          hasWorkflow: true,
          hasPackages: true,
          switchable: true,
          acting: false
        }))
      }),
      choose
    });
    expect(await resolve({ target: TARGET, isCurrent: () => true })).toEqual({
      state: "selected",
      login: "saved",
      executor
    });
    expect(choose).toHaveBeenCalledExactlyOnceWith({
      target: TARGET,
      logins: ["first", "saved"]
    });
  });

  it("refuses a credential for another login instead of an ambient fallback", async () => {
    const { resolve } = fixture({
      createExecutor: async () =>
        successfulSelectedGhExecutor({ login: "wrong" })
    });
    expect(
      await resolve({
        target: TARGET,
        savedLogin: "saved",
        isCurrent: () => true
      })
    ).toMatchObject({
      state: "unavailable",
      message: expect.stringContaining("no longer matches")
    });
  });

  it("drops a late executor if the invocation lost ownership while it was acquired", async () => {
    let current = true;
    const { resolve } = fixture({
      createExecutor: async () => {
        current = false;
        return successfulSelectedGhExecutor({ login: "saved" });
      }
    });
    expect(
      await resolve({
        target: TARGET,
        savedLogin: "saved",
        isCurrent: () => current
      })
    ).toEqual({ state: "stopped" });
  });

  it.each([new Error("private-host-value"), "private-host-value"])(
    "reports acquisition failures with host and core redaction (%j)",
    async (failure) => {
      const { resolve } = fixture({
        createExecutor: async () => {
          throw failure;
        }
      });
      expect(
        await resolve({
          target: TARGET,
          savedLogin: "saved",
          isCurrent: () => true
        })
      ).toEqual({
        state: "unavailable",
        message: "[REDACTED]"
      });
    }
  );

  it("bounds diagnostics after redaction", async () => {
    const { resolve } = fixture({
      createExecutor: async () => {
        throw new Error("client_secret=fixture-value\n" + "x".repeat(5000));
      }
    });
    const result = await resolve({
      target: TARGET,
      savedLogin: "saved",
      isCurrent: () => true
    });
    expect(result.state).toBe("unavailable");
    if (result.state !== "unavailable")
      throw new Error("Expected explicit failure");
    expect(result.message).toHaveLength(4000);
    expect(result.message).not.toContain("fixture-value");
  });
});
