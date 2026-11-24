import { describe, expect, it, vi } from "vitest";
import {
  admitEnvironmentDeletion,
  type EnvironmentDeletionAdmissionPorts
} from "./environment-deletion-admission.js";

const target = { repo: "octo/app", environment: "dev" };
const azure = {
  provider: "azure",
  tenantId: "tenant",
  clientId: "client",
  repoId: 42
};

describe("admitEnvironmentDeletion", () => {
  it("does not read cloud configuration when the active-app lookup fails", async () => {
    const error = new Error("deployment read failed");
    const discoverEnvironmentTarget = vi.fn();
    const result = await admitEnvironmentDeletion(
      target,
      {
        resolveEnvDeployment: vi.fn().mockRejectedValue(error),
        discoverEnvironmentTarget
      },
      false
    );
    expect(result).toEqual({ kind: "deployment-unreadable", error });
    expect(discoverEnvironmentTarget).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, { kind: "identity-unavailable", readFailed: false }],
    [
      { state: "unavailable", reason: "artifact unreadable", readFailed: true },
      {
        kind: "identity-unavailable",
        readFailed: true,
        reason: "artifact unreadable"
      }
    ],
    [
      { state: "known", application: "api" },
      { kind: "app-deployed", app: "api", status: "delete-failed" }
    ]
  ] as const)(
    "blocks cleanup for deployment identity %j",
    async (identity, verdict) => {
      const discoverEnvironmentTarget = vi.fn();
      const resolveEnvDeployment: EnvironmentDeletionAdmissionPorts["resolveEnvDeployment"] =
        async () => ({ app: "api", status: "delete-failed", identity });
      expect(
        await admitEnvironmentDeletion(
          target,
          { resolveEnvDeployment, discoverEnvironmentTarget },
          false
        )
      ).toEqual(verdict);
      expect(discoverEnvironmentTarget).not.toHaveBeenCalled();
    }
  );

  it("propagates configuration lookup failure after confirming no active app", async () => {
    const error = new Error("configuration unavailable");
    const resolveEnvDeployment = vi.fn(async () => null);
    expect(
      await admitEnvironmentDeletion(
        target,
        {
          resolveEnvDeployment,
          discoverEnvironmentTarget: vi.fn().mockRejectedValue(error)
        },
        true
      )
    ).toEqual({ kind: "configuration-unreadable", error });
    expect(resolveEnvDeployment).toHaveBeenCalledWith("octo/app", "dev", "");
  });

  it.each([
    ["azure", false, true],
    ["aws", false, false],
    ["aws", true, true],
    ["unknown", true, false]
  ] as const)(
    "checks %s support with AWS enabled=%s",
    async (provider, flag, supported) => {
      const configuration = { ...azure, provider };
      expect(
        await admitEnvironmentDeletion(
          target,
          {
            resolveEnvDeployment: async () => null,
            discoverEnvironmentTarget: async () => configuration
          },
          flag
        )
      ).toEqual(
        supported ?
          { kind: "ready", configuration }
        : { kind: "provider-unsupported", provider }
      );
    }
  );
});
