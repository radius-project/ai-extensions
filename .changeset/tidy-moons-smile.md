---
"@radius-project/core": patch
"@radius-project/adapter-canvas": patch
---

Stop reporting a manual edit to `.radius/app.bicep` that needs no regeneration.

An edit was checked before anything else and always asked the user to confirm before an overwrite. But on its own an edit is not a reason to regenerate: when the source and the skill still match, the model describes the current source. Since an edit is permanent and there is no way to accept it, the question came back on every graph open, forever.

The edit is now checked against the other results and only reported when one of them already calls for a regeneration, which is when the overwrite would actually cost the user work. The `edited` status is renamed `manually-edited` to say what it means.
