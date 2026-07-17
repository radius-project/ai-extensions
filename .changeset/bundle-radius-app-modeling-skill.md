---
"@radius-project/canvas": patch
---

Bundle the full `radius-app-modeling` skill (SKILL.md and all reference files) into
the canvas extension so `radius_generate_app` returns the authoritative,
schema-accurate guidance even when the extension is installed on its own,
without the sibling `plugins/radius/skills/` tree.

Previously the tool returned a hand-maintained summary that drifted from the
skill and omitted property-level schema details (e.g. `Radius.Compute/containers`
uses a `containers` map and container images expose `imageReference`), which
could produce a `.radius/app.bicep` that failed to compile. The skill Markdown
is now inlined at build time via an esbuild `.md` text loader, keeping a single
source of truth.
