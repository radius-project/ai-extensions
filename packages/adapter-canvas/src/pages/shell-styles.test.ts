import { describe, expect, it } from "vitest";
import { CRITICAL_SHELL_STYLE_CSS, SHELL_STYLE_CSS } from "./shell-styles.js";
import {
  commandActionSpecs,
  commandActionView
} from "../browser/command-action.js";
import type { ElementSpec } from "../browser/dom.js";
import type { RemediationView } from "@radius-project/core/remediations";

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

// Reads a host color mix straight out of the stylesheet, so the ratios below
// are computed from the declaration that actually ships rather than a copy.
function hostColorMixToken(name: string): {
  hostToken: string;
  portion: number;
} {
  const declaration = new RegExp(
    `--rad-${name}: color-mix\\(in srgb, var\\((--[a-z-]+), (#[0-9a-f]{6})\\) (\\d+)%, var\\(--rad-text\\)\\);`
  ).exec(SHELL_STYLE_CSS);
  if (!declaration) throw new Error(`--rad-${name} is not a text-safe mix`);
  return { hostToken: declaration[1], portion: Number(declaration[3]) / 100 };
}

function diffToken(name: string): {
  hostToken: string;
  borderPortion: number;
  fillPortion: number;
} {
  const border = hostColorMixToken(`diff-${name}`);
  const fill = new RegExp(
    `--rad-diff-${name}-bg: color-mix\\(in srgb, var\\(--rad-diff-${name}\\) (\\d+)%, var\\(--rad-surface\\)\\);`
  ).exec(SHELL_STYLE_CSS);
  if (!fill) throw new Error(`--rad-diff-${name} is incomplete`);
  return {
    hostToken: border.hostToken,
    borderPortion: border.portion,
    fillPortion: Number(fill[1]) / 100
  };
}

function maximumChannelDelta(a: Rgb, b: Rgb): number {
  return Math.max(...a.map((channel, index) => Math.abs(channel - b[index])));
}

// The host owns theme selection and injects the palette. The dark-canvas case
// that motivated this (issue #214) is a host that keeps its *light* status
// colors in a dark canvas, so both host palettes are checked against both
// canvases.
const palettes = {
  light: {
    bg: "#ffffff",
    text: "#1f2328",
    tertiary: "#656d76",
    link: "#0969da"
  },
  dark: {
    bg: "#0d1117",
    text: "#e6edf3",
    tertiary: "#8b949e",
    link: "#58a6ff"
  }
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

describe("document canvas background", () => {
  it("paints the host background before the full shell stylesheet loads", () => {
    expect(CRITICAL_SHELL_STYLE_CSS).toContain(
      "background: var(--background-color-default, Canvas)"
    );
  });

  it("paints both document roots with the host background during navigation", () => {
    const documentRootStyles = SHELL_STYLE_CSS.match(
      /html, body\s*\{([^}]*)\}/
    )?.[1];

    expect(documentRootStyles).toContain("background: var(--rad-bg)");
  });
});

