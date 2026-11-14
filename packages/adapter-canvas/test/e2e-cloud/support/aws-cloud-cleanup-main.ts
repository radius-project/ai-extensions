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
  createAwsCleanupAccessRemoval,
  createGhCleanupGitHub,
  createKubectlCleanupKubernetes,
  ghJsonRunner,
  ghNamespaceClaims,
  runCommand,
  temporaryDirectory,
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
  log(line: string): void;
  summary(markdown: string): Promise<void>;
}

export function createAwsCleanupPorts(
  config: AwsCleanupConfig,
  dependencies: AwsCleanupMainDependencies
): AwsCleanupPorts {
  const { env, run, sleep, now } = dependencies;
  const gh = (args: readonly string[], packages = false) =>
    run("gh", args, {
      env: {
        GH_TOKEN: (packages ? env.GH_PACKAGES_TOKEN : env.GH_TOKEN) ?? ""
      }
    });
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
  try {
    config = resolveAwsCleanupConfig(dependencies.env, dependencies.now());
  } catch (error) {
    log(`::error::${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!config) {
    log(
      "::notice::The AWS Cloud E2E variables are not set, so there is no AWS state to reclaim."
    );
    return 0;
  }
  const ports = createAwsCleanupPorts(config, dependencies);
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
    "- Verified: no RDS resource, workload, namespace, node, lock, or deploy-role grant of the AWS stage remains\n"
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
    log: (line) => console.log(line),
    summary: async (markdown) => {
      if (summaryFile && markdown) await appendFile(summaryFile, markdown);
    }
  });
}
