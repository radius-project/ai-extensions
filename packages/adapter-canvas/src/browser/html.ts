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
