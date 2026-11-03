---
"radius": patch
---

**Fixed:** Share in-progress environment setup recovery across panel attachments, and prevent old tasks or delayed updates from clearing newer work or overwriting a reopened panel.

Queued tasks and delayed reconciliation cannot run against a replaced, removed or retargeted operation. A replacement can register its own reconciliation without an old timer consuming it.
