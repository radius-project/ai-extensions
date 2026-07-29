---
"@radius-project/canvas": patch
---

Add a per-status badge (hourglass / ✓ / ✗) to the top-right of every node card so the deploy phase is legible at a glance in addition to the border/fill color change. Pending nodes get a muted grey hourglass, in-progress/waiting/postponed get a yellow hourglass, succeeded gets a green check, failed gets a red cross. Only rendered when the resource carries a `deployStatus` — modeled and planned graphs stay clean. Combined with the incremental-render change, a resource transitioning pending → in_progress → success/failed just flips its glyph and background in place instead of the whole card re-mounting. Glyphs are built via `React.createElement` (never via raw-HTML injection) so the client keeps its XSS discipline.
