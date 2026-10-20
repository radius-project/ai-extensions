import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSelectedGhExecutor,
  resetGhIdentityCache,
  type SelectedGhExecutor
} from "../../src/gh.js";

export interface ContractConfig {
  repo: string;
  login: string;
  setupToken: string;
  maskedToken: string;
  restrictedToken: string;
}

export function readContractConfig(env: NodeJS.ProcessEnv): ContractConfig {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Required live GitHub configuration: ${name}`);
    return value;
  };
  const repo = required("GITHUB_CONTRACT_REPOSITORY");
  if (
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
    repo.toLowerCase() !==
      required("GITHUB_CONTRACT_ALLOWLIST").toLowerCase() ||
    repo.toLowerCase() === "radius-project/ai-extensions" ||
    repo.toLowerCase() === env.AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY?.toLowerCase()
  ) {
    throw new Error("The live GitHub sandbox must be separately allowlisted.");
  }
  const login = required("GITHUB_CONTRACT_APP_LOGIN");
  if (!/^[A-Za-z0-9-]+\[bot\]$/.test(login)) {
    throw new Error("The live GitHub credential must select an App bot.");
  }
  return {
    repo,
    login,
    setupToken: required("GITHUB_CONTRACT_SETUP_TOKEN"),
    maskedToken: required("GITHUB_CONTRACT_MASKED_TOKEN"),
    restrictedToken: required("GITHUB_CONTRACT_RESTRICTED_TOKEN")
  };
}

export async function withCleanup<T>(
  body: () => Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (primary) {
    try {
      await cleanup();
    } catch (secondary) {
      throw new AggregateError(
        [primary, secondary],
        "Live GitHub contract failed; cleanup also failed. Inspect both errors.",
        { cause: secondary }
      );
    }
    throw primary;
  }
  await cleanup();
  return result;
}

export async function withAppExecutor<T>(
  config: ContractConfig,
  token: string,
  body: (executor: SelectedGhExecutor) => Promise<T>,
  createExecutor: typeof createSelectedGhExecutor = createSelectedGhExecutor
): Promise<T> {
  const names = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_PACKAGES_TOKEN",
    "GH_PACKAGES_USER",
    "GH_HOST",
    "GH_CONFIG_DIR",
    "GH_DEBUG"
  ];
  const saved = names.map((name) => [name, process.env[name]] as const);
  const directory = mkdtempSync(join(tmpdir(), "radius-gh-contract-"));
  return withCleanup(
    async () => {
      for (const name of names) delete process.env[name];
      process.env.GH_CONFIG_DIR = directory;
      process.env.GH_TOKEN = token;
      resetGhIdentityCache();
      const executor = await createExecutor(config.login);
      if (executor.credentialSource !== "injected") {
        throw new Error("Live contracts must not use stored credentials.");
      }
      return await body(executor);
    },
    async () => {
      resetGhIdentityCache();
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  );
}
