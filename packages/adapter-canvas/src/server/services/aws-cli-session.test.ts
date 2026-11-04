import { describe, expect, it } from "vitest";
import {
  verifyAwsCliSession,
  type AwsCommandResult
} from "./aws-cli-session.js";

const ACCOUNT = "123456789012";
const ok = (stdout: string): AwsCommandResult => ({
  code: 0,
  stdout,
  stderr: ""
});

function session(
  options: {
    accountId?: string;
    region?: string;
    version?: AwsCommandResult;
    identity?: AwsCommandResult;
  } = {}
) {
  const calls: string[][] = [];
  const result = verifyAwsCliSession(
    {
      accountId: options.accountId ?? ACCOUNT,
      ...(options.region !== undefined ? { region: options.region } : {})
    },
    async (args) => {
      calls.push(args);
      if (args[0] === "--version") {
        expect(args).toEqual(["--version"]);
        return options.version ?? ok("aws-cli/2.39.0 Python/3.13");
      }
      expect(args).toEqual([
        "sts",
        "get-caller-identity",
        "--output",
        "json",
        ...(options.region ? ["--region", options.region.trim()] : [])
      ]);
      return (
        options.identity ??
        ok(
          JSON.stringify({
            Account: ACCOUNT,
            Arn: `arn:aws:iam::${ACCOUNT}:user/example`
          })
        )
      );
    }
  );
  return { calls, result };
}

describe("verifyAwsCliSession", () => {
  it("uses the requested region and trims identifiers", async () => {
    const { result } = session({
      accountId: ` ${ACCOUNT} `,
      region: " us-east-2 "
    });
    expect(await result).toEqual({
      ok: true,
      accountId: ACCOUNT,
      arn: `arn:aws:iam::${ACCOUNT}:user/example`,
      user: "example",
      version: "2.39.0"
    });
  });

  it.each(["", "123", "12345678901", "not-an-account"])(
    "rejects account %j before executing the CLI",
    async (accountId) => {
      const { result, calls } = session({ accountId });
      expect(await result).toMatchObject({
        ok: false,
        code: "aws-account-invalid"
      });
      expect(calls).toEqual([]);
    }
  );

  it.each(["", "--debug", "not-a-region"])(
    "rejects region %j before executing the CLI",
    async (region) => {
      const { result, calls } = session({ region });
      expect(await result).toMatchObject({
        ok: false,
        code: "aws-region-invalid"
      });
      expect(calls).toEqual([]);
    }
  );

  it("accepts a CLI version reported on stderr", async () => {
    expect(
      await session({
        version: { code: 0, stdout: "", stderr: "aws-cli/2.15.3" }
      }).result
    ).toMatchObject({ ok: true, version: "2.15.3" });
  });

  it.each([
    { code: "ENOENT", stdout: "", stderr: "spawn aws ENOENT" },
    { code: 1, stdout: "", stderr: "", timedOut: true },
    ok("aws-cli/2.15.2"),
    ok("credential_process printed private diagnostics")
  ])("stops an unavailable or unsupported CLI before STS", async (version) => {
    const { calls, result } = session({ version });
    expect(await result).toMatchObject({
      ok: false,
      code: "aws-cli-unsupported",
      message: expect.stringContaining("2.15.3"),
      remediation: { id: "aws-cli-install" }
    });
    expect(JSON.stringify(await result)).not.toContain("private diagnostics");
    expect(calls).toEqual([["--version"]]);
  });

  it.each([
    "null",
    "[]",
    "not json",
    "{}",
    '{"Account":123456789012}',
    '{"Account":"12345678901"}'
  ])("rejects malformed STS output %s", async (stdout) => {
    expect(await session({ identity: ok(stdout) }).result).toMatchObject({
      ok: false,
      code: "aws-identity-invalid"
    });
  });

  it.each([undefined, 42, ""])(
    "uses the account if the ARN is absent or invalid",
    async (Arn) => {
      expect(
        await session({
          identity: ok(JSON.stringify({ Account: ACCOUNT, Arn }))
        }).result
      ).toMatchObject({ ok: true, accountId: ACCOUNT, user: ACCOUNT, arn: "" });
    }
  );

  it("names both accounts on mismatch", async () => {
    expect(await session({ accountId: "999988887777" }).result).toMatchObject({
      ok: false,
      code: "aws-account-mismatch",
      sessionAccountId: ACCOUNT,
      accountId: "999988887777",
      message: expect.stringContaining(ACCOUNT)
    });
  });

  it("falls back to the verified account when the ARN has no final identity segment", async () => {
    expect(
      await session({
        identity: ok(
          JSON.stringify({
            Account: ACCOUNT,
            Arn: `arn:aws:iam::${ACCOUNT}:user/`
          })
        )
      }).result
    ).toMatchObject({ ok: true, user: ACCOUNT });
  });

  it.each([
    "Unable to locate credentials",
    "NoCredentialsError",
    "SSOTokenLoadError",
    "Error loading SSO Token",
    "Error when retrieving token from sso: Token has expired and refresh failed",
    "The SSO session associated with this profile has expired"
  ])("offers sign-in for %s", async (stderr) => {
    expect(
      await session({ identity: { code: 254, stdout: "", stderr } }).result
    ).toMatchObject({
      ok: false,
      code: "aws-cli-login-required",
      remediation: { id: "aws-cli-login" }
    });
  });

  it.each([
    ["ExpiredToken", "expired"],
    ["Token has expired", "expired"],
    ["The security token included in the request is expired", "expired"],
    ["InvalidClientTokenId", "rejected"],
    ["The security token included in the request is invalid", "rejected"],
    ["AccessDenied", "denied"],
    [
      "credential_process failed: private provider output",
      "credential provider failed"
    ],
    [
      "Error when retrieving credentials from custom-process: credential-helper: command not found",
      "credential provider failed"
    ],
    ["MFA prompt failed", "credential provider failed"],
    ["Read timeout", "timed out"],
    ["endpoint unavailable: private provider output", "verification failed"]
  ])(
    "does not offer SSO or expose provider output for %s",
    async (stderr, message) => {
      const result = await session({
        identity: { code: 254, stdout: "", stderr }
      }).result;
      expect(result).toMatchObject({
        ok: false,
        code: "aws-verification-failed",
        message: expect.stringContaining(message)
      });
      expect(result).not.toHaveProperty("remediation");
      expect(JSON.stringify(result)).not.toContain("private provider output");
    }
  );

  it("labels subprocess timeouts even without stderr", async () => {
    expect(
      await session({
        identity: { code: 1, stdout: "", stderr: "", timedOut: true }
      }).result
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("timed out")
    });
  });
});
