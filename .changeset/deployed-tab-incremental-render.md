---
"@radius-project/canvas": patch
---

Deployed tab renders incrementally on each poll instead of tearing down and re-mounting the whole React root every ~5s. The renderer's existing `controller.update(newResources)` path (which just calls `setNodes`/`setEdges` behind the scenes) is now cached on first render and reused on every subsequent poll, so per-resource status changes (pending → in_progress → success/failed) animate in place — no more full-canvas flash on every progression update. `showNothing()` invalidates the cache so the "nothing deployed yet" transition still mounts a fresh root on the next real render.
