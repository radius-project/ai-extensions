// A single definition of what the canvas is willing to hand to the host's
// external opener. Anything that is not an absolute https URL is refused rather
// than passed through, so a javascript: or file: value carried in server state
// can never become a navigation.

export function safeExternalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : "";
  } catch {
    return "";
  }
}
