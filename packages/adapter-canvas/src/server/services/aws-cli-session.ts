import {
  AWS_CLI_INSTALL_URL,
  AWS_CLI_MINIMUM_VERSION,
  checkAwsCliVersion,
  classifyAwsCliFailure,
  isAwsAccountId,
  isAwsRegion,
  remediationView,
  type AwsCliFailure,
  type RemediationView
} from "@radius-project/core";

export interface AwsCommandResult {
  code: number | string;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type AwsCliRunner = (args: string[]) => Promise<AwsCommandResult>;

export interface AwsSessionFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly remediation?: RemediationView;
  readonly sessionAccountId?: string;
  readonly accountId?: string;
}

export type AwsSessionResult =
  | AwsSessionFailure
  | {
      readonly ok: true;
      readonly accountId: string;
      readonly arn: string;
      readonly user: string;
      readonly version: string;
    };

const FAILURE_MESSAGES: Record<AwsCliFailure, string> = {
  "missing-cli": "The AWS CLI executable is not available.",
  timeout:
    "The AWS CLI call timed out. Check network access and refresh your configured credential provider, then retry.",
  "login-required":
    'No active AWS CLI session. Sign in with "aws sso login", or refresh your configured credential provider, then verify again.',
  "credentials-expired":
    "The AWS credentials have expired. Refresh your configured credential provider, then verify again.",
  "credentials-invalid":
    "AWS rejected the configured credentials. Check the selected AWS profile and refresh its credential provider, then verify again.",
  "access-denied":
    "AWS denied the identity check. Check the permissions of your current CLI session, then retry.",
  "provider-failed":
    "The AWS credential provider failed. Complete any sign-in or MFA in your terminal, then verify again.",
  "command-failed":
    "AWS CLI verification failed. Check network access and your configured credential provider, then retry."
};

function succeeded(result: AwsCommandResult): boolean {
  return result.code === 0 || result.code === "0";
}

function unsupportedVersion(message: string): AwsSessionFailure {
  return {
    ok: false,
    code: "aws-cli-unsupported",
    message,
    remediation: remediationView("aws-cli-install", {})
  };
}

export async function verifyAwsCliSession(
  input: { accountId: string; region?: string },
  runAws: AwsCliRunner
): Promise<AwsSessionResult> {
  const accountId = input.accountId.trim();
  const region = input.region?.trim();
  if (!isAwsAccountId(accountId)) {
    return {
      ok: false,
      code: "aws-account-invalid",
      message: "Enter the 12-digit AWS account ID, then verify again."
    };
  }
  if (region !== undefined && !isAwsRegion(region)) {
    return {
      ok: false,
      code: "aws-region-invalid",
      message: "Enter a valid AWS region, then verify again."
    };
  }
  const version = await runAws(["--version"]);
  if (!succeeded(version)) {
    const failure = classifyAwsCliFailure({
      output: `${version.code} ${version.stderr} ${version.stdout}`,
      timedOut: version.timedOut
    });
    return unsupportedVersion(
      `${FAILURE_MESSAGES[failure]} Radius needs AWS CLI ${AWS_CLI_MINIMUM_VERSION} or newer. Install or upgrade it: ${AWS_CLI_INSTALL_URL}`
    );
  }
  const versionCheck = checkAwsCliVersion(
    `${version.stdout} ${version.stderr}`.trim()
  );
  if (!versionCheck.ok) return unsupportedVersion(versionCheck.message);
  const result = await runAws([
    "sts",
    "get-caller-identity",
    "--output",
    "json",
    ...(region ? ["--region", region] : [])
  ]);
  if (!succeeded(result)) {
    const failure = classifyAwsCliFailure({
      output: `${result.stderr} ${result.stdout}`,
      timedOut: result.timedOut
    });
    return {
      ok: false,
      code:
        failure === "login-required" ?
          "aws-cli-login-required"
        : "aws-verification-failed",
      message: FAILURE_MESSAGES[failure],
      ...(failure === "login-required" ?
        { remediation: remediationView("aws-cli-login", {}) }
      : {})
    };
  }
  let identity: unknown;
  try {
    identity = JSON.parse(result.stdout);
  } catch {
    identity = null;
  }
  if (
    typeof identity !== "object" ||
    identity === null ||
    !("Account" in identity) ||
    typeof identity.Account !== "string" ||
    !isAwsAccountId(identity.Account)
  ) {
    return {
      ok: false,
      code: "aws-identity-invalid",
      message:
        "The AWS CLI did not return a valid account ID. Credentials were not verified. Check your credential provider, then retry."
    };
  }
  if (identity.Account !== accountId) {
    return {
      ok: false,
      code: "aws-account-mismatch",
      message: `Your AWS CLI session is signed in to account ${identity.Account}, but the requested account is ${accountId}. Nothing was changed. Sign in to account ${accountId}, or correct the account ID, then retry.`,
      sessionAccountId: identity.Account,
      accountId
    };
  }
  const arn =
    "Arn" in identity && typeof identity.Arn === "string" ? identity.Arn : "";
  return {
    ok: true,
    accountId,
    arn,
    user: arn ? arn.split("/").pop() || accountId : accountId,
    version: versionCheck.version
  };
}
