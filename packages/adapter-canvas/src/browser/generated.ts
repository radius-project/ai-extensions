// Development loads compile entries in memory. The production build replaces
// this module with a literal payload map, so neither this import nor esbuild is
// present in the shipped extension.

import {
  BROWSER_ENTRY_NAMES,
  compileBrowserEntry,
  compileBrowserStyle
} from "./build.js";
import type { BrowserEntryName } from "./build.js";

export { BROWSER_ENTRY_NAMES };
export type { BrowserEntryName };

export function loadBrowserScript(name: string): string {
  return compileBrowserEntry(name);
}

export function loadBrowserStyle(name: string): string {
  return compileBrowserStyle(name);
}
