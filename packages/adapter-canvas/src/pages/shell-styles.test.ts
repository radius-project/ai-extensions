import { describe, expect, it } from "vitest";
import { SHELL_STYLE_CSS } from "./shell-styles.js";

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const v = hex.replace("#", "");
  return [
    parseInt(v.slice(0, 2), 16),
    parseInt(v.slice(2, 4), 16),
    parseInt(v.slice(4, 6), 16)
  ];
}

// color-mix(in srgb, a p%, b) interpolates in gamma-encoded sRGB.
function mix(a: Rgb, b: Rgb, portionOfA: number): Rgb {
  return [0, 1, 2].map(
    (i) => a[i] * portionOfA + b[i] * (1 - portionOfA)
  ) as Rgb;
}

function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x
  );
  return (hi + 0.05) / (lo + 0.05);
}

// Reads a status token straight out of the stylesheet, so the ratios below are
// computed from the declaration that actually ships rather than a copy of it.
function statusToken(name: string): { hostToken: string; portion: number } {
  const declaration = new RegExp(
    `--rad-${name}: color-mix\\(in srgb, var\\((--[a-z-]+), (#[0-9a-f]{6})\\) (\\d+)%, var\\(--rad-text\\)\\);`
  ).exec(SHELL_STYLE_CSS);
  if (!declaration) throw new Error(`--rad-${name} is not a text-safe mix`);
  return { hostToken: declaration[1], portion: Number(declaration[3]) / 100 };
}

// The host owns theme selection and injects the palette. The dark-canvas case
// that motivated this (issue #214) is a host that keeps its *light* status
// colors in a dark canvas, so both host palettes are checked against both
// canvases.
const palettes = {
  light: { bg: "#ffffff", text: "#1f2328" },
  dark: { bg: "#0d1117", text: "#e6edf3" }
} as const;

const hostStatusColors = {
  "light palette": {
    success: "#1a7f37",
    warning: "#9a6700",
    danger: "#cf222e"
  },
  "dark palette": { success: "#3fb950", warning: "#d29922", danger: "#f85149" }
} as const;

const statuses = ["success", "warning", "danger"] as const;

describe("status color tokens", () => {
  const cases = statuses.flatMap((status) =>
    Object.entries(palettes).flatMap(([canvas, palette]) =>
      Object.entries(hostStatusColors).map(
        ([host, colors]) =>
          [status, canvas, host, palette, colors[status]] as const
      )
    )
  );

  it.each(cases)(
    "%s text stays readable on a %s canvas with the host's %s",
    (status, _canvas, _host, palette, hostColor) => {
      const { portion } = statusToken(status);
      const resolved = mix(
        parseHex(hostColor),
        parseHex(palette.text),
        portion
      );
      expect(contrast(resolved, parseHex(palette.bg))).toBeGreaterThanOrEqual(
        4.5
      );
    }
  );

  it.each(statuses)(
    "%s reads the host token with a light-mode fallback",
    (status) => {
      const { hostToken } = statusToken(status);
      expect(SHELL_STYLE_CSS).toContain(`var(${hostToken},`);
    }
  );

  it("keeps solid fills off the surface-following tokens", () => {
    // A badge that prints #fff on a status fill must not lighten with the
    // canvas, or its own label disappears.
    expect(SHELL_STYLE_CSS).toContain("--rad-warning-solid: #9a6700;");
    expect(SHELL_STYLE_CSS).toContain("--rad-success-solid: #1a7f37;");
  });

  it.each(statuses)("%s tints a background from the same token", (status) => {
    expect(SHELL_STYLE_CSS).toContain(
      `--rad-${status}-bg: color-mix(in srgb, var(--rad-${status})`
    );
  });
});

describe("connection ordinal chip", () => {
  const declaration = /\.rad-conn__ord \{([^}]*)\}/.exec(SHELL_STYLE_CSS);

  it("is styled from theme-following tokens rather than fixed colors", () => {
    expect(declaration).not.toBeNull();
    const body = (declaration as RegExpExecArray)[1];
    expect(body).toContain("color: var(--rad-text-secondary)");
    expect(body).toContain("background: var(--rad-surface)");
    expect(body).toContain("border: 1px solid var(--rad-stroke)");
    // A literal color here would pin the chip to one theme, which is exactly
    // what the host-injected palette breaks.
    expect(body).not.toMatch(/#[0-9a-f]{3,6}/i);
  });

  it.each(Object.entries(palettes))(
    "reads its label against the %s canvas surface",
    (_canvas, palette) => {
      // Both tokens resolve to the host's default text and background, so the
      // chip inherits the canvas's own guaranteed body contrast.
      expect(
        contrast(parseHex(palette.text), parseHex(palette.bg))
      ).toBeGreaterThanOrEqual(4.5);
    }
  );
});
