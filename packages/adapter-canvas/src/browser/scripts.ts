import { BROWSER_ENTRY_NAMES, loadBrowserScript } from "./generated.js";
import type { BrowserEntryName } from "./generated.js";

export { BROWSER_ENTRY_NAMES };
export type { BrowserEntryName };

export const BROWSER_ENTRY_MARKER = "// radius:browser-entry";

export function browserEntryMarker(name: BrowserEntryName): string {
  return `${BROWSER_ENTRY_MARKER} ${name}`;
}

export function browserScript(name: BrowserEntryName): string {
  return loadBrowserScript(name);
}

export function browserScriptTag(name: BrowserEntryName): string {
  return `<script>\n${browserEntryMarker(name)}\n${browserScript(name)}\n</script>`;
}
