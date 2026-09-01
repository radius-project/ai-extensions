---
"radius": minor
---

Adopt the [Agent Plugins](https://agent-plugins.org) 1.0.0 manifest format. `plugin.json` now declares the canonical `$schema` and drops `skills` and `extensions`: the specification defines a closed manifest whose components load from fixed locations, so skills are discovered from `skills/` without being declared, and a client that honors the schema ignores a non-object `extensions` value. The release gate validates the schema identifier, rejects fields outside the specification, and requires the fixed `skills/` directory.

Remove the `radius-fix-canvas-installation` skill. The GitHub Copilot app now loads a plugin's canvas from its installed location, so copying `extension.mjs` into a separate extensions folder is no longer a supported repair.
