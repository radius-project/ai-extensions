// Canvas adapter — context-specific encoding for the values page renderers
// inject into inline browser scripts and link attributes.
//
// HTML escaping is not JavaScript escaping: `escapeHtml` leaves a backslash, a
// line terminator and a `</script` sequence intact, and each of those changes
// how the browser parses the surrounding script rather than the text it shows.
// Every helper here encodes for exactly one output context, and leaves ordinary
// values (identifiers, branch names, `owner/repo` paths, URLs) untouched.

import { escapeHtml } from "../shared.js";

// `<`, `>` and `&` are encoded so emitted text can never carry `</script` or an
// HTML comment opener: the HTML parser acts on those before JavaScript ever
// sees them. U+2028 and U+2029 are JavaScript line terminators, so they end a
// string literal even though JSON accepts them raw.
const JS_STRING_UNSAFE = /[\\'"\n\r\t<>&\u0000-\u001f\u2028\u2029]/g;
const JSON_UNSAFE = /[<>&\u2028\u2029]/g;

function unicodeEscape(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

function jsStringEscape(character: string): string {
  switch (character) {
    case "\\":
      return "\\\\";
    case "'":
      return "\\'";
    case '"':
      return '\\"';
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return unicodeEscape(character);
  }
}

// Encode a value for the inside of a single-quoted JavaScript string literal in
// an inline script.
export function inlineJsString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(JS_STRING_UNSAFE, jsStringEscape);
}

// Encode a value as a complete JavaScript literal for serialized page state.
export function inlineJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  // `undefined` has no JSON form, and emitting the bare identifier would make
  // the surrounding script read a global instead of the intended value.
  if (serialized === undefined) return "null";
  return serialized.replace(JSON_UNSAFE, unicodeEscape);
}

// Encode a caller-supplied external link for an `href` attribute. Only http(s)
// destinations are returned; anything else — `javascript:`, `data:`, a relative
// or malformed value — yields an empty string so the renderer can drop the link
// rather than ship an executable one.
export function safeExternalHref(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
  return escapeHtml(value);
}
