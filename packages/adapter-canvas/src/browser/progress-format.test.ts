// Presentation shared by every progress surface.
//
// These cases were previously duplicated beside the environment panel and the
// graph panel. They live here now because both surfaces render from one module,
// and the honesty rule they pin — elapsed time only, never an estimate — has to
// hold for whichever surface calls in.

import { describe, expect, it } from "vitest";
import { formatElapsed, stageGlyph } from "./progress-format.js";

describe("formatElapsed", () => {
  it.each([
    [0, "0:00"],
    [999, "0:00"],
    [1000, "0:01"],
    [5000, "0:05"],
    [59_000, "0:59"],
    [60_000, "1:00"],
    [65_000, "1:05"],
    [125_000, "2:05"],
    [600_000, "10:00"],
    [-5000, "0:00"]
  ])("renders %ims as %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });
});

describe("stageGlyph", () => {
  it.each([
    ["pending", "○"],
    ["running", "◐"],
    ["succeeded", "✓"],
    ["warning", "⚠"],
    ["failed", "✗"],
    ["skipped", "–"]
  ])("renders the %s state as %s", (state, expected) => {
    expect(stageGlyph(state)).toBe(expected);
  });

  it("falls back to pending for a state neither workflow defines", () => {
    expect(stageGlyph("invented")).toBe("○");
  });

  it("honors a caller's fallback for an unknown state", () => {
    expect(stageGlyph("invented", "·")).toBe("·");
  });

  it("prefers a known glyph over the caller's fallback", () => {
    expect(stageGlyph("failed", "·")).toBe("✗");
  });
});
