import { appendFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  findAwsLeftovers,
  resolveAwsCleanupConfig,
  sweepAwsCloudE2E,
  type AwsCleanupConfig,
  type AwsCleanupPorts
} from "./aws-cloud-cleanup.js";
import {
  mintGitHubAppToken,
  readGitHubAppTokenConfig,
  type GitHubAppTokenConfig
} from "./github-app-token.js";
import {
  AWS_CLEANUP_APP_TOKEN_PERMISSIONS,
  createAppTokenSource,
  createAwsCleanupAccessRemoval,
  createGhCleanupGitHub,
  createKubectlCleanupKubernetes,
  ghJsonRunner,
  ghNamespaceClaims,
  runCommand,
  temporaryDirectory,
  type CommandResult,
  type CommandRunner
} from "./aws-cloud-cleanup-ports.js";

// The entry point purge-aws runs. The workflow bundles it with esbuild,
// because it imports the product's removal code, which plain `node` can't
// load. `sweep` reclaims leaked state; `verify` only reports what is left.

export interface AwsCleanupMainDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly run: CommandRunner;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  // Mint a fixture installation token with the GitHub App's credentials.
  mintAppToken(
    config: GitHubAppTokenConfig,
    permissions: Readonly<Record<string, string>>
  ): Promise<string>;
  log(line: string): void;
  summary(markdown: string): Promise<void>;
}

export function createAwsCleanupPorts(
  config: AwsCleanupConfig,
  dependencies: AwsCleanupMainDependencies
): AwsCleanupPorts {
  const { env, run, sleep, now } = dependencies;
  // In CI the App's credentials are set, and the token is renewed before it
  // expires. A local run uses the GH_TOKEN it was given.
  const app = readGitHubAppTokenConfig({
    ...env,
    AIEXT_CLOUD_E2E_FIXTURE_REPOSITORY: config.repository
  });
  const fixtureToken =
    app ?
      createAppTokenSource({
        initial: env.GH_TOKEN ?? "",
        mint: () =>
          dependencies.mintAppToken(app, AWS_CLEANUP_APP_TOKEN_PERMISSIONS),
        now
      })
    : async () => env.GH_TOKEN ?? "";
  const gh = async (
    args: readonly string[],
    packages = false
  ): Promise<CommandResult> => {
    let token: string;
    try {
      token = packages ? (env.GH_PACKAGES_TOKEN ?? "") : await fixtureToken();
    } catch (error) {
      return {
        code: 1,
        stdout: "",
        stderr: `Could not renew the GitHub App token: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    return run("gh", args, { env: { GH_TOKEN: token } });
  };
  const runAws = (args: string[]) => run("aws", args);
  return {
    runAws,
    github: createGhCleanupGitHub({
      repository: config.repository,
      defaultBranch: (env.DEFAULT_BRANCH ?? "").trim() || "main",
      gh,
      sleep,
      now
    }),
    kubernetes: createKubectlCleanupKubernetes({
      run,
      directory: temporaryDirectory("aws-cleanup-")
    }),
    removeAccess: createAwsCleanupAccessRemoval({
      repository: config.repository,
      runAws,
      runGitHubJson: ghJsonRunner((args) => gh(args)),
      environments: ghNamespaceClaims((args) => gh(args)),
      sleep,
      now
    }),
    sleep,
    now,
    log: dependencies.log
  };
}

function list(title: string, lines: readonly string[]): string {
  return lines.length === 0 ?
      ""
    : `### ${title}\n\n${lines.map((line) => `- ${line}`).join("\n")}\n\n`;
}

/** Run one mode and return the process exit code. */
export async function runAwsCleanup(
  mode: string | undefined,
  dependencies: AwsCleanupMainDependencies
): Promise<number> {
  const { log } = dependencies;
  if (mode !== "sweep" && mode !== "verify") {
    log(
      `::error::Usage: aws-cloud-cleanup-main (sweep|verify). Got "${mode ?? ""}".`
    );
    return 2;
  }
  let config: AwsCleanupConfig | null;
  let ports: AwsCleanupPorts;
  try {
    config = resolveAwsCleanupConfig(dependencies.env, dependencies.now());
    if (!config) {
      log(
        "::notice::The AWS Cloud E2E variables are not set, so there is no AWS state to reclaim."
      );
      return 0;
    }
    ports = createAwsCleanupPorts(config, dependencies);
  } catch (error) {
    log(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (mode === "sweep") {
    const report = await sweepAwsCloudE2E(config, ports);
    await dependencies.summary(
      list("AWS cleanup", report.done) +
        list("AWS cleanup warnings", report.warnings) +
        list("AWS cleanup failures", report.failures)
    );
    return report.failures.length > 0 ? 1 : 0;
  }
  const { findings, warnings } = await findAwsLeftovers(config, ports);
  for (const line of warnings) log(`::warning::${line}`);
  if (findings.length > 0) {
    log(
      "::error::Leaked AWS state remains, so the fixture branch is not reset. To delete it whatever its age, run this workflow with max_age_hours=0. See docs/eng/CLOUD_E2E_RUNBOOK.md."
    );
    for (const line of findings) log(`  - ${line}`);
    await dependencies.summary(
      list("Leaked AWS state blocks the fixture reset", findings)
    );
    return 1;
  }
  await dependencies.summary(
    "- Verified: no RDS resource, app boundary, workload, namespace, node, lock, or deploy-role grant of the AWS stage remains\n"
  );
  return 0;
}

// Run only as the process entry point, so tests can import this module.
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  process.exitCode = await runAwsCleanup(process.argv[2], {
    env: process.env,
    run: runCommand,
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now: () => Date.now(),
    mintAppToken: (config, permissions) =>
      mintGitHubAppToken(config, undefined, permissions),
    log: (line) => console.log(line),
    summary: async (markdown) => {
      if (summaryFile && markdown) await appendFile(summaryFile, markdown);
    }
  });
}
