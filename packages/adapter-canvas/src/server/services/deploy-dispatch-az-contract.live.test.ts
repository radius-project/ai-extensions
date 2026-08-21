// Opt-in live contract test. Runs the REAL `az` CLI with the argument list the
// Azure OIDC deploy preflight builds and asserts the CLI accepts it.
//
// Why this matters: the preflight's unit tests drive a fake `runAz`, so they
// pin the argument list without anything checking that `az` understands it.
// That is exactly how a `--tenant` flag survived review and full branch
// coverage: `az ad app federated-credential list` rejects it with "unrecognized
// arguments", so the check failed every time, always reported "unverified", and
// never blocked anything — a green suite guarding nothing.
//
// The assertion is deliberately parse-level. It needs no Azure login, no
// credentials, and no cloud resources: an unauthenticated `az` still parses its
// arguments first, so an argument the CLI does not know is distinguishable from
// a call it understood but could not complete. The client id below is the
// all-zero UUID, which names nothing.
//
// This shells out to a tool that is not present on every machine, so it is NOT
// part of the default hermetic suite. The live upstream workflow sets
// RUN_LIVE_AZ_CLI_TESTS on pull requests, pushes to main, and nightly.
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { buildFederatedCredentialListArgs } from "./deploy-dispatch.js";

const LIVE = !!process.env.RUN_LIVE_AZ_CLI_TESTS;

const PLACEHOLDER_CLIENT_ID = "00000000-0000-0000-0000-000000000000";

interface AzResult {
  code: number | string;
  stdout: string;
  stderr: string;
}

function runAz(args: string[]): Promise<AzResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "az",
      args,
      { timeout: 60_000, shell: process.platform === "win32" },
      (error, stdout, stderr) => {
        resolve({
          code: error ? error.code || 1 : 0,
          stdout: stdout || "",
          stderr: stderr || ""
        });
      }
    );
    child.stdin?.end();
  });
}

describe.skipIf(!LIVE)(
  "live az federated-credential argument contract (opt-in: set RUN_LIVE_AZ_CLI_TESTS)",
  () => {
    it("az is available to check the contract against", async () => {
      const result = await runAz(["version"]);
      expect(
        result.code,
        `az version failed: ${result.stderr || result.stdout}`
      ).toBe(0);
    }, 60_000);

    it("accepts every argument the deploy preflight passes", async () => {
      const result = await runAz(
        buildFederatedCredentialListArgs(PLACEHOLDER_CLIENT_ID)
      );
      const output = `${result.stderr}\n${result.stdout}`;
      // Argument parsing happens before authentication, so an argparse
      // rejection is proof the preflight builds a command `az` cannot run,
      // whatever the sign-in state of the machine.
      expect(
        output,
        `az rejected the preflight arguments: ${output.trim()}`
      ).not.toMatch(
        /unrecognized arguments|invalid choice|expected one argument/i
      );
      expect(output).not.toMatch(/--tenant/);
    }, 60_000);
  }
);
