const MIN_OPAQUE_CREDENTIAL_LENGTH = 12;
const REDACTED = "[REDACTED]";

const RECOGNIZABLE_CREDENTIAL_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
] as const;

const NAMED_CREDENTIAL_PATTERN =
  /((?:access[_-]?token|refresh[_-]?token|client[_-]?secret|federated[_-]?token|password)["']?\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^"',}\s]+))/gi;

/**
 * Redacts recognizable credentials and opaque values known by the caller.
 *
 * Process boundaries provide the credentials present in their environment.
 * Short values are ignored so incidental words such as "token" are not
 * replaced throughout otherwise useful diagnostics.
 */
export function redactCredentials(
  value: string,
  opaqueCredentials: readonly (string | undefined)[] = []
): string {
  let redacted = value;
  for (const rawCredential of opaqueCredentials) {
    const credential = rawCredential?.trim();
    if (credential && credential.length >= MIN_OPAQUE_CREDENTIAL_LENGTH)
      redacted = redacted.replaceAll(credential, REDACTED);
  }
  for (const pattern of RECOGNIZABLE_CREDENTIAL_PATTERNS)
    redacted = redacted.replace(pattern, REDACTED);
  return redacted.replace(
    NAMED_CREDENTIAL_PATTERN,
    (
      _match,
      prefix: string,
      doubleQuoted: string | undefined,
      singleQuoted: string | undefined
    ) =>
      prefix +
      (doubleQuoted !== undefined ? `"${REDACTED}"`
      : singleQuoted !== undefined ? `'${REDACTED}'`
      : REDACTED)
  );
}
