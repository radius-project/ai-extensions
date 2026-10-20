import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectedGhExecutor } from "../../src/gh.js";
import { readContractConfig, withAppExecutor, withCleanup } from "./support.js";

const env = {
  GITHUB_CONTRACT_REPOSITORY: "example/contract-sandbox",
  GITHUB_CONTRACT_ALLOWLIST: "example/contract-sandbox",
  GITHUB_CONTRACT_APP_LOGIN: "contract-app[bot]",
  GITHUB_CONTRACT_SETUP_TOKEN: "setup-fixture",
  GITHUB_CONTRACT_MASKED_TOKEN: "masked-fixture",
  GITHUB_CONTRACT_RESTRICTED_TOKEN: "restricted-fixture"
};

describe("live GitHub safety configuration", () => {
  it("requires every field without exposing values", () => {
    for (const name of Object.keys(env)) {
      expect(() => readContractConfig({ ...env, [name]: "" })).toThrow(name);
    }
    expect(readContractConfig(env).repo).toBe("example/contract-sandbox");
  });

  it.each([
    { GITHUB_CONTRACT_REPOSITORY: "example/../unsafe" },
    { GITHUB_CONTRACT_ALLOWLIST: "example/different" },
    {
      GITHUB_CONTRACT_REPOSITORY: "radius-project/ai-extensions",
      GITHUB_CONTRACT_ALLOWLIST: "radius-project/ai-extensions"
    },
    { AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY: "EXAMPLE/contract-sandbox" },
    { GITHUB_CONTRACT_APP_LOGIN: "personal-user" }
  ])("rejects unsafe configuration %j", (override) => {
    expect(() => readContractConfig({ ...env, ...override })).toThrow();
  });
});

describe("live resource cleanup", () => {
  it("cleans up after success and returns the result", async () => {
    const calls: string[] = [];
    await expect(
      withCleanup(
        async () => 42,
        async () => {
          calls.push("cleanup");
        }
      )
    ).resolves.toBe(42);
    expect(calls).toEqual(["cleanup"]);
  });

  describe("live credential isolation", () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each(["success", "body failure", "credential failure", "stored login"])(
      "removes ambient credentials and restores the environment after %s",
      async (scenario) => {
        const names = [
          "GH_TOKEN",
          "GITHUB_TOKEN",
          "GH_PACKAGES_TOKEN",
          "GH_PACKAGES_USER",
          "GH_HOST",
          "GH_CONFIG_DIR",
          "GH_DEBUG"
        ];
        for (const name of names) vi.stubEnv(name, `ambient-${name}`);
        let directory = "";
        let entered = false;
        const unsupported = (): never => {
          throw new Error("Unspecified executor operation");
        };
        const executor: SelectedGhExecutor = {
          login: env.GITHUB_CONTRACT_APP_LOGIN,
          credentialSource:
            scenario === "stored login" ? "keyring" : "injected",
          requiresKeyringSwitch: false,
          scopes: [],
          run: unsupported,
          runOrThrow: unsupported,
          verifyIdentity: unsupported,
          packageCredentials: unsupported,
          redact: unsupported,
          errorMessage: unsupported
        };
        const result = withAppExecutor(
          readContractConfig(env),
          "installation-fixture",
          async (selected) => {
            entered = true;
            expect(selected).toBe(executor);
            if (scenario === "body failure") throw new Error("body failure");
            return 42;
          },
          async (login) => {
            expect(login).toBe(env.GITHUB_CONTRACT_APP_LOGIN);
            expect(process.env.GH_TOKEN).toBe("installation-fixture");
            for (const name of names.filter(
              (name) => name !== "GH_TOKEN" && name !== "GH_CONFIG_DIR"
            )) {
              expect(process.env[name]).toBeUndefined();
            }
            directory = process.env.GH_CONFIG_DIR || "";
            expect(existsSync(directory)).toBe(true);
            if (scenario === "credential failure") {
              throw new Error("credential failure");
            }
            return executor;
          }
        );
        if (scenario === "success") await expect(result).resolves.toBe(42);
        else await expect(result).rejects.toThrow();
        expect(entered).toBe(
          scenario === "success" || scenario === "body failure"
        );
        expect(existsSync(directory)).toBe(false);
        for (const name of names) {
          expect(process.env[name]).toBe(`ambient-${name}`);
        }
      }
    );

    it("does not leave newly set credential values in the environment", async () => {
      vi.stubEnv("GH_TOKEN", undefined);
      vi.stubEnv("GH_CONFIG_DIR", undefined);
      await expect(
        withAppExecutor(
          readContractConfig(env),
          "installation-fixture",
          async () => {},
          async () => {
            throw new Error("unavailable");
          }
        )
      ).rejects.toThrow("unavailable");
      expect(process.env.GH_TOKEN).toBeUndefined();
      expect(process.env.GH_CONFIG_DIR).toBeUndefined();
    });
  });

  it("retains the primary failure", async () => {
    const primary = new Error("contract failed");
    let cleaned = false;
    await expect(
      withCleanup(
        async () => {
          throw primary;
        },
        async () => {
          cleaned = true;
        }
      )
    ).rejects.toBe(primary);
    expect(cleaned).toBe(true);
  });

  it("reports both failures without hiding either", async () => {
    const errors = [new Error("contract"), new Error("cleanup")];
    await expect(
      withCleanup(
        async () => {
          throw errors[0];
        },
        async () => {
          throw errors[1];
        }
      )
    ).rejects.toMatchObject({ errors });
  });

  it("fails when cleanup alone fails", async () => {
    await expect(
      withCleanup(
        async () => 42,
        async () => {
          throw new Error("cleanup");
        }
      )
    ).rejects.toThrow("cleanup");
  });
});
