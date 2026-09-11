---
"radius": patch
---

Stop reporting an application model as permanently out of date when two copies of the Radius plugin are installed with different versions. The generator version written into `.radius/app.origin.json` is now the one the running extension supplies, rather than one guessed from wherever the writer script happens to live, so the recorded version and the version the freshness check compares it against can no longer disagree. When no version is supplied the record leaves it unknown and says so, which skips the generator comparison for that model instead of recording a wrong value.
