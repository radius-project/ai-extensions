---
"radius": patch
---

**Fixed:** Honor an explicitly selected Bicep path and stop deployment preparation when branch access, application reads, secret provisioning or workflow publication fails. Refuse deployment when existing workflow files cannot be synchronized instead of dispatching stale workflows. Preparation no longer substitutes stale environment commands or overwrites secrets after an unreadable listing. Canvas retains its existing matching-worktree source selection.
