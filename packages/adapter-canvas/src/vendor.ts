// Canvas adapter — fixed graph libraries embedded in every rendered page.
//
// The build replaces vendor-assets.ts with a virtual module containing the
// locally installed, pinned library files. Source tests use the same reader
// directly, so the tested inputs are the inputs shipped in the extension.

import { readVendorAssets, type VendorAssets } from "./vendor-assets.js";

let vendorAssets: VendorAssets | undefined;

function getVendorAssets(): VendorAssets {
  vendorAssets ??= readVendorAssets();
  return vendorAssets;
}

const escapeClosingTag = (value: string, tag: "script" | "style"): string =>
  value.replace(new RegExp(`<\\/${tag}>`, "gi"), `<\\/${tag}>`);

export async function ensureVendorScripts(): Promise<void> {
  getVendorAssets();
}

export function getInlineVendorStyles(): string {
  return `<style>${escapeClosingTag(getVendorAssets().reactFlowCss, "style")}</style>`;
}

export function getInlineVendorScripts(): string {
  const assets = getVendorAssets();
  const scripts = [
    assets.react,
    assets.reactDom,
    assets.reactFlow,
    assets.dagre
  ].map((source) => `<script>${escapeClosingTag(source, "script")}</script>`);
  return scripts.join("\n");
}
