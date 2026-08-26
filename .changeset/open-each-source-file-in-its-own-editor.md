---
"radius": patch
---

Fix "View source code" so clicking a second node opens that node's file instead of refocusing the first one:

- The open-source handler opened every file under the constant editor handle `radius-source`. Re-opening an `instanceId` that already exists focuses the existing panel rather than re-initializing it with the new input, so the first click created the panel and every later click silently discarded its `path` and refocused the file already shown. The editor canvas exposes no navigate action and the canvas RPC surface has no close, so a distinct handle per file is the only way to open a different file.
- `sourceEditorInstanceId` now derives a stable per-path handle from a readable slug plus a 32-bit FNV-1a digest, so two different files get two different editor tabs, re-clicking the same node reuses its tab, and paths that slug identically (or diverge past the slug cutoff) stay apart.

Line numbers are still not honored: the editor canvas input accepts no line or selection field, so `line` remains validated and threaded but unused.
