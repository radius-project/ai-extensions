// Classify an AWS CLI failure by the text it writes to stderr, so a surface can
// say whether the identity lacks a permission, the CLI has no valid session,
// AWS rejected the credentials, or something else went wrong.

export type AwsCliErrorKind = "denied" | "credentials" | "rejected" | "other";

// Checked in order; the first rule with a matching text decides the kind. The
// texts come from the AWS CLI v2 exceptions CredentialRetrievalError,
// NoCredentialsError, SSOTokenLoadError, UnauthorizedSSOTokenError, and
// TokenRetrievalError, and from AWS service error codes.
const RULES: readonly {
  readonly kind: AwsCliErrorKind;
  readonly texts: readonly string[];
}[] = [
  // A credential process failed. `aws sso login` does not fix it, so the
  // surface shows the CLI's own text instead of offering a sign-in. This rule
  // comes first because the process's message can contain "Token has expired".
  { kind: "other", texts: ["Error when retrieving credentials from"] },
  {
    kind: "credentials",
    texts: [
      "Unable to locate credentials",
      "Error loading SSO Token",
      "The SSO session associated with this profile has expired or is otherwise invalid",
      "Error when retrieving token from sso",
      "ExpiredToken",
      "Token has expired"
    ]
  },
  {
    kind: "denied",
    texts: [
      "AccessDenied",
      "UnauthorizedOperation",
      "is not authorized to perform"
    ]
  },
  // A region that is not enabled for the account also answers this way.
  {
    kind: "rejected",
    texts: [
      "UnrecognizedClientException",
      "AuthFailure",
      "InvalidClientTokenId"
    ]
  }
];

/** The first matching rule's kind, or "other" when no rule matches. */
export function classifyAwsCliError(message: string): AwsCliErrorKind {
  const rule = RULES.find(({ texts }) =>
    texts.some((text) => message.includes(text))
  );
  return rule?.kind ?? "other";
}
