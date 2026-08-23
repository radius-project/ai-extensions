---
"radius": patch
---

Regenerate an app model that has no origin record instead of asking the user.

Every `.radius/app.bicep` written before origin records existed has no record, so opening a graph asked the user whether to regenerate before showing anything.

A missing record says nothing about whether a person edited the file, so guessing was the wrong approach. Radius now asks git a question it can answer instead: could the file be recovered? Regeneration writes the working tree and never commits, so a committed, unmodified model survives being overwritten as an undoable diff and is refreshed without asking. One that is untracked or already modified exists nowhere else, so Radius asks first.
