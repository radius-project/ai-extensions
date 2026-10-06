const MIN_OPAQUE_CREDENTIAL_LENGTH = 12;
const REDACTED = "[REDACTED]";

const RECOGNIZABLE_CREDENTIAL_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
] as const;

const NAMED_CREDENTIAL_PATTERN =
  /(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|federated[_-]?token|password)(?:\\*["'])?\s*[:=]\s*/gi;

function redactNamedCredentials(value: string): string {
  let result = "";
  let consumed = 0;
  for (const match of value.matchAll(NAMED_CREDENTIAL_PATTERN)) {
    if (match.index < consumed) continue;
    const start = match.index + match[0].length;
    let quoteIndex = start;
    while (value[quoteIndex] === "\\") quoteIndex++;
    const quote = value[quoteIndex];
    if (quote === '"' || quote === "'") {
      const delimiter = value.slice(start, quoteIndex + 1);
      const escapeCount = quoteIndex - start;
      let backslashes = 0;
      let end = quoteIndex + 1;
      for (; end < value.length; end++) {
        const character = value[end];
        if (character === "\\") {
          backslashes++;
          continue;
        }
        // Re-escaped embedded quotes differ from a close, including after a
        // trailing literal backslash, by one encoded backslash.
        if (
          character === quote &&
          backslashes >= escapeCount &&
          (backslashes - escapeCount) % (2 * (escapeCount + 1)) === 0
        )
          break;
        backslashes = 0;
      }
      result += value.slice(consumed, start) + delimiter + REDACTED;
      if (end < value.length) {
        result += delimiter;
        end++;
      }
      consumed = end;
    } else {
      let end = start;
      while (end < value.length && !/["',}\s]/.test(value.charAt(end))) end++;
      if (end === start) continue;
      result += value.slice(consumed, start) + REDACTED;
      consumed = end;
    }
  }
  return result + value.slice(consumed);
}

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
  return redactNamedCredentials(redacted);
}
