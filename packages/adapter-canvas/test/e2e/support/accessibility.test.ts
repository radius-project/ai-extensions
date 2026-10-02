import { describe, expect, it } from "vitest";
import type { NodeResult, Result } from "./accessibility.js";
import {
  COLOR_CONTRAST_NOISE_MARGIN,
  filterColorContrastNoise
} from "./accessibility.js";

function colorContrastNode(
  target: string,
  contrastRatio: number,
  expectedContrastRatio = 4.5
): NodeResult {
  return {
    html: `<button id="${target.replace("#", "")}"></button>`,
    target: [target],
    any: [
      {
        id: "color-contrast",
        data: { contrastRatio, expectedContrastRatio },
        impact: "serious",
        message: "Element has insufficient color contrast",
        relatedNodes: []
      }
    ],
    all: [],
    none: []
  } as unknown as NodeResult;
}

function colorContrastViolation(nodes: NodeResult[]): Result {
  return {
    id: "color-contrast",
    nodes,
    impact: "serious",
    description: "Elements must meet minimum color contrast ratio thresholds",
    help: "Elements must have sufficient color contrast",
    helpUrl: "https://dequeuniversity.com/rules/axe/color-contrast",
    tags: []
  } as unknown as Result;
}

function otherViolation(id: string): Result {
  return {
    id,
    nodes: [
      {
        html: "<div></div>",
        target: ["#unrelated"],
        any: [],
        all: [],
        none: []
      }
    ],
    impact: "serious",
    description: "",
    help: "",
    helpUrl: "",
    tags: []
  } as unknown as Result;
}

describe("filterColorContrastNoise", () => {
  it("keeps non-color-contrast violations untouched", () => {
    const violations = [otherViolation("label")];
    expect(filterColorContrastNoise(violations)).toEqual(violations);
  });

  it("drops a color-contrast node whose ratio is within the noise margin below the threshold", () => {
    const node = colorContrastNode("#btn-verify-azure", 4.45, 4.5);
    const violations = [colorContrastViolation([node])];
    expect(filterColorContrastNoise(violations)).toEqual([]);
  });

  it("keeps a color-contrast node whose ratio is clearly below the threshold", () => {
    const node = colorContrastNode("#low-contrast", 3.0, 4.5);
    const violations = [colorContrastViolation([node])];
    expect(filterColorContrastNoise(violations)).toEqual(violations);
  });

  it("keeps the node exactly at the margin boundary (inclusive)", () => {
    const boundaryRatio = 4.5 - COLOR_CONTRAST_NOISE_MARGIN;
    const node = colorContrastNode("#boundary", boundaryRatio, 4.5);
    const violations = [colorContrastViolation([node])];
    expect(filterColorContrastNoise(violations)).toEqual([]);
  });

  it("keeps the node one hundredth below the margin boundary", () => {
    const belowBoundaryRatio = 4.5 - COLOR_CONTRAST_NOISE_MARGIN - 0.01;
    const node = colorContrastNode("#below-boundary", belowBoundaryRatio, 4.5);
    const violations = [colorContrastViolation([node])];
    expect(filterColorContrastNoise(violations)).toEqual(violations);
  });

  it("filters nodes independently within a single violation", () => {
    const nearThreshold = colorContrastNode("#plan-btn", 4.45, 4.5);
    const realFailure = colorContrastNode("#low-contrast", 2.0, 4.5);
    const violations = [colorContrastViolation([nearThreshold, realFailure])];
    expect(filterColorContrastNoise(violations)).toEqual([
      colorContrastViolation([realFailure])
    ]);
  });

  it("keeps a node with missing contrast data rather than treating it as noise", () => {
    const node: NodeResult = {
      html: "<button></button>",
      target: ["#incomplete"],
      any: [
        {
          id: "color-contrast",
          data: null,
          impact: "serious",
          message: "Unable to determine contrast",
          relatedNodes: []
        }
      ],
      all: [],
      none: []
    } as unknown as NodeResult;
    const violations = [colorContrastViolation([node])];
    expect(filterColorContrastNoise(violations)).toEqual(violations);
  });

  it("keeps a node whose any[] has no color-contrast check", () => {
    const node: NodeResult = {
      html: "<button></button>",
      target: ["#other-check"],
      any: [
        {
          id: "some-other-check",
          data: { contrastRatio: 4.45, expectedContrastRatio: 4.5 },
          impact: "serious",
          message: "",
          relatedNodes: []
        }
      ],
      all: [],
      none: []
    } as unknown as NodeResult;
    const violations = [colorContrastViolation([node])];
    expect(filterColorContrastNoise(violations)).toEqual(violations);
  });
});
