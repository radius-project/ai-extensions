import { describe, expect, it, vi } from "vitest";
import { createGitHubAccountCoordinator } from "../server/services/github-account-coordinator.js";
import { successfulSelectedGhExecutor } from "../../test/support/server/selected-gh.js";
import { createGitHubAccountResolvers } from "./github-account-resolvers.js";

describe("production account policies", () => {
  it.each(["administrator", "installation"] as const)(
    "does not weaken strict setup for %s lacking setup-only grants",
    async (kind) => {
      const login = kind === "installation" ? "fixture[bot]" : "administrator";
      const packageProbe = vi.fn(async (): Promise<never> => {
        throw new Error("Package probe not permitted");
      });
      const executor = successfulSelectedGhExecutor({
        login,
        scopes: ["repo", "workflow"],
        run: async (args) => {
          if (args[1] === "repos/fixture/app")
            return {
              code: 0,
              stdout: JSON.stringify({ permissions: { admin: true } }),
              stderr: ""
            };
          if (args[1] === "repos/fixture/app/actions/permissions")
            return {
              code: 1,
              stdout: "",
              stderr: "HTTP 403: setup administration denied"
            };
          throw new Error(`Unexpected command ${args}`);
        }
      });
      const coordinator = createGitHubAccountCoordinator({
        createExecutor: async () => executor,
        getActiveKeyringLogin: async () => login,
        switchKeyringAccount: async () => {
          throw new Error("Unexpected switch");
        },
        resetIdentityCache: () => {}
      });
      const accounts = createGitHubAccountResolvers({
        coordinator,
        ownerKey: "setup-guards",
        readIdentity: async () => ({ accounts: [] }),
        readinessOptions: { ports: { probePackageAccess: packageProbe } },
        redactDiagnostic: (value) => value
      });
      expect(
        await accounts.setup({
          target: { repo: "fixture/app", environment: "dev" },
          savedLogin: login,
          isCurrent: () => true
        })
      ).toMatchObject({
        state:
          kind === "installation" ? "unavailable" : "reauthorization-required"
      });
      expect(packageProbe).not.toHaveBeenCalled();
    }
  );

  it("reads the host choice lazily for both policies", async () => {
    let choice = "first";
    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async (login) =>
        successfulSelectedGhExecutor({
          login,
          requiresKeyringSwitch: false,
          run: async (args) => {
            if (args.join(" ") !== "api repos/fixture/app")
              throw new Error(`Unexpected ${args}`);
            return {
              code: 0,
              stdout: '{"permissions":{"admin":true,"push":true}}',
              stderr: ""
            };
          }
        }),
      getActiveKeyringLogin: async () => "first",
      switchKeyringAccount: async () => {
        throw new Error("Unexpected switch");
      },
      resetIdentityCache: () => {}
    });
    const accounts = createGitHubAccountResolvers({
      coordinator,
      ownerKey: "lazy-host",
      readIdentity: async () => ({
        accounts: ["first", "second"].map((login) => ({
          login,
          hasWorkflow: true,
          hasPackages: true,
          switchable: true,
          acting: false
        }))
      }),
      get choose() {
        return async () => choice;
      },
      readinessOptions: {
        ports: {
          probePackageAccess: async () => ({
            ok: true,
            detail: "Fixture package grant"
          })
        }
      },
      redactDiagnostic: (value) => value
    });
    choice = "second";
    for (const resolve of [accounts.setup, accounts.deployment])
      expect(
        await resolve({
          target: { repo: "fixture/app", environment: "dev" },
          isCurrent: () => true
        })
      ).toMatchObject({ state: "selected", login: "second" });
  });

  it("admits an existing-environment writer without setup or package permissions", async () => {
    const run = vi.fn(async (args: string[]) => {
      if (args.join(" ") !== "api repos/fixture/app")
        throw new Error(`Unexpected command: ${args.join(" ")}`);
      return {
        code: 0,
        stdout: JSON.stringify({ permissions: { admin: false, push: true } }),
        stderr: ""
      };
    });
    const executor = successfulSelectedGhExecutor({
      login: "writer",
      scopes: ["repo", "workflow"],
      run
    });
    const keyringRead = vi.fn(async () => "writer");
    const switchAccount = vi.fn(async (): Promise<never> => {
      throw new Error("Unexpected keyring switch");
    });
    const coordinator = createGitHubAccountCoordinator({
      createExecutor: async () => executor,
      getActiveKeyringLogin: keyringRead,
      switchKeyringAccount: switchAccount,
      resetIdentityCache: () => {}
    });
    const accounts = createGitHubAccountResolvers({
      readIdentity: async () => ({ accounts: [] }),
      coordinator,
      ownerKey: "permission-regression",
      redactDiagnostic: (value) => value
    });
    expect(
      await accounts.deployment({
        target: { repo: "fixture/app", environment: "dev" },
        savedLogin: "writer",
        isCurrent: () => true
      })
    ).toMatchObject({ state: "selected", login: "writer" });
    expect(keyringRead).not.toHaveBeenCalled();
    expect(switchAccount).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledExactlyOnceWith(["api", "repos/fixture/app"], {
      timeout: 15000
    });
    expect(
      await accounts.setup({
        target: { repo: "fixture/app", environment: "dev" },
        savedLogin: "writer",
        isCurrent: () => true
      })
    ).toMatchObject({
      state: "reauthorization-required",
      message: expect.stringContaining("cannot administer")
    });
  });
});