describe("busy pane affordance", () => {
  const busyStyles = SHELL_STYLE_CSS.match(
    /\.main-content\[aria-busy="true"\]\s*\{([^}]*)\}/
  )?.[1];

  it("dims the outgoing pane it makes inert so it reads as unavailable", () => {
    expect(busyStyles).toContain("opacity: 0.55");
    expect(busyStyles).toContain("cursor: progress");
  });

  it("delays the dim so a fast pane swap never flickers", () => {
    expect(busyStyles).toContain("transition: opacity 120ms linear 200ms");
  });

  it("drops the transition under a reduced-motion preference", () => {
    const reducedMotion = SHELL_STYLE_CSS.slice(
      SHELL_STYLE_CSS.indexOf("@media (prefers-reduced-motion: reduce)")
    );

    expect(reducedMotion).toContain(
      '.main-content[aria-busy="true"] { transition: none; }'
    );
  });
});

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
      const { portion } = hostColorMixToken(status);
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
      const { hostToken } = hostColorMixToken(status);
      expect(SHELL_STYLE_CSS).toContain(`var(${hostToken},`);
    }
  );

  it("keeps solid fills off the surface-following tokens", () => {
    // A badge that prints #fff on a status fill must not lighten with the
    // canvas, or its own label disappears.
    expect(SHELL_STYLE_CSS).toContain("--rad-warning-solid: #9a6700;");
    expect(SHELL_STYLE_CSS).toContain("--rad-success-solid: #1a7f37;");
  });

  describe("diff color tokens", () => {
    const diffStatuses = [
      ["added", "success"],
      ["modified", "warning"],
      ["removed", "danger"]
    ] as const;
    const cases = diffStatuses.flatMap(([diffStatus, status]) =>
      Object.entries(palettes).flatMap(([canvas, palette]) =>
        Object.entries(hostStatusColors).map(
          ([host, colors]) =>
            [diffStatus, canvas, host, palette, colors[status]] as const
        )
      )
    );

    it.each(cases)(
      "%s stays distinct and readable on a %s canvas with the host's %s",
      (diffStatus, _canvas, _host, palette, hostColor) => {
        const { borderPortion, fillPortion } = diffToken(diffStatus);
        const border = mix(
          parseHex(hostColor),
          parseHex(palette.text),
          borderPortion
        );
        const fill = mix(border, parseHex(palette.bg), fillPortion);

        expect(contrast(border, parseHex(palette.bg))).toBeGreaterThanOrEqual(
          3
        );
        expect(contrast(parseHex(palette.text), fill)).toBeGreaterThanOrEqual(
          4.5
        );
        expect(
          contrast(parseHex(palette.tertiary), fill)
        ).toBeGreaterThanOrEqual(4.5);
        expect(contrast(parseHex(palette.link), fill)).toBeGreaterThanOrEqual(
          4.5
        );
      }
    );

    it.each(
      Object.entries(palettes).flatMap(([canvas, palette]) =>
        Object.entries(hostStatusColors).map(
          ([host, colors]) => [canvas, host, palette, colors] as const
        )
      )
    )(
      "keeps every fill visibly distinct on a %s canvas with the host's %s",
      (_canvas, _host, palette, colors) => {
        const fills = diffStatuses.map(([diffStatus, status]) => {
          const { borderPortion, fillPortion } = diffToken(diffStatus);
          const border = mix(
            parseHex(colors[status]),
            parseHex(palette.text),
            borderPortion
          );
          return mix(border, parseHex(palette.bg), fillPortion);
        });

        for (let left = 0; left < fills.length; left += 1) {
          for (let right = left + 1; right < fills.length; right += 1) {
            expect(
              maximumChannelDelta(fills[left], fills[right])
            ).toBeGreaterThanOrEqual(4);
          }
        }
      }
    );

    it.each(diffStatuses)(
      "%s reads the host's %s token",
      (diffStatus, status) => {
        expect(diffToken(diffStatus).hostToken).toBe(`--text-color-${status}`);
      }
    );
  });

  it.each(statuses)("%s tints a background from the same token", (status) => {
    expect(SHELL_STYLE_CSS).toContain(
      `--rad-${status}-bg: color-mix(in srgb, var(--rad-${status})`
    );
  });
});

describe("resource table status styles", () => {
  it("does not define decorative colored status circles", () => {
    expect(SHELL_STYLE_CSS).not.toContain(".rad-dot");
  });
});

describe("run-command callout styles", () => {
  // The callout builds its markup in the browser bundle while its styles live
  // in this shell, so nothing in the type system connects the two. Deriving the
  // class names from the real specs keeps that seam honest: a class the callout
  // emits but the shell never styles renders as unstyled markup in the canvas.
  function classesFrom(remediation: RemediationView): string[] {
    const specs = commandActionSpecs(
      commandActionView({
        remediation,
        phase: "confirming",
        error: "",
        copied: false
      }),
      "cmd"
    );
    const nodes: ElementSpec[] = [
      specs.container,
      ...(specs.container.children ?? []),
      ...specs.buttons,
      ...(specs.status === null ? [] : [specs.status])
    ];
    return [
      ...new Set(nodes.flatMap((n) => (n.className ?? "").split(" ")))
    ].filter((c) => c !== "");
  }

  const remediation: RemediationView = {
    id: "git-push-branch",
    params: { branch: "feature" },
    title: "Push the branch",
    command: "git push -u origin feature",
    cwd: "workspace",
    impact: "high",
    runnable: true,
    unsupportedReason: "",
    warning: "",
    confirmTitle: "Push this branch?",
    confirmBody: "This writes to the remote.",
    confirmLabel: "Push",
    followUp: "Then choose Retry."
  };

  it.each(classesFrom(remediation))("styles .%s", (className) => {
    expect(SHELL_STYLE_CSS).toContain(`.${className}`);
  });

  it("styles the buttons row and status shown only in later phases", () => {
    // `cancel` and the status node appear only once the callout has a phase, so
    // assert the container pieces the idle callout does not emit.
    expect(SHELL_STYLE_CSS).toContain(".rad-command-action-buttons");
    expect(SHELL_STYLE_CSS).toContain(".rad-command-action-status");
    expect(SHELL_STYLE_CSS).toContain(".rad-command-action-warning");
  });

  it("keeps the command block readable verbatim", () => {
    // A multi-command remediation is newline-joined, so collapsing whitespace
    // would run `git add`, `git commit`, and `git push` together on one line.
    expect(SHELL_STYLE_CSS).toContain("white-space: pre-wrap;");
  });
});
