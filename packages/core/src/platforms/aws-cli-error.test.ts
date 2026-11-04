import { describe, expect, it } from "vitest";
import { classifyAwsCliError } from "./aws-cli-error.js";

describe("classifyAwsCliError", () => {
  it.each([
    [
      "NoCredentialsError",
      'Unable to locate credentials. You can configure credentials by running "aws configure".'
    ],
    [
      "a missing SSOTokenLoadError token",
      "Error loading SSO Token: Token for my-sso does not exist"
    ],
    [
      "an invalid SSOTokenLoadError token",
      "Error loading SSO Token: The SSO token for my-sso is invalid"
    ],
    [
      "UnauthorizedSSOTokenError",
      "The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile."
    ],
    [
      "TokenRetrievalError",
      "Error when retrieving token from sso: Token has expired and refresh failed"
    ],
    [
      "ExpiredTokenException",
      "An error occurred (ExpiredTokenException) when calling the ListClusters operation: The security token included in the request is expired"
    ],
    ["an expired token message", "Token has expired"]
  ])("classifies %s as credentials", (_label, message) => {
    expect(classifyAwsCliError(message)).toBe("credentials");
  });

  it.each([
    [
      "AccessDeniedException",
      "An error occurred (AccessDeniedException) when calling the ListClusters operation: User: arn:aws:iam::123456789012:user/dev is not authorized to perform: eks:ListClusters"
    ],
    [
      "UnauthorizedOperation",
      "An error occurred (UnauthorizedOperation) when calling the DescribeRouteTables operation: You are not authorized to perform this operation."
    ],
    [
      "a bare authorization message",
      "User: arn:aws:sts::123456789012:assumed-role/dev/session is not authorized to perform: ec2:DescribeSubnets"
    ]
  ])("classifies %s as denied", (_label, message) => {
    expect(classifyAwsCliError(message)).toBe("denied");
  });

  it.each([
    [
      "UnrecognizedClientException",
      "An error occurred (UnrecognizedClientException) when calling the ListClusters operation: The security token included in the request is invalid."
    ],
    [
      "AuthFailure",
      "An error occurred (AuthFailure) when calling the DescribeSubnets operation: AWS was not able to validate the provided access credentials"
    ],
    [
      "InvalidClientTokenId",
      "An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid."
    ]
  ])("classifies %s as rejected", (_label, message) => {
    expect(classifyAwsCliError(message)).toBe("rejected");
  });

  it.each([
    [
      "a credential process failure that mentions an expired token",
      "Error when retrieving credentials from custom-process: Token has expired; run the helper again"
    ],
    [
      "a credential process failure that mentions a denial",
      "Error when retrieving credentials from custom-process: AccessDenied by the keychain"
    ],
    [
      "a timeout",
      'Connect timeout on endpoint URL: "https://eks.us-west-2.amazonaws.com/clusters"'
    ],
    ["an empty message", ""]
  ])("classifies %s as other", (_label, message) => {
    expect(classifyAwsCliError(message)).toBe("other");
  });
});
