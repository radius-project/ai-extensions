---
"radius": patch
---

**Fixed:** Keep graph previews on the selected saved workspace or GitHub revision, and report unreadable or empty models instead of silently substituting another source.

Reject checkout changes during reads and compile captured configuration and extension files so later workspace edits cannot corrupt cached graphs.

Reject dangling model or configuration links and stop automatic regeneration when workspace provenance cannot be read. Record failed authoring attempts that leave blank models without confusing unreadable sources with missing files.

Do not request regeneration after a workspace branch change, and show why authoring could not start instead of waiting for a timeout.
