// Browser-created text must be escaped before it is interpolated into markup.
// DOM adapters do not expose innerHTML, so callers must make an explicit choice
// to use this helper at the few markup-producing boundaries delivered later.

export function escapeBrowserHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// An icon URL interpolated into a CSS `url("…")` token must not be able to
// close the token or the surrounding declaration, so the CSS-significant
// characters are percent-encoded. Ordinary data and http(s) URLs contain none of
// them and therefore survive byte-identical.
export function browserCssMaskUrl(value: unknown): string {
  const encoded = String(value).replace(/["'();\\\s]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).toUpperCase();
    return "%" + (code.length < 2 ? "0" + code : code);
  });
  return 'url("' + encoded + '")';
}

export function hasClassToken(className: string, token: string): boolean {
  return className.split(/\s+/).includes(token);
}
