// Canvas adapter — presentation shared by every progress surface.
//
// Environment setup and graph builds are different workflows, but they report
// themselves the same way: a checklist of stages carrying a glyph, and a clock
// of time actually spent. Both are rendered from here so the two surfaces stay
// visually identical and the honesty rule has one home — elapsed time is time
// that has passed, never an estimate of time remaining, and there is no
// percentage or progress bar anywhere in this module.

// A stage glyph for any state either workflow reports. Graph builds use a
// subset; an unrecognized state renders as pending rather than as nothing.
const STAGE_GLYPHS: Readonly<Record<string, string>> = {
  pending: "○",
  running: "◐",
  succeeded: "✓",
  warning: "⚠",
  failed: "✗",
  skipped: "–"
};

export function stageGlyph(
  state: string,
  fallback = STAGE_GLYPHS.pending
): string {
  return STAGE_GLYPHS[state] ?? fallback;
}

// Plain m:ss of time spent. Negative input clamps to 0:00, so a client clock
// that is behind the server's cannot render a negative duration.
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}
