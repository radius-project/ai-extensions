// Shared graph library — the Radius brand mark.
//
// One canonical definition of the Radius dial, so every host that links to a
// Radius surface draws the same mark: the Copilot canvas inlines it into its
// server-rendered page headings, and a Kubernetes dashboard registers it as a
// named icon for its Radius navigation entries.
//
// The mark is published as its viewBox geometry plus the inner markup, because
// icon registries take a body and its dimensions rather than a complete `<svg>`
// element. `radiusBrandMarkSvg` composes the same pieces into a standalone
// element for hosts that inline markup directly.
//
// Colors resolve through the `--rad-brand` and `--rad-brand-dark` custom
// properties with the Radius palette as the fallback, so a host restyles the
// mark through the same tokens it themes the rest of the graph with. Those
// properties only resolve where the markup is inlined into the host document;
// referencing the mark as an image or data URI renders the fallback palette.
//
// This module is deliberately free of React, DOM, and layout imports so a host
// can register the icon without pulling in the renderer.

import { escapeBrowserHtml } from "./html.js";

export interface RadiusBrandMark {
  /** The mark's inner SVG markup, without the enclosing `<svg>` element. */
  readonly body: string;
  /** The viewBox width the body is drawn against. */
  readonly width: number;
  /** The viewBox height the body is drawn against. */
  readonly height: number;
}

export interface RadiusBrandMarkOptions {
  /** Rendered edge length in CSS pixels. Defaults to 28. */
  size?: number;
  /**
   * Accessible name for a mark that carries meaning on its own. Omit it for a
   * mark sitting beside its own text label, which is hidden from assistive
   * technology instead.
   */
  title?: string;
}

export const RADIUS_BRAND_MARK: RadiusBrandMark = {
  body:
    `<circle cx="64" cy="64" r="64" fill="var(--rad-brand, #da4c2a)"/>` +
    `<circle cx="64" cy="64" r="56" fill="var(--rad-brand-dark, #bb311e)" opacity="0.3"/>` +
    `<line x1="64" y1="64" x2="34" y2="28" stroke="#fff" stroke-width="7" stroke-linecap="round"/>` +
    `<circle cx="64" cy="64" r="8" fill="#fff"/>`,
  width: 128,
  height: 128
};

export function radiusBrandMarkSvg(
  options: RadiusBrandMarkOptions = {}
): string {
  const size = options.size ?? 28;
  // The size is interpolated into markup, so a JavaScript caller that ignores
  // the type must not be able to smuggle attributes through it.
  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    throw new RangeError("Radius brand mark size must be a positive number.");
  }
  const { width, height, body } = RADIUS_BRAND_MARK;
  const label =
    options.title === undefined ?
      ` aria-hidden="true"`
    : ` role="img" aria-label="${escapeBrowserHtml(options.title)}"`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${size}" height="${size}"${label}>` +
    `${body}</svg>`
  );
}
