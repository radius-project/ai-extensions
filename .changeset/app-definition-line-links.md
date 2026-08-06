---
"radius": patch
---

Anchor "View app definition" links to the resource's line in `app.bicep` and default the planned-graph branch selector to the current branch:

- `applicationGraphToResources` now accepts the authored Bicep content and derives each resource's `definitionLine` when `rad app graph` does not emit a source location. A new `findResourceDefinitionLines` parser maps both a resource's Bicep symbol and its literal top-level `name:` value to the declaration line (brace-depth aware, ignoring strings and comments), so the in-card app-definition link deep-links to `#L<line>` instead of the file top. `buildGraphViaRad` threads the exact compiled Bicep through to the converter, keeping line numbers correct per branch (including diff base/head).
- The empty planned-deployment page now seeds its branch selector with the current context branch (matching the modeled graph page), so every single-branch selector defaults to the same branch on load. The diff page intentionally keeps distinct base/head branches.
