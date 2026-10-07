const MIN_OPAQUE_CREDENTIAL_LENGTH = 12;
const REDACTED = "[REDACTED]";

const RECOGNIZABLE_CREDENTIAL_PATTERNS = [
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
] as const;

const NAMED_CREDENTIAL_PATTERN =
  /(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|federated[_-]?token|password)(\\*["'])?\s*[:=]/gi;

interface QuoteContext {
  cursor: number;
  backslashes: number;
  delimiters: number[];
}

function enclosingEscapeScale(
  value: string,
  end: number,
  context: QuoteContext
): number {
  for (; context.cursor < end; context.cursor++) {
    const character = value[context.cursor];
    if (character === "\n" || character === "\r") {
      context.delimiters.length = 0;
      context.backslashes = 0;
      continue;
    }
    if (character === "\\") {
      context.backslashes++;
      continue;
    }
    if (character === '"') {
      let delimiter = context.delimiters.at(-1);
      // A shallower closing quote also ends an incomplete nested string.
      while (delimiter !== undefined && context.backslashes < delimiter) {
        context.delimiters.pop();
        delimiter = context.delimiters.at(-1);
      }
      if (
        delimiter !== undefined &&
        (context.backslashes - delimiter) % (2 * (delimiter + 1)) === 0
      )
        context.delimiters.pop();
      else context.delimiters.push(context.backslashes);
    }
    context.backslashes = 0;
  }
  const delimiter = context.delimiters.at(-1);
  return delimiter === undefined ? 1 : 2 * (delimiter + 1);
}

function redactNamedCredentials(value: string): string {
  let result = "";
  let consumed = 0;
  const context: QuoteContext = {
    cursor: 0,
    backslashes: 0,
    delimiters: []
  };
  for (const match of value.matchAll(NAMED_CREDENTIAL_PATTERN)) {
    if (match.index < consumed) continue;
    let start = match.index + match[0].length;
    while (/\s/.test(value.charAt(start))) start++;
    const enclosingScale = enclosingEscapeScale(value, start, context);
    const keyDelimiter = match[1];
    const scale = Math.max(
      enclosingScale,
      keyDelimiter?.endsWith('"') ? keyDelimiter.length : 1
    );
    const bareStart = start;
    let encodedWhitespace = false;
    while (start < value.length) {
      if (/\s/.test(value.charAt(start))) {
        start++;
        continue;
      }
      let end = start;
      while (value[end] === "\\") end++;
      if (
        scale > 1 &&
        end - start === scale / 2 &&
        /[nrt]/.test(value.charAt(end))
      ) {
        start = end + 1;
        encodedWhitespace = true;
        continue;
      }
      break;
    }
    let quoteIndex = start;
    while (value[quoteIndex] === "\\") quoteIndex++;
    // Encoded whitespace is structural only when a value delimiter follows.
    // Otherwise it belongs to an unquoted credential, including its slashes.
    if (
      encodedWhitespace &&
      !(
        (value[quoteIndex] === "'" && quoteIndex === start) ||
        (value[quoteIndex] === '"' && quoteIndex - start === scale - 1)
      )
    ) {
      start = bareStart;
      quoteIndex = start;
      while (value[quoteIndex] === "\\") quoteIndex++;
    }
    const quote = value[quoteIndex];
    if (quote === '"' || quote === "'") {
      const delimiter = value.slice(start, quoteIndex + 1);
      const escapeCount = quoteIndex - start;
      // Apostrophes are not escaped by JSON serialization; their opening
      // delimiter alone cannot establish the encoded backslash width.
      const escapeScale = Math.max(scale, escapeCount + 1);
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
          (backslashes - escapeCount) % (2 * escapeScale) === 0
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
    // Quoted credential contents are opaque to the enclosing-context scanner.
    // Raw line boundaries still terminate any enclosing serialized string.
    for (; context.cursor < consumed; context.cursor++) {
      if (value[context.cursor] === "\n" || value[context.cursor] === "\r")
        context.delimiters.length = 0;
    }
    context.backslashes = 0;
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
