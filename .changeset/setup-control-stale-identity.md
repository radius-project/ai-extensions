---
"radius": patch
---

**Fixed:** Refuse a credential-verification retry when its saved GitHub account or operation changes while checking whether the setup pull request merged. A previous account's merge confirmation cannot authorize a replacement operation.

Reject setup answers when the original operation is removed, replaced, or retargeted while reading or saving the answer. Do not report the answer as accepted, start replacement work, or restore stale prompt data over the changed operation.
