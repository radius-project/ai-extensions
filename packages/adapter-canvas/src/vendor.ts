// Canvas adapter — fixed graph libraries embedded in every rendered page.
//
// The build replaces vendor-assets.ts with a virtual module containing the
// locally installed, pinned library files. Source tests use the same reader
// directly, so the tested inputs are the inputs shipped in the extension.

import { readVendorAssets } from "./vendor-assets.js";

const vendorAssets = readVendorAssets();

const escapeClosingTag = (value: string, tag: "script" | "style"): string =>
  value.replace(new RegExp(`<\\/${tag}>`, "gi"), `<\\/${tag}>`);

export async function ensureVendorScripts(): Promise<void> {
  // Keep the async API used by the server while making loading deterministic
  // and entirely local.
}

export function getInlineVendorStyles(): string {
  return `<style>${escapeClosingTag(vendorAssets.reactFlowCss, "style")}</style>`;
}

export function getInlineVendorScripts(): string {
  const scripts = [
    vendorAssets.react,
    vendorAssets.reactDom,
    vendorAssets.reactFlow,
    vendorAssets.dagre
  ].map((source) => `<script>${escapeClosingTag(source, "script")}</script>`);
  return scripts.join("\n");
}
