---
"radius": patch
---

**Fixed:** Clean up temporary graph compilation artifacts after failures and superseded requests without deleting workspace files or hiding the original result.

Use OS temporary storage for runtime graph snapshots and report cleanup failures. Prevent older refreshes from replacing newer graphs or requesting repair, and end cancelled progress without clearing a newer build's status.
