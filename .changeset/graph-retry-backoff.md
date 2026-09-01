---
"radius": patch
---

Show the application graph sooner after Copilot generates the app model. The Graph tab now re-checks for `.radius/app.bicep` on a 300ms, 1s, 2s, 5s backoff instead of waiting a fixed 10 seconds between polls, so a model that finishes quickly renders almost immediately while a long modeling run still settles onto a steady polling interval.
