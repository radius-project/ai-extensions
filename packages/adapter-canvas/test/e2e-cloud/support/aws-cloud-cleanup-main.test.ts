import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createAwsCleanupPorts,
  runAwsCleanup,
  type AwsCleanupMainDependencies
} from "./aws-cloud-cleanup-main.js";
import {
  AWS_CLEANUP_APP_TOKEN_PERMISSIONS,
  type CommandResult
} from "./aws-cloud-cleanup-ports.js";
import { resolveAwsCleanupConfig } from "./aws-cloud-cleanup.js";

const ACCOUNT = "123456789012";
const ENV = {
  FIXTURE_REPOSITORY: "octo/fixture",
  FIXTURE_APPLICATION: "cloud-e2e",
  RADIUS_ENVIRONMENT_NAMESPACE: "default-cloud-e2e",
  AWS_ENVIRONMENT_PREFIX: "radtest-aws-",
  MAX_AGE_HOURS: "6",
  AWS_TEST_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/ai-extensions-cloud-e2e`,
  AWS_MAIN_REGION: "us-east-2",
  AWS_MAIN_CLUSTER: "main",
  AWS_SECOND_REGION: "us-west-1",
  AWS_SECOND_CLUSTER: "second",
  GH_TOKEN: "app-token",
  GH_PACKAGES_TOKEN: "packages-token",
  DEFAULT_BRANCH: "main"
};

const OK = (value: unknown): CommandResult => ({
  code: 0,
  stdout: JSON.stringify(value),
  stderr: ""
});
const NOT_FOUND = (code: string): CommandResult => ({
  code: 254,
  stdout: "",
  stderr: `An error occurred (${code}) when calling the operation`
});

// An account with the two clusters and the deploy role, and nothing to
// clean, answered as the CLIs would.
function cli(account = ACCOUNT) {
  const calls: Array<{
    command: string;
    args: string[];
    env?: Record<string, string>;
  }> = [];
  const run = async (
    command: string,
    args: readonly string[],
    options?: { env?: Record<string, string> }
  ): Promise<CommandResult> => {
    calls.push({
      command,
      args: [...args],
      ...(options?.env ? { env: options.env } : {})
    });
    const line = `${command} ${args.join(" ")}`;
    if (line.startsWith("aws sts")) return OK({ Account: account });
    if (line.startsWith("aws eks describe-cluster"))
      return OK({ cluster: { resourcesVpcConfig: { vpcId: "vpc-1" } } });
    if (line.startsWith("aws rds describe-db-instances"))
      return OK({ DBInstances: [] });
    if (line.startsWith("aws rds describe-db-subnet-groups"))
      return OK({ DBSubnetGroups: [] });
    if (line.startsWith("aws rds describe-db-parameter-groups"))
      return OK({ DBParameterGroups: [] });
    if (line.startsWith("aws rds describe-db-snapshots"))
      return OK({ DBSnapshots: [] });
    if (line.startsWith("aws eks describe-nodegroup"))
      return OK({
        nodegroup: {
          status: "ACTIVE",
          scalingConfig: { minSize: 0, maxSize: 1, desiredSize: 0 }
        }
      });
    if (line.startsWith("aws iam get-policy")) return NOT_FOUND("NoSuchEntity");
    if (line.startsWith("aws iam get-role"))
      return OK({
        Role: {
          AssumeRolePolicyDocument: { Version: "2012-10-17", Statement: [] }
        }
      });
    if (line.startsWith("aws iam list-role-policies"))
      return OK({ PolicyNames: [] });
    if (line.startsWith("aws iam list-roles")) return OK({ Roles: [] });
    if (line.startsWith("aws iam list-policies")) return OK({ Policies: [] });
    if (line.startsWith("aws eks list-pod-identity-associations"))
      return OK({ associations: [] });
    if (line.startsWith("aws eks describe-access-entry"))
      return NOT_FOUND("ResourceNotFoundException");
    if (line.startsWith("aws eks update-kubeconfig")) return OK({});
    if (line.startsWith("kubectl") && args.includes("namespace"))
      return { code: 0, stdout: "", stderr: "" };
    if (line.startsWith("kubectl")) return OK({ items: [] });
    if (
      line.startsWith(
        "gh api --paginate --slurp repos/octo/fixture/environments"
      )
    )
      return OK([{ environments: [] }]);
    if (
      line.startsWith(
        "gh api --paginate --slurp repos/octo/fixture/deployments"
      )
    )
      return OK([[]]);
    if (line.startsWith("gh api repos/octo/fixture -H")) return OK({ id: 42 });
    if (line.startsWith("gh api users/octo"))
      return OK({ type: "Organization" });
    if (line.startsWith("gh api --paginate --slurp orgs/octo/packages"))
      return OK([[]]);
    throw new Error(`unexpected ${line}`);
  };
  return { run, calls };
}

function dependencies(
  env: Record<string, string | undefined>,
  run: AwsCleanupMainDependencies["run"]
) {
  const log: string[] = [];
  const summaries: string[] = [];
  // Sleeping moves the clock, so every wait reaches its deadline.
  let now = Date.parse("2026-11-14T02:23:00Z");
  return {
    log,
    summaries,
    deps: {
      env,
      run,
      sleep: async (milliseconds: number) => {
        now += milliseconds;
      },
      now: () => now,
      mintAppToken: async () => {
        throw new Error("No App token mint is expected.");
      },
      log: (line: string) => log.push(line),
      summary: async (markdown: string) => {
        summaries.push(markdown);
      }
    } satisfies AwsCleanupMainDependencies
  };
}

describe("runAwsCleanup", () => {
  it("sweeps and verifies an account with nothing to clean", async () => {
    const { run, calls } = cli();
    const sweep = dependencies(ENV, run);
    expect(await runAwsCleanup("sweep", sweep.deps)).toBe(0);
    expect(sweep.log.filter((line) => line.startsWith("::"))).toEqual([]);
    const verify = dependencies(ENV, run);
    expect(await runAwsCleanup("verify", verify.deps)).toBe(0);
    expect(verify.summaries.join("")).toContain("- Verified: no RDS resource");
    // GitHub reads use the App token, and package reads the package token.
    const gh = calls.filter((call) => call.command === "gh");
    expect(gh.find((call) => call.args.includes("users/octo"))?.env).toEqual({
      GH_TOKEN: "packages-token"
    });
    expect(
      gh.find((call) => call.args.some((arg) => arg.includes("environments")))
        ?.env
    ).toEqual({
      GH_TOKEN: "app-token"
    });
    expect(calls.some((call) => call.command === "kubectl")).toBe(true);
    // App roles are read under the repository's ID, which GitHub names.
    expect(
      calls.find((call) => call.args[1] === "list-roles")?.args.slice(2, 4)
    ).toEqual(["--path-prefix", "/radius/apps/42/"]);
  });

  it("still scales the node groups down when the repository's ID can't be read, and fails", async () => {
    const { run } = cli();
    const lines: string[] = [];
    const noRepository: AwsCleanupMainDependencies["run"] = async (
      command,
      args,
      options
    ) => {
      lines.push(`${command} ${args.slice(0, 2).join(" ")}`);
      if (args[1] === "repos/octo/fixture")
        return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
      // A run left the default node group up.
      if (args[1] === "describe-nodegroup" && args.includes("default"))
        return OK({
          nodegroup: {
            status: "ACTIVE",
            scalingConfig: { minSize: 0, maxSize: 2, desiredSize: 1 }
          }
        });
      if (args[1] === "update-nodegroup-config") return OK({});
      return run(command, args, options);
    };
    const sweep = dependencies(ENV, noRepository);
    expect(await runAwsCleanup("sweep", sweep.deps)).toBe(1);
    expect(sweep.log.filter((line) => line.startsWith("::"))).toEqual([
      "::error::No app role, Pod Identity association, or app boundary was swept, because the fixture repository's ID could not be read: Could not read the ID of octo/fixture (gh: Not Found (HTTP 404))."
    ]);
    expect(sweep.log).toContain(
      "Scaled node group default on main to zero from 1"
    );
    // The account is still checked before any other AWS call.
    expect(lines.find((line) => line.startsWith("aws "))).toBe(
      "aws sts get-caller-identity"
    );
    expect(lines).not.toContain("aws iam list-roles");

    const verify = dependencies(ENV, noRepository);
    expect(await runAwsCleanup("verify", verify.deps)).toBe(1);
    expect(verify.log).toContain(
      "  - Could not check app roles, Pod Identity associations, or app boundaries: Could not read the ID of octo/fixture (gh: Not Found (HTTP 404))."
    );
    expect(verify.log).toContain(
      "  - node group default on cluster main at 1 nodes"
    );
  });

  it("fails each mode with the findings in the log and the summary", async () => {
    const { run } = cli("999999999999");
    const sweep = dependencies(ENV, run);
    expect(await runAwsCleanup("sweep", sweep.deps)).toBe(1);
    expect(sweep.log).toEqual([
      `::error::AWS is signed in to account 999999999999, not ${ACCOUNT}. Nothing was changed.`
    ]);
    expect(sweep.summaries.join("")).toContain("### AWS cleanup failures");
    const verify = dependencies(ENV, run);
    expect(await runAwsCleanup("verify", verify.deps)).toBe(1);
    expect(verify.log[0]).toContain("::error::Leaked AWS state remains");
    expect(verify.summaries.join("")).toContain(
      "### Leaked AWS state blocks the fixture reset"
    );
  });

  it("fails verification on an app boundary, reading the repository's ID with the App token", async () => {
    const { run, calls } = cli();
    const boundary = `arn:aws:iam::${ACCOUNT}:policy/radius/apps/42/radtest-aws-1/b-1`;
    const withBoundary: AwsCleanupMainDependencies["run"] = async (
      command,
      args,
      options
    ) =>
      args[1] === "list-policies" ?
        OK({
          Policies: [
            {
              PolicyName: "b-1",
              Path: "/radius/apps/42/radtest-aws-1/",
              Arn: boundary
            }
          ]
        })
      : run(command, args, options);
    const { deps, log } = dependencies(ENV, withBoundary);
    expect(await runAwsCleanup("verify", deps)).toBe(1);
    expect(log.join("\n")).toContain(`permissions boundary ${boundary}`);
    expect(
      calls.find((call) => call.args.includes("repos/octo/fixture"))?.env
    ).toEqual({ GH_TOKEN: "app-token" });
  });

  it("logs a warning in each mode", async () => {
    const { run } = cli();
    const withSnapshot: AwsCleanupMainDependencies["run"] = async (
      command,
      args,
      options
    ) =>
      args[1] === "describe-db-snapshots" ?
        OK({
          DBSnapshots: [
            {
              DBSnapshotIdentifier: "rds-snapshot-x",
              DBSnapshotArn: `arn:aws:rds:${args[3]}:${ACCOUNT}:snapshot:rds-snapshot-x`,
              SnapshotType: "manual",
              VpcId: "vpc-1",
              TagList: []
            }
          ]
        })
      : run(command, args, options);
    for (const mode of ["sweep", "verify"]) {
      const { deps, log } = dependencies(ENV, withSnapshot);
      expect(await runAwsCleanup(mode, deps)).toBe(0);
      expect(
        log.some((line) =>
          line.startsWith("::warning::RDS DB snapshot rds-snapshot-x")
        )
      ).toBe(true);
    }
  });

  it("skips with a notice when the AWS variables are not set", async () => {
    const { deps, log } = dependencies(
      {
        ...ENV,
        AWS_TEST_ROLE_ARN: "",
        AWS_MAIN_REGION: "",
        AWS_MAIN_CLUSTER: "",
        AWS_SECOND_REGION: "",
        AWS_SECOND_CLUSTER: ""
      },
      async () => {
        throw new Error("nothing may run");
      }
    );
    expect(await runAwsCleanup("sweep", deps)).toBe(0);
    expect(log).toEqual([
      "::notice::The AWS Cloud E2E variables are not set, so there is no AWS state to reclaim."
    ]);
  });

  it("refuses a bad mode or a bad configuration", async () => {
    const bad = dependencies(ENV, cli().run);
    expect(await runAwsCleanup(undefined, bad.deps)).toBe(2);
    expect(bad.log[0]).toContain(
      "Usage: aws-cloud-cleanup-main (sweep|verify)"
    );
    const partial = dependencies({ ...ENV, AWS_SECOND_CLUSTER: "" }, cli().run);
    expect(await runAwsCleanup("verify", partial.deps)).toBe(1);
    expect(partial.log[0]).toContain("must be set together");
  });

  it("renews the App token for gh calls once the first one nears expiry", async () => {
    const clock = { now: Date.parse("2026-11-14T02:23:00Z") };
    const tokens: string[] = [];
    const mints: Array<Record<string, string>> = [];
    const { run } = cli();
    const deps: AwsCleanupMainDependencies = {
      ...dependencies(
        {
          ...ENV,
          CLOUD_E2E_BOT_CLIENT_ID: "Iv1.cleanup",
          CLOUD_E2E_BOT_INSTALLATION_ID: "42",
          CLOUD_E2E_BOT_PRIVATE_KEY: "key"
        },
        async (command, args, options) => {
          if (command === "gh") tokens.push(options?.env?.GH_TOKEN ?? "");
          return run(command, args, options);
        }
      ).deps,
      now: () => clock.now,
      mintAppToken: async (config, permissions) => {
        mints.push({ ...permissions, repository: config.repository });
        return `ghs_renewed_${mints.length}`;
      }
    };
    const ports = createAwsCleanupPorts(
      resolveAwsCleanupConfig(ENV, clock.now)!,
      deps
    );
    await ports.github.listEnvironments();
    clock.now += 2 * 60 * 60 * 1000;
    await ports.github.listEnvironments();
    expect(tokens).toEqual(["app-token", "ghs_renewed_1"]);
    expect(mints).toEqual([
      { ...AWS_CLEANUP_APP_TOKEN_PERMISSIONS, repository: "octo/fixture" }
    ]);
  });

  it.each([new Error("HTTP 401"), "HTTP 401"])(
    "answers a gh call with the reason when the App token can't be minted (%s)",
    async (failure) => {
      const { run } = cli();
      const deps: AwsCleanupMainDependencies = {
        ...dependencies(
          {
            ...ENV,
            GH_TOKEN: undefined,
            CLOUD_E2E_BOT_CLIENT_ID: "Iv1.cleanup",
            CLOUD_E2E_BOT_INSTALLATION_ID: "42",
            CLOUD_E2E_BOT_PRIVATE_KEY: "key"
          },
          run
        ).deps,
        mintAppToken: () => Promise.reject(failure)
      };
      const ports = createAwsCleanupPorts(
        resolveAwsCleanupConfig(ENV, 0)!,
        deps
      );
      await expect(ports.github.listEnvironments()).rejects.toThrow(
        "Could not renew the GitHub App token: HTTP 401"
      );
    }
  );

  it("verifies with a token it mints itself when it has only the App's credentials", async () => {
    const tokens: string[] = [];
    const mints: string[] = [];
    const { run } = cli();
    const verify = dependencies(
      {
        ...ENV,
        GH_TOKEN: undefined,
        CLOUD_E2E_BOT_CLIENT_ID: "Iv1.cleanup",
        CLOUD_E2E_BOT_INSTALLATION_ID: "42",
        CLOUD_E2E_BOT_PRIVATE_KEY: "key"
      },
      async (command, args, options) => {
        if (command === "gh") tokens.push(options?.env?.GH_TOKEN ?? "");
        return run(command, args, options);
      }
    );
    const deps: AwsCleanupMainDependencies = {
      ...verify.deps,
      mintAppToken: async (config) => {
        mints.push(config.repository);
        return "ghs_verify";
      }
    };
    expect(await runAwsCleanup("verify", deps)).toBe(0);
    expect(mints).toEqual(["octo/fixture"]);
    expect(tokens.length).toBeGreaterThan(0);
    expect(new Set(tokens)).toEqual(new Set(["ghs_verify"]));
  });

  it("sends an empty token when a local run has none", async () => {
    const { run, calls } = cli();
    const { deps } = dependencies(
      { ...ENV, GH_TOKEN: undefined, GH_PACKAGES_TOKEN: undefined },
      run
    );
    const ports = createAwsCleanupPorts(resolveAwsCleanupConfig(ENV, 0)!, deps);
    await ports.github.listEnvironments();
    await ports.github.listPackages();
    expect(
      calls.filter((call) => call.command === "gh").map((call) => call.env)
    ).toEqual([{ GH_TOKEN: "" }, { GH_TOKEN: "" }, { GH_TOKEN: "" }]);
  });

  it("fails before any call when the App credentials are set only in part", async () => {
    const { deps, log } = dependencies(
      { ...ENV, CLOUD_E2E_BOT_CLIENT_ID: "Iv1.cleanup" },
      async () => {
        throw new Error("nothing may run");
      }
    );
    expect(await runAwsCleanup("sweep", deps)).toBe(1);
    expect(log[0]).toContain("CLOUD_E2E_BOT_INSTALLATION_ID is required");
  });

  it("defaults the fixture branch to main", () => {
    const { run, calls } = cli();
    const ports = createAwsCleanupPorts(
      {
        repository: "octo/fixture",
        application: "a",
        namespace: "n",
        environmentPrefix: "radtest-aws-",
        accountId: ACCOUNT,
        clusters: [
          { region: "us-east-2", name: "main" },
          { region: "us-west-1", name: "second" }
        ],
        deployRoleName: "r",
        cutoff: "2026-01-01T00:00:00Z",
        operationId: "op"
      },
      dependencies(
        { ...ENV, DEFAULT_BRANCH: undefined, GH_TOKEN: undefined },
        run
      ).deps
    );
    expect(ports.github).toBeDefined();
    expect(calls).toEqual([]);
  });
});

describe("the bundled AWS cleanup entry point", () => {
  it("bundles into one file that plain node runs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "aws-cleanup-bundle-"));
    try {
      const outfile = path.join(directory, "aws-cloud-cleanup.mjs");
      // As purge-aws runs it: plain node, which strips the script's types.
      const script = fileURLToPath(
        new URL("./aws-cloud-cleanup-bundle.ts", import.meta.url)
      );
      expect(
        spawnSync(process.execPath, [script], { encoding: "utf8" }).status
      ).toBe(2);
      const bundled = spawnSync(process.execPath, [script, outfile], {
        encoding: "utf8"
      });
      expect(bundled.stderr).toBe("");
      expect(bundled.status).toBe(0);
      const run = (args: string[], env: Record<string, string>) =>
        spawnSync(process.execPath, [outfile, ...args], {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "", ...env }
        });
      const skipped = run(["sweep"], {});
      expect(skipped.stderr).toBe("");
      expect(skipped.stdout).toContain(
        "::notice::The AWS Cloud E2E variables are not set"
      );
      expect(skipped.status).toBe(0);
      const usage = run([], {});
      expect(usage.status).toBe(2);
      const invalid = run(["verify"], { ...ENV, AWS_MAIN_REGION: "us-west-2" });
      expect(invalid.stdout).toContain("other than us-west-2");
      expect(invalid.status).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
