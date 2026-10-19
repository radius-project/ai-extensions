---
"radius": minor
---

**Added:** Regenerate the application model after a plugin update moves to a newer Radius version, and move the Radius extension pin in `.radius/bicepconfig.json` with it when modeling wrote that pin. A pin set by hand is left unchanged, and an older Radius CLI shows a note to update the plugin instead of regenerating.
