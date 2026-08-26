---
"radius": patch
---

Refresh the whole skills tree on `build:install` so a local install stops running stale skill text. The installer previously copied only `skills/radius-app-bicep/scripts`, so `SKILL.md` and its reference files kept whatever content the install directory already had — a developer could rebuild, install, and still watch the agent follow guidance the bundle no longer contained. The skills directory is now replaced as a whole (copied to a temp directory and then renamed into place), which also evicts files deleted upstream instead of leaving them behind to be read.
