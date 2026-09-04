import { describe, expect, it, vi } from "vitest";
import { BARE_GH_COMMAND_PRESENTATION } from "../../gh-command-display.js";
import { createStatePackageDeletion } from "./state-package-deletion.js";

describe("createStatePackageDeletion", () => {
  it("derives the registry and refreshes package credentials for every attempt", async () => {
    const getCredentials = vi
      .fn()
      .mockResolvedValueOnce({
        username: "octocat",
        token: "first-token",
        source: "keyring",
        scopes: ["read:packages", "delete:packages"]
      })
      .mockResolvedValueOnce({
        username: "octocat",
        token: "refreshed-token",
        source: "keyring",
        scopes: ["read:packages", "delete:packages"]
      });
    const deletePackage = vi
      .fn()
      .mockRejectedValueOnce(new Error("missing delete:packages"))
      .mockResolvedValueOnce({
        outcome: "deleted",
        registry: "ghcr.io/octo/app-radius-state-dev"
      });
    const deleteStatePackage = createStatePackageDeletion({
      stateRegistryForEnvironment: (repo, environment) =>
        `ghcr.io/${repo}-radius-state-${environment}`,
      getCredentials,
      deletePackage,
      ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION
    });

    await expect(
      deleteStatePackage({ repo: "octo/app", environment: "dev" })
    ).rejects.toThrow("missing delete:packages");
    await expect(
      deleteStatePackage({ repo: "octo/app", environment: "dev" })
    ).resolves.toBe("deleted");

    expect(getCredentials).toHaveBeenNthCalledWith(1, { fresh: true });
    expect(getCredentials).toHaveBeenNthCalledWith(2, { fresh: true });
    expect(deletePackage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        targetRepository: "octo/app",
        registry: "ghcr.io/octo/app-radius-state-dev",
        credentials: expect.objectContaining({ token: "refreshed-token" }),
        ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION
      })
    );
  });

  it("maps a confirmed missing package to the service outcome", async () => {
    const deleteStatePackage = createStatePackageDeletion({
      stateRegistryForEnvironment: () => "ghcr.io/octo/state",
      getCredentials: async () => ({
        username: "octocat",
        token: "token",
        source: "keyring",
        scopes: ["read:packages", "delete:packages"]
      }),
      deletePackage: async () => ({
        outcome: "not_found",
        registry: "ghcr.io/octo/state"
      }),
      ghCommandPresentation: BARE_GH_COMMAND_PRESENTATION
    });

    await expect(
      deleteStatePackage({ repo: "octo/app", environment: "dev" })
    ).resolves.toBe("not_found");
  });
});
