---
"radius": patch
---

**Fixed:** Refuse a credential-verification retry when its saved GitHub account or operation changes while checking whether the setup pull request merged or saving the accepted command. A previous account's merge confirmation cannot authorize a replacement operation.

Reject setup answers when the original operation or panel attachment is removed, replaced, or retargeted while reading or saving the answer. Restore and save an unchanged, unstarted prompt when its panel closes before admission, without overwriting a competing prompt or operation. Report failed corrective saves with inspection guidance instead of suggesting an unsafe retry.

Refuse setup controls when their operation or original coordinator changes during admission. Wait for pending saves to settle before recovery, restore only an unchanged and unstarted request, and report a failed durable undo instead of accepting or starting stale work. Recheck only the affected operation after its admission settles, without restarting recovery for unrelated operations.

Keep controls retryable when a previous task is still settling: return a temporary busy response instead of permanently blocking recovery, while preserving duplicate-command acceptance.
