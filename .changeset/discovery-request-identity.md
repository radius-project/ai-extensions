---
"@radius-project/adapter-canvas": patch
---

Fix the Create Environment resource discovery dropping a profile switch made while an earlier lookup was still running. Discovery was de-duplicated per provider alone, so selecting Azure profile B while profile A's discovery was in flight was rejected outright: no request was ever issued for B, and A's response stayed on screen as B's resource list. Requests are now keyed by identity (provider plus subscription and tenant), so only an exact duplicate is suppressed while a changed account supersedes the outstanding request and a per-provider sequence number discards the superseded response instead of letting it overwrite the newer account's resources. Suppressing a duplicate also re-asserts the disabled Refresh button, which the profile handler optimistically re-enables, and a superseded request no longer hands Refresh back while its successor is still running.
