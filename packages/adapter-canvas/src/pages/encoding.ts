import { escapeHtml } from "../shared.js";

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
